import { and, asc, count, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ANIMAL_ON_FARM_STATUSES, HEALTH_RECORD_TYPES, addDays, diffDays, round } from '@yap/shared';
import { nextVaccinationDue, withdrawalEnd } from '@yap/shared/formulas/reproduction';
import { schema } from '../../db/client';
import { newId } from '../../db/schema';
import { canSeeMoney, ctx, today, tx } from '../../core/context';
import { ensureCostCenter } from '../../core/costCenters';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getItemOrThrow, issueStock, reverseMovements } from '../../core/inventory';
import { recordEvent } from '../../core/journal';
import { hideMoney, hidePii } from '../../core/privacy';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { raiseAlert, resolveByDedupKey } from '../alerts/alerts.service';
import { signedFileUrl } from '../files';
import { findByCode, sickDedupKey } from './animals.service';
import { restingStatus } from './breeding.shared';
import {
  assertInFarm,
  assertNotFuture,
  assertOnFarm,
  getAnimalOrThrow,
  getHerdOrThrow,
  herdHeadCount,
  isOnFarm,
  onFarm,
  type Animal,
  type Herd,
} from './refs';

const {
  animals,
  documents,
  employees,
  files,
  healthRecords: h,
  herds,
  items,
  users,
  vaccinationPlans: plans,
  warehouses,
} = schema;

type HealthRecord = typeof h.$inferSelect;

const text = (max: number) => z.string().trim().max(max).nullish();

// ─── Journal ────────────────────────────────────────────────────────────────

const recordFields = {
  animalId: z.uuid().nullish(),
  herdId: z.uuid().nullish(),
  date: isoDate,
  diagnosis: text(300),
  itemId: z.uuid().nullish(),
  warehouseId: z.uuid().nullish(),
  dose: z.number().positive().nullish(),
  doseUnit: text(20),
  /** Quantity leaving the warehouse, in the item's unit. Derived from dose × head when omitted. */
  qtyUsed: z.number().positive().nullish(),
  courseDays: z.number().int().min(1).max(365).nullish(),
  vetEmployeeId: z.uuid().nullish(),
  result: text(300),
  /** Overrides the drug's default withdrawal period. */
  withdrawalDays: z.number().int().min(0).max(365).nullish(),
  headCount: z.number().int().positive().nullish(),
  nextDueDate: isoDate.nullish(),
  vaccinationPlanId: z.uuid().nullish(),
  photoFileIds: z.array(z.uuid()).max(10).optional(),
  notes: text(1000),
};

export const healthRecordInput = z.object({ id: clientId, type: z.enum(HEALTH_RECORD_TYPES), ...recordFields });
export type HealthRecordInput = z.infer<typeof healthRecordInput>;

export const healthRecordUpdate = z.object(recordFields).partial();

export const healthListQuery = listQuery.extend({
  type: z.enum(HEALTH_RECORD_TYPES).optional(),
  animalId: z.uuid().optional(),
  herdId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const EVENT_TYPES: Record<string, string> = {
  vaccination: 'animal.vaccinated',
  treatment: 'animal.treated',
  prophylaxis: 'animal.prophylaxis',
  deworming: 'animal.dewormed',
  examination: 'animal.examined',
  quarantine: 'animal.quarantined',
};

type RecordValues = Omit<HealthRecordInput, 'id'>;

/** The cost of one animal's care stays on that animal; whole-herd care goes to the herd. */
async function costCenterFor(animal: Animal | null, herd: Herd | null): Promise<string> {
  if (animal) return ensureCostCenter('animal', animal.id, animal.tag);
  return herd!.costCenterId ?? ensureCostCenter('herd', herd!.id, herd!.name);
}

/** Validate the input, take the drug from stock, and work out the derived fields. */
async function prepare(input: RecordValues, recordId: string) {
  if (!!input.animalId === !!input.herdId) throw badRequest('TARGET_REQUIRED', 'Choose one animal or one herd');
  assertNotFuture(input.date);

  const animal = input.animalId ? await getAnimalOrThrow(input.animalId) : null;
  const herd = input.herdId ? await getHerdOrThrow(input.herdId) : null;
  if (animal?.exitDate && input.date > animal.exitDate) {
    throw conflict('ANIMAL_NOT_ON_FARM', `Animal ${animal.tag} had left the farm by this date`);
  }
  await assertInFarm(employees, input.vetEmployeeId, 'Veterinarian');
  await assertInFarm(plans, input.vaccinationPlanId, 'Vaccination plan');

  const plan = input.vaccinationPlanId
    ? (await tx().select().from(plans).where(eq(plans.id, input.vaccinationPlanId)))[0]
    : null;
  const itemId = input.itemId ?? plan?.itemId ?? null;
  const headCount = animal ? 1 : (input.headCount ?? (await herdHeadCount(herd!.id)));
  const courseDays = input.courseDays ?? null;

  let warehouseId: string | null = null;
  let qtyUsed: number | null = null;
  let totalCost = 0;
  let itemWithdrawal: number | null = null;

  if (itemId) {
    const item = await getItemOrThrow(itemId);
    itemWithdrawal = item.withdrawalDays;
    warehouseId = input.warehouseId ?? item.defaultWarehouseId;
    if (!warehouseId) throw badRequest('WAREHOUSE_REQUIRED', 'Choose the warehouse the drug comes from');
    await assertInFarm(warehouses, warehouseId, 'Warehouse');

    // A dose in ml says nothing about vials used: only a dose in the item's own unit can be multiplied.
    const sameUnit = !input.doseUnit || input.doseUnit === item.unit;
    qtyUsed = input.qtyUsed ?? (input.dose && sameUnit ? round(input.dose * headCount * (courseDays ?? 1), 3) : null);
    if (!qtyUsed) throw badRequest('QTY_REQUIRED', 'Enter how much was taken from the warehouse');

    const issue = await issueStock({
      itemId,
      warehouseId,
      qty: qtyUsed,
      date: input.date,
      costCenterId: await costCenterFor(animal, herd),
      reason: 'treatment',
      refType: 'health_record',
      refId: recordId,
    });
    totalCost = issue.totalCost;
  }

  const withdrawalDays = input.withdrawalDays ?? itemWithdrawal;
  return {
    animalId: animal?.id ?? null,
    herdId: herd?.id ?? null,
    itemId,
    warehouseId,
    qtyUsed,
    totalCost,
    headCount,
    courseDays,
    withdrawalDays,
    withdrawalUntil: withdrawalDays ? withdrawalEnd(input.date, courseDays, withdrawalDays) : null,
    nextDueDate: input.nextDueDate ?? (plan?.intervalDays ? addDays(input.date, plan.intervalDays) : null),
  };
}

export async function createRecord(input: HealthRecordInput) {
  if (input.type === 'quarantine') {
    if (!input.animalId) throw badRequest('TARGET_REQUIRED', 'Quarantine applies to one animal');
    const { started } = await startQuarantine({ animalIds: [input.animalId], startDate: input.date, reason: input.diagnosis, notes: input.notes });
    return getRecord(started[0]);
  }

  const c = ctx();
  const id = input.id ?? newId();
  const derived = await prepare(input, id);
  await tx()
    .insert(h)
    .values({
      id,
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      type: input.type,
      date: input.date,
      diagnosis: input.diagnosis,
      dose: input.dose,
      doseUnit: input.doseUnit,
      vetEmployeeId: input.vetEmployeeId,
      result: input.result,
      vaccinationPlanId: input.vaccinationPlanId,
      photoFileIds: input.photoFileIds ?? [],
      notes: input.notes,
      ...derived,
    });
  await recordEvent({
    type: EVENT_TYPES[input.type],
    entityType: derived.animalId ? 'animal' : 'herd',
    entityId: derived.animalId ?? derived.herdId,
    occurredAt: input.date,
    data: { healthRecordId: id, itemId: derived.itemId, qty: derived.qtyUsed, headCount: derived.headCount, diagnosis: input.diagnosis },
  });
  return getRecord(id);
}

function recordSelection() {
  return {
    ...getTableColumns(h),
    animalTag: animals.tag,
    herdName: herds.name,
    itemName: items.name,
    itemUnit: items.unit,
    vetName: employees.fullName,
    /** The plan a scheduled dose answered, e.g. "Gijjaga qarshi ishlov". */
    planName: plans.name,
  };
}

function joinedRecords() {
  return tx()
    .select(recordSelection())
    .from(h)
    .leftJoin(animals, eq(animals.id, h.animalId))
    .leftJoin(herds, eq(herds.id, h.herdId))
    .leftJoin(items, eq(items.id, h.itemId))
    .leftJoin(employees, eq(employees.id, h.vetEmployeeId))
    .leftJoin(plans, eq(plans.id, h.vaccinationPlanId));
}

/** Sorting by a hidden number would still reveal which records cost most (CLAUDE.md rule 7). */
function journalSort() {
  return { date: h.date, type: h.type, ...(canSeeMoney() ? { totalCost: h.totalCost } : {}) };
}

export async function listRecords(q: z.infer<typeof healthListQuery>) {
  const c = ctx();
  const byTag = q.search
    ? inArray(h.animalId, tx().select({ id: animals.id }).from(animals).where(and(eq(animals.farmId, c.farmId), searchAny(q.search, [animals.tag]))))
    : undefined;
  const where = and(
    eq(h.farmId, c.farmId),
    q.type ? eq(h.type, q.type) : undefined,
    q.animalId ? eq(h.animalId, q.animalId) : undefined,
    q.herdId ? eq(h.herdId, q.herdId) : undefined,
    q.from ? gte(h.date, q.from) : undefined,
    q.to ? lte(h.date, q.to) : undefined,
    q.search ? or(byTag, searchAny(q.search, [h.diagnosis, h.notes])) : undefined,
  );
  const page = await paged(q, h, where, async (limit, offset) =>
    joinedRecords()
      .where(where)
      .orderBy(...sortBy(q.sort, journalSort(), desc(h.date), h.id))
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: hidePii(hideMoney(page.data, ['totalCost']), ['vetName']) };
}

export async function getRecord(id: string) {
  const [row] = await joinedRecords().where(and(eq(h.id, id), eq(h.farmId, ctx().farmId)));
  if (!row) throw notFound('Health record');
  return hidePii(hideMoney([row], ['totalCost']), ['vetName'])[0];
}

async function getRow(id: string): Promise<HealthRecord> {
  const [row] = await tx()
    .select()
    .from(h)
    .where(and(eq(h.id, id), eq(h.farmId, ctx().farmId)))
    .for('update');
  if (!row) throw notFound('Health record');
  return row;
}

/** Records that drive an animal's status are closed through their own actions, not edited. */
function isLifecycleRecord(row: HealthRecord): boolean {
  return row.type === 'quarantine' || row.reportStatus !== null;
}

export async function updateRecord(id: string, patch: z.infer<typeof healthRecordUpdate>) {
  // This path rewrites the row itself, so the kernel's empty-update check never sees it.
  if (Object.values(patch).every((value) => value === undefined)) {
    throw badRequest('NOTHING_TO_UPDATE', 'No changes were sent');
  }
  const existing = await getRow(id);

  if (isLifecycleRecord(existing)) {
    const { diagnosis, result, notes, photoFileIds } = patch;
    await tx().update(h).set({ diagnosis, result, notes, photoFileIds }).where(eq(h.id, id));
    return getRecord(id);
  }

  const merged: RecordValues = {
    type: existing.type as RecordValues['type'],
    animalId: existing.animalId,
    herdId: existing.herdId,
    date: existing.date,
    diagnosis: existing.diagnosis,
    itemId: existing.itemId,
    warehouseId: existing.warehouseId,
    dose: existing.dose,
    doseUnit: existing.doseUnit,
    qtyUsed: existing.qtyUsed,
    courseDays: existing.courseDays,
    vetEmployeeId: existing.vetEmployeeId,
    result: existing.result,
    withdrawalDays: existing.withdrawalDays,
    headCount: existing.headCount,
    nextDueDate: existing.nextDueDate,
    vaccinationPlanId: existing.vaccinationPlanId,
    photoFileIds: existing.photoFileIds,
    notes: existing.notes,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  };
  // Give the old quantity back first, so the new one is checked against real stock.
  await reverseMovements('health_record', id);
  const derived = await prepare(merged, id);
  await tx()
    .update(h)
    .set({
      date: merged.date,
      diagnosis: merged.diagnosis,
      dose: merged.dose,
      doseUnit: merged.doseUnit,
      vetEmployeeId: merged.vetEmployeeId,
      result: merged.result,
      vaccinationPlanId: merged.vaccinationPlanId,
      photoFileIds: merged.photoFileIds,
      notes: merged.notes,
      ...derived,
    })
    .where(eq(h.id, id));
  return getRecord(id);
}

export async function deleteRecord(id: string) {
  const row = await getRow(id);
  if (row.type === 'quarantine' && !row.endedOn) {
    throw conflict('QUARANTINE_ACTIVE', 'End the quarantine before deleting it');
  }
  if (row.reportStatus === 'open') throw conflict('REPORT_OPEN', 'Close the sick report before deleting it');
  await reverseMovements('health_record', id);
  await tx().delete(h).where(eq(h.id, id));
  await recordEvent({
    type: 'health_record.deleted',
    entityType: row.animalId ? 'animal' : 'herd',
    entityId: row.animalId ?? row.herdId,
    data: { healthRecordId: id, type: row.type },
  });
  return { id };
}

// ─── Sick reports ───────────────────────────────────────────────────────────

export const reportSickInput = z
  .object({
    id: clientId,
    animalId: z.uuid().optional(),
    /** Ear tag, RFID or QR value, when the shepherd typed or scanned it. */
    tag: z.string().trim().min(1).max(60).optional(),
    date: isoDate.nullish(),
    note: z.string().trim().min(1).max(1000),
    photoFileIds: z.array(z.uuid()).max(5).optional(),
  })
  .refine((v) => !!v.animalId || !!v.tag, { message: 'Choose an animal', path: ['animalId'] });

export const sickReportQuery = listQuery.extend({ status: z.enum(['open', 'resolved']).default('open') });

export const resolveSickInput = z.object({ result: text(300), date: isoDate.nullish() });

/**
 * A shepherd reports a sick animal (spec 18.1). It must reach the vet at once, so the alert is
 * urgent and repeats until acknowledged. Quarantine stays the visible status if it applies.
 */
export async function reportSick(input: z.infer<typeof reportSickInput>) {
  const animal = input.animalId ? await getAnimalOrThrow(input.animalId) : await findByCode(input.tag!);
  if (!animal) throw notFound('Animal');
  assertOnFarm(animal);
  const date = input.date ?? today();
  assertNotFuture(date);

  const c = ctx();
  const id = input.id ?? newId();
  await tx()
    .insert(h)
    .values({
      id,
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      type: 'examination',
      animalId: animal.id,
      date,
      headCount: 1,
      reportStatus: 'open',
      notes: input.note,
      photoFileIds: input.photoFileIds ?? [],
    });
  if (animal.status === 'active' || animal.status === 'pregnant') {
    await tx().update(animals).set({ status: 'sick' }).where(eq(animals.id, animal.id));
  }
  await recordEvent({
    type: 'animal.sick_reported',
    entityType: 'animal',
    entityId: animal.id,
    severity: 'urgent',
    occurredAt: date,
    photoFileId: input.photoFileIds?.[0],
    data: { healthRecordId: id, tag: animal.tag, note: input.note },
  });
  await raiseAlert({
    ruleKey: 'sick_report',
    dedupKey: sickDedupKey(animal.id),
    severity: 'urgent',
    title: `Kasal hayvon: ${animal.tag}`,
    body: input.note,
    link: '/livestock/health?tab=sick',
    entityType: 'animal',
    entityId: animal.id,
    data: { tag: animal.tag, note: input.note },
  });
  return getRecord(id);
}

export async function listSickReports(q: z.infer<typeof sickReportQuery>) {
  const where = and(eq(h.farmId, ctx().farmId), eq(h.reportStatus, q.status));
  const page = await paged(q, h, where, async (limit, offset) =>
    tx()
      .select({
        id: h.id,
        animalId: h.animalId,
        date: h.date,
        notes: h.notes,
        result: h.result,
        reportStatus: h.reportStatus,
        endedOn: h.endedOn,
        photoFileIds: h.photoFileIds,
        createdAt: h.createdAt,
        tag: animals.tag,
        animalStatus: animals.status,
        herdName: herds.name,
        reportedBy: users.fullName,
      })
      .from(h)
      .innerJoin(animals, eq(animals.id, h.animalId))
      .leftJoin(herds, eq(herds.id, animals.herdId))
      .leftJoin(users, eq(users.id, h.createdBy))
      .where(where)
      .orderBy(desc(h.date), desc(h.createdAt))
      .limit(limit)
      .offset(offset),
  );
  const data = await Promise.all(
    page.data.map(async (row) => ({
      ...row,
      photoUrls: await Promise.all(row.photoFileIds.map((fileId) => signedFileUrl(fileId))),
    })),
  );
  return { ...page, data };
}

/** The animal is well again: close every open report for it and clear the alert. */
export async function recoverAnimal(animalId: string, input: z.infer<typeof resolveSickInput>) {
  const animal = await getAnimalOrThrow(animalId, { lock: true });
  const date = input.date ?? today();
  await tx()
    .update(h)
    .set({ reportStatus: 'resolved', endedOn: date, result: input.result })
    .where(and(eq(h.animalId, animalId), eq(h.reportStatus, 'open')));
  if (animal.status === 'sick') {
    await tx().update(animals).set({ status: await restingStatus(animalId) }).where(eq(animals.id, animalId));
  }
  await resolveByDedupKey(sickDedupKey(animalId));
  await recordEvent({
    type: 'animal.recovered',
    entityType: 'animal',
    entityId: animalId,
    occurredAt: date,
    data: { result: input.result },
  });
  return getAnimalOrThrow(animalId).then(({ id, tag, status }) => ({ id, tag, status }));
}

export async function resolveSickReport(id: string, input: z.infer<typeof resolveSickInput>) {
  const row = await getRow(id);
  if (row.reportStatus !== 'open' || !row.animalId) throw conflict('REPORT_NOT_OPEN', 'This report is already closed');
  await recoverAnimal(row.animalId, input);
  return getRecord(id);
}

// ─── Quarantine ─────────────────────────────────────────────────────────────

export const quarantineInput = z.object({
  animalIds: z.array(z.uuid()).min(1).max(2000),
  startDate: isoDate.nullish(),
  /** Defaults to the tenant's quarantine period. */
  days: z.number().int().min(1).max(365).nullish(),
  reason: text(300),
  notes: text(1000),
});

export const quarantineEndInput = z.object({ date: isoDate.nullish(), result: text(300) });

export const quarantineQuery = listQuery.extend({ state: z.enum(['active', 'ended']).default('active') });

/** Put animals into quarantine (spec 8.3). Those already there are reported, not doubled. */
export async function startQuarantine(input: z.infer<typeof quarantineInput>) {
  const c = ctx();
  const startDate = input.startDate ?? today();
  assertNotFuture(startDate);
  const days = input.days ?? c.settings.livestock.quarantineDays;
  const until = addDays(startDate, days);

  const targets = await tx()
    .select()
    .from(animals)
    .where(and(eq(animals.farmId, c.farmId), inArray(animals.id, input.animalIds)))
    .for('update');
  if (targets.length !== new Set(input.animalIds).size) throw notFound('Animal');

  const already = await tx()
    .select({ animalId: h.animalId })
    .from(h)
    .where(and(inArray(h.animalId, input.animalIds), eq(h.type, 'quarantine'), isNull(h.endedOn)));
  const open = new Set(already.map((r) => r.animalId));

  const skipped: { animalId: string; tag: string; reason: string }[] = [];
  const accepted: Animal[] = [];
  for (const a of targets) {
    const reason = !isOnFarm(a.status) ? 'ANIMAL_NOT_ON_FARM' : open.has(a.id) ? 'ALREADY_IN_QUARANTINE' : null;
    if (reason) skipped.push({ animalId: a.id, tag: a.tag, reason });
    else accepted.push(a);
  }
  if (accepted.length === 0) {
    throw conflict(skipped[0].reason, 'None of these animals can enter quarantine', { skipped });
  }

  const rows = accepted.map((a) => ({
    id: newId(),
    tenantId: c.tenantId,
    farmId: c.farmId,
    createdBy: c.userId,
    type: 'quarantine',
    animalId: a.id,
    date: startDate,
    headCount: 1,
    diagnosis: input.reason,
    nextDueDate: until,
    notes: input.notes,
  }));
  await tx().insert(h).values(rows);
  await tx()
    .update(animals)
    .set({ status: 'quarantine', quarantineUntil: until })
    .where(inArray(animals.id, accepted.map((a) => a.id)));
  await recordEvent({
    type: EVENT_TYPES.quarantine,
    entityType: accepted.length === 1 ? 'animal' : undefined,
    entityId: accepted.length === 1 ? accepted[0].id : undefined,
    occurredAt: startDate,
    severity: 'attention',
    data: { count: accepted.length, until, reason: input.reason },
  });
  return { started: rows.map((r) => r.id), until, skipped };
}

export async function endQuarantine(id: string, input: z.infer<typeof quarantineEndInput>) {
  const row = await getRow(id);
  if (row.type !== 'quarantine') throw notFound('Quarantine');
  if (row.endedOn) throw conflict('QUARANTINE_ENDED', 'This quarantine has already ended');
  const date = input.date ?? today();
  assertNotFuture(date);
  if (date < row.date) throw badRequest('QUARANTINE_END_BEFORE_START', 'The end date is before the start date');

  await tx().update(h).set({ endedOn: date, result: input.result }).where(eq(h.id, id));
  const animal = await getAnimalOrThrow(row.animalId!, { lock: true });
  if (animal.status === 'quarantine') {
    await tx()
      .update(animals)
      .set({ status: await restingStatus(animal.id), quarantineUntil: null })
      .where(eq(animals.id, animal.id));
  }
  await recordEvent({
    type: 'animal.quarantine_ended',
    entityType: 'animal',
    entityId: animal.id,
    occurredAt: date,
    data: { healthRecordId: id, result: input.result },
  });
  return getRecord(id);
}

export async function listQuarantine(q: z.infer<typeof quarantineQuery>) {
  const where = and(
    eq(h.farmId, ctx().farmId),
    eq(h.type, 'quarantine'),
    q.state === 'active' ? isNull(h.endedOn) : isNotNull(h.endedOn),
  );
  const page = await paged(q, h, where, async (limit, offset) =>
    tx()
      .select({
        id: h.id,
        animalId: h.animalId,
        startDate: h.date,
        until: h.nextDueDate,
        endedOn: h.endedOn,
        reason: h.diagnosis,
        result: h.result,
        tag: animals.tag,
        herdName: herds.name,
      })
      .from(h)
      .innerJoin(animals, eq(animals.id, h.animalId))
      .leftJoin(herds, eq(herds.id, animals.herdId))
      .where(where)
      .orderBy(asc(h.nextDueDate), asc(h.id))
      .limit(limit)
      .offset(offset),
  );
  const now = today();
  return {
    ...page,
    data: page.data.map((r) => ({ ...r, daysLeft: r.until ? diffDays(now, r.until) : null })),
  };
}

// ─── Withdrawal ─────────────────────────────────────────────────────────────

export interface WithdrawalRow {
  animalId: string;
  tag: string;
  herdName: string | null;
  drug: string | null;
  recordId: string;
  withdrawalUntil: string;
  daysLeft: number;
}

/**
 * Animals whose meat or milk may not be sold yet, with the latest date for each. A herd treatment
 * covers everyone in the herd then, including animals moved out since; animals that joined later
 * are also included unless they did not exist yet, because being wrong here means unsafe meat.
 */
async function withdrawalRows(animalIds?: string[], asOf?: string): Promise<WithdrawalRow[]> {
  const c = ctx();
  const now = asOf ?? today();
  const only = animalIds ? sql`and a.id = any(${sql.param(animalIds)}::uuid[])` : sql``;
  const result = await tx().execute<{
    animal_id: string;
    tag: string;
    herd_name: string | null;
    drug: string | null;
    record_id: string;
    withdrawal_until: string;
  }>(sql`
    select distinct on (a.id)
      a.id as animal_id, a.tag, hd.name as herd_name, i.name as drug, r.id as record_id,
      r.withdrawal_until::text as withdrawal_until
    from health_records r
    join animals a
      on a.farm_id = r.farm_id
     and (
       a.id = r.animal_id
       or (
         r.animal_id is null
         and coalesce(a.birth_date, r.date) <= r.date
         and (
           a.herd_id = r.herd_id
           or exists (
             select 1 from herd_transfers t
             where t.animal_id = a.id and t.from_herd_id = r.herd_id and t.date >= r.date
           )
         )
       )
     )
    left join herds hd on hd.id = a.herd_id
    left join items i on i.id = r.item_id
    where r.farm_id = ${c.farmId}
      and r.withdrawal_until > ${now}::date
      and a.status = any(${sql.param([...ANIMAL_ON_FARM_STATUSES])}::text[])
      ${only}
    order by a.id, r.withdrawal_until desc`);
  return result.rows
    .map((row) => ({
      animalId: row.animal_id,
      tag: row.tag,
      herdName: row.herd_name,
      drug: row.drug,
      recordId: row.record_id,
      withdrawalUntil: row.withdrawal_until,
      daysLeft: diffDays(now, row.withdrawal_until),
    }))
    .sort((a, b) => a.withdrawalUntil.localeCompare(b.withdrawalUntil) || a.tag.localeCompare(b.tag));
}

export const withdrawalQuery = listQuery.extend({});

export async function listWithdrawal(q: z.infer<typeof withdrawalQuery>) {
  const term = q.search?.toLowerCase();
  const rows = (await withdrawalRows()).filter((r) => !term || r.tag.toLowerCase().includes(term));
  const start = (q.page - 1) * q.pageSize;
  return { data: rows.slice(start, start + q.pageSize), meta: { page: q.page, pageSize: q.pageSize, total: rows.length } };
}

/**
 * The single food-safety check for selling or slaughtering: which of these animals may not leave
 * yet on `asOf` (default today). `withdrawalUntil` is the first allowed day, so that day passes.
 * Sale and slaughter must call this rather than query health records themselves.
 */
export async function animalsUnderWithdrawal(animalIds: string[], asOf?: string): Promise<WithdrawalRow[]> {
  if (animalIds.length === 0) return [];
  return withdrawalRows(animalIds, asOf);
}

// ─── Vaccination plans and due calendar ─────────────────────────────────────

export const vaccinationPlanInput = z.object({
  id: clientId,
  name: z.string().trim().min(1).max(120),
  itemId: z.uuid().nullish(),
  speciesId: z.uuid().nullish(),
  category: text(30),
  ageDays: z.number().int().min(0).max(7300).nullish(),
  intervalDays: z.number().int().min(1).max(3650).nullish(),
  mandatory: z.boolean().optional(),
  notes: text(1000),
});

export const vaccinationDueQuery = z.object({
  herdId: z.uuid().optional(),
  /** How far ahead to look. Overdue vaccinations always show. */
  horizonDays: z.coerce.number().int().min(0).max(366).default(30),
});

/** What a plan can schedule (spec 8.3): a vaccine, a dewormer, a preventive drug, or a test. */
export const SCHEDULED_TYPES = ['vaccination', 'deworming', 'prophylaxis', 'examination'] as const;

export const herdVaccinationInput = z.object({
  id: clientId,
  herdId: z.uuid(),
  planId: z.uuid().nullish(),
  /** A dewormer or a blood test is not a vaccination: the record says what was done. */
  type: z.enum(SCHEDULED_TYPES).optional(),
  date: isoDate,
  itemId: z.uuid().nullish(),
  warehouseId: z.uuid().nullish(),
  dosePerHead: z.number().positive().nullish(),
  doseUnit: text(20),
  headCount: z.number().int().positive().nullish(),
  qtyUsed: z.number().positive().nullish(),
  vetEmployeeId: z.uuid().nullish(),
  notes: text(1000),
});

async function assertPlanRefs(i: { itemId?: string | null }) {
  await assertInFarm(items, i.itemId, 'Vaccine');
}

export async function listPlans() {
  const rows = await tx()
    .select({
      ...getTableColumns(plans),
      itemName: items.name,
      itemUnit: items.unit,
      itemCategory: items.category,
      /** What was last done under this plan: the form offers the same again. */
      lastType: sql<string | null>`(select hr.type from health_records hr where hr.vaccination_plan_id = ${plans.id} order by hr.date desc, hr.id desc limit 1)`,
    })
    .from(plans)
    .leftJoin(items, eq(items.id, plans.itemId))
    .where(and(eq(plans.farmId, ctx().farmId), eq(plans.active, true)))
    .orderBy(desc(plans.mandatory), asc(plans.name));
  return rows;
}

export async function createPlan(input: z.infer<typeof vaccinationPlanInput>) {
  await assertPlanRefs(input);
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(plans)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  return row;
}

export async function updatePlan(id: string, input: Partial<z.infer<typeof vaccinationPlanInput>>) {
  await assertPlanRefs(input);
  const { id: _ignored, ...values } = input;
  const [row] = await tx()
    .update(plans)
    .set(values)
    .where(and(eq(plans.id, id), eq(plans.farmId, ctx().farmId)))
    .returning();
  if (!row) throw notFound('Vaccination plan');
  return row;
}

/** Soft delete: past records keep pointing at the plan. */
export async function removePlan(id: string) {
  const [row] = await tx()
    .update(plans)
    .set({ active: false })
    .where(and(eq(plans.id, id), eq(plans.farmId, ctx().farmId)))
    .returning({ id: plans.id });
  if (!row) throw notFound('Vaccination plan');
  return row;
}


type DueState = 'overdue' | 'today' | 'upcoming';

interface PlanDue {
  plan: typeof plans.$inferSelect;
  animal: { id: string; tag: string; herdId: string | null };
  dueDate: string;
  state: DueState;
}

/** Work out, animal by animal, when each active plan is due next. */
async function computeDue(q: { herdId?: string; planId?: string; horizon: string }): Promise<PlanDue[]> {
  const c = ctx();
  const now = today();
  const activePlans = await tx()
    .select()
    .from(plans)
    .where(and(eq(plans.farmId, c.farmId), eq(plans.active, true), q.planId ? eq(plans.id, q.planId) : undefined));
  if (activePlans.length === 0) return [];

  const herd = await tx()
    .select({
      id: animals.id,
      tag: animals.tag,
      herdId: animals.herdId,
      speciesId: animals.speciesId,
      category: animals.category,
      birthDate: animals.birthDate,
      purchaseDate: animals.purchaseDate,
    })
    .from(animals)
    .where(and(eq(animals.farmId, c.farmId), onFarm(), q.herdId ? eq(animals.herdId, q.herdId) : undefined));

  const doses = await tx()
    .select({ animalId: h.animalId, herdId: h.herdId, date: h.date, planId: h.vaccinationPlanId, itemId: h.itemId })
    .from(h)
    .where(and(eq(h.farmId, c.farmId), inArray(h.type, [...SCHEDULED_TYPES])))
    .orderBy(desc(h.date));

  const due: PlanDue[] = [];
  for (const plan of activePlans) {
    const applies = doses.filter((d) => d.planId === plan.id || (!d.planId && !!plan.itemId && d.itemId === plan.itemId));
    const lastByAnimal = new Map<string, string>();
    const herdDates = new Map<string, string[]>();
    for (const dose of applies) {
      if (dose.animalId) {
        if (!lastByAnimal.has(dose.animalId)) lastByAnimal.set(dose.animalId, dose.date);
      } else if (dose.herdId) {
        herdDates.set(dose.herdId, [...(herdDates.get(dose.herdId) ?? []), dose.date]);
      }
    }

    for (const animal of herd) {
      if (plan.speciesId && plan.speciesId !== animal.speciesId) continue;
      if (plan.category && plan.category !== animal.category) continue;

      const arrival = animal.purchaseDate ?? animal.birthDate;
      // A herd dose counts only if the animal was on the farm that day.
      const herdLast = animal.herdId ? herdDates.get(animal.herdId)?.find((date) => !arrival || date >= arrival) : undefined;
      const own = lastByAnimal.get(animal.id);
      const lastDate = own && herdLast ? (own > herdLast ? own : herdLast) : (own ?? herdLast ?? null);

      const dueDate = nextVaccinationDue({
        lastDate,
        intervalDays: plan.intervalDays,
        birthDate: animal.birthDate,
        ageDays: plan.ageDays,
        arrivalDate: animal.purchaseDate,
        today: now,
      });
      if (!dueDate || dueDate > q.horizon) continue;
      due.push({
        plan,
        animal: { id: animal.id, tag: animal.tag, herdId: animal.herdId },
        dueDate,
        state: dueDate < now ? 'overdue' : dueDate === now ? 'today' : 'upcoming',
      });
    }
  }
  return due;
}

const STATE_ORDER: Record<DueState, number> = { overdue: 0, today: 1, upcoming: 2 };

/** Due calendar, grouped by plan, herd and date: a vet vaccinates a group, not a list of 500. */
export async function vaccinationDue(q: { herdId?: string; horizonDays?: number }) {
  const now = today();
  const due = await computeDue({ herdId: q.herdId, horizon: addDays(now, q.horizonDays ?? 30) });

  const herdIds = [...new Set(due.map((d) => d.animal.herdId).filter((id): id is string => !!id))];
  const herdRows = herdIds.length
    ? await tx().select({ id: herds.id, name: herds.name }).from(herds).where(inArray(herds.id, herdIds))
    : [];
  const herdName = new Map(herdRows.map((r) => [r.id, r.name]));

  const groups = new Map<string, {
    planId: string;
    planName: string;
    mandatory: boolean;
    itemId: string | null;
    herdId: string | null;
    herdName: string | null;
    dueDate: string;
    state: DueState;
    daysOverdue: number;
    head: number;
  }>();
  for (const d of due) {
    const key = `${d.plan.id}|${d.animal.herdId}|${d.dueDate}`;
    const group = groups.get(key);
    if (group) group.head += 1;
    else {
      groups.set(key, {
        planId: d.plan.id,
        planName: d.plan.name,
        mandatory: d.plan.mandatory,
        itemId: d.plan.itemId,
        herdId: d.animal.herdId,
        herdName: d.animal.herdId ? (herdName.get(d.animal.herdId) ?? null) : null,
        dueDate: d.dueDate,
        state: d.state,
        daysOverdue: Math.max(0, diffDays(d.dueDate, now)),
        head: 1,
      });
    }
  }
  const rows = [...groups.values()].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.dueDate.localeCompare(b.dueDate) || a.planName.localeCompare(b.planName),
  );
  const headIn = (state: DueState) => due.filter((d) => d.state === state).length;
  const dueNow = due.filter((d) => d.state !== 'upcoming');
  return {
    rows,
    /** Doses by state: one animal on two plans counts twice here. */
    totals: { overdue: headIn('overdue'), today: headIn('today'), upcoming: headIn('upcoming') },
    /** Different animals needing a dose now, and how many plans that spans. */
    animals: new Set(dueNow.map((d) => d.animal.id)).size,
    plans: new Set(dueNow.map((d) => d.plan.id)).size,
  };
}

/** The animals behind one row of the calendar. */
export async function vaccinationDueAnimals(planId: string, q: { herdId?: string; horizonDays?: number }) {
  const due = await computeDue({ planId, herdId: q.herdId, horizon: addDays(today(), q.horizonDays ?? 30) });
  return due
    .map((d) => ({ animalId: d.animal.id, tag: d.animal.tag, herdId: d.animal.herdId, dueDate: d.dueDate, state: d.state }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.tag.localeCompare(b.tag));
}

/** Vaccinate a whole herd: head count and doses are worked out, and stock is consumed once. */
export async function vaccinateHerd(input: z.infer<typeof herdVaccinationInput>) {
  const type = input.type ?? 'vaccination';
  // A test needs no product; a dose of nothing would count towards no plan.
  if (type !== 'examination' && !input.planId && !input.itemId) {
    throw badRequest('VACCINE_REQUIRED', 'Choose the plan or the product');
  }
  return createRecord({
    id: input.id,
    type,
    herdId: input.herdId,
    vaccinationPlanId: input.planId,
    date: input.date,
    itemId: input.itemId,
    warehouseId: input.warehouseId,
    dose: input.dosePerHead,
    doseUnit: input.doseUnit,
    headCount: input.headCount,
    qtyUsed: input.qtyUsed,
    vetEmployeeId: input.vetEmployeeId,
    notes: input.notes,
  });
}

// ─── Veterinary documents ───────────────────────────────────────────────────

const VET_DOCUMENT = 'vet_certificate';

export const vetDocumentInput = z.object({
  id: clientId,
  title: z.string().trim().min(1).max(200),
  number: text(60),
  fileId: z.uuid().nullish(),
  issueDate: isoDate.nullish(),
  expiryDate: isoDate.nullish(),
  entityType: z.enum(['animal', 'herd']).nullish(),
  entityId: z.uuid().nullish(),
  notes: text(1000),
});

export const vetDocumentQuery = listQuery.extend({
  entityType: z.enum(['animal', 'herd']).optional(),
  entityId: z.uuid().optional(),
});

export async function listDocuments(q: z.infer<typeof vetDocumentQuery>) {
  const where = and(
    eq(documents.farmId, ctx().farmId),
    eq(documents.type, VET_DOCUMENT),
    q.entityType ? eq(documents.entityType, q.entityType) : undefined,
    q.entityId ? eq(documents.entityId, q.entityId) : undefined,
    searchAny(q.search, [documents.title, documents.number]),
  );
  const page = await paged(q, documents, where, async (limit, offset) =>
    tx()
      .select()
      .from(documents)
      .where(where)
      .orderBy(...sortBy(q.sort, { issueDate: documents.issueDate, title: documents.title }, desc(documents.createdAt), documents.id))
      .limit(limit)
      .offset(offset),
  );
  const data = await Promise.all(
    page.data.map(async (doc) => ({ ...doc, fileUrl: doc.fileId ? await signedFileUrl(doc.fileId) : null })),
  );
  return { ...page, data };
}

export async function createDocument(input: z.infer<typeof vetDocumentInput>) {
  await assertInFarm(files, input.fileId, 'File');
  if (input.entityType === 'animal') await assertInFarm(animals, input.entityId, 'Animal');
  if (input.entityType === 'herd') await assertInFarm(herds, input.entityId, 'Herd');
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(documents)
    .values({ ...(id ? { id } : {}), ...values, type: VET_DOCUMENT, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  return row;
}

export async function removeDocument(id: string) {
  const [row] = await tx()
    .delete(documents)
    .where(and(eq(documents.id, id), eq(documents.farmId, ctx().farmId), eq(documents.type, VET_DOCUMENT)))
    .returning({ id: documents.id });
  if (!row) throw notFound('Document');
  return row;
}

// ─── What the vet needs today ───────────────────────────────────────────────

const PREVIEW = 5;

/** The first thing a vet opens: everything that needs action, nothing that does not. */
export async function vetToday() {
  const c = ctx();
  const now = today();
  const vaccinations = await vaccinationDue({ horizonDays: 7 });

  const [{ sick }] = await tx()
    .select({ sick: count() })
    .from(h)
    .where(and(eq(h.farmId, c.farmId), eq(h.reportStatus, 'open')));
  const sickReports = await listSickReports({ page: 1, pageSize: PREVIEW, status: 'open' });
  // Status can also be set on the animal card, so not every sick animal has a report.
  const [{ sickAnimals }] = await tx()
    .select({ sickAnimals: count() })
    .from(animals)
    .where(and(eq(animals.farmId, c.farmId), eq(animals.status, 'sick')));

  const quarantine = await listQuarantine({ page: 1, pageSize: 200, state: 'active' });
  const endingSoon = quarantine.data.filter((r) => r.daysLeft !== null && r.daysLeft <= 3);

  const courses = await tx()
    .select({
      id: h.id,
      date: h.date,
      courseDays: h.courseDays,
      diagnosis: h.diagnosis,
      animalId: h.animalId,
      tag: animals.tag,
      herdName: herds.name,
      itemName: items.name,
    })
    .from(h)
    .leftJoin(animals, eq(animals.id, h.animalId))
    .leftJoin(herds, eq(herds.id, h.herdId))
    .leftJoin(items, eq(items.id, h.itemId))
    .where(
      and(
        eq(h.farmId, c.farmId),
        eq(h.type, 'treatment'),
        sql`${h.courseDays} > 1`,
        sql`${h.date} + (${h.courseDays} - 1) >= ${now}::date`,
      ),
    )
    .orderBy(asc(h.date))
    .limit(PREVIEW);

  return {
    date: now,
    vaccinations: {
      ...vaccinations.totals,
      animals: vaccinations.animals,
      plans: vaccinations.plans,
      rows: vaccinations.rows.slice(0, PREVIEW),
    },
    sick: { open: sick, animals: sickAnimals, reports: sickReports.data },
    quarantine: { active: quarantine.meta.total, endingSoon: endingSoon.slice(0, PREVIEW) },
    courses: courses.map((row) => ({ ...row, day: diffDays(row.date, now) + 1 })),
    withdrawal: { animals: (await withdrawalRows()).length },
  };
}
