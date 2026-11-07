import { and, asc, desc, eq, getTableColumns, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  ANIMAL_CATEGORIES,
  ANIMAL_ON_FARM_STATUSES,
  ANIMAL_ORIGINS,
  ANIMAL_STATUSES,
  IDENTIFIER_TYPES,
  SEXES,
  addDays,
  averageDailyGain,
  diffDays,
} from '@yap/shared';
import { animalBookValue } from '@yap/shared/formulas/livestock';
import { MIN_BREEDING_AGE_DAYS } from '@yap/shared/formulas/reproduction';
import { schema } from '../../db/client';
import { canSeeMoney, ctx, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { resolveByDedupKey } from '../alerts/alerts.service';
import { signedFileUrl } from '../files';
import {
  accumulatedCostPerHead,
  assertInFarm,
  assertInTenant,
  assertNotFuture,
  carryingPregnancy,
  getAnimalOrThrow,
  isOnFarm,
  onFarm,
  type Animal,
} from './refs';
import { addWeight, weightHistory } from './weights.service';

export { herdHeadCount } from './refs';

const {
  animalExits,
  animalIdentifiers: identifiers,
  animals: t,
  breedingRecords,
  breeds,
  counterparties,
  facilities,
  healthRecords,
  herdTransfers,
  herds,
  species,
} = schema;

const identifierInput = z.object({
  type: z.enum(IDENTIFIER_TYPES),
  value: z.string().trim().min(1).max(60),
});

export const animalInput = z.object({
  id: clientId,
  tag: z.string().trim().min(1).max(40),
  speciesId: z.uuid(),
  breedId: z.uuid().nullish(),
  sex: z.enum(SEXES),
  category: z.enum(ANIMAL_CATEGORIES),
  birthDate: isoDate.nullish(),
  birthDateEstimated: z.boolean().optional(),
  origin: z.enum(ANIMAL_ORIGINS),
  damId: z.uuid().nullish(),
  sireId: z.uuid().nullish(),
  purchaseDate: isoDate.nullish(),
  purchasePrice: z.number().min(0).nullish(),
  sellerId: z.uuid().nullish(),
  herdId: z.uuid().nullish(),
  facilityId: z.uuid().nullish(),
  status: z.enum(ANIMAL_ON_FARM_STATUSES).optional(),
  /** First weight; stored as a weight record on the purchase or birth date. */
  currentWeightKg: z.number().positive().max(2000).nullish(),
  birthWeightKg: z.number().positive().max(200).nullish(),
  photoFileId: z.uuid().nullish(),
  notes: z.string().max(1000).nullish(),
  identifiers: z.array(identifierInput).max(10).optional(),
});
export type AnimalInput = z.infer<typeof animalInput>;

export const animalUpdate = animalInput
  .omit({ id: true, speciesId: true, origin: true, currentWeightKg: true, identifiers: true })
  .partial();

export const animalListQuery = listQuery.extend({
  herdId: z.uuid().optional(),
  status: z.enum(ANIMAL_STATUSES).optional(),
  category: z.enum(ANIMAL_CATEGORIES).optional(),
  sex: z.enum(SEXES).optional(),
  /** on_farm by default; `archived` holds sold, slaughtered, dead and lost animals. */
  scope: z.enum(['on_farm', 'archived', 'all']).default('on_farm'),
});

const FEMALE_ONLY = new Set(['ewe', 'lamb_female']);
const MALE_ONLY = new Set(['ram', 'lamb_male', 'wether']);

function assertSexMatchesCategory(sex: string, category: string): void {
  if ((sex === 'male' && FEMALE_ONLY.has(category)) || (sex === 'female' && MALE_ONLY.has(category))) {
    throw badRequest('CATEGORY_SEX_MISMATCH', 'This category does not match the sex', { sex, category });
  }
}

function assertOriginDetails(i: { origin: string; birthDate?: string | null; purchaseDate?: string | null }): void {
  // Herd movement reports count arrivals by these dates (spec 8.6).
  if (i.origin === 'born' && !i.birthDate) throw badRequest('BIRTH_DATE_REQUIRED', 'Enter the birth date');
  if (i.origin === 'purchased' && !i.purchaseDate) throw badRequest('PURCHASE_DATE_REQUIRED', 'Enter the purchase date');
}

async function assertParent(id: string | null | undefined, sex: 'female' | 'male', what: string): Promise<void> {
  if (!id) return;
  const [parent] = await tx()
    .select({ sex: t.sex })
    .from(t)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!parent) throw badRequest('INVALID_REFERENCE', `${what} was not found on this farm`, { field: what });
  if (parent.sex !== sex) throw badRequest('INVALID_PARENT', `${what} has the wrong sex`, { field: what });
}

async function assertRefs(i: Partial<AnimalInput>, selfId?: string): Promise<void> {
  if (selfId && (i.damId === selfId || i.sireId === selfId)) {
    throw badRequest('INVALID_PARENT', 'An animal cannot be its own parent');
  }
  await assertInTenant(species, i.speciesId, 'Species');
  await assertInTenant(breeds, i.breedId, 'Breed');
  await assertInFarm(herds, i.herdId, 'Herd');
  await assertInFarm(facilities, i.facilityId, 'Facility');
  await assertInFarm(counterparties, i.sellerId, 'Seller');
  await assertParent(i.damId, 'female', 'Dam');
  await assertParent(i.sireId, 'male', 'Sire');
}

async function assertIdentifierFree(type: string, value: string): Promise<void> {
  const [taken] = await tx()
    .select({ animalId: identifiers.animalId, tag: t.tag })
    .from(identifiers)
    .innerJoin(t, eq(t.id, identifiers.animalId))
    .where(and(eq(identifiers.tenantId, ctx().tenantId), eq(identifiers.type, type), eq(identifiers.value, value)));
  if (taken) {
    throw conflict('IDENTIFIER_TAKEN', `${value} already belongs to animal ${taken.tag}`, { value, tag: taken.tag });
  }
}

/**
 * Register an animal. Also the path used by lambing and Excel import.
 * The tag is mirrored into animal_identifiers so that one lookup covers every code.
 */
export async function createAnimal(input: AnimalInput): Promise<Animal> {
  const c = ctx();
  // A person who cannot read money cannot write it either, even by a crafted request.
  const i = canSeeMoney() ? input : { ...input, purchasePrice: null, sellerId: null };

  assertSexMatchesCategory(i.sex, i.category);
  assertOriginDetails(i);
  if (i.birthDate) assertNotFuture(i.birthDate);
  if (i.purchaseDate) assertNotFuture(i.purchaseDate);
  await assertRefs(i);

  const [tagTaken] = await tx()
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.tenantId, c.tenantId), eq(t.tag, i.tag)));
  if (tagTaken) throw conflict('TAG_TAKEN', `The tag ${i.tag} is already in use`, { tag: i.tag });
  await assertIdentifierFree('ear_tag', i.tag);
  for (const identifier of i.identifiers ?? []) await assertIdentifierFree(identifier.type, identifier.value);

  // A herd decides where the animal stands unless the form says otherwise.
  let facilityId = i.facilityId ?? null;
  if (!facilityId && i.herdId) {
    const [herd] = await tx().select({ facilityId: herds.facilityId }).from(herds).where(eq(herds.id, i.herdId));
    facilityId = herd?.facilityId ?? null;
  }

  const { id, identifiers: extra, currentWeightKg, ...values } = i;
  const [animal] = await tx()
    .insert(t)
    .values({
      ...(id ? { id } : {}),
      ...values,
      facilityId,
      birthDateEstimated: i.birthDateEstimated ?? false,
      status: i.status ?? 'active',
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
    })
    .returning();

  const rows = [{ type: 'ear_tag', value: i.tag }, ...(extra ?? [])];
  await tx()
    .insert(identifiers)
    .values(rows.map((r) => ({ ...r, animalId: animal.id, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })));

  const arrival = i.origin === 'born' ? i.birthDate : i.purchaseDate;
  if (i.birthWeightKg && i.birthDate) {
    await addWeight({ animal, date: i.birthDate, weightKg: i.birthWeightKg });
  }
  if (currentWeightKg) {
    // A bought animal is weighed on arrival. One born here is being weighed now, not at birth.
    await addWeight({ animal, date: i.origin === 'purchased' ? (i.purchaseDate ?? today()) : today(), weightKg: currentWeightKg });
  }

  await recordEvent({
    type: 'animal.registered',
    entityType: 'animal',
    entityId: animal.id,
    occurredAt: arrival ?? undefined,
    data: { tag: animal.tag, origin: animal.origin, category: animal.category },
  });
  return getAnimalOrThrow(animal.id);
}

export async function updateAnimal(id: string, input: z.infer<typeof animalUpdate>) {
  const current = await getAnimalOrThrow(id, { lock: true });
  if (!isOnFarm(current.status)) {
    throw conflict('ANIMAL_ARCHIVED', 'An animal that left the farm can no longer be changed');
  }

  const values: Partial<typeof t.$inferInsert> = { ...input };
  if (!canSeeMoney()) {
    delete values.purchasePrice;
    delete values.sellerId;
  }
  assertSexMatchesCategory(input.sex ?? current.sex, input.category ?? current.category);
  assertOriginDetails({
    origin: current.origin,
    birthDate: 'birthDate' in input ? input.birthDate : current.birthDate,
    purchaseDate: 'purchaseDate' in input ? input.purchaseDate : current.purchaseDate,
  });
  if (input.birthDate) assertNotFuture(input.birthDate);
  if (input.purchaseDate) assertNotFuture(input.purchaseDate);
  await assertRefs(input, id);

  if (input.tag && input.tag !== current.tag) {
    const [tagTaken] = await tx()
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.tenantId, current.tenantId), eq(t.tag, input.tag)));
    if (tagTaken) throw conflict('TAG_TAKEN', `The tag ${input.tag} is already in use`, { tag: input.tag });
    await assertIdentifierFree('ear_tag', input.tag);
    await tx()
      .update(identifiers)
      .set({ value: input.tag })
      .where(and(eq(identifiers.animalId, id), eq(identifiers.type, 'ear_tag'), eq(identifiers.value, current.tag)));
  }

  if (Object.keys(values).length === 0) throw badRequest('NOTHING_TO_UPDATE', 'No changes were sent');
  const [row] = await tx().update(t).set(values).where(eq(t.id, id)).returning();
  // A passport reads herd history from transfers, so a move on this form must leave one too.
  if (input.herdId !== undefined && input.herdId !== current.herdId) {
    const c = ctx();
    await tx().insert(herdTransfers).values({
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      animalId: id,
      fromHerdId: current.herdId,
      toHerdId: input.herdId,
      date: today(),
    });
    await recordEvent({ type: 'animal.transferred', entityType: 'animal', entityId: id, data: { count: 1 } });
  }
  return visible(row);
}

/** Only for an animal registered by mistake: records that matter block this through foreign keys. */
export async function removeAnimal(id: string) {
  const animal = await getAnimalOrThrow(id, { lock: true });
  await tx().delete(t).where(eq(t.id, id));
  await recordEvent({ type: 'animal.deleted', entityType: 'animal', entityId: id, data: { tag: animal.tag } });
  return { id };
}

export async function addIdentifier(animalId: string, input: z.infer<typeof identifierInput>) {
  const c = ctx();
  await getAnimalOrThrow(animalId);
  await assertIdentifierFree(input.type, input.value);
  const [row] = await tx()
    .insert(identifiers)
    .values({ ...input, animalId, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  return row;
}

export const identifierBody = identifierInput;

export async function removeIdentifier(animalId: string, identifierId: string) {
  const animal = await getAnimalOrThrow(animalId);
  const [row] = await tx()
    .select()
    .from(identifiers)
    .where(and(eq(identifiers.id, identifierId), eq(identifiers.animalId, animalId)));
  if (!row) throw notFound('Identifier');
  if (row.type === 'ear_tag' && row.value === animal.tag) {
    throw conflict('PRIMARY_TAG', 'The main ear tag cannot be removed. Change it on the animal instead.');
  }
  await tx().delete(identifiers).where(eq(identifiers.id, identifierId));
  return { id: identifierId };
}

function moneyFree<T extends { purchasePrice: number | null; sellerId: string | null }>(rows: T[]): T[] {
  return hideMoney(rows, ['purchasePrice', 'sellerId']);
}

/** One animal as the caller may see it. Every response carrying an animal row passes through this. */
export function visible<T extends { purchasePrice: number | null; sellerId: string | null }>(row: T): T {
  return moneyFree([row])[0];
}

const identifierValues = sql`(select string_agg(i.value, ' ') from animal_identifiers i where i.animal_id = ${t.id})`;

function scopeFilter(q: z.infer<typeof animalListQuery>): SQL | undefined {
  // The same head the summary counts, so a number and the list it opens agree.
  if (q.status === 'pregnant') return and(onFarm(), carryingPregnancy);
  if (q.status) return eq(t.status, q.status);
  if (q.scope === 'on_farm') return onFarm();
  if (q.scope === 'archived') return inArray(t.status, ['sold', 'slaughtered', 'dead', 'lost']);
  return undefined;
}

export async function listAnimals(q: z.infer<typeof animalListQuery>) {
  const where = and(
    eq(t.farmId, ctx().farmId),
    q.herdId ? eq(t.herdId, q.herdId) : undefined,
    q.category ? eq(t.category, q.category) : undefined,
    q.sex ? eq(t.sex, q.sex) : undefined,
    scopeFilter(q),
    searchAny(q.search, [t.tag, identifierValues]),
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select({ ...getTableColumns(t), herdName: herds.name, breedName: breeds.name })
      .from(t)
      .leftJoin(herds, eq(herds.id, t.herdId))
      .leftJoin(breeds, eq(breeds.id, t.breedId))
      .where(where)
      .orderBy(
        ...sortBy(
          q.sort,
          {
            tag: t.tag,
            birthDate: t.birthDate,
            category: t.category,
            status: t.status,
            currentWeightKg: t.currentWeightKg,
            lastWeighedOn: t.lastWeighedOn,
            createdAt: t.createdAt,
          },
          asc(t.tag),
          t.id,
        ),
      )
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: moneyFree(page.data) };
}

/** Id, tag and basics for dropdowns. Open to any signed-in role, so it carries no money. */
export async function lookupAnimals(q: {
  search?: string;
  sex?: (typeof SEXES)[number];
  category?: (typeof ANIMAL_CATEGORIES)[number];
  herdId?: string;
  forBreeding?: boolean;
}) {
  // The list a mating form offers: canBreed() as of today.
  const oldEnough = sql`coalesce(${t.birthDate} <= ${addDays(today(), -MIN_BREEDING_AGE_DAYS)}, ${t.category} not in ('lamb_male', 'lamb_female'))`;
  const rows = await tx()
    .select({ id: t.id, tag: t.tag, category: t.category, sex: t.sex, herdId: t.herdId })
    .from(t)
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        onFarm(),
        q.sex ? eq(t.sex, q.sex) : undefined,
        q.category ? eq(t.category, q.category) : undefined,
        q.herdId ? eq(t.herdId, q.herdId) : undefined,
        q.forBreeding ? and(ne(t.category, 'wether'), oldEnough) : undefined,
        searchAny(q.search, [t.tag, identifierValues]),
      ),
    )
    .orderBy(asc(t.tag))
    .limit(50);
  return rows.map((row) => ({ ...row, name: row.tag }));
}

/**
 * Resolve what a scanner or a person produced. Scanners send the exact value; people type "ya-0123",
 * or just "123" for YA-0123 because the number is what they read off the ear. The number only
 * counts if it points at one animal, so a typo cannot record a weight on the wrong sheep.
 */
export async function findByCode(code: string): Promise<Animal | null> {
  const farm = eq(t.farmId, ctx().farmId);

  const [exact] = await tx()
    .select({ animal: t })
    .from(t)
    .leftJoin(identifiers, eq(identifiers.animalId, t.id))
    .where(and(farm, or(eq(t.tag, code), eq(identifiers.value, code))))
    .limit(1);
  if (exact) return exact.animal;

  const [caseless] = await tx()
    .select()
    .from(t)
    .where(and(farm, sql`lower(${t.tag}) = lower(${code})`))
    .limit(1);
  if (caseless) return caseless;

  if (/^\d{1,12}$/.test(code)) {
    const matches = await tx()
      .select()
      .from(t)
      .where(and(farm, onFarm(), sql`substring(${t.tag} from '([0-9]{1,12})$')::bigint = ${code}::bigint`))
      .limit(2);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

export async function scan(code: string) {
  const animal = await findByCode(code);
  if (!animal) throw notFound('Animal');
  const [herd] = animal.herdId ? await tx().select({ name: herds.name }).from(herds).where(eq(herds.id, animal.herdId)) : [];
  return { ...visible(animal), herdName: herd?.name ?? null };
}

export async function getAnimalCard(id: string) {
  const fromHerd = alias(herds, 'from_herd');
  const toHerd = alias(herds, 'to_herd');
  const dam = alias(t, 'dam');
  const sire = alias(t, 'sire');

  const [row] = await tx()
    .select({
      ...getTableColumns(t),
      speciesName: species.name,
      speciesKey: species.key,
      breedName: breeds.name,
      herdName: herds.name,
      facilityName: facilities.name,
      damTag: dam.tag,
      sireTag: sire.tag,
      sellerName: counterparties.name,
    })
    .from(t)
    .leftJoin(species, eq(species.id, t.speciesId))
    .leftJoin(breeds, eq(breeds.id, t.breedId))
    .leftJoin(herds, eq(herds.id, t.herdId))
    .leftJoin(facilities, eq(facilities.id, t.facilityId))
    .leftJoin(dam, eq(dam.id, t.damId))
    .leftJoin(sire, eq(sire.id, t.sireId))
    .leftJoin(counterparties, eq(counterparties.id, t.sellerId))
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Animal');

  const ids = await tx()
    .select({ id: identifiers.id, type: identifiers.type, value: identifiers.value, active: identifiers.active })
    .from(identifiers)
    .where(eq(identifiers.animalId, id))
    .orderBy(asc(identifiers.type));

  const weights = await weightHistory(id);
  const last = weights.at(-1);
  const previous = weights.at(-2);
  const adg = last && previous ? averageDailyGain(last.weightKg, previous.weightKg, diffDays(previous.date, last.date)) : null;

  const transfers = await tx()
    .select({
      id: herdTransfers.id,
      date: herdTransfers.date,
      reason: herdTransfers.reason,
      fromHerdName: fromHerd.name,
      toHerdName: toHerd.name,
    })
    .from(herdTransfers)
    .leftJoin(fromHerd, eq(fromHerd.id, herdTransfers.fromHerdId))
    .leftJoin(toHerd, eq(toHerd.id, herdTransfers.toHerdId))
    .where(eq(herdTransfers.animalId, id))
    .orderBy(desc(herdTransfers.date));

  const [exit] = await tx().select().from(animalExits).where(eq(animalExits.animalId, id));
  const visibleExit = exit
    ? hideMoney([exit], ['pricePerKg', 'amount', 'lossAmount', 'transactionId', 'counterpartyId'])[0]
    : null;

  const [pregnancy] = await tx()
    .select({ id: breedingRecords.id, matingDate: breedingRecords.matingDate, expectedDate: breedingRecords.expectedDate })
    .from(breedingRecords)
    .where(and(eq(breedingRecords.eweId, id), eq(breedingRecords.status, 'pregnant')))
    .limit(1);

  const money = canSeeMoney();
  const accumulated = money ? await accumulatedCostPerHead(row.herdId) : null;

  return {
    ...row,
    purchasePrice: money ? row.purchasePrice : null,
    sellerId: money ? row.sellerId : null,
    sellerName: money ? row.sellerName : null,
    photoUrl: row.photoFileId ? await signedFileUrl(row.photoFileId) : null,
    identifiers: ids,
    weights,
    adgG: adg === null ? null : Math.round(adg * 1000),
    transfers,
    exit: visibleExit,
    pregnancy: pregnancy ?? null,
    cost: money
      ? {
          purchasePrice: row.purchasePrice,
          accumulatedPerHead: accumulated,
          bookValue: animalBookValue(row.purchasePrice, accumulated),
        }
      : null,
  };
}

export const sickDedupKey = (animalId: string) => `sick_report:${animalId}`;

/**
 * Take an animal off the farm. Every exit passes through here, whichever module started it,
 * so head counts stay right. The row stays: the registry is the animal's history.
 */
export async function markExited(
  animalId: string,
  status: 'sold' | 'slaughtered' | 'dead' | 'lost',
  date: string,
): Promise<void> {
  const animal = await getAnimalOrThrow(animalId, { lock: true });
  if (!isOnFarm(animal.status)) {
    throw conflict('ANIMAL_NOT_ON_FARM', `Animal ${animal.tag} is no longer on the farm`, { animalId, status: animal.status });
  }
  await tx().update(t).set({ status, exitDate: date, quarantineUntil: null }).where(eq(t.id, animalId));
  // An open pregnancy must leave the lambing calendar with the ewe.
  await tx()
    .update(breedingRecords)
    .set({ status: 'failed', notes: sql`coalesce(${breedingRecords.notes} || ' ', '') || ${`(${status} ${date})`}` })
    .where(and(eq(breedingRecords.eweId, animalId), eq(breedingRecords.status, 'pregnant')));
  // Nobody treats an animal that has left. Closed with no result, which undoing the exit relies on.
  await tx()
    .update(healthRecords)
    .set({ reportStatus: 'resolved', endedOn: date })
    .where(and(eq(healthRecords.animalId, animalId), eq(healthRecords.reportStatus, 'open')));
  await tx()
    .update(healthRecords)
    .set({ endedOn: date })
    .where(and(eq(healthRecords.animalId, animalId), eq(healthRecords.type, 'quarantine'), isNull(healthRecords.endedOn)));
  await resolveByDedupKey(sickDedupKey(animalId));
}

export const lookupQuery = z.object({
  search: z.string().trim().optional(),
  sex: z.enum(SEXES).optional(),
  category: z.enum(ANIMAL_CATEGORIES).optional(),
  herdId: z.uuid().optional(),
  forBreeding: z.stringbool().optional(),
});

export async function listSpecies() {
  const rows = await tx()
    .select({
      id: species.id,
      key: species.key,
      name: species.name,
      gestationDays: species.gestationDays,
    })
    .from(species)
    .where(and(eq(species.tenantId, ctx().tenantId), eq(species.active, true)))
    .orderBy(asc(species.key));
  const breedRows = await tx()
    .select({ id: breeds.id, key: breeds.key, name: breeds.name, speciesId: breeds.speciesId })
    .from(breeds)
    .where(and(eq(breeds.tenantId, ctx().tenantId), eq(breeds.active, true)));
  return rows.map((s) => ({ ...s, breeds: breedRows.filter((b) => b.speciesId === s.id) }));
}
