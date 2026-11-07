import { and, asc, desc, eq, getTableColumns, gte, inArray, lte, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  BREEDING_SOURCES,
  SEXES,
  addDays,
  diffDays,
  expectedLambingDate,
  lambingWindow,
} from '@yap/shared';
import { canBreed, commonAncestors, type ParentLinks } from '@yap/shared/formulas/reproduction';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { createAnimal } from './animals.service';
import {
  assertNotFuture,
  assertOnFarm,
  getAnimalOrThrow,
  getHerdOrThrow,
  isOnFarm,
  onFarm,
  type Animal,
} from './refs';

const { animals, breedingRecords: b, herds, lambingRecords: l, species } = schema;
const ram = alias(animals, 'ram');
const ewe = alias(animals, 'ewe');

export type BreedingRecord = typeof b.$inferSelect;

const notes = z.string().trim().max(1000).nullish();

// ─── Pregnancies ────────────────────────────────────────────────────────────

export const pregnancyInput = z.object({
  id: clientId,
  eweId: z.uuid(),
  ramId: z.uuid().nullish(),
  matingDate: isoDate,
  source: z.enum(BREEDING_SOURCES).optional(),
  notes,
});
export type PregnancyInput = z.infer<typeof pregnancyInput>;

export const pregnancyUpdate = z.object({ matingDate: isoDate.optional(), ramId: z.uuid().nullish(), notes });

export const bulkPregnancyInput = z
  .object({
    /** Every ewe in this herd, or the listed animals. */
    herdId: z.uuid().optional(),
    animalIds: z.array(z.uuid()).min(1).max(5000).optional(),
    matingDate: isoDate,
    ramId: z.uuid().nullish(),
    source: z.enum(BREEDING_SOURCES).optional(),
    notes,
  })
  .refine((v) => !!v.herdId !== !!v.animalIds, { message: 'Choose a herd or a list of animals', path: ['herdId'] });

export const closePregnancyInput = z.object({
  status: z.enum(['aborted', 'failed']),
  notes,
});

export const pregnancyListQuery = listQuery.extend({
  status: z.enum(['pregnant', 'lambed', 'aborted', 'failed']).optional(),
  herdId: z.uuid().optional(),
  ramId: z.uuid().optional(),
  expectedFrom: isoDate.optional(),
  expectedTo: isoDate.optional(),
});

interface Gestation {
  days: number;
  min: number;
  max: number;
}

async function gestationOf(speciesId: string): Promise<Gestation> {
  const [row] = await tx()
    .select({ days: species.gestationDays, min: species.gestationMinDays, max: species.gestationMaxDays })
    .from(species)
    .where(eq(species.id, speciesId));
  if (row) return row;
  const days = ctx().settings.livestock.defaultGestationDays;
  return { days, min: days, max: days };
}

function pregnancyDates(matingDate: string, g: Gestation) {
  const window = lambingWindow(matingDate, g.min, g.max);
  return {
    expectedDate: expectedLambingDate(matingDate, g.days),
    expectedEarliest: window.earliest,
    expectedLatest: window.latest,
  };
}

function assertCanBreed(animal: Animal, on: string): void {
  if (!canBreed(animal, on)) throw badRequest('ANIMAL_CANNOT_BREED', `Animal ${animal.tag} is too young to breed, or castrated`);
}

async function assertRam(ramId: string | null | undefined, on: string): Promise<void> {
  if (!ramId) return;
  const row = await getAnimalOrThrow(ramId);
  if (row.sex !== 'male') throw badRequest('RAM_NOT_MALE', `Animal ${row.tag} is not a male`);
  assertCanBreed(row, on);
}

async function openPregnancy(eweId: string): Promise<BreedingRecord | undefined> {
  const [row] = await tx()
    .select()
    .from(b)
    .where(and(eq(b.eweId, eweId), eq(b.status, 'pregnant')))
    .orderBy(desc(b.matingDate))
    .limit(1);
  return row;
}

/** Register a pregnancy, compute the expected lambing dates, and mark the ewe as pregnant. */
export async function createPregnancy(i: PregnancyInput): Promise<BreedingRecord> {
  assertNotFuture(i.matingDate);
  // Locked so that two requests for one ewe run in turn. The unique index is the last line.
  const target = await getAnimalOrThrow(i.eweId, { lock: true });
  assertOnFarm(target);
  if (target.sex !== 'female') throw badRequest('ANIMAL_NOT_FEMALE', `Animal ${target.tag} is not a female`);
  assertCanBreed(target, i.matingDate);
  await assertRam(i.ramId, i.matingDate);
  if (await openPregnancy(i.eweId)) {
    throw conflict('ALREADY_PREGNANT', `Animal ${target.tag} already has an open pregnancy`);
  }

  const c = ctx();
  const [row] = await tx()
    .insert(b)
    .values({
      ...(i.id ? { id: i.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      eweId: i.eweId,
      ramId: i.ramId,
      source: i.source ?? 'mating',
      matingDate: i.matingDate,
      ...pregnancyDates(i.matingDate, await gestationOf(target.speciesId)),
      notes: i.notes,
    })
    .returning();

  // Sick and quarantined stay as they are: their status is the more urgent fact.
  if (target.status === 'active') {
    await tx().update(animals).set({ status: 'pregnant' }).where(eq(animals.id, i.eweId));
  }
  await recordEvent({
    type: 'animal.pregnancy_recorded',
    entityType: 'animal',
    entityId: i.eweId,
    occurredAt: i.matingDate,
    data: { breedingId: row.id, ramId: i.ramId, expectedDate: row.expectedDate },
  });
  return row;
}

export interface BulkResult {
  created: number;
  skipped: { animalId: string; tag: string; reason: string }[];
  inbreeding: { animalId: string; tag: string }[];
}

/** Register many pregnancies at once. Ewes that cannot take one are reported, not failed. */
export async function bulkPregnancy(i: z.infer<typeof bulkPregnancyInput>): Promise<BulkResult> {
  assertNotFuture(i.matingDate);
  await assertRam(i.ramId, i.matingDate);
  const c = ctx();
  if (i.herdId) await getHerdOrThrow(i.herdId);

  const targets = i.herdId
    ? await tx()
        .select()
        .from(animals)
        .where(and(eq(animals.herdId, i.herdId), eq(animals.sex, 'female'), eq(animals.category, 'ewe'), onFarm()))
    : await tx()
        .select()
        .from(animals)
        .where(and(eq(animals.farmId, c.farmId), inArray(animals.id, i.animalIds!)));

  const ids = targets.map((a) => a.id);
  const open = ids.length
    ? await tx()
        .select({ eweId: b.eweId })
        .from(b)
        .where(and(inArray(b.eweId, ids), eq(b.status, 'pregnant')))
    : [];
  const pregnant = new Set(open.map((r) => r.eweId));

  const skipped: BulkResult['skipped'] = [];
  const accepted: Animal[] = [];
  for (const a of targets) {
    const reason = !isOnFarm(a.status)
      ? 'ANIMAL_NOT_ON_FARM'
      : a.sex !== 'female'
        ? 'ANIMAL_NOT_FEMALE'
        : !canBreed(a, i.matingDate)
          ? 'ANIMAL_CANNOT_BREED'
          : pregnant.has(a.id)
            ? 'ALREADY_PREGNANT'
            : null;
    if (reason) skipped.push({ animalId: a.id, tag: a.tag, reason });
    else accepted.push(a);
  }
  if (accepted.length === 0) return { created: 0, skipped, inbreeding: [] };

  const gestations = new Map<string, Gestation>();
  for (const speciesId of new Set(accepted.map((a) => a.speciesId))) {
    gestations.set(speciesId, await gestationOf(speciesId));
  }
  await tx()
    .insert(b)
    .values(
      accepted.map((a) => ({
        tenantId: c.tenantId,
        farmId: c.farmId,
        createdBy: c.userId,
        eweId: a.id,
        ramId: i.ramId,
        source: i.source ?? 'mating',
        matingDate: i.matingDate,
        ...pregnancyDates(i.matingDate, gestations.get(a.speciesId)!),
        notes: i.notes,
      })),
    );
  const active = accepted.filter((a) => a.status === 'active').map((a) => a.id);
  if (active.length) await tx().update(animals).set({ status: 'pregnant' }).where(inArray(animals.id, active));

  let inbreeding: BulkResult['inbreeding'] = [];
  if (i.ramId) {
    const links = await parentLinks([i.ramId, ...accepted.map((a) => a.id)], INBREEDING_GENERATIONS);
    inbreeding = accepted
      .filter((a) => commonAncestors(links, a.id, i.ramId!, INBREEDING_GENERATIONS).length > 0)
      .map((a) => ({ animalId: a.id, tag: a.tag }));
  }
  await recordEvent({
    type: 'animal.pregnancies_recorded',
    entityType: i.herdId ? 'herd' : undefined,
    entityId: i.herdId,
    occurredAt: i.matingDate,
    severity: inbreeding.length ? 'attention' : 'info',
    data: { count: accepted.length, ramId: i.ramId, inbreeding: inbreeding.length },
  });
  return { created: accepted.length, skipped, inbreeding };
}

export async function listPregnancies(q: z.infer<typeof pregnancyListQuery>) {
  const c = ctx();
  const eweFilter =
    q.herdId || q.search
      ? inArray(
          b.eweId,
          tx()
            .select({ id: animals.id })
            .from(animals)
            .where(
              and(
                eq(animals.farmId, c.farmId),
                q.herdId ? eq(animals.herdId, q.herdId) : undefined,
                searchAny(q.search, [animals.tag]),
              ),
            ),
        )
      : undefined;
  // An ewe that left the farm is not expected to lamb here, whatever her record says.
  const stillHere =
    q.status === 'pregnant'
      ? inArray(b.eweId, tx().select({ id: animals.id }).from(animals).where(and(eq(animals.farmId, c.farmId), onFarm())))
      : undefined;
  const where = and(
    eq(b.farmId, c.farmId),
    q.status ? eq(b.status, q.status) : undefined,
    q.ramId ? eq(b.ramId, q.ramId) : undefined,
    q.expectedFrom ? gte(b.expectedDate, q.expectedFrom) : undefined,
    q.expectedTo ? lte(b.expectedDate, q.expectedTo) : undefined,
    eweFilter,
    stillHere,
  );
  const page = await paged(q, b, where, async (limit, offset) =>
    tx()
      .select({
        ...getTableColumns(b),
        eweTag: ewe.tag,
        eweStatus: ewe.status,
        herdId: ewe.herdId,
        herdName: herds.name,
        ramTag: ram.tag,
      })
      .from(b)
      .innerJoin(ewe, eq(ewe.id, b.eweId))
      .leftJoin(ram, eq(ram.id, b.ramId))
      .leftJoin(herds, eq(herds.id, ewe.herdId))
      .where(where)
      .orderBy(
        ...sortBy(
          q.sort,
          { matingDate: b.matingDate, expectedDate: b.expectedDate, status: b.status, tag: ewe.tag },
          asc(b.expectedDate),
          b.id,
        ),
      )
      .limit(limit)
      .offset(offset),
  );
  const now = today();
  return { ...page, data: page.data.map((r) => ({ ...r, daysToExpected: diffDays(now, r.expectedDate) })) };
}

export async function getPregnancy(id: string): Promise<BreedingRecord> {
  const [row] = await tx()
    .select()
    .from(b)
    .where(and(eq(b.id, id), eq(b.farmId, ctx().farmId)));
  if (!row) throw notFound('Pregnancy');
  return row;
}

async function getOpenPregnancy(id: string): Promise<BreedingRecord> {
  const row = await getPregnancy(id);
  if (row.status !== 'pregnant') throw conflict('PREGNANCY_NOT_OPEN', 'This pregnancy is already closed');
  return row;
}

export async function updatePregnancy(id: string, input: z.infer<typeof pregnancyUpdate>) {
  // The recalculated dates would otherwise make every update look like a change.
  if (Object.values(input).every((value) => value === undefined)) {
    throw badRequest('NOTHING_TO_UPDATE', 'No changes were sent');
  }
  const row = await getOpenPregnancy(id);
  const matingDate = input.matingDate ?? row.matingDate;
  assertNotFuture(matingDate);
  await assertRam(input.ramId, matingDate);
  const target = await getAnimalOrThrow(row.eweId);
  const [updated] = await tx()
    .update(b)
    .set({
      matingDate,
      ...pregnancyDates(matingDate, await gestationOf(target.speciesId)),
      ...(input.ramId !== undefined ? { ramId: input.ramId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    })
    .where(eq(b.id, id))
    .returning();
  return updated;
}

/** Return the ewe to active once her pregnancy is over. Sick or quarantined stay as they are. */
async function releaseEwe(eweId: string): Promise<void> {
  await tx()
    .update(animals)
    .set({ status: 'active' })
    .where(and(eq(animals.id, eweId), eq(animals.status, 'pregnant')));
}

/** The pregnancy ended without lambing: aborted, or she turned out not to be pregnant. */
export async function closePregnancy(id: string, input: z.infer<typeof closePregnancyInput>) {
  const row = await getOpenPregnancy(id);
  const [updated] = await tx()
    .update(b)
    .set({ status: input.status, notes: input.notes ?? row.notes })
    .where(eq(b.id, id))
    .returning();
  await releaseEwe(row.eweId);
  await recordEvent({
    type: `animal.pregnancy_${input.status}`,
    entityType: 'animal',
    entityId: row.eweId,
    severity: 'attention',
    data: { breedingId: id },
  });
  return updated;
}

/** Remove a pregnancy entered by mistake. */
export async function deletePregnancy(id: string) {
  const row = await getOpenPregnancy(id);
  await tx().delete(b).where(eq(b.id, id));
  await releaseEwe(row.eweId);
  await recordEvent({ type: 'animal.pregnancy_deleted', entityType: 'animal', entityId: row.eweId, data: { breedingId: id } });
  return { id };
}

// ─── Lambing ────────────────────────────────────────────────────────────────

export const lambInput = z.object({
  /** Client-generated animal id, for the offline outbox. */
  id: clientId,
  /** Generated from the mother's tag when left empty. */
  tag: z.string().trim().min(1).max(40).optional(),
  sex: z.enum(SEXES),
  birthWeightKg: z.number().positive().max(20).nullish(),
  alive: z.boolean().default(true),
});

export const lambingInput = z.object({
  id: clientId,
  eweId: z.uuid(),
  breedingId: z.uuid().nullish(),
  date: isoDate,
  /** Where the lambs go. Defaults to the mother's herd. */
  herdId: z.uuid().nullish(),
  lambs: z.array(lambInput).min(1).max(3),
  complications: z.string().trim().max(500).nullish(),
  notes,
});
export type LambingInput = z.infer<typeof lambingInput>;

export const lambingUpdate = z.object({ complications: z.string().trim().max(500).nullish(), notes });

export const lambingListQuery = listQuery.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  herdId: z.uuid().optional(),
});

/** "<mother's tag>-<yy>-<n>", skipping numbers already taken. */
async function nextLambTag(mother: Animal, date: string, used: Set<string>): Promise<string> {
  const prefix = `${mother.tag}-${date.slice(2, 4)}-`;
  const existing = await tx()
    .select({ tag: animals.tag })
    .from(animals)
    .where(and(eq(animals.tenantId, ctx().tenantId), eq(animals.damId, mother.id)));
  const taken = new Set([...existing.map((a) => a.tag), ...used]);
  for (let n = 1; ; n++) {
    const tag = `${prefix}${n}`;
    if (!taken.has(tag)) return tag;
  }
}

/** No ewe lambs twice this close together, so a second record is a repeat of the first. */
const MIN_DAYS_BETWEEN_LAMBINGS = 100;

async function assertNotJustLambed(eweId: string, date: string): Promise<void> {
  const [recent] = await tx()
    .select({ date: l.date })
    .from(l)
    .where(and(eq(l.eweId, eweId), gte(l.date, addDays(date, -MIN_DAYS_BETWEEN_LAMBINGS)), lte(l.date, addDays(date, MIN_DAYS_BETWEEN_LAMBINGS))))
    .limit(1);
  if (recent) {
    throw conflict('LAMBED_RECENTLY', `This ewe already has a lambing on ${recent.date}`, { date: recent.date });
  }
}

/**
 * Record a lambing (spec 8.2): live lambs become animals with mother and father set, their birth
 * weights go into the weight history, the pregnancy closes, and the ewe returns to active.
 * Stillborn lambs are counted on the record only: they never joined the herd.
 */
export async function recordLambing(i: LambingInput) {
  assertNotFuture(i.date);
  const mother = await getAnimalOrThrow(i.eweId, { lock: true });
  if (mother.sex !== 'female') throw badRequest('ANIMAL_NOT_FEMALE', `Animal ${mother.tag} is not a female`);
  // Up to the day she left is real, a ewe can die lambing. A phone working offline can still offer her later.
  if (!isOnFarm(mother.status) && (!mother.exitDate || i.date > mother.exitDate)) {
    throw conflict('ANIMAL_NOT_ON_FARM', `Animal ${mother.tag} is no longer on the farm`, { animalId: mother.id, status: mother.status });
  }
  assertCanBreed(mother, i.date);
  if (i.herdId) await getHerdOrThrow(i.herdId);
  await assertNotJustLambed(i.eweId, i.date);

  const pregnancy = i.breedingId ? await getOpenPregnancy(i.breedingId) : await openPregnancy(i.eweId);
  if (pregnancy) {
    if (pregnancy.eweId !== i.eweId) throw badRequest('PREGNANCY_MISMATCH', 'This pregnancy belongs to another ewe');
    if (i.date < pregnancy.matingDate) {
      throw badRequest('LAMBING_BEFORE_MATING', 'Lambing cannot be earlier than the mating date');
    }
  }

  const c = ctx();
  const usedTags = new Set<string>();
  const lambs: (typeof l.$inferInsert)['lambs'] = [];
  for (const lamb of i.lambs) {
    if (!lamb.alive) {
      lambs!.push({ sex: lamb.sex, birthWeightKg: lamb.birthWeightKg ?? null, alive: false, animalId: null, tag: null });
      continue;
    }
    const tag = lamb.tag ?? (await nextLambTag(mother, i.date, usedTags));
    usedTags.add(tag);
    // createAnimal also writes the birth weight into the weight history.
    const { id: animalId } = await createAnimal({
      id: lamb.id,
      tag,
      speciesId: mother.speciesId,
      breedId: mother.breedId,
      sex: lamb.sex,
      category: lamb.sex === 'male' ? 'lamb_male' : 'lamb_female',
      birthDate: i.date,
      origin: 'born',
      damId: mother.id,
      sireId: pregnancy?.ramId ?? null,
      herdId: i.herdId ?? mother.herdId,
      facilityId: mother.facilityId,
      birthWeightKg: lamb.birthWeightKg ?? null,
    });
    lambs!.push({ sex: lamb.sex, birthWeightKg: lamb.birthWeightKg ?? null, alive: true, animalId, tag });
  }

  const lambsAlive = i.lambs.filter((x) => x.alive).length;
  const [record] = await tx()
    .insert(l)
    .values({
      ...(i.id ? { id: i.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      breedingId: pregnancy?.id,
      eweId: i.eweId,
      date: i.date,
      lambsBorn: i.lambs.length,
      lambsAlive,
      lambs,
      complications: i.complications,
      notes: i.notes,
    })
    .returning();

  if (pregnancy) await tx().update(b).set({ status: 'lambed' }).where(eq(b.id, pregnancy.id));
  await releaseEwe(i.eweId);
  await recordEvent({
    type: 'animal.lambed',
    entityType: 'animal',
    entityId: i.eweId,
    occurredAt: i.date,
    severity: i.complications || lambsAlive < i.lambs.length ? 'attention' : 'info',
    data: { lambingId: record.id, lambsBorn: i.lambs.length, lambsAlive, complications: i.complications },
  });
  return record;
}

export async function listLambings(q: z.infer<typeof lambingListQuery>) {
  const c = ctx();
  const eweFilter =
    q.herdId || q.search
      ? inArray(
          l.eweId,
          tx()
            .select({ id: animals.id })
            .from(animals)
            .where(
              and(
                eq(animals.farmId, c.farmId),
                q.herdId ? eq(animals.herdId, q.herdId) : undefined,
                searchAny(q.search, [animals.tag]),
              ),
            ),
        )
      : undefined;
  const where = and(
    eq(l.farmId, c.farmId),
    q.from ? gte(l.date, q.from) : undefined,
    q.to ? lte(l.date, q.to) : undefined,
    eweFilter,
  );
  return paged(q, l, where, async (limit, offset) =>
    tx()
      .select({ ...getTableColumns(l), eweTag: ewe.tag, herdName: herds.name })
      .from(l)
      .innerJoin(ewe, eq(ewe.id, l.eweId))
      .leftJoin(herds, eq(herds.id, ewe.herdId))
      .where(where)
      .orderBy(...sortBy(q.sort, { date: l.date, lambsBorn: l.lambsBorn }, desc(l.date), l.id))
      .limit(limit)
      .offset(offset),
  );
}

export async function updateLambing(id: string, input: z.infer<typeof lambingUpdate>) {
  const [row] = await tx()
    .update(l)
    .set(input)
    .where(and(eq(l.id, id), eq(l.farmId, ctx().farmId)))
    .returning();
  if (!row) throw notFound('Lambing');
  return row;
}

// ─── Pedigree and inbreeding ────────────────────────────────────────────────

/** Spec 8.2: warn when ewe and ram share an ancestor within this many generations. */
export const INBREEDING_GENERATIONS = 3;

/** Walks up generation by generation, so the cost depends on the pedigree, not on the farm. */
async function parentLinks(roots: string[], generations: number): Promise<Map<string, ParentLinks>> {
  const links = new Map<string, ParentLinks>();
  let frontier = [...new Set(roots)];
  for (let level = 0; level <= generations && frontier.length > 0; level++) {
    const rows = await tx()
      .select({ id: animals.id, damId: animals.damId, sireId: animals.sireId })
      .from(animals)
      .where(and(eq(animals.farmId, ctx().farmId), inArray(animals.id, frontier)));
    const next: string[] = [];
    for (const row of rows) {
      links.set(row.id, { damId: row.damId, sireId: row.sireId });
      for (const parent of [row.damId, row.sireId]) if (parent && !links.has(parent)) next.push(parent);
    }
    frontier = [...new Set(next)];
  }
  return links;
}

export interface InbreedingCheck {
  related: boolean;
  common: { id: string; tag: string | null; distanceEwe: number; distanceRam: number }[];
}

/** A warning, not a block: the breeder decides (spec 8.2). */
export async function checkInbreeding(eweId: string, ramId: string): Promise<InbreedingCheck> {
  await getAnimalOrThrow(eweId);
  await getAnimalOrThrow(ramId);
  const links = await parentLinks([eweId, ramId], INBREEDING_GENERATIONS);
  const common = commonAncestors(links, eweId, ramId, INBREEDING_GENERATIONS);
  if (common.length === 0) return { related: false, common: [] };

  const tags = await tx()
    .select({ id: animals.id, tag: animals.tag })
    .from(animals)
    .where(inArray(animals.id, common.map((a) => a.id)));
  const tagOf = new Map(tags.map((t) => [t.id, t.tag]));
  return {
    related: true,
    common: common.map((a) => ({
      id: a.id,
      tag: tagOf.get(a.id) ?? null,
      distanceEwe: a.distanceA,
      distanceRam: a.distanceB,
    })),
  };
}

const pedigreeColumns = {
  id: animals.id,
  tag: animals.tag,
  sex: animals.sex,
  category: animals.category,
  status: animals.status,
  birthDate: animals.birthDate,
  damId: animals.damId,
  sireId: animals.sireId,
};

type PedigreeRow = { id: string; tag: string; sex: string; category: string; status: string; birthDate: string | null; damId: string | null; sireId: string | null };

export interface AncestorNode extends Omit<PedigreeRow, 'damId' | 'sireId'> {
  dam: AncestorNode | null;
  sire: AncestorNode | null;
}

export interface DescendantNode extends Omit<PedigreeRow, 'damId' | 'sireId'> {
  children: DescendantNode[];
}

const DESCENDANT_LEVELS = 2;
/** A ram can sire hundreds of lambs; the tree view does not need all of them. */
const DESCENDANT_LIMIT = 200;

/** Ancestors and descendants of an animal (spec 8.2). */
export async function pedigree(animalId: string, generations = 3) {
  const root = await getAnimalOrThrow(animalId);
  const farmId = ctx().farmId;

  const known = new Map<string, PedigreeRow>();
  let frontier = [animalId];
  for (let level = 0; level <= generations && frontier.length > 0; level++) {
    const rows = await tx()
      .select(pedigreeColumns)
      .from(animals)
      .where(and(eq(animals.farmId, farmId), inArray(animals.id, frontier)));
    const next: string[] = [];
    for (const row of rows) {
      known.set(row.id, row);
      for (const parent of [row.damId, row.sireId]) if (parent && !known.has(parent)) next.push(parent);
    }
    frontier = [...new Set(next)];
  }

  const ancestorNode = (id: string | null, depth: number): AncestorNode | null => {
    const row = id ? known.get(id) : undefined;
    if (!row) return null;
    const { damId, sireId, ...rest } = row;
    if (depth >= generations) return { ...rest, dam: null, sire: null };
    return { ...rest, dam: ancestorNode(damId, depth + 1), sire: ancestorNode(sireId, depth + 1) };
  };

  let truncated = false;
  const loadChildren = async (ids: string[], level: number): Promise<Map<string, DescendantNode[]>> => {
    const byParent = new Map<string, DescendantNode[]>();
    if (ids.length === 0 || level > DESCENDANT_LEVELS) return byParent;
    const rows = await tx()
      .select(pedigreeColumns)
      .from(animals)
      .where(and(eq(animals.farmId, farmId), or(inArray(animals.damId, ids), inArray(animals.sireId, ids))))
      .orderBy(asc(animals.birthDate), asc(animals.tag))
      .limit(DESCENDANT_LIMIT + 1);
    if (rows.length > DESCENDANT_LIMIT) {
      truncated = true;
      rows.pop();
    }
    const grandchildren = await loadChildren(rows.map((r) => r.id), level + 1);
    for (const { damId, sireId, ...rest } of rows) {
      const node = { ...rest, children: grandchildren.get(rest.id) ?? [] };
      for (const parent of [damId, sireId]) {
        if (parent && ids.includes(parent)) byParent.set(parent, [...(byParent.get(parent) ?? []), node]);
      }
    }
    return byParent;
  };

  const children = await loadChildren([animalId], 1);
  return {
    animal: ancestorNode(root.id, 0)!,
    descendants: children.get(animalId) ?? [],
    truncated,
  };
}
