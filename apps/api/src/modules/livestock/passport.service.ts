/** The two histories an animal's passport shows beside its card: breeding and veterinary. */
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { wasInHerdOn } from '@yap/shared/formulas/livestock';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { hideMoney, hidePii } from '../../core/privacy';
import { ewePerformance } from './breeding.summary';
import { getAnimalOrThrow, isOnFarm } from './refs';

const { animals, breedingRecords: b, employees, healthRecords: h, herdTransfers, herds, items, lambingRecords: l, vaccinationPlans: plans } = schema;
const ram = alias(animals, 'ram');

type Lamb = (typeof l.$inferSelect)['lambs'][number];

interface LambAnimal {
  id: string;
  tag: string;
  sireId: string | null;
  sireTag: string | null;
}

/** The registry rows of the lambs that became animals. A row deleted as a mistake is simply absent. */
async function lambAnimals(lambs: Lamb[]): Promise<Map<string, LambAnimal>> {
  const ids = lambs.flatMap((lamb) => (lamb.animalId ? [lamb.animalId] : []));
  if (ids.length === 0) return new Map();
  const rows = await tx()
    .select({ id: animals.id, tag: animals.tag, sireId: animals.sireId, sireTag: ram.tag })
    .from(animals)
    .leftJoin(ram, eq(ram.id, animals.sireId))
    .where(and(eq(animals.farmId, ctx().farmId), inArray(animals.id, ids)));
  return new Map(rows.map((row) => [row.id, row]));
}

/** Lambs whose fathers differ, or are not all known, name no ram. A stillborn lamb has no record to ask. */
function sharedSire(lambs: LambAnimal[]) {
  const [first, ...rest] = lambs;
  if (!first?.sireId || rest.some((lamb) => lamb.sireId !== first.sireId)) return { ramId: null, ramTag: null };
  return { ramId: first.sireId, ramTag: first.sireTag };
}

export async function animalBreeding(id: string) {
  await getAnimalOrThrow(id);
  const { farmId } = ctx();

  const matings = await tx()
    .select({
      id: b.id,
      source: b.source,
      matingDate: b.matingDate,
      expectedDate: b.expectedDate,
      status: b.status,
      ramId: b.ramId,
      ramTag: ram.tag,
      notes: b.notes,
    })
    .from(b)
    .leftJoin(ram, eq(ram.id, b.ramId))
    .where(and(eq(b.eweId, id), eq(b.farmId, farmId)))
    .orderBy(desc(b.matingDate), desc(b.id));

  const births = await tx()
    .select()
    .from(l)
    .where(and(eq(l.eweId, id), eq(l.farmId, farmId)))
    .orderBy(desc(l.date), desc(l.id));

  const registered = await lambAnimals(births.flatMap((birth) => birth.lambs));
  const performance = (await ewePerformance([id])).get(id)!;
  // PATCH /breeding/:id: the same access, and it refuses a pregnancy that has closed.
  const mayChange = hasPermission('livestock.update') || hasPermission('health.update');

  return {
    summary: { ...performance, lastLambingDate: births[0]?.date ?? null },
    matings: matings.map((mating) => {
      const birth = births.find((row) => row.breedingId === mating.id);
      return {
        ...mating,
        canSetRam: mayChange && mating.ramId === null && mating.source === 'mating' && mating.status === 'pregnant',
        lambing: birth ? { id: birth.id, date: birth.date, lambsBorn: birth.lambsBorn, lambsAlive: birth.lambsAlive } : null,
      };
    }),
    lambings: births.map((birth) => {
      const mating = matings.find((row) => row.id === birth.breedingId);
      const lambs = birth.lambs.map((lamb) => ({ lamb, animal: lamb.animalId ? registered.get(lamb.animalId) : undefined }));
      const sire = mating?.ramId
        ? { ramId: mating.ramId, ramTag: mating.ramTag }
        : sharedSire(lambs.flatMap(({ animal }) => (animal ? [animal] : [])));
      return {
        id: birth.id,
        breedingId: birth.breedingId,
        date: birth.date,
        lambsBorn: birth.lambsBorn,
        lambsAlive: birth.lambsAlive,
        complications: birth.complications,
        ...sire,
        lambs: lambs.map(({ lamb, animal }) => ({
          sex: lamb.sex,
          birthWeightKg: lamb.birthWeightKg ?? null,
          alive: lamb.alive,
          animalId: animal?.id ?? null,
          tag: animal?.tag ?? lamb.tag ?? null,
        })),
      };
    }),
  };
}

function healthRows(animalId: string, herdIds: string[]) {
  return tx()
    .select({
      id: h.id,
      animalId: h.animalId,
      herdId: h.herdId,
      itemId: h.itemId,
      planId: h.vaccinationPlanId,
      planName: plans.name,
      type: h.type,
      date: h.date,
      herdName: herds.name,
      diagnosis: h.diagnosis,
      itemName: items.name,
      itemUnit: items.unit,
      dose: h.dose,
      doseUnit: h.doseUnit,
      courseDays: h.courseDays,
      vetName: employees.fullName,
      result: h.result,
      withdrawalUntil: h.withdrawalUntil,
      nextDueDate: h.nextDueDate,
      reportStatus: h.reportStatus,
      endedOn: h.endedOn,
      notes: h.notes,
      totalCost: h.totalCost,
    })
    .from(h)
    .leftJoin(herds, eq(herds.id, h.herdId))
    .leftJoin(items, eq(items.id, h.itemId))
    .leftJoin(employees, eq(employees.id, h.vetEmployeeId))
    .leftJoin(plans, eq(plans.id, h.vaccinationPlanId))
    .where(
      and(
        eq(h.farmId, ctx().farmId),
        or(eq(h.animalId, animalId), herdIds.length ? and(isNull(h.animalId), inArray(h.herdId, herdIds)) : undefined),
      ),
    )
    .orderBy(desc(h.date), desc(h.id));
}

type HealthRow = Awaited<ReturnType<typeof healthRows>>[number];

/**
 * Only the newest record of each item and type speaks: a later dose answers an earlier reminder,
 * even if it set no date of its own. A date that has passed stays: that dose is still owed.
 * A quarantine keeps its planned end after it has ended. Plans without a product (a blood test)
 * are told apart by the plan, and each reminder names its plan.
 */
function nextDue(newestFirst: HealthRow[]) {
  const latest = new Map<string, HealthRow>();
  for (const row of newestFirst) {
    const key = !row.itemId && row.planId ? `plan|${row.planId}` : `${row.type}|${row.itemId}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  return [...latest.values()]
    .flatMap((row) =>
      row.nextDueDate && !row.endedOn
        ? [{ date: row.nextDueDate, type: row.type, itemName: row.itemName, ...(row.planName ? { planName: row.planName } : {}) }]
        : [],
    )
    .sort((x, y) => x.date.localeCompare(y.date));
}

export async function animalHealth(id: string) {
  const animal = await getAnimalOrThrow(id);

  const transfers = await tx()
    .select({ date: herdTransfers.date, fromHerdId: herdTransfers.fromHerdId, toHerdId: herdTransfers.toHerdId })
    .from(herdTransfers)
    .where(and(eq(herdTransfers.animalId, id), eq(herdTransfers.farmId, ctx().farmId)))
    .orderBy(asc(herdTransfers.date), asc(herdTransfers.id));
  const history = { ...animal, transfers };

  const everIn = [animal.herdId, ...transfers.flatMap((t) => [t.fromHerdId, t.toHerdId])].filter((herdId) => herdId !== null);
  const rows = await healthRows(id, everIn);
  const reached = rows.filter((row) => row.animalId !== null || wasInHerdOn(history, row.herdId!, row.date));

  const records = reached.map(({ animalId, herdId, itemId, planId, planName, totalCost, ...row }) => ({
    ...row,
    // Only a scheduled dose has a plan; the key is left out otherwise.
    ...(planName ? { planName } : {}),
    scope: animalId === null ? ('herd' as const) : ('animal' as const),
    // A herd row carries the cost of the whole herd, which says nothing about this animal.
    totalCost: animalId === null ? null : totalCost,
  }));

  return {
    // Nobody is going to vaccinate an animal that has left.
    nextDue: isOnFarm(animal.status) ? nextDue(reached) : [],
    records: hidePii(hideMoney(records, ['totalCost']), ['vetName']),
  };
}
