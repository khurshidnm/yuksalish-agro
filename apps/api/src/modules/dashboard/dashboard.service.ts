/**
 * The dashboard of spec 14.1: one screen, built only from the modules' summary functions, so no
 * figure here can disagree with the module it came from. Blocks a reader may not see are left out
 * of the response, not sent and hidden. Inside a block, a part the reader may not see is left out
 * too, while null keeps its usual meaning of "not enough data".
 */
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  FINANCE_SUMMARY_VIEW,
  addDays,
  budgetYearMonths,
  budgetYearOf,
  monthOf,
  monthRange,
  round,
  type Module,
  type Permission,
  type RoleKey,
} from '@yap/shared';
import { averageDailyConsumption } from '@yap/shared/formulas/feed';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { counts as alertCounts } from '../alerts/alerts.service';
import { openAlerts } from '../alerts/summary';
import { assetStatus, fuelUsage } from '../assets/summary';
import { fieldStatus, harvestPlanFact, overdueOperations } from '../crops/summary';
import { eventFeed } from '../devices/devices.service';
import { forecast } from '../farm/weather.service';
import { capitalTiles } from '../finance/advances.service';
import { budgetExecution, cashPosition, cashflowForecastDetail, debtSummary, monthToDate } from '../finance/summary';
import { attendanceToday } from '../hr/summary';
import { feedBalance, feedConsumption, lowStock } from '../inventory/summary';
import { calendar as lambingCalendar } from '../livestock/breeding.summary';
import { herdSummary, mortality, weightTrend } from '../livestock/summary';
import { taskSummary } from '../tasks/summary';
import { AGGREGATES, enabledModules, holdsAny, isolate, limitingFeed, type Block } from './blocks';

const LIST_LIMIT = 5;
const ALERT_LIMIT = 8;
const LOW_STOCK_LIMIT = 8;
const BUDGET_OVERRUN_LIMIT = 3;
const FORECAST_MONTHS = 3;
const FEED_CONSUMPTION_DAYS = 14;
const WEATHER_DAYS = 7;
const FUEL_DAYS = 30;
const MORTALITY_DAYS = 30;
const WEIGHT_MONTHS = 6;

async function loadFinance() {
  const now = today();
  const month = monthOf(now);
  const { from, to } = monthRange(month);

  const income = await monthToDate(month);
  const cash = await cashPosition();
  const debts = await debtSummary();
  const budgetMonth = await budgetExecution(from, to);
  // The budget year, as on the budget page (October to September), through this month: the months
  // begun, against what they spent. A calendar year would set September's barn against a budget
  // that starts in October, and December's plan against nothing yet.
  const yearFrom = budgetYearMonths(budgetYearOf(now)).from;
  const budgetYear = await budgetExecution(yearFrom, to);
  const forecasted = await cashflowForecastDetail(FORECAST_MONTHS);

  const totals = ({ planned, actual, deviation, percent }: typeof budgetMonth) => ({ planned, actual, deviation, percent });
  return {
    month: income,
    // finance.summary is aggregated figures: the total, not the accounts behind it (rule 7).
    cash: hasPermission('finance.view') ? cash : { total: cash.total, accounts: [] },
    // The owner's own money put in, and cash in people's hands (docs/cash-holders.md).
    capital: hasPermission('finance.view') ? await capitalTiles() : null,
    debts,
    budget: {
      month: totals(budgetMonth),
      year: totals(budgetYear),
      /** First month of the budget year in `year`, YYYY-MM. */
      yearFrom,
      overruns: budgetYear.rows
        .filter((row) => row.deviation > 0)
        .sort((a, b) => b.deviation - a.deviation)
        .slice(0, BUDGET_OVERRUN_LIMIT),
    },
    forecast: {
      method: forecasted.method,
      lowConfidence: forecasted.lowConfidence,
      firstNegativeMonth: forecasted.firstNegativeMonth,
      months: forecasted.rows.map(({ month: m, inflow, outflow, net, closing, negative }) => ({
        month: m,
        inflow,
        outflow,
        net,
        closing,
        negative,
      })),
    },
  };
}

async function loadLivestock() {
  const herd = await herdSummary();
  const plan = await lambingCalendar({});
  const deaths = await mortality(MORTALITY_DAYS);
  const weights = await weightTrend(WEIGHT_MONTHS);

  const within7Days = addDays(today(), 7);
  return {
    ...herd,
    lambing: {
      weeks: plan.weeks,
      totalEwes: plan.totalEwes,
      overdue: plan.overdue,
      expectedLambs: plan.expectedLambs,
      // Until the farm records its own lambings, the outlook's figure, said to be an assumption.
      assumedLambs: plan.assumedLambs,
      assumedLambsPerEwe: plan.assumedLambsPerEwe,
      next7Days: plan.days.filter((d) => d.date <= within7Days).reduce((sum, d) => sum + d.expected, 0),
      nextDate: plan.days[0]?.date ?? null,
    },
    mortality: deaths,
    weightTrend: weights,
  };
}

async function loadCrops() {
  const status = await fieldStatus();
  const overdue = await overdueOperations();
  const harvest = await harvestPlanFact();
  const weather = await forecast(WEATHER_DAYS);
  return { status, overdueCount: overdue.length, overdue: overdue.slice(0, LIST_LIMIT), harvest, weather };
}

async function loadFeed() {
  const items = await feedBalance();
  const consumption = await feedConsumption(FEED_CONSUMPTION_DAYS);
  const low = await lowStock();

  const average = averageDailyConsumption(consumption, today());
  const limiting = limitingFeed(items);
  return {
    // Soonest to run out first; feeds with no known figure go last, not to the top.
    items: [...items].sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity) || a.name.localeCompare(b.name)),
    limiting: limiting ? { itemId: limiting.itemId, name: limiting.name, days: limiting.days, basis: limiting.basis } : null,
    avgDailyKg: average ? round(average.avgDaily, 1) : null,
    consumption,
    lowStockCount: low.length,
    lowStock: low.slice(0, LOW_STOCK_LIMIT),
  };
}

async function loadStaff(modules: Set<string>) {
  const block: {
    attendance?: Awaited<ReturnType<typeof attendanceToday>>;
    tasks?: Awaited<ReturnType<typeof taskSummary>>;
    machinery?: Awaited<ReturnType<typeof assetStatus>>;
    fuel?: Awaited<ReturnType<typeof fuelUsage>> & { days: number };
  } = {};
  if (holdsAny('hr.view', AGGREGATES) && modules.has('hr')) block.attendance = await attendanceToday();
  if (holdsAny('tasks.view', AGGREGATES)) block.tasks = await taskSummary();
  if (holdsAny('assets.view', AGGREGATES) && modules.has('assets')) {
    block.machinery = await assetStatus();
    block.fuel = { ...(await fuelUsage(FUEL_DAYS)), days: FUEL_DAYS };
  }
  return block;
}

async function loadAlerts() {
  const rows = await openAlerts(ALERT_LIMIT);
  return {
    counts: await alertCounts(),
    // The fields the reader needs. Rule data stays, because the web renders text from it.
    items: rows.map(({ id, ruleKey, severity, status, source, title, body, data, link, lastSeenAt, createdAt, acknowledgedAt }) => ({
      id,
      ruleKey,
      severity,
      status,
      source,
      title,
      body,
      data,
      link,
      lastSeenAt,
      createdAt,
      acknowledgedAt,
    })),
  };
}

async function loadCameras() {
  const { devices } = schema;
  const [fleet] = await tx()
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      online: sql<number>`count(*) filter (where ${devices.status} = 'online')`.mapWith(Number),
      offline: sql<number>`count(*) filter (where ${devices.status} = 'offline')`.mapWith(Number),
      planned: sql<number>`count(*) filter (where ${devices.status} = 'planned')`.mapWith(Number),
    })
    .from(devices)
    .where(and(eq(devices.farmId, ctx().farmId), eq(devices.type, 'camera')));

  const feed = await eventFeed({ page: 1, pageSize: LIST_LIMIT });
  return {
    fleet,
    events: feed.data.map(({ id, occurredAt, source, type, severity, deviceId, deviceName, data }) => ({
      id,
      occurredAt,
      source,
      type,
      severity,
      deviceId,
      deviceName,
      /** Seeded demo readings say so, so nobody takes them for real ones. */
      sample: (data as { sample?: unknown } | null)?.sample === true,
    })),
  };
}

export const BLOCK_KEYS = ['finance', 'livestock', 'crops', 'feed', 'staff', 'alerts', 'cameras'] as const;
export type BlockKey = (typeof BLOCK_KEYS)[number];

interface BlockDefinition {
  /** Any one of these lets the reader see the block. */
  permissions: Permission[];
  /** Any one of these must be switched on for the tenant. */
  modules?: Module[];
  load: (modules: Set<string>) => Promise<unknown>;
}

const BLOCKS: Record<BlockKey, BlockDefinition> = {
  finance: { permissions: ['finance.view', FINANCE_SUMMARY_VIEW], modules: ['finance'], load: loadFinance },
  livestock: { permissions: ['livestock.view', AGGREGATES], modules: ['livestock'], load: loadLivestock },
  crops: { permissions: ['crops.view', AGGREGATES], modules: ['crops'], load: loadCrops },
  feed: { permissions: ['feed.view', 'inventory.view', AGGREGATES], modules: ['feed', 'inventory'], load: loadFeed },
  staff: { permissions: ['hr.view', 'assets.view', 'tasks.view', AGGREGATES], load: loadStaff },
  alerts: { permissions: ['dashboard.view'], load: loadAlerts },
  cameras: { permissions: ['cameras.view'], modules: ['cameras'], load: loadCameras },
};

/** What each role looks at first (spec 14). A custom role falls back to the default order. */
const DEFAULT_ORDER: BlockKey[] = ['alerts', 'finance', 'livestock', 'feed', 'crops', 'staff', 'cameras'];
const ROLE_ORDER: Partial<Record<RoleKey, BlockKey[]>> = {
  owner: ['finance', 'alerts', 'livestock', 'feed', 'crops', 'staff', 'cameras'],
  accountant: ['finance', 'alerts', 'staff', 'livestock', 'feed', 'crops', 'cameras'],
  auditor: ['finance', 'alerts', 'livestock', 'feed', 'crops', 'staff', 'cameras'],
  zootechnician: ['livestock', 'feed', 'alerts', 'staff', 'crops', 'cameras', 'finance'],
  veterinarian: ['livestock', 'alerts', 'feed', 'staff', 'crops', 'cameras', 'finance'],
  agronomist: ['crops', 'alerts', 'feed', 'staff', 'livestock', 'cameras', 'finance'],
  storekeeper: ['feed', 'alerts', 'staff', 'crops', 'livestock', 'cameras', 'finance'],
  investor: ['finance', 'livestock', 'crops', 'feed', 'staff', 'alerts', 'cameras'],
};

export function blockOrder(roleKey: string | null): BlockKey[] {
  return ROLE_ORDER[roleKey as RoleKey] ?? DEFAULT_ORDER;
}

export async function dashboard(log: FastifyBaseLogger) {
  const modules = await enabledModules();
  const order = blockOrder(ctx().roleKey).filter((key) => {
    const definition = BLOCKS[key];
    return holdsAny(...definition.permissions) && (!definition.modules || definition.modules.some((m) => modules.has(m)));
  });

  const blocks: Partial<Record<BlockKey, Block<unknown>>> = {};
  // One after another: one transaction is one connection, so running them together gains nothing.
  for (const key of order) blocks[key] = await isolate(key, log, () => BLOCKS[key].load(modules));

  return { asOf: today(), order, blocks };
}
