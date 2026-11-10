/**
 * Feed balance (spec 9.3, 25.1): how long stock lasts, by plan and by actual consumption.
 * All planning arithmetic is in kg, because rations are. Stock and consumption are reported
 * in the item's own unit, as the storekeeper counts them.
 */
import { addDays, feedDays, feedDaysByActual, hectaresForShortage, round, winterFeedBalance, ANIMAL_ON_FARM_STATUSES } from '@yap/shared';
import { ACTUAL_CONSUMPTION_WINDOW_DAYS, averageDailyConsumption, kgPerUnit } from '@yap/shared/formulas/feed';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { hideMoney } from '../../core/privacy';
import { sumOf } from '../../core/query';
import { unitCostsPerKg } from './rations.service';

const { animals, cropPlans, crops, herds, items, rationLines, rations, seasons, stockBatches, stockMovements } = schema;

const LAMB_CATEGORIES = ['lamb_male', 'lamb_female'];
/** Rations meant for young stock. Every other ration is for grown sheep. */
const YOUNG_STOCK_RATIONS = ['lamb', 'fattening'];

interface HerdHead {
  /** Every animal of the herd on the farm today. */
  all: number;
  lambs: number;
}

/** Animals on the farm per herd today, and the lambs among them. */
async function headByHerd(): Promise<Map<string, HerdHead>> {
  const rows = await tx()
    .select({
      herdId: animals.herdId,
      head: count(),
      lambs: sql<number>`count(*) filter (where ${inArray(animals.category, LAMB_CATEGORIES)})`.mapWith(Number),
    })
    .from(animals)
    .where(
      and(
        eq(animals.farmId, ctx().farmId),
        inArray(animals.status, [...ANIMAL_ON_FARM_STATUSES]),
        isNotNull(animals.herdId),
      ),
    )
    .groupBy(animals.herdId);
  return new Map(rows.map((r) => [r.herdId!, { all: r.head, lambs: r.lambs }]));
}

/**
 * Head that eat a herd's ration. Lambs born into a ewes' herd suckle their mothers, so an adult ration
 * is not fed to them; once weaned they belong in a lamb or fattening herd, whose ration counts everyone.
 */
function eatersOf(herd: { rationState: string | null }, head: HerdHead | undefined): { eating: number; lambsLeftOut: number } {
  if (!head) return { eating: 0, lambsLeftOut: 0 };
  if (herd.rationState !== null && YOUNG_STOCK_RATIONS.includes(herd.rationState)) return { eating: head.all, lambsLeftOut: 0 };
  return { eating: head.all - head.lambs, lambsLeftOut: head.lambs };
}

async function activeHerds() {
  return tx()
    .select({
      herdId: herds.id,
      herdName: herds.name,
      state: herds.state,
      rationId: herds.rationId,
      rationName: rations.name,
      rationState: rations.state,
    })
    .from(herds)
    .leftJoin(rations, eq(rations.id, herds.rationId))
    .where(and(eq(herds.farmId, ctx().farmId), eq(herds.status, 'active')))
    .orderBy(asc(herds.name));
}

async function rationLinesFor(rationIds: string[]) {
  if (rationIds.length === 0) return [];
  return tx()
    .select({
      rationId: rationLines.rationId,
      itemId: rationLines.itemId,
      itemName: items.name,
      unit: items.unit,
      kgPerHeadDay: rationLines.kgPerHeadDay,
    })
    .from(rationLines)
    .innerJoin(items, eq(items.id, rationLines.itemId))
    .where(inArray(rationLines.rationId, rationIds))
    .orderBy(desc(rationLines.kgPerHeadDay));
}

/** Planned daily feeding per herd: ration × head count (spec 9.3). */
export async function feedingPlan() {
  const plan = await feedingPlanWithCosts();
  return { herds: hideMoney(plan.herds, ['costPerDay'], 'feed.approve'), withoutRation: plan.withoutRation };
}

/**
 * The same plan with every herd's cost, whoever asks. Only for a caller that gives out an average
 * over the flock and never a herd's own figure (the scenario baseline, read with finance.summary).
 * `ownProduce: 'left_out'` prices bought feed only (rations.service unitCostsPerKg).
 */
export async function feedingPlanWithCosts(opts: { ownProduce?: 'left_out' } = {}) {
  const [herdRows, head] = [await activeHerds(), await headByHerd()];
  const rationIds = [...new Set(herdRows.flatMap((h) => (h.rationId ? [h.rationId] : [])))];
  const lines = await rationLinesFor(rationIds);
  const costs = await unitCostsPerKg([...new Set(lines.map((l) => l.itemId))], opts);

  const plan = herdRows
    .filter((h) => h.rationId)
    .map((herd) => {
      const { eating: headCount, lambsLeftOut } = eatersOf(herd, head.get(herd.herdId));
      const own = lines
        .filter((l) => l.rationId === herd.rationId)
        .map(({ rationId: _rationId, ...line }) => ({ ...line, dailyKg: round(line.kgPerHeadDay * headCount, 3) }));
      const priced = own.length > 0 && own.every((l) => costs.has(l.itemId));
      return {
        herdId: herd.herdId,
        herdName: herd.herdName,
        state: herd.state,
        head: headCount,
        /** Suckling lambs in the herd, not fed its ration. */
        lambs: lambsLeftOut,
        rationId: herd.rationId!,
        rationName: herd.rationName,
        /** What the ration is for: 'lamb' and 'fattening' feed young stock, the rest grown sheep. */
        rationState: herd.rationState,
        lines: own,
        dailyKg: round(own.reduce((sum, l) => sum + l.dailyKg, 0), 3),
        costPerDay: priced ? round(own.reduce((sum, l) => sum + l.dailyKg * costs.get(l.itemId)!, 0), 2) : null,
      };
    });

  return {
    herds: plan,
    // Without a ration a herd is invisible to every "days left" figure, so name it.
    withoutRation: herdRows
      .filter((h) => !h.rationId && (head.get(h.herdId)?.all ?? 0) > 0)
      .map((h) => ({ herdId: h.herdId, herdName: h.herdName, head: head.get(h.herdId)?.all ?? 0 })),
  };
}

export interface FeedConsumer {
  kgPerHeadPerDay: number;
  head: number;
}

/** Everyone eating each item today, from herds' rations. */
async function consumersByItem(): Promise<Map<string, FeedConsumer[]>> {
  const [herdRows, head] = [await activeHerds(), await headByHerd()];
  const assigned = herdRows.filter((h) => h.rationId && eatersOf(h, head.get(h.herdId)).eating > 0);
  const lines = await rationLinesFor([...new Set(assigned.map((h) => h.rationId!))]);
  const result = new Map<string, FeedConsumer[]>();
  for (const herd of assigned) {
    for (const line of lines.filter((l) => l.rationId === herd.rationId)) {
      const list = result.get(line.itemId) ?? [];
      list.push({ kgPerHeadPerDay: line.kgPerHeadDay, head: eatersOf(herd, head.get(herd.herdId)).eating });
      result.set(line.itemId, list);
    }
  }
  return result;
}

async function stockByItem(itemIds: string[]): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx()
    .select({ itemId: stockBatches.itemId, qty: sumOf(stockBatches.qtyRemaining) })
    .from(stockBatches)
    .where(and(eq(stockBatches.farmId, ctx().farmId), inArray(stockBatches.itemId, itemIds)))
    .groupBy(stockBatches.itemId);
  return new Map(rows.map((r) => [r.itemId, r.qty]));
}

/** Issues per item and day. A sale is stock leaving, not feed eaten. */
async function feedIssuesByDay(from: string, to: string) {
  return tx()
    .select({
      itemId: stockMovements.itemId,
      unit: items.unit,
      kgPerUnit: items.kgPerUnit,
      date: stockMovements.date,
      qty: sumOf(stockMovements.qty),
    })
    .from(stockMovements)
    .innerJoin(items, eq(items.id, stockMovements.itemId))
    .where(
      and(
        eq(stockMovements.farmId, ctx().farmId),
        eq(stockMovements.type, 'issue'),
        // Sold or spoiled feed left the store but nobody ate it, so it says nothing about how fast it goes.
        notInArray(stockMovements.reason, ['sale', 'write_off']),
        eq(items.category, 'feed'),
        gte(stockMovements.date, from),
        lte(stockMovements.date, to),
      ),
    )
    .groupBy(stockMovements.itemId, items.unit, items.kgPerUnit, stockMovements.date);
}

export interface FeedBalanceRow {
  itemId: string;
  name: string;
  unit: string;
  stockQty: number;
  /** Per day, in the item's unit. Null when there is no plan or the unit has no known weight. */
  plannedDaily: number | null;
  /** Per day, in the item's unit, over the last days of real issues. Null without issues. */
  actualDaily: number | null;
  daysByPlan: number | null;
  daysByActual: number | null;
  /** The headline figure: by actual when known, otherwise by plan (spec 24.1). */
  days: number | null;
  basis: 'actual' | 'plan' | null;
  /** Calendar days the actual average covers. */
  actualDaysCovered: number | null;
  minDays: number;
  belowMinimum: boolean;
}

export async function feedBalance(): Promise<FeedBalanceRow[]> {
  const c = ctx();
  const feeds = await tx()
    .select({
      id: items.id,
      name: items.name,
      unit: items.unit,
      kgPerUnit: items.kgPerUnit,
      minQty: items.minQty,
      minDays: items.minDays,
    })
    .from(items)
    .where(and(eq(items.farmId, c.farmId), eq(items.active, true), eq(items.category, 'feed')))
    .orderBy(asc(items.name));

  const ids = feeds.map((f) => f.id);
  const stock = await stockByItem(ids);
  const consumers = await consumersByItem();
  const now = today();
  const issues = await feedIssuesByDay(addDays(now, -ACTUAL_CONSUMPTION_WINDOW_DAYS), now);

  return feeds.map((feed) => {
    const stockQty = stock.get(feed.id) ?? 0;
    const kg = kgPerUnit(feed.unit, feed.kgPerUnit);
    const eaters = consumers.get(feed.id) ?? [];

    const stockKg = kg === null ? null : stockQty * kg;
    const planDays = stockKg === null ? null : feedDays(stockKg, eaters);
    const plannedKg = eaters.reduce((sum, e) => sum + e.kgPerHeadPerDay * e.head, 0);
    const plannedDaily = kg === null || plannedKg === 0 ? null : plannedKg / kg;

    const actual = averageDailyConsumption(
      issues.filter((i) => i.itemId === feed.id).map((i) => ({ date: i.date, qty: i.qty })),
      now,
    );
    const actualDays = actual ? feedDaysByActual(stockQty, actual.avgDaily) : null;

    const days = actualDays ?? planDays;
    const minDays = feed.minDays ?? c.settings.feed.minStockDays;
    const belowMinimum = (days !== null && days < minDays) || (feed.minQty !== null && stockQty < feed.minQty);

    return {
      itemId: feed.id,
      name: feed.name,
      unit: feed.unit,
      stockQty,
      plannedDaily: plannedDaily === null ? null : round(plannedDaily, 3),
      actualDaily: actual ? round(actual.avgDaily, 3) : null,
      daysByPlan: planDays === null ? null : round(planDays, 1),
      daysByActual: actualDays === null ? null : round(actualDays, 1),
      days: days === null ? null : round(days, 1),
      basis: actualDays !== null ? 'actual' : planDays !== null ? 'plan' : null,
      actualDaysCovered: actual?.days ?? null,
      minDays,
      belowMinimum,
    };
  });
}

/** Total feed issued per day in kg, for charts. Days with no issues are real zeros. */
export async function feedConsumption(days: number): Promise<{ date: string; qty: number }[]> {
  const now = today();
  const from = addDays(now, 1 - days);
  const rows = await feedIssuesByDay(from, now);
  const byDate = new Map<string, number>();
  for (const row of rows) {
    const kg = kgPerUnit(row.unit, row.kgPerUnit);
    if (kg !== null) byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.qty * kg);
  }
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(from, i);
    return { date, qty: round(byDate.get(date) ?? 0, 3) };
  });
}

export const winterPlanQuery = z.object({
  days: z.coerce.number().int().min(1).max(366).optional(),
  /** What-if: plan for this many head on this ration instead of the current herds. */
  rationId: z.uuid().optional(),
  head: z.coerce.number().int().min(1).max(1_000_000).optional(),
});

/** Yield to plan with for a crop: the latest plan on record, or the tenant's default. */
async function expectedYields(cropIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (cropIds.length === 0) return result;
  const defaults = await tx()
    .select({ id: crops.id, value: crops.defaultYieldTHa })
    .from(crops)
    .where(and(eq(crops.tenantId, ctx().tenantId), inArray(crops.id, cropIds)));
  for (const crop of defaults) {
    const parsed = Number(crop.value);
    if (crop.value && parsed > 0) result.set(crop.id, parsed);
  }
  const planned = await tx()
    .selectDistinctOn([cropPlans.cropId], { cropId: cropPlans.cropId, value: cropPlans.expectedYieldTHa })
    .from(cropPlans)
    .innerJoin(seasons, eq(seasons.id, cropPlans.seasonId))
    .where(
      and(
        eq(cropPlans.farmId, ctx().farmId),
        inArray(cropPlans.cropId, cropIds),
        isNotNull(cropPlans.expectedYieldTHa),
      ),
    )
    .orderBy(cropPlans.cropId, desc(seasons.startDate));
  for (const row of planned) if (row.value) result.set(row.cropId, row.value);
  return result;
}

export interface WinterPlanRow {
  itemId: string;
  name: string;
  unit: string;
  requiredKg: number;
  stockKg: number | null;
  shortageKg: number | null;
  surplusKg: number | null;
  dailyKg: number;
  /** Days the current stock covers at this rate. */
  coverageDays: number | null;
  /** When stock runs out if feeding starts today. */
  runsOutOn: string | null;
  unitCostPerKg: number | null;
  purchaseCost: number | null;
  cropId: string | null;
  cropName: { uz: string; ru: string; en: string } | null;
  yieldTHa: number | null;
  hectares: number | null;
}

/**
 * Winter feed requirement (spec 9.3): head × winter days × ration, against stock.
 * A shortage is priced as a purchase and, for feed the farm can grow, turned into hectares.
 */
export async function winterPlan(q: z.infer<typeof winterPlanQuery>) {
  const c = ctx();
  const days = q.days ?? c.settings.feed.winterDays;
  const scenario = q.rationId !== undefined || q.head !== undefined;

  let consumers: Map<string, FeedConsumer[]>;
  let totalHead: number;
  if (scenario) {
    if (!q.rationId || !q.head) throw badRequest('SCENARIO_INCOMPLETE', 'A what-if plan needs both a ration and a head count');
    const [ration] = await tx()
      .select({ id: rations.id })
      .from(rations)
      .where(and(eq(rations.id, q.rationId), eq(rations.farmId, c.farmId)));
    if (!ration) throw notFound('Ration');
    const lines = await rationLinesFor([q.rationId]);
    consumers = new Map(lines.map((l) => [l.itemId, [{ kgPerHeadPerDay: l.kgPerHeadDay, head: q.head! }]]));
    totalHead = q.head;
  } else {
    consumers = await consumersByItem();
    const head = await headByHerd();
    const herdRows = await activeHerds();
    totalHead = herdRows.filter((h) => h.rationId).reduce((sum, h) => sum + eatersOf(h, head.get(h.herdId)).eating, 0);
  }

  const itemIds = [...consumers.keys()];
  const feeds = itemIds.length
    ? await tx()
        .select({
          id: items.id,
          name: items.name,
          unit: items.unit,
          kgPerUnit: items.kgPerUnit,
          cropId: items.cropId,
          cropName: crops.name,
        })
        .from(items)
        .leftJoin(crops, eq(crops.id, items.cropId))
        .where(and(eq(items.farmId, c.farmId), inArray(items.id, itemIds)))
        .orderBy(asc(items.name))
    : [];
  const stock = await stockByItem(itemIds);
  const costs = await unitCostsPerKg(itemIds);
  const yields = await expectedYields([...new Set(feeds.flatMap((f) => (f.cropId ? [f.cropId] : [])))]);
  const now = today();

  const rows: WinterPlanRow[] = feeds.map((feed) => {
    const eaters = consumers.get(feed.id) ?? [];
    const dailyKg = eaters.reduce((sum, e) => sum + e.kgPerHeadPerDay * e.head, 0);
    const kg = kgPerUnit(feed.unit, feed.kgPerUnit);
    const stockKg = kg === null ? null : (stock.get(feed.id) ?? 0) * kg;
    const requiredKg = dailyKg * days;
    // dailyKg already sums every herd, so the whole farm counts as one consumer here.
    const balance = stockKg === null ? null : winterFeedBalance({ head: 1, days, kgPerHeadPerDay: dailyKg, stockKg });
    const unitCostPerKg = costs.get(feed.id) ?? null;
    const coverageDays = stockKg === null || dailyKg === 0 ? null : stockKg / dailyKg;
    const yieldTHa = feed.cropId ? (yields.get(feed.cropId) ?? null) : null;
    return {
      itemId: feed.id,
      name: feed.name,
      unit: feed.unit,
      requiredKg: round(requiredKg, 3),
      stockKg: stockKg === null ? null : round(stockKg, 3),
      shortageKg: balance ? round(balance.shortageKg, 3) : null,
      surplusKg: balance ? round(balance.surplusKg, 3) : null,
      dailyKg: round(dailyKg, 3),
      coverageDays: coverageDays === null ? null : round(coverageDays, 1),
      runsOutOn: coverageDays === null ? null : addDays(now, Math.floor(coverageDays)),
      unitCostPerKg,
      purchaseCost: balance && unitCostPerKg !== null ? round(balance.shortageKg * unitCostPerKg, 2) : null,
      cropId: feed.cropId,
      cropName: feed.cropName,
      yieldTHa,
      hectares:
        balance && balance.shortageKg > 0 && yieldTHa !== null ? round(hectaresForShortage(balance.shortageKg, yieldTHa) ?? 0, 2) : null,
    };
  });

  const short = rows.filter((r) => (r.shortageKg ?? 0) > 0);
  const unpriced = short.some((r) => r.purchaseCost === null);
  const totals = {
    requiredKg: round(rows.reduce((sum, r) => sum + r.requiredKg, 0), 3),
    shortageKg: round(short.reduce((sum, r) => sum + (r.shortageKg ?? 0), 0), 3),
    /** Null when a short feed has no price: a partial total would read as the whole bill. */
    purchaseCost: unpriced ? null : round(short.reduce((sum, r) => sum + (r.purchaseCost ?? 0), 0), 2),
    shortItems: short.length,
  };

  return {
    days,
    head: totalHead,
    basis: scenario ? ('scenario' as const) : ('herds' as const),
    rows: hideMoney(rows, ['unitCostPerKg', 'purchaseCost'], 'feed.approve'),
    totals: hideMoney([totals], ['purchaseCost'], 'feed.approve')[0],
  };
}
