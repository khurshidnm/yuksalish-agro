import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { OPERATION_TYPES, withdrawalUntil } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { ensureCostCenter } from '../../core/costCenters';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getItemOrThrow, issueStock, reverseMovements } from '../../core/inventory';
import { recordEvent } from '../../core/journal';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { signedFileUrl } from '../files';
import { bestEffort } from '../assets/best-effort';
import { logUsage, removeUsageForOperation } from '../assets/usage.service';
import { getWeatherFor } from '../farm/weather.service';
import { getFieldRow, refreshPlanStatus, resolvePlanId } from './plans.service';

const { assets, cropPlans, crops, employees, fieldOperationMaterials: materials, fieldOperations: t, fields, items, warehouses } = schema;

/** A second pass over part of a field is normal; working more than the field is a typing error. */
const AREA_TOLERANCE = 1.02;

const operationDetails = {
  tillage: z.object({ method: z.string().trim().max(60).optional() }),
  sowing: z.object({ variety: z.string().trim().max(120).optional(), seedRateKgHa: z.number().min(0).optional() }),
  irrigation: z.object({ waterSource: z.string().trim().max(120).optional() }),
  fertilizing: z.object({ method: z.string().trim().max(60).optional() }),
  protection: z.object({
    target: z.string().trim().max(120).optional(),
    dose: z.number().min(0).optional(),
    doseUnit: z.string().trim().max(20).optional(),
    withdrawalDays: z.number().int().min(0).max(365).optional(),
  }),
  observation: z.object({
    condition: z.enum(['good', 'fair', 'poor']).optional(),
    pests: z.string().trim().max(500).optional(),
    diseases: z.string().trim().max(500).optional(),
  }),
  harvest: z.object({}),
} as const;

const materialInput = z.object({
  itemId: z.uuid(),
  warehouseId: z.uuid(),
  qty: z.number().positive(),
  normPerHa: z.number().min(0).nullish(),
});

const operationFields = {
  type: z.enum(OPERATION_TYPES),
  date: isoDate,
  fieldId: z.uuid(),
  cropPlanId: z.uuid().nullish(),
  assetId: z.uuid().nullish(),
  employeeId: z.uuid().nullish(),
  areaDoneHa: z.number().positive().nullish(),
  waterM3: z.number().min(0).nullish(),
  durationH: z.number().positive().max(24).nullish(),
  fuelL: z.number().min(0).nullish(),
  fuelItemId: z.uuid().nullish(),
  fuelWarehouseId: z.uuid().nullish(),
  skipFuelIssue: z.boolean().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  photoFileIds: z.array(z.uuid()).max(10).optional(),
  notes: z.string().trim().max(1000).nullish(),
  materials: z.array(materialInput).max(20).optional(),
};

export const operationInput = z.object({
  id: clientId,
  status: z.enum(['planned', 'done']).optional(),
  ...operationFields,
});
export type OperationInput = z.infer<typeof operationInput>;

export const operationPatch = z.object(operationFields).partial();
export type OperationPatch = z.infer<typeof operationPatch>;

/** Completing planned work: the date defaults to today, the rest fills in what actually happened. */
export const completeInput = operationPatch.omit({ type: true, fieldId: true, cropPlanId: true });

export const operationListQuery = listQuery.extend({
  type: z.enum(OPERATION_TYPES).optional(),
  status: z.enum(['planned', 'done']).optional(),
  fieldId: z.uuid().optional(),
  cropPlanId: z.uuid().optional(),
  seasonId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  overdue: z.enum(['true', 'false']).optional(),
});

type Operation = typeof t.$inferSelect;
type MaterialInput = z.infer<typeof materialInput>;
type FuelSource = Pick<OperationInput, 'fuelItemId' | 'fuelWarehouseId' | 'skipFuelIssue'>;

function validateDetails(type: Operation['type'], details: Record<string, unknown>) {
  const schemaForType = operationDetails[type as keyof typeof operationDetails];
  const parsed = schemaForType.loose().safeParse(details);
  if (!parsed.success) {
    throw badRequest('INVALID_DETAILS', 'Some operation details are not valid', {
      fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [`details.${i.path.join('.')}`, i.message])),
    });
  }
  return parsed.data as Record<string, unknown>;
}

async function validateWork(input: {
  type: string;
  status: string;
  date: string;
  fieldId: string;
  areaDoneHa?: number | null;
  waterM3?: number | null;
  assetId?: string | null;
  fuelL?: number | null;
}) {
  const field = await getFieldRow(input.fieldId);
  if (input.status !== 'done') return field;

  if (input.date > today()) throw badRequest('FUTURE_DATE', 'Completed work cannot be dated in the future');
  if (input.areaDoneHa && field.areaHa > 0 && input.areaDoneHa > field.areaHa * AREA_TOLERANCE) {
    throw badRequest('AREA_EXCEEDS_FIELD', `This field is only ${field.areaHa} ha`, { fieldAreaHa: field.areaHa });
  }
  if (input.type === 'irrigation' && !input.waterM3) {
    throw badRequest('WATER_REQUIRED', 'Enter the amount of water');
  }
  if ((input.fuelL ?? 0) > 0 && !input.assetId) {
    // Otherwise the liters would be noted, but nothing would leave the warehouse.
    throw badRequest('ASSET_REQUIRED_FOR_FUEL', 'Choose the machine that used this fuel');
  }
  return field;
}

/** Weather of the work day (spec 7.3). The record is saved whether or not it is available. */
async function weatherSnapshot(date: string): Promise<Record<string, unknown> | null> {
  const weather = await bestEffort(() => getWeatherFor(date));
  return weather ? { ...weather } : null;
}

/** Stock and machine effects of completed work. Planned work only remembers its materials. */
async function applyEffects(op: Operation, list: MaterialInput[], fuel: FuelSource): Promise<void> {
  const c = ctx();
  const field = await getFieldRow(op.fieldId);
  const rows = [];
  for (const material of list) {
    await getItemOrThrow(material.itemId);
    let totalCost = 0;
    if (op.status === 'done') {
      const issue = await issueStock({
        itemId: material.itemId,
        warehouseId: material.warehouseId,
        qty: material.qty,
        date: op.date,
        costCenterId: field.costCenterId ?? (await ensureCostCenter('field', field.id, field.number)),
        reason: 'field_operation',
        refType: 'field_operation',
        refId: op.id,
      });
      totalCost = issue.totalCost;
    }
    rows.push({
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      operationId: op.id,
      itemId: material.itemId,
      warehouseId: material.warehouseId,
      qty: material.qty,
      normPerHa: material.normPerHa,
      totalCost,
    });
  }
  if (rows.length > 0) await tx().insert(materials).values(rows);

  if (op.status === 'done' && op.assetId) {
    await logUsage({
      assetId: op.assetId,
      operationId: op.id,
      date: op.date,
      operatorEmployeeId: op.employeeId,
      fieldId: op.fieldId,
      workType: op.type,
      motoHours: op.durationH,
      volumeHa: op.areaDoneHa,
      fuelL: op.fuelL,
      ...fuel,
    });
  }
}

/** Undo stock and machine effects. Returns the fuel source, so an edit can use it again. */
async function undoEffects(op: Operation): Promise<FuelSource> {
  await reverseMovements('field_operation', op.id);
  await tx().delete(materials).where(eq(materials.operationId, op.id));
  const usage = await removeUsageForOperation(op.id);
  return {
    fuelItemId: usage?.fuelItemId,
    fuelWarehouseId: usage?.fuelWarehouseId,
    skipFuelIssue: usage ? !usage.fuelItemId : undefined,
  };
}

function eventFor(op: Operation) {
  return recordEvent({
    type: `field.${op.type}`,
    entityType: 'field',
    entityId: op.fieldId,
    occurredAt: op.date,
    data: { operationId: op.id, areaDoneHa: op.areaDoneHa, waterM3: op.waterM3, status: op.status },
  });
}

/** Set by the platform, not typed by anyone, so an edit of the form must not lose them. */
const SYSTEM_DETAILS = ['name', 'cardLine'];

function keepSystemDetails(previous: Record<string, unknown>, next: Record<string, unknown>) {
  const kept = SYSTEM_DETAILS.filter((key) => key in previous).map((key) => [key, previous[key]]);
  return { ...Object.fromEntries(kept), ...next };
}

/** Details that depend on other values, kept on the row so reports need no extra logic. */
function deriveDetails(type: string, date: string, details: Record<string, unknown>) {
  if (type !== 'protection' || typeof details.withdrawalDays !== 'number') return details;
  return { ...details, safeFrom: withdrawalUntil(date, details.withdrawalDays) };
}

export async function createOperation(input: OperationInput) {
  if (input.type === 'harvest' && (input.status ?? 'done') === 'done') {
    throw badRequest('USE_HARVEST_FORM', 'Record a harvest through the harvest form');
  }
  const status = input.status ?? 'done';
  await validateWork({ ...input, status });
  const c = ctx();
  const id = input.id ?? uuidv7();
  const details = deriveDetails(input.type, input.date, validateDetails(input.type, input.details ?? {}));
  const cropPlanId = await resolvePlanId(input.fieldId, input.date, input.cropPlanId);

  const [op] = await tx()
    .insert(t)
    .values({
      id,
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      type: input.type,
      status,
      date: input.date,
      plannedDate: status === 'planned' ? input.date : null,
      fieldId: input.fieldId,
      cropPlanId,
      assetId: input.assetId,
      employeeId: input.employeeId,
      areaDoneHa: input.areaDoneHa,
      waterM3: input.waterM3,
      durationH: input.durationH,
      fuelL: input.fuelL,
      details,
      lat: input.lat,
      lng: input.lng,
      photoFileIds: input.photoFileIds ?? [],
      weather: status === 'done' ? await weatherSnapshot(input.date) : null,
      notes: input.notes,
    })
    .returning();

  await applyEffects(op, input.materials ?? [], input);
  await refreshPlanStatus(cropPlanId, input.type === 'sowing');
  await eventFor(op);
  return getOperation(id);
}

async function getRow(id: string): Promise<Operation> {
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Field operation');
  return row;
}

async function currentMaterials(operationId: string): Promise<MaterialInput[]> {
  const rows = await tx().select().from(materials).where(eq(materials.operationId, operationId));
  return rows.map((m) => ({ itemId: m.itemId, warehouseId: m.warehouseId, qty: m.qty, normPerHa: m.normPerHa }));
}

function assertEditable(op: Operation): void {
  if (op.type === 'harvest' && op.status === 'done') {
    throw conflict('USE_HARVEST_FORM', 'Change a harvest through the harvest form');
  }
}

/** Edit by undoing and re-posting, so stock, cost and motor-hours stay exact. */
export async function updateOperation(id: string, input: OperationPatch) {
  const before = await getRow(id);
  assertEditable(before);
  const { materials: nextMaterials, fuelItemId, fuelWarehouseId, skipFuelIssue, details, ...changes } = input;
  const merged = { ...before, ...changes };
  await validateWork(merged);

  const list = nextMaterials ?? (await currentMaterials(id));
  const previousFuel = await undoEffects(before);
  const fuel: FuelSource = {
    fuelItemId: fuelItemId ?? previousFuel.fuelItemId,
    fuelWarehouseId: fuelWarehouseId ?? previousFuel.fuelWarehouseId,
    skipFuelIssue: skipFuelIssue ?? previousFuel.skipFuelIssue,
  };

  const nextDetails = details ? keepSystemDetails(before.details, validateDetails(merged.type, details)) : before.details;
  const [op] = await tx()
    .update(t)
    .set({
      ...changes,
      details: deriveDetails(merged.type, merged.date, nextDetails),
      plannedDate: before.status === 'planned' ? merged.date : before.plannedDate,
      cropPlanId: await resolvePlanId(merged.fieldId, merged.date, input.cropPlanId ?? before.cropPlanId),
      weather: before.status === 'done' && merged.date !== before.date ? await weatherSnapshot(merged.date) : before.weather,
    })
    .where(eq(t.id, id))
    .returning();

  await applyEffects(op, list, fuel);
  const isSowing = op.type === 'sowing' || before.type === 'sowing';
  await refreshPlanStatus(before.cropPlanId, isSowing);
  if (op.cropPlanId !== before.cropPlanId) await refreshPlanStatus(op.cropPlanId, isSowing);
  return getOperation(id);
}

/** Turn planned work into done work: stock leaves the warehouse now, not when it was planned. */
export async function completeOperation(id: string, input: z.infer<typeof completeInput>) {
  const before = await getRow(id);
  if (before.status !== 'planned') throw conflict('NOT_PLANNED', 'This work is already done');
  if (before.type === 'harvest') throw conflict('USE_HARVEST_FORM', 'Record a harvest through the harvest form');

  const { materials: nextMaterials, fuelItemId, fuelWarehouseId, skipFuelIssue, details, ...changes } = input;
  const date = input.date ?? today();
  const merged = { ...before, ...changes, date, status: 'done' };
  await validateWork(merged);

  const list = nextMaterials ?? (await currentMaterials(id));
  await tx().delete(materials).where(eq(materials.operationId, id));

  const nextDetails = details ? keepSystemDetails(before.details, validateDetails(before.type, details)) : before.details;
  const [op] = await tx()
    .update(t)
    .set({
      ...changes,
      date,
      status: 'done',
      details: deriveDetails(before.type, date, nextDetails),
      weather: await weatherSnapshot(date),
    })
    .where(eq(t.id, id))
    .returning();

  await applyEffects(op, list, { fuelItemId, fuelWarehouseId, skipFuelIssue });
  await refreshPlanStatus(op.cropPlanId, op.type === 'sowing');
  await eventFor(op);
  return getOperation(id);
}

export async function removeOperation(id: string) {
  const op = await getRow(id);
  assertEditable(op);
  await undoEffects(op);
  await tx().delete(t).where(eq(t.id, id));
  await refreshPlanStatus(op.cropPlanId, op.type === 'sowing');
  await recordEvent({ type: 'field.operation_deleted', entityType: 'field', entityId: op.fieldId, data: { operationId: id, type: op.type } });
  return { id };
}

const listColumns = {
  id: t.id,
  type: t.type,
  status: t.status,
  date: t.date,
  plannedDate: t.plannedDate,
  fieldId: t.fieldId,
  fieldNumber: fields.number,
  fieldName: fields.name,
  cropPlanId: t.cropPlanId,
  cropName: crops.name,
  assetId: t.assetId,
  assetName: assets.name,
  employeeId: t.employeeId,
  employeeName: employees.fullName,
  areaDoneHa: t.areaDoneHa,
  waterM3: t.waterM3,
  durationH: t.durationH,
  fuelL: t.fuelL,
  details: t.details,
  lat: t.lat,
  lng: t.lng,
  photoFileIds: t.photoFileIds,
  weather: t.weather,
  notes: t.notes,
  createdAt: t.createdAt,
};

function listQueryBase() {
  return tx()
    .select(listColumns)
    .from(t)
    .innerJoin(fields, eq(fields.id, t.fieldId))
    .leftJoin(cropPlans, eq(cropPlans.id, t.cropPlanId))
    .leftJoin(crops, eq(crops.id, cropPlans.cropId))
    .leftJoin(assets, eq(assets.id, t.assetId))
    .leftJoin(employees, eq(employees.id, t.employeeId));
}

async function attachMaterials<T extends { id: string; status: string; date: string }>(rows: T[]) {
  const ids = rows.map((r) => r.id);
  const lines =
    ids.length === 0
      ? []
      : await tx()
          .select({
            id: materials.id,
            operationId: materials.operationId,
            itemId: materials.itemId,
            itemName: items.name,
            unit: items.unit,
            warehouseId: materials.warehouseId,
            warehouseName: warehouses.name,
            qty: materials.qty,
            normPerHa: materials.normPerHa,
            totalCost: materials.totalCost,
          })
          .from(materials)
          .innerJoin(items, eq(items.id, materials.itemId))
          .innerJoin(warehouses, eq(warehouses.id, materials.warehouseId))
          .where(inArray(materials.operationId, ids));
  const visible = hideMoney(lines, ['totalCost'], 'crops.approve');
  const date = today();
  return rows.map((row) => ({
    ...row,
    overdue: row.status === 'planned' && row.date < date,
    materials: visible.filter((m) => m.operationId === row.id),
  }));
}

export async function listOperations(q: z.infer<typeof operationListQuery>) {
  const date = today();
  const where = and(
    eq(t.farmId, ctx().farmId),
    q.type ? eq(t.type, q.type) : undefined,
    q.status ? eq(t.status, q.status) : undefined,
    q.fieldId ? eq(t.fieldId, q.fieldId) : undefined,
    q.cropPlanId ? eq(t.cropPlanId, q.cropPlanId) : undefined,
    q.seasonId
      ? inArray(t.cropPlanId, tx().select({ id: cropPlans.id }).from(cropPlans).where(eq(cropPlans.seasonId, q.seasonId)))
      : undefined,
    q.from ? sql`${t.date} >= ${q.from}` : undefined,
    q.to ? sql`${t.date} <= ${q.to}` : undefined,
    q.overdue === 'true' ? sql`${t.status} = 'planned' and ${t.date} < ${date}` : undefined,
    q.search
      ? or(
          searchAny(q.search, [t.notes]),
          inArray(t.fieldId, tx().select({ id: fields.id }).from(fields).where(searchAny(q.search, [fields.number, fields.name]))),
        )
      : undefined,
  );
  const page = await paged(q, t, where, (limit, offset) =>
    listQueryBase()
      .where(where)
      .orderBy(...sortBy(q.sort, { date: t.date, type: t.type, status: t.status }, desc(t.date), t.id))
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: await attachMaterials(page.data) };
}

export async function getOperation(id: string) {
  const rows = await listQueryBase().where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!rows[0]) throw notFound('Field operation');
  const [row] = await attachMaterials(rows);
  const photos = await Promise.all(row.photoFileIds.map(async (fileId) => ({ id: fileId, url: await signedFileUrl(fileId) })));
  return { ...row, photos };
}

/** Work that should have happened by now (spec 7.4, 14.1). */
export async function overdue(limit = 50) {
  return listQueryBase()
    .where(and(eq(t.farmId, ctx().farmId), eq(t.status, 'planned'), sql`${t.date} < ${today()}`))
    .orderBy(asc(t.date))
    .limit(limit);
}

/** The newest protection treatment on a field whose waiting period is still running on `date`. */
export async function activeWithdrawal(fieldId: string, date: string): Promise<string | null> {
  const [row] = await tx()
    .select({ safeFrom: sql<string>`${t.details}->>'safeFrom'` })
    .from(t)
    .where(
      and(
        eq(t.fieldId, fieldId),
        eq(t.type, 'protection'),
        eq(t.status, 'done'),
        sql`${t.details}->>'safeFrom' > ${date}`,
      ),
    )
    .orderBy(sql`${t.details}->>'safeFrom' desc`)
    .limit(1);
  return row?.safeFrom ?? null;
}
