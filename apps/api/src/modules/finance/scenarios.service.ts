/**
 * Three-year plans (formulas/scenario.ts): the farm's own figures to start one from, the model run
 * for a set of assumptions, and plans saved under a name.
 *
 * The baseline gives one figure per assumption, with where it came from, and `null` where the farm
 * has no record: a guess would read as the farm's own number (rule 5). The app's stated starting
 * values go out apart, as `suggestions`, each marked `source: 'default'`. Everything in it is an
 * average or a total, so a person holding only finance.summary may read it: no journal row,
 * account or counterparty.
 */
import { and, asc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { addDays, monthOf, monthRange, round } from '@yap/shared';
import { feedCostPerHeadDay } from '@yap/shared/formulas/kpi';
import { OUTLOOK_ASSUMPTIONS } from '@yap/shared/formulas/outlook';
import { lambsPerEwe } from '@yap/shared/formulas/reproduction';
import {
  EWE_LAMB_SHARE,
  SCENARIO_DEFAULTS,
  SCENARIO_MONTHS,
  runScenario,
  scenarioMonthAt,
  type ScenarioAssumptionKey,
  type ScenarioAssumptions,
} from '@yap/shared/formulas/scenario';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoMonth, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { feedingPlanWithCosts } from '../feed/balance.service';
import { calendar as lambingPlan } from '../livestock/breeding.summary';
import { herdSummary, reproductionKpis } from '../livestock/summary';
import { cashPosition, operatingCostByMonth, type Bucket } from './summary';

const { animalExits, animals, lambingRecords, scenarios: t, transactions } = schema;

// ─── Input ─────────────────────────────────────────────────────────────────

const MAX_MONEY = 1e13;
const head = z.number().min(0).max(1e7).nullable();
const share = z.number().min(0).max(1).nullable();
const money = z.number().min(0).max(MAX_MONEY).nullable();
const calendarMonth = z.number().int().min(1).max(12);

/** Every assumption may be left empty: the figures that rest on it then come back null. */
export const assumptionsInput = z.object({
  startMonth: isoMonth,
  openingEwes: head,
  openingRams: head,
  openingReplacements: head,
  openingLambs: head,
  lambingMonth: calendarMonth.nullable(),
  lambingShare: share,
  lambsPerEweLambing: z.number().min(0).max(5).nullable(),
  lambSurvival: share,
  eweDeathsPerYear: share,
  eweCullsPerYear: share,
  replacementShare: share,
  firstLambingAgeMonths: z.number().int().min(1).max(60).nullable(),
  saleAgeMonths: z.number().int().min(1).max(36).nullable(),
  saleWeightKg: z.number().min(0).max(500).nullable(),
  pricePerKg: money,
  cullEwePrice: money,
  feedAdultStallPerMonth: money,
  feedAdultGrazingPerMonth: money,
  feedLambPerMonth: money,
  otherCostPerHeadPerMonth: money,
  fixedCostPerMonth: money,
  openingCash: z.number().min(-MAX_MONEY).max(MAX_MONEY).nullable(),
  stallMonths: z.array(calendarMonth).max(12).nullable(),
  oneOffs: z
    .array(z.object({ month: z.number().int().min(0).max(SCENARIO_MONTHS - 1), amount: z.number().min(0).max(MAX_MONEY) }))
    .max(50),
}) satisfies z.ZodType<ScenarioAssumptions>;

export const scenarioInput = z.object({
  id: clientId,
  name: z.string().trim().min(1).max(120),
  assumptions: assumptionsInput,
  notes: z.string().trim().max(1000).nullish(),
});
export type ScenarioInput = z.infer<typeof scenarioInput>;

export const scenarioListQuery = listQuery;

// ─── The model ─────────────────────────────────────────────────────────────

/** Stateless: the figures for one set of assumptions. Nothing is read from the farm and nothing stored. */
export function compute(assumptions: ScenarioAssumptions) {
  return runScenario(assumptions);
}

// ─── The farm's own figures ────────────────────────────────────────────────

/** Where a baseline figure came from. `default` is never among them: suggestions carry that. */
export type BaselineSource = 'animals' | 'lambings' | 'scans' | 'pregnancies' | 'sales' | 'costs' | 'rations' | 'accounts';

interface Origin {
  source: BaselineSource;
  /** The counts behind the figure, so a person can judge how much it rests on. */
  basis: Record<string, number | string>;
}

const HISTORY_MONTHS = 12;
const HISTORY_DAYS = 365;
/** An average month, for turning a ration's cost per day into a cost per month. */
const DAYS_PER_MONTH = 365 / 12;
/** A ration with one of these purposes feeds young stock (feed/balance.service). */
const YOUNG_STOCK_RATIONS = ['lamb', 'fattening'];
/** Sold for meat when grown: everything that is neither a ewe nor a ram. */
const SALE_LAMB_CATEGORIES = ['lamb_male', 'lamb_female', 'wether', 'fattening'];
/** Cost groups charged per head in the plan. Feed is priced from rations; the rest is taken as fixed. */
const PER_HEAD_BUCKETS: Bucket[] = ['vet'];
const FEED_BUCKET: Bucket = 'feed';

const emptyAssumptions = (startMonth: string): ScenarioAssumptions => ({
  startMonth,
  openingEwes: null,
  openingRams: null,
  openingReplacements: null,
  openingLambs: null,
  lambingMonth: null,
  lambingShare: null,
  lambsPerEweLambing: null,
  lambSurvival: null,
  eweDeathsPerYear: null,
  eweCullsPerYear: null,
  replacementShare: null,
  firstLambingAgeMonths: null,
  saleAgeMonths: null,
  saleWeightKg: null,
  pricePerKg: null,
  cullEwePrice: null,
  feedAdultStallPerMonth: null,
  feedAdultGrazingPerMonth: null,
  feedLambPerMonth: null,
  otherCostPerHeadPerMonth: null,
  fixedCostPerMonth: null,
  openingCash: null,
  stallMonths: null,
  oneOffs: [],
});

/** The commonest calendar month among dated counts; the earlier month wins a tie. Null with nothing to count. */
function busiestMonth(rows: { date: string; n: number }[]): number | null {
  const byMonth = new Map<number, number>();
  for (const row of rows) {
    const month = Number(row.date.slice(5, 7));
    byMonth.set(month, (byMonth.get(month) ?? 0) + row.n);
  }
  let best: number | null = null;
  for (const [month, n] of [...byMonth].sort(([a], [b]) => a - b)) {
    if (n > 0 && (best === null || n > byMonth.get(best)!)) best = month;
  }
  return best;
}

/**
 * Approved animal sales of the last 12 months, in the farm's currency. A sale counts once its
 * money is approved (rule 6); one document's money is shared between its animals as the document did.
 */
async function animalSales(since: string, until: string, categories: string[]) {
  const amountBase = sql`${animalExits.amount} * ${transactions.amountBase} / nullif(${transactions.amount}, 0)`;
  const [row] = await tx()
    .select({
      head: sql<number>`count(*)`.mapWith(Number),
      amount: sql`coalesce(sum(${amountBase}), 0)`.mapWith(Number),
      weighedHead: sql<number>`count(${animalExits.liveWeightKg})`.mapWith(Number),
      weighedKg: sql`coalesce(sum(${animalExits.liveWeightKg}), 0)`.mapWith(Number),
      weighedAmount: sql`coalesce(sum(${amountBase}) filter (where ${animalExits.liveWeightKg} is not null), 0)`.mapWith(Number),
    })
    .from(animalExits)
    .innerJoin(animals, eq(animals.id, animalExits.animalId))
    .innerJoin(transactions, eq(transactions.id, animalExits.transactionId))
    .where(
      and(
        eq(animalExits.farmId, ctx().farmId),
        eq(animalExits.type, 'sale'),
        eq(transactions.status, 'approved'),
        isNotNull(animalExits.amount),
        inArray(animals.category, categories),
        gte(animalExits.date, since),
        lte(animalExits.date, until),
      ),
    );
  return row;
}

/** Lambing days on record, for the month the flock lambs in when no ewe is carrying now. */
async function lambingDays() {
  return tx()
    .select({ date: lambingRecords.date, n: sql<number>`count(*)`.mapWith(Number) })
    .from(lambingRecords)
    .where(eq(lambingRecords.farmId, ctx().farmId))
    .groupBy(lambingRecords.date);
}

/**
 * Operating cost of the last 12 whole months, as an average month. A farm younger than that is
 * averaged over the months since its first cost on record, not over twelve: three months of
 * spending spread over a year would show a quarter of what the farm costs. Null with no whole
 * month of cost on record.
 */
async function monthlyCosts(asOf: string) {
  const current = monthOf(asOf);
  const first = scenarioMonthAt(current, -HISTORY_MONTHS);
  const last = scenarioMonthAt(current, -1);
  const rows = await operatingCostByMonth(monthRange(first).from, monthRange(last).to);
  if (rows.length === 0) return null;
  const from = rows[0].month;
  let months = 0;
  while (scenarioMonthAt(from, months) <= last) months++;
  const total = (bucket: Bucket) => rows.reduce((sum, row) => sum + row.buckets[bucket], 0);
  const buckets = Object.keys(rows[0].buckets) as Bucket[];
  const perMonth = Object.fromEntries(buckets.map((bucket) => [bucket, round(total(bucket) / months, 2)])) as Record<Bucket, number>;
  return {
    from,
    to: last,
    months,
    perMonth,
    total: round(rows.reduce((sum, row) => sum + row.total, 0) / months, 2),
    perHead: PER_HEAD_BUCKETS.reduce((sum, bucket) => sum + total(bucket), 0) / months,
    fixed: buckets.filter((b) => b !== FEED_BUCKET && !PER_HEAD_BUCKETS.includes(b)).reduce((sum, bucket) => sum + total(bucket), 0) / months,
  };
}

/**
 * What the rations fed today cost per head per month, grown sheep and young stock apart. A group
 * is null when it has no herd on a ration, or when one of its herds has a ration that cannot be
 * priced: an average over the herds that can would look real and be wrong.
 *
 * Bought feed only. The fixed cost beside it holds what the farm spent growing its own feed (seed,
 * fuel, water, wages), so pricing that feed here again would count it twice (rule 3).
 */
async function rationCosts() {
  const { herds } = await feedingPlanWithCosts({ ownProduce: 'left_out' });
  const group = (young: boolean) => {
    const fed = herds.filter((herd) => herd.head > 0 && (herd.rationState !== null && YOUNG_STOCK_RATIONS.includes(herd.rationState)) === young);
    if (fed.length === 0 || fed.some((herd) => herd.costPerDay === null)) return null;
    const headCount = fed.reduce((sum, herd) => sum + herd.head, 0);
    const perDay = feedCostPerHeadDay(fed.reduce((sum, herd) => sum + herd.costPerDay!, 0), headCount);
    return perDay === null ? null : { perMonth: round(perDay * DAYS_PER_MONTH, 2), head: headCount, herds: fed.length };
  };
  return { adult: group(false), young: group(true) };
}

export async function baseline() {
  const asOf = today();
  const startMonth = monthOf(asOf);
  const a = emptyAssumptions(startMonth);
  const sources: Partial<Record<ScenarioAssumptionKey, Origin>> = {};
  const set = <K extends Exclude<ScenarioAssumptionKey, 'stallMonths'>>(key: K, value: number, origin: Origin) => {
    a[key] = value;
    sources[key] = origin;
  };

  // The flock, from the animals on the farm today. A farm with no animals has nothing to state.
  const herd = await herdSummary();
  const ofCategory = (category: string) => herd.byCategory[category] ?? 0;
  const ewes = ofCategory('ewe');
  if (herd.total > 0) {
    const origin: Origin = { source: 'animals', basis: { head: herd.total } };
    set('openingEwes', ewes, origin);
    set('openingRams', ofCategory('ram'), origin);
    set('openingReplacements', ofCategory('lamb_female'), origin);
    set('openingLambs', ofCategory('lamb_male') + ofCategory('wether') + ofCategory('fattening'), origin);
  }

  // Lambing: the farm's own lambings first, then what its ewes carry now.
  const repro = await reproductionKpis();
  const due = await lambingPlan({ from: addDays(asOf, -HISTORY_DAYS), to: addDays(asOf, HISTORY_DAYS) });
  const history = await lambingDays();
  const dueMonth = busiestMonth(due.days.map((day) => ({ date: day.date, n: day.expected })));
  const pastMonth = busiestMonth(history);
  if (dueMonth !== null) set('lambingMonth', dueMonth, { source: 'pregnancies', basis: { ewes: due.totalEwes } });
  else if (pastMonth !== null) set('lambingMonth', pastMonth, { source: 'lambings', basis: { lambings: repro.lambings } });

  if (repro.ewesWithOutcome > 0 && repro.lambings > 0) {
    set('lambingShare', Math.min(1, repro.lambings / repro.ewesWithOutcome), {
      source: 'lambings',
      basis: { lambings: repro.lambings, ewes: repro.ewesWithOutcome },
    });
  } else if (ewes > 0 && due.totalEwes > 0) {
    set('lambingShare', Math.min(1, due.totalEwes / ewes), { source: 'pregnancies', basis: { pregnant: due.totalEwes, ewes } });
  }

  const ownLambsPerEwe = lambsPerEwe(repro.lambsBorn, repro.lambings);
  if (ownLambsPerEwe !== null) {
    set('lambsPerEweLambing', ownLambsPerEwe, { source: 'lambings', basis: { lambs: repro.lambsBorn, lambings: repro.lambings } });
  } else if (due.scannedEwes > 0) {
    set('lambsPerEweLambing', due.scannedFetuses / due.scannedEwes, {
      source: 'scans',
      basis: { fetuses: due.scannedFetuses, ewes: due.scannedEwes },
    });
  }
  if (repro.survivalPercent !== null) set('lambSurvival', repro.survivalPercent / 100, { source: 'lambings', basis: {} });

  // Prices, from sales whose money is approved.
  const since = addDays(asOf, -HISTORY_DAYS);
  const lambSales = await animalSales(since, asOf, SALE_LAMB_CATEGORIES);
  if (lambSales.weighedHead > 0 && lambSales.weighedKg > 0) {
    const basis = { head: lambSales.weighedHead, kg: round(lambSales.weighedKg, 2), since };
    set('saleWeightKg', round(lambSales.weighedKg / lambSales.weighedHead, 2), { source: 'sales', basis });
    set('pricePerKg', round(lambSales.weighedAmount / lambSales.weighedKg, 2), { source: 'sales', basis });
  }
  const eweSales = await animalSales(since, asOf, ['ewe']);
  if (eweSales.head > 0) {
    set('cullEwePrice', round(eweSales.amount / eweSales.head, 2), { source: 'sales', basis: { head: eweSales.head, since } });
  }

  // Costs: feed from the rations fed today, the rest from what the farm spent.
  const rations = await rationCosts();
  const stallNow = (SCENARIO_DEFAULTS.stallMonths as readonly number[]).includes(Number(startMonth.slice(5)));
  const adultKey = stallNow ? 'feedAdultStallPerMonth' : 'feedAdultGrazingPerMonth';
  if (rations.adult) {
    set(adultKey, rations.adult.perMonth, { source: 'rations', basis: { head: rations.adult.head, herds: rations.adult.herds } });
  }
  if (rations.young) {
    set('feedLambPerMonth', rations.young.perMonth, { source: 'rations', basis: { head: rations.young.head, herds: rations.young.herds } });
  }
  const costs = await monthlyCosts(asOf);
  if (costs) {
    const basis = { months: costs.months, from: costs.from, to: costs.to };
    set('fixedCostPerMonth', round(costs.fixed, 2), { source: 'costs', basis });
    if (herd.total > 0) set('otherCostPerHeadPerMonth', round(costs.perHead / herd.total, 2), { source: 'costs', basis: { ...basis, head: herd.total } });
  }

  // Cash: the approved balance of every account together. No account, no figure.
  const cash = await cashPosition();
  if (cash.accounts.length > 0) set('openingCash', cash.total, { source: 'accounts', basis: { accounts: cash.accounts.length } });

  // The app's own starting values, apart from the farm's figures and only where the farm has none.
  const suggestions: Partial<Record<ScenarioAssumptionKey, { value: number | number[]; source: 'default' }>> = {};
  const suggest = (key: ScenarioAssumptionKey, value: number | number[]) => {
    if (a[key] === null) suggestions[key] = { value, source: 'default' };
  };
  suggest('lambsPerEweLambing', OUTLOOK_ASSUMPTIONS.lambsPerEwe);
  suggest('lambSurvival', OUTLOOK_ASSUMPTIONS.survival);
  suggest('eweDeathsPerYear', SCENARIO_DEFAULTS.eweDeathsPerYear);
  suggest('eweCullsPerYear', SCENARIO_DEFAULTS.eweCullsPerYear);
  // The outlook keeps a share of all lambs; here the share is of the ewe lambs, who are half of them.
  suggest('replacementShare', OUTLOOK_ASSUMPTIONS.keepShare / EWE_LAMB_SHARE);
  suggest('firstLambingAgeMonths', SCENARIO_DEFAULTS.firstLambingAgeMonths);
  suggest('saleAgeMonths', OUTLOOK_ASSUMPTIONS.monthsToSale);
  suggest('saleWeightKg', OUTLOOK_ASSUMPTIONS.saleWeightKg);
  suggest('stallMonths', [...SCENARIO_DEFAULTS.stallMonths]);
  // One season is known from today's rations; the other is offered at the stated share of it.
  if (rations.adult && stallNow) suggest('feedAdultGrazingPerMonth', round(rations.adult.perMonth * SCENARIO_DEFAULTS.grazingFeedShare, 2));
  if (rations.adult && !stallNow) suggest('feedAdultStallPerMonth', round(rations.adult.perMonth / SCENARIO_DEFAULTS.grazingFeedShare, 2));

  return {
    asOf,
    startMonth,
    assumptions: a,
    sources,
    suggestions,
    /** The average month of spending the cost figures were taken from, by group. Feed is shown, not used: rations price it. */
    costGroups: costs ? { from: costs.from, to: costs.to, months: costs.months, perMonth: costs.perMonth, total: costs.total } : null,
  };
}

// ─── Saved plans ───────────────────────────────────────────────────────────

export async function list(q: z.infer<typeof scenarioListQuery>) {
  const where = and(eq(t.farmId, ctx().farmId), searchAny(q.search, [t.name]));
  return paged(q, t, where, (limit, offset) =>
    tx()
      .select()
      .from(t)
      .where(where)
      .orderBy(...sortBy(q.sort, { name: t.name, createdAt: t.createdAt, updatedAt: t.updatedAt }, asc(t.name), t.id))
      .limit(limit)
      .offset(offset),
  );
}

export async function get(id: string) {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Scenario');
  return row;
}

export async function create(input: ScenarioInput) {
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({ type: 'scenario.created', entityType: 'scenario', entityId: row.id, data: { name: row.name } });
  return row;
}

export async function update(id: string, input: Partial<ScenarioInput>) {
  await get(id);
  const { id: _id, ...values } = input;
  const [row] = await tx()
    .update(t)
    .set(values)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)))
    .returning();
  await recordEvent({ type: 'scenario.updated', entityType: 'scenario', entityId: id, data: { name: row.name } });
  return row;
}

export async function remove(id: string) {
  const row = await get(id);
  await tx().delete(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  await recordEvent({ type: 'scenario.deleted', entityType: 'scenario', entityId: id, data: { name: row.name } });
  return { id };
}
