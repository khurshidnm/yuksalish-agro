/**
 * The year ahead on one page (spec 14): herd, feed, crops and money projected from the records.
 * The assistant reads this same result, so a forecast has one source and one set of figures.
 */
import { and, desc, eq, gte, notInArray, sql } from 'drizzle-orm';
import { FINANCE_SUMMARY_VIEW, addDays, monthOf, round, type Permission } from '@yap/shared';
import { feedClassOf, type FeedClass } from '@yap/shared/formulas/ai';
import { OUTLOOK_ASSUMPTIONS, feedCoverage, projectHerd, type HerdOutlookRow } from '@yap/shared/formulas/outlook';
import { schema } from '../../db/client';
import { canSeeMoney, ctx, hasPermission, today, tx } from '../../core/context';
import { monthsBetween } from '../finance/budget.service';
import { cashflowForecastDetail } from '../finance/summary';
import { feedBalance } from '../inventory/summary';
import { herdSummary } from '../livestock/summary';

const { breedingRecords, cropPlans, crops, harvests, items, prices, rationLines, rations, seasons } = schema;

const HORIZON_MONTHS = 12;
/** Months the flock grazes, and the share of its forage the pasture then replaces. */
const GRAZING_MONTHS = ['04', '05', '06', '07', '08', '09', '10'];
const PASTURE_SHARE = 0.5;
/**
 * Grazing replaces hay, straw and silage, never grain, cake or salt. Told by the feed itself, not its
 * crop: wheat gives both straw (forage) and feed grain (a concentrate that pasture does not replace).
 */
const PASTURE_REPLACES: FeedClass[] = ['roughage', 'succulent'];

function daysInMonth(month: string): number {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

function addMonths(month: string, n: number): string {
  const [year, m] = month.split('-').map(Number);
  const index = year * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

async function ewesDueByMonth(): Promise<Record<string, number>> {
  const rows = await tx()
    .select({ month: sql<string>`to_char(${breedingRecords.expectedDate}, 'YYYY-MM')`, ewes: sql<number>`count(*)`.mapWith(Number) })
    .from(breedingRecords)
    .where(and(eq(breedingRecords.farmId, ctx().farmId), eq(breedingRecords.status, 'pregnant')))
    .groupBy(sql`to_char(${breedingRecords.expectedDate}, 'YYYY-MM')`);
  return Object.fromEntries(rows.map((row) => [row.month, row.ewes]));
}

async function lambingWindow(): Promise<{ from: string | null; to: string | null }> {
  const [row] = await tx()
    .select({ from: sql<string | null>`min(${breedingRecords.expectedDate})::text`, to: sql<string | null>`max(${breedingRecords.expectedDate})::text` })
    .from(breedingRecords)
    .where(and(eq(breedingRecords.farmId, ctx().farmId), eq(breedingRecords.status, 'pregnant')));
  return row;
}

async function herdOutlook(months: string[]) {
  const { total: head, pregnant } = await herdSummary();
  const rows = projectHerd({ months, head, ewesDue: await ewesDueByMonth(), assumptions: OUTLOOK_ASSUMPTIONS });
  const lambsBorn = rows.reduce((sum, row) => sum + row.lambsBorn, 0);
  const lambsSold = rows.reduce((sum, row) => sum + row.lambsSold, 0);
  return {
    assumptions: OUTLOOK_ASSUMPTIONS,
    pregnant,
    lambing: await lambingWindow(),
    lambsBorn,
    lambsSold,
    lambsKept: rows[rows.length - 1]?.lambsOnFarm ?? 0,
    peakHead: rows.reduce((peak, row) => Math.max(peak, row.head), head),
    closingHead: rows[rows.length - 1]?.head ?? head,
    rows,
  };
}

interface RationNeed {
  itemId: string;
  state: string;
  kgPerHeadDay: number;
}

async function rationNeeds(): Promise<RationNeed[]> {
  return tx()
    .select({ itemId: rationLines.itemId, state: rations.state, kgPerHeadDay: rationLines.kgPerHeadDay })
    .from(rationLines)
    .innerJoin(rations, eq(rations.id, rationLines.rationId))
    .where(eq(rations.farmId, ctx().farmId));
}

/** First harvest of each crop in the last 14 months, a year on: when that feed next comes in. */
async function nextHarvestByCrop(now: string): Promise<Map<string, string>> {
  const rows = await tx()
    .select({ crop: crops.key, first: sql<string>`min(${harvests.date})::text` })
    .from(harvests)
    .innerJoin(cropPlans, eq(cropPlans.id, harvests.cropPlanId))
    .innerJoin(crops, eq(crops.id, cropPlans.cropId))
    .where(and(eq(harvests.farmId, ctx().farmId), gte(harvests.date, addDays(now, -425))))
    .groupBy(crops.key);
  return new Map(rows.map((row) => [row.crop, addMonths(monthOf(row.first), 12)]));
}

function kgInMonth(item: { itemId: string; forage: boolean }, needs: RationNeed[], row: HerdOutlookRow, days: number, adults: number): number {
  const perHead = (state: string) => needs.find((need) => need.itemId === item.itemId && need.state === state)?.kgPerHeadDay ?? 0;
  const resting = Math.max(0, adults - row.nursing);
  const daily = resting * perHead('pregnant') + row.nursing * perHead('lactating') + row.lambsOnFarm * perHead('lamb');
  const grazing = item.forage && GRAZING_MONTHS.includes(row.month.slice(5)) ? 1 - PASTURE_SHARE : 1;
  return daily * days * grazing;
}

async function feedOutlook(rows: HerdOutlookRow[], adults: number, now: string) {
  const balance = await feedBalance();
  const needs = await rationNeeds();
  const harvestsAhead = await nextHarvestByCrop(now);
  const itemRows = await tx()
    .select({ id: items.id, name: items.name, dryMatterPct: items.dryMatterPct, crop: crops.key })
    .from(items)
    .leftJoin(crops, eq(crops.id, items.cropId))
    .where(eq(items.farmId, ctx().farmId));
  const cropOf = new Map(itemRows.map((row) => [row.id, row.crop]));
  const forageItems = new Set(
    itemRows
      .filter((row) => {
        const feedClass = feedClassOf(row.name, row.dryMatterPct);
        return feedClass !== null && PASTURE_REPLACES.includes(feedClass);
      })
      .map((row) => row.id),
  );
  const firstMonth = monthOf(now);
  const daysLeft = daysInMonth(firstMonth) - Number(now.slice(8, 10)) + 1;

  return balance
    // Rations are in kilograms. Feed kept in bales has no weight to compare until one is entered.
    .filter((feed) => (feed.unit === 'kg' || feed.unit === 't') && needs.some((need) => need.itemId === feed.itemId))
    .map((feed) => {
      const crop = cropOf.get(feed.itemId) ?? null;
      const item = { itemId: feed.itemId, forage: forageItems.has(feed.itemId) };
      const monthly = rows.map((row) => ({
        month: row.month,
        kg: kgInMonth(item, needs, row, row.month === firstMonth ? daysLeft : daysInMonth(row.month), adults),
      }));
      const nextHarvest = crop ? (harvestsAhead.get(crop) ?? null) : null;
      const stockKg = feed.unit === 't' ? feed.stockQty * 1000 : feed.stockQty;
      const cover = feedCoverage(stockKg, monthly, nextHarvest);
      return {
        itemId: feed.itemId,
        name: feed.name,
        stockKg: round(stockKg, 0),
        ownCrop: crop !== null,
        nextHarvest,
        needKg: round(cover.needKg, 0),
        surplusKg: round(cover.surplusKg, 0),
        runsOutMonth: cover.runsOutMonth,
      };
    })
    .sort((a, b) => (a.runsOutMonth ?? '9999').localeCompare(b.runsOutMonth ?? '9999'));
}

/** What is in the ground or planned, beside what the same crop gave over the last year. */
async function cropOutlook() {
  const now = today();
  const planned = await tx()
    .select({
      key: crops.key,
      name: crops.name,
      areaHa: sql<number>`sum(${cropPlans.areaHa})`.mapWith(Number),
      expectedT: sql<number>`sum(${cropPlans.areaHa} * coalesce(${cropPlans.expectedYieldTHa}, 0))`.mapWith(Number),
    })
    .from(cropPlans)
    .innerJoin(crops, eq(crops.id, cropPlans.cropId))
    .innerJoin(seasons, eq(seasons.id, cropPlans.seasonId))
    .where(and(eq(cropPlans.farmId, ctx().farmId), gte(seasons.endDate, now), notInArray(cropPlans.status, ['harvested', 'cancelled'])))
    .groupBy(crops.key, crops.name);
  const harvested = await tx()
    .select({ key: crops.key, tons: sql<number>`sum(${harvests.grossT})`.mapWith(Number) })
    .from(harvests)
    .innerJoin(cropPlans, eq(cropPlans.id, harvests.cropPlanId))
    .innerJoin(crops, eq(crops.id, cropPlans.cropId))
    .where(and(eq(harvests.farmId, ctx().farmId), gte(harvests.date, addDays(now, -365))))
    .groupBy(crops.key);
  const lastYear = new Map(harvested.map((row) => [row.key, row.tons]));
  const rows = planned
    .map((row) => ({
      crop: row.key,
      name: row.name,
      areaHa: round(row.areaHa, 1),
      expectedT: row.expectedT > 0 ? round(row.expectedT, 1) : null,
      expectedYieldTHa: row.expectedT > 0 ? round(row.expectedT / row.areaHa, 1) : null,
      lastYearT: lastYear.has(row.key) ? round(lastYear.get(row.key)!, 1) : null,
    }))
    .sort((a, b) => b.areaHa - a.areaHa);
  return { rows, areaHa: round(rows.reduce((sum, row) => sum + row.areaHa, 0), 1) };
}

async function lambPricePerKg(): Promise<number | null> {
  const [row] = await tx()
    .select({ price: prices.price })
    .from(prices)
    .innerJoin(items, eq(items.id, prices.itemId))
    .where(and(eq(prices.farmId, ctx().farmId), eq(prices.kind, 'sale'), sql`${items.name} ilike '%qo''zi%'`))
    .orderBy(desc(prices.date))
    .limit(1);
  return row?.price ?? null;
}

async function moneyOutlook(lambsSold: number) {
  const forecast = await cashflowForecastDetail(HORIZON_MONTHS);
  const rows = forecast.rows.map(({ month, inflow, outflow, net, closing }) => ({ month, inflow, outflow, net, closing }));
  const planned = rows.filter((row) => !forecast.plannedThrough || row.month <= forecast.plannedThrough);
  const lowest = planned.reduce<(typeof rows)[number] | null>((low, row) => (!low || row.closing < low.closing ? row : low), null);
  const price = await lambPricePerKg();
  return {
    opening: forecast.opening,
    inflow: round(rows.reduce((sum, row) => sum + row.inflow, 0), 2),
    outflow: round(rows.reduce((sum, row) => sum + row.outflow, 0), 2),
    closing: rows[rows.length - 1]?.closing ?? forecast.opening,
    lowest: lowest ? { month: lowest.month, closing: lowest.closing } : null,
    firstNegativeMonth: forecast.firstNegativeMonth,
    lambPricePerKg: price,
    lambIncome: price === null ? null : round(lambsSold * OUTLOOK_ASSUMPTIONS.saleWeightKg * price, 0),
    rows,
  };
}

const may = (...permissions: Permission[]) => permissions.some((permission) => hasPermission(permission));

/** Each part appears only for a reader allowed to see it, and money stays behind rule 7. */
export async function outlook() {
  const now = today();
  const first = monthOf(now);
  const months = monthsBetween(first, addMonths(first, HORIZON_MONTHS - 1));
  const herd = await herdOutlook(months);
  const { total: adults } = await herdSummary();
  return {
    asOf: now,
    months,
    herd: may('livestock.view') ? herd : null,
    feed: may('feed.view', 'inventory.view') ? await feedOutlook(herd.rows, adults, now) : null,
    crops: may('crops.view') ? await cropOutlook() : null,
    money: canSeeMoney(FINANCE_SUMMARY_VIEW) ? await moneyOutlook(herd.lambsSold) : null,
  };
}

