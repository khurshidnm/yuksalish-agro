/**
 * Read-only facts for the assistant and the analyzers. Everything here runs inside asAi(), so
 * `tx()` is the read-only yap_ai transaction. Money appears only where the name says so, and
 * those functions are reachable only through tools marked `money`.
 */
import { and, asc, count, desc, eq, gte, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
import { addDays, round } from '@yap/shared';
import { canSeeMoney, ctx, today, tx } from '../../core/context';
import { COST_CREDIT_MOVEMENT_TYPES, COST_MOVEMENT_TYPES } from '../../core/inventory';
import { searchAny, sumOf } from '../../core/query';
import { schema } from '../../db/client';
import { mortality } from '../livestock/summary';
import { SUPERSEDED } from './insights.service';

const {
  aiInsights,
  animalExits,
  animalIdentifiers,
  animals,
  breedingRecords,
  breeds,
  cropPlans,
  crops,
  fields,
  financeCategories,
  healthRecords,
  herds,
  items,
  seasons,
  stockBatches,
  stockMovements,
  tasks,
  transactions,
} = schema;

const farmId = () => ctx().farmId;

/** Name in the Uzbek reference form; the assistant translates as it answers. */
const nameUz = (column: typeof crops.name | typeof breeds.name | typeof financeCategories.name) =>
  sql<string>`${column}->>'uz'`;

export async function lambingSchedule(from: string, to: string, limit = 100) {
  const where = and(
    eq(breedingRecords.farmId, farmId()),
    eq(breedingRecords.status, 'pregnant'),
    gte(breedingRecords.expectedDate, from),
    lte(breedingRecords.expectedDate, to),
  );
  const byDay = await tx()
    .select({ date: breedingRecords.expectedDate, ewes: count() })
    .from(breedingRecords)
    .where(where)
    .groupBy(breedingRecords.expectedDate)
    .orderBy(asc(breedingRecords.expectedDate));
  const ewes = await tx()
    .select({
      tag: animals.tag,
      expectedDate: breedingRecords.expectedDate,
      earliest: breedingRecords.expectedEarliest,
      latest: breedingRecords.expectedLatest,
      herd: herds.name,
    })
    .from(breedingRecords)
    .innerJoin(animals, eq(animals.id, breedingRecords.eweId))
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .where(where)
    .orderBy(asc(breedingRecords.expectedDate), asc(animals.tag))
    .limit(limit);
  return { total: byDay.reduce((sum, d) => sum + d.ewes, 0), byDay, ewes };
}

/** The herd module's figures, plus the reasons behind them. */
export async function mortalitySummary(days: number) {
  const from = addDays(today(), -(days - 1));
  const figures = await mortality(days);
  const reasons = await tx()
    .select({ reason: animalExits.reason, dead: count() })
    .from(animalExits)
    .where(and(eq(animalExits.farmId, farmId()), eq(animalExits.type, 'death'), gte(animalExits.date, from)))
    .groupBy(animalExits.reason)
    .orderBy(desc(count()));
  return { from, to: today(), ...figures, reasons };
}

export async function sickAnimals(limit = 100) {
  return tx()
    .select({ tag: animals.tag, status: animals.status, quarantineUntil: animals.quarantineUntil, herd: herds.name })
    .from(animals)
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .where(and(eq(animals.farmId, farmId()), inArray(animals.status, ['sick', 'quarantine'])))
    .orderBy(asc(animals.status), asc(animals.tag))
    .limit(limit);
}

/** One animal by ear tag or other identifier. Purchase price is never part of this. */
export async function animalFacts(tag: string) {
  const needle = tag.toLowerCase();
  const [animal] = await tx()
    .select({
      id: animals.id,
      tag: animals.tag,
      category: animals.category,
      sex: animals.sex,
      status: animals.status,
      birthDate: animals.birthDate,
      birthDateEstimated: animals.birthDateEstimated,
      origin: animals.origin,
      weightKg: animals.currentWeightKg,
      weighedOn: animals.lastWeighedOn,
      breed: nameUz(breeds.name),
      herd: herds.name,
    })
    .from(animals)
    .leftJoin(breeds, eq(breeds.id, animals.breedId))
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .leftJoin(animalIdentifiers, eq(animalIdentifiers.animalId, animals.id))
    .where(
      and(
        eq(animals.farmId, farmId()),
        or(eq(sql`lower(${animals.tag})`, needle), eq(sql`lower(${animalIdentifiers.value})`, needle)),
      ),
    )
    .limit(1);
  if (!animal) return null;

  const { id, ...facts } = animal;
  const [pregnancy] = await tx()
    .select({ expectedDate: breedingRecords.expectedDate, status: breedingRecords.status })
    .from(breedingRecords)
    .where(eq(breedingRecords.eweId, id))
    .orderBy(desc(breedingRecords.matingDate))
    .limit(1);
  const health = await tx()
    .select({
      type: healthRecords.type,
      date: healthRecords.date,
      diagnosis: healthRecords.diagnosis,
      withdrawalUntil: healthRecords.withdrawalUntil,
    })
    .from(healthRecords)
    .where(eq(healthRecords.animalId, id))
    .orderBy(desc(healthRecords.date))
    .limit(5);
  return { ...facts, pregnancy: pregnancy ?? null, health };
}

/** Quantities for anyone with stock access. `value` appears only for finance.view holders. */
export async function stockLevels(filter: { category?: string; search?: string }, limit = 100) {
  const rows = await tx()
    .select({
      name: items.name,
      category: items.category,
      unit: items.unit,
      minQty: items.minQty,
      qty: sumOf(stockBatches.qtyRemaining),
      value: sumOf(sql`${stockBatches.qtyRemaining} * ${stockBatches.unitCost}`),
    })
    .from(items)
    .leftJoin(stockBatches, eq(stockBatches.itemId, items.id))
    .where(
      and(
        eq(items.farmId, farmId()),
        eq(items.active, true),
        filter.category ? eq(items.category, filter.category) : undefined,
        searchAny(filter.search, [items.name]),
      ),
    )
    .groupBy(items.id)
    .orderBy(asc(items.category), asc(items.name))
    .limit(limit);

  const showValue = canSeeMoney();
  return rows.map(({ value, ...row }) => ({
    ...row,
    belowMinimum: row.minQty !== null && row.qty < row.minQty,
    ...(showValue ? { value: round(value, 2) } : {}),
  }));
}

export async function feedConsumption(from: string, to: string) {
  return tx()
    .select({ name: items.name, unit: items.unit, qty: sumOf(stockMovements.qty) })
    .from(stockMovements)
    .innerJoin(items, eq(items.id, stockMovements.itemId))
    .where(
      and(
        eq(stockMovements.farmId, farmId()),
        eq(stockMovements.type, 'issue'),
        eq(items.category, 'feed'),
        gte(stockMovements.date, from),
        lte(stockMovements.date, to),
      ),
    )
    .groupBy(items.id)
    .orderBy(desc(sumOf(stockMovements.qty)));
}

/**
 * "How much did we spend on feed?" has two honest answers (rule 3), so both are returned:
 * the value of feed consumed, and cash paid to buy feed in the period.
 */
export async function feedSpending(from: string, to: string) {
  const signedCost = sql`case when ${stockMovements.type} in ${COST_CREDIT_MOVEMENT_TYPES}
    then -${stockMovements.totalCost} else ${stockMovements.totalCost} end`;
  const byItem = await tx()
    .select({ name: items.name, unit: items.unit, qty: sumOf(stockMovements.qty), consumedValue: sumOf(signedCost) })
    .from(stockMovements)
    .innerJoin(items, eq(items.id, stockMovements.itemId))
    .where(
      and(
        eq(stockMovements.farmId, farmId()),
        inArray(stockMovements.type, [...COST_MOVEMENT_TYPES, ...COST_CREDIT_MOVEMENT_TYPES]),
        eq(items.category, 'feed'),
        gte(stockMovements.date, from),
        lte(stockMovements.date, to),
      ),
    )
    .groupBy(items.id)
    .orderBy(desc(sumOf(signedCost)));

  const [paid] = await tx()
    .select({ purchased: sumOf(transactions.amountBase) })
    .from(transactions)
    .innerJoin(financeCategories, eq(financeCategories.id, transactions.categoryId))
    .where(
      and(
        eq(transactions.farmId, farmId()),
        eq(transactions.status, 'approved'),
        eq(transactions.type, 'expense'),
        eq(financeCategories.key, 'feed'),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    );
  return {
    from,
    to,
    consumedValue: round(byItem.reduce((sum, row) => sum + row.consumedValue, 0), 2),
    purchased: paid.purchased,
    byItem,
  };
}

export async function fieldsOverview() {
  const [season] = await tx()
    .select({ id: seasons.id, name: seasons.name })
    .from(seasons)
    .where(and(eq(seasons.farmId, farmId()), eq(seasons.isCurrent, true)))
    .limit(1);

  const rows = await tx()
    .select({
      number: fields.number,
      name: fields.name,
      areaHa: fields.areaHa,
      crop: nameUz(crops.name),
      variety: cropPlans.variety,
      planStatus: cropPlans.status,
    })
    .from(fields)
    .leftJoin(
      cropPlans,
      and(eq(cropPlans.fieldId, fields.id), season ? eq(cropPlans.seasonId, season.id) : sql`false`),
    )
    .leftJoin(crops, eq(crops.id, cropPlans.cropId))
    .where(and(eq(fields.farmId, farmId()), eq(fields.landUse, 'arable'), eq(fields.status, 'active')))
    .orderBy(asc(fields.number));
  return { season: season?.name ?? null, fields: rows };
}

export async function overdueTasks(limit = 50) {
  return tx()
    .select({ title: tasks.title, dueDate: tasks.dueDate, priority: tasks.priority, status: tasks.status })
    .from(tasks)
    .where(
      and(eq(tasks.farmId, farmId()), inArray(tasks.status, ['open', 'in_progress']), lt(tasks.dueDate, today())),
    )
    .orderBy(asc(tasks.dueDate))
    .limit(limit);
}

export async function recentInsights(limit = 20) {
  return tx()
    .select({
      type: aiInsights.type,
      title: aiInsights.title,
      body: aiInsights.body,
      confidence: aiInsights.confidence,
      decision: aiInsights.decision,
      createdAt: aiInsights.createdAt,
    })
    .from(aiInsights)
    .where(
      and(
        eq(aiInsights.farmId, farmId()),
        // A retired finding was replaced by a later analysis: the assistant must not repeat it.
        ne(aiInsights.decision, SUPERSEDED),
        canSeeMoney() ? undefined : eq(aiInsights.containsMoney, false),
      ),
    )
    .orderBy(desc(aiInsights.createdAt))
    .limit(limit);
}

/** The farm's chosen current season, or the one whose dates contain today. */
export async function currentSeason() {
  const [season] = await tx()
    .select()
    .from(seasons)
    .where(
      and(
        eq(seasons.farmId, farmId()),
        or(eq(seasons.isCurrent, true), and(lte(seasons.startDate, today()), gte(seasons.endDate, today()))),
      ),
    )
    .orderBy(desc(seasons.isCurrent), desc(seasons.startDate))
    .limit(1);
  return season ?? null;
}
