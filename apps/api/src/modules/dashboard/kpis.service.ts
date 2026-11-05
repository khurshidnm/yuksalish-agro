/**
 * Key indicators of spec 14.3 for a period of whole months. Figures come from the modules' summary
 * functions and shared formulas. Null means there is not enough data yet, so the UI can say so
 * rather than show a zero. Money figures are left out unless the reader holds finance.view.
 */
import { and, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
  costPerTon,
  deviationPercent,
  diffDays,
  machineryUnitCost,
  monthOf,
  monthRange,
  mortalityPercent,
  profitabilityPercent,
  round,
  type CropCostInput,
  type Module,
  type Permission,
  FINANCE_SUMMARY_VIEW,
} from '@yap/shared';
import {
  attendancePercent,
  feedCostPerHeadDay,
  feedLossPercent,
  machineryUtilizationPercent,
  operatingRatio,
  perEmployee,
  profitPerHead,
} from '@yap/shared/formulas/kpi';
import { averageHead } from '@yap/shared/formulas/livestock';
import { schema } from '../../db/client';
import { canSeeMoney, ctx, today, tx } from '../../core/context';
import { badRequest } from '../../core/errors';
import { COST_MOVEMENT_TYPES } from '../../core/inventory';
import { isoMonth, sumOf } from '../../core/query';
import { assetCosts } from '../assets/costs.service';
import { cropKpis } from '../crops/summary';
import { feedingPlan } from '../feed/balance.service';
import { monthsBetween } from '../finance/budget.service';
import { budgetExecution, cashflowActual, fieldCosts, herdCost, herdResult, monthToDate } from '../finance/summary';
import { attendanceToday } from '../hr/summary';
import { feedBalance } from '../inventory/summary';
import { reproductionKpis } from '../livestock/breeding.summary';
import { growthKpis, herdMovement, herdSummary } from '../livestock/summary';
import { AGGREGATES, enabledModules, holdsAny, isolate, limitingFeed, roundOrNull, type Block } from './blocks';

const { assets, assetUsageLogs, fields, items, maintenanceRecords, stockCounts, stockMovements, timesheets, warehouses } = schema;

/** Machines that log motor-hours. A scale or a camera has no working day. */
const MOTOR_TYPES = ['tractor', 'combine', 'vehicle'];
const MAX_MONTHS = 36;

export const kpiQuery = z.object({ from: isoMonth.optional(), to: isoMonth.optional() });

interface Period {
  from: string;
  to: string;
  fromDate: string;
  /** The end of the last month, or today while that month is still running. */
  toDate: string;
}

/** Defaults to the current year so far. */
function resolvePeriod(q: z.infer<typeof kpiQuery>): Period {
  const now = today();
  const from = q.from ?? `${now.slice(0, 4)}-01`;
  const to = q.to ?? monthOf(now);
  const months = from <= to ? monthsBetween(from, to).length : 0;
  if (months === 0 || months > MAX_MONTHS) {
    throw badRequest('INVALID_PERIOD', `Choose a period of 1 to ${MAX_MONTHS} months`, { max: MAX_MONTHS });
  }
  const end = monthRange(to).to;
  return { from, to, fromDate: `${from}-01`, toDate: end < now ? end : now };
}

async function financeKpis(p: Period) {
  const months = [];
  for (const month of monthsBetween(p.from, p.to)) months.push(await monthToDate(month));
  const income = months.reduce((sum, m) => sum + m.income, 0);
  const operatingExpense = months.reduce((sum, m) => sum + m.operatingExpense, 0);

  const herds = await herdResult(p.fromDate, p.toDate);
  const { byCategory } = await herdSummary();

  const cashflow = await cashflowActual(p.fromDate, p.toDate);
  const budget = await budgetExecution(p.fromDate, p.toDate);

  return {
    income: round(income, 2),
    operatingExpense: round(operatingExpense, 2),
    // Before the first sale there is no return to measure; -100 % would only look alarming.
    profitabilityPercent: income > 0 ? roundOrNull(profitabilityPercent(income, operatingExpense), 1) : null,
    profitPerEwe: roundOrNull(profitPerHead(herds.income, herds.expense, byCategory.ewe ?? 0), 0),
    operatingRatio: roundOrNull(operatingRatio(operatingExpense, income), 2),
    netCashflow: cashflow.length ? round(cashflow.reduce((sum, m) => sum + m.net, 0), 2) : null,
    budgetDeviation: budget.planned > 0 ? budget.deviation : null,
    budgetDeviationPercent: roundOrNull(deviationPercent(budget.actual, budget.planned), 1),
  };
}

async function livestockKpis(p: Period) {
  const reproduction = await reproductionKpis();
  const growth = await growthKpis(p.fromDate, p.toDate);
  const movement = await herdMovement(p.fromDate, p.toDate);
  return {
    lambingPercent: reproduction.lambingPercent,
    survivalPercent: reproduction.survivalPercent,
    // An average per animal weighed, so a partial weighing is still a fair sample.
    adgG: growth.adgG,
    weighedAnimals: growth.animals,
    feedConversion: roundOrNull(growth.feedConversion, 2),
    mortalityPercent: roundOrNull(mortalityPercent(movement.dead, averageHead(movement.opening, movement.closing)), 2),
    ...(canSeeMoney(FINANCE_SUMMARY_VIEW) ? { costPerKgLive: (await herdCost()).costPerKg } : {}),
  };
}

/** Farm cost of one ton, over the fields that have been harvested. */
async function seasonCostPerTon(): Promise<number | null> {
  const harvested = (await fieldCosts()).filter((row) => row.harvestT > 0);
  const total: CropCostInput = { seed: 0, fertilizer: 0, water: 0, machinery: 0, labor: 0, overheadShare: 0 };
  for (const row of harvested) {
    for (const key of Object.keys(total) as (keyof CropCostInput)[]) total[key] += row.breakdown[key];
  }
  return roundOrNull(
    costPerTon(total, harvested.reduce((sum, row) => sum + row.harvestT, 0)),
    0,
  );
}

async function cropKpiGroup() {
  const { yieldTHa, onTimePercent, waterM3PerTon } = await cropKpis();
  return {
    yieldTHa: roundOrNull(yieldTHa, 2),
    onTimePercent: roundOrNull(onTimePercent, 1),
    waterM3PerTon: roundOrNull(waterM3PerTon, 1),
    ...(canSeeMoney(FINANCE_SUMMARY_VIEW) ? { costPerTon: await seasonCostPerTon() } : {}),
  };
}

/** Losses are only known from a stock count. Without one in the period, they are unknown, not 0. */
async function feedLoss(p: Period): Promise<number | null> {
  const farm = ctx().farmId;
  const [counted] = await tx()
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(stockCounts)
    .innerJoin(warehouses, eq(warehouses.id, stockCounts.warehouseId))
    .where(
      and(
        eq(stockCounts.farmId, farm),
        eq(stockCounts.status, 'approved'),
        eq(warehouses.type, 'feed'),
        gte(stockCounts.date, p.fromDate),
        lte(stockCounts.date, p.toDate),
      ),
    );
  if (counted.n === 0) return null;

  const rows = await tx()
    .select({ type: stockMovements.type, value: sumOf(stockMovements.totalCost) })
    .from(stockMovements)
    .innerJoin(items, eq(items.id, stockMovements.itemId))
    .where(
      and(
        eq(stockMovements.farmId, farm),
        eq(items.category, 'feed'),
        inArray(stockMovements.type, [...COST_MOVEMENT_TYPES]),
        gte(stockMovements.date, p.fromDate),
        lte(stockMovements.date, p.toDate),
      ),
    )
    .groupBy(stockMovements.type);
  const value = (type: string) => rows.find((row) => row.type === type)?.value ?? 0;
  return roundOrNull(feedLossPercent(value('adjustment_out'), value('issue')), 1);
}

/** By ration, so it is known from day one: every herd's daily ration cost over its head count. */
async function rationCostPerHeadDay(): Promise<number | null> {
  const { herds } = await feedingPlan();
  const fed = herds.filter((herd) => herd.head > 0);
  if (fed.length === 0 || fed.some((herd) => herd.costPerDay === null)) return null;
  return roundOrNull(
    feedCostPerHeadDay(
      fed.reduce((sum, herd) => sum + herd.costPerDay!, 0),
      fed.reduce((sum, herd) => sum + herd.head, 0),
    ),
    0,
  );
}

async function feedKpis(p: Period) {
  const limiting = limitingFeed(await feedBalance());
  return {
    stockDays: limiting?.days ?? null,
    limitingItem: limiting?.name ?? null,
    lossPercent: await feedLoss(p),
    ...(canSeeMoney(FINANCE_SUMMARY_VIEW) ? { costPerHeadDay: await rationCostPerHeadDay() } : {}),
  };
}

async function staffKpis(p: Period) {
  const farm = ctx().farmId;
  const { total: employees } = await attendanceToday();
  const { total: head } = await herdSummary();
  const [area] = await tx()
    .select({ ha: sumOf(fields.areaHa) })
    .from(fields)
    .where(and(eq(fields.farmId, farm), eq(fields.landUse, 'arable'), eq(fields.status, 'active')));
  const days = await tx()
    .select({ status: timesheets.status, n: sql<number>`count(*)`.mapWith(Number) })
    .from(timesheets)
    .where(and(eq(timesheets.farmId, farm), gte(timesheets.date, p.fromDate), lte(timesheets.date, p.toDate)))
    .groupBy(timesheets.status);
  const dayCount = (status: string) => days.find((row) => row.status === status)?.n ?? 0;

  return {
    headPerEmployee: roundOrNull(perEmployee(head, employees), 1),
    haPerEmployee: roundOrNull(perEmployee(area.ha, employees), 1),
    attendancePercent: roundOrNull(attendancePercent(dayCount('present'), dayCount('absent')), 1),
  };
}

/** Cost of one hectare across the machines that worked hectares in the period. */
async function machineryCostPerHa(p: Period, assetIds: string[]): Promise<number | null> {
  const costs = { fuel: 0, labor: 0, repairs: 0, depreciation: 0 };
  let hectares = 0;
  for (const id of assetIds) {
    const asset = await assetCosts(id, p.fromDate, p.toDate);
    if (asset.hectares <= 0) continue;
    hectares += asset.hectares;
    costs.fuel += asset.fuel;
    costs.labor += asset.labor;
    costs.repairs += asset.repairs;
    costs.depreciation += asset.depreciation;
  }
  return roundOrNull(machineryUnitCost(costs, hectares), 0);
}

async function machineryKpis(p: Period) {
  const farm = ctx().farmId;
  const fleet = await tx()
    .select({ id: assets.id, type: assets.type, rented: assets.rented })
    .from(assets)
    .where(and(eq(assets.farmId, farm), ne(assets.status, 'written_off')));
  // Hired machines are paid for by the job, so idle time on them is not this farm's load.
  const motorized = fleet.filter((asset) => !asset.rented && MOTOR_TYPES.includes(asset.type)).map((asset) => asset.id);

  const [usage] = motorized.length
    ? await tx()
        .select({ hours: sumOf(assetUsageLogs.motoHours) })
        .from(assetUsageLogs)
        .where(
          and(
            inArray(assetUsageLogs.assetId, motorized),
            gte(assetUsageLogs.date, p.fromDate),
            lte(assetUsageLogs.date, p.toDate),
          ),
        )
    : [{ hours: 0 }];

  const [stops] = await tx()
    .select({ n: sql<number>`count(*)`.mapWith(Number), hours: sumOf(maintenanceRecords.downtimeHours) })
    .from(maintenanceRecords)
    .where(
      and(
        eq(maintenanceRecords.farmId, farm),
        eq(maintenanceRecords.type, 'repair'),
        gte(maintenanceRecords.date, p.fromDate),
        lte(maintenanceRecords.date, p.toDate),
      ),
    );

  const days = diffDays(p.fromDate, p.toDate) + 1;
  return {
    utilizationPercent: roundOrNull(machineryUtilizationPercent(usage.hours, motorized.length, days), 1),
    unplannedStops: stops.n,
    downtimeHours: stops.hours,
    ...(canSeeMoney(FINANCE_SUMMARY_VIEW) ? { costPerHa: await machineryCostPerHa(p, fleet.map((asset) => asset.id)) } : {}),
  };
}

interface KpiGroup {
  permissions: Permission[];
  modules?: Module[];
  load: (period: Period) => Promise<unknown>;
}

const GROUPS: Record<string, KpiGroup> = {
  finance: { permissions: ['finance.view', FINANCE_SUMMARY_VIEW], modules: ['finance'], load: financeKpis },
  livestock: { permissions: ['livestock.view', AGGREGATES], modules: ['livestock'], load: livestockKpis },
  crops: { permissions: ['crops.view', AGGREGATES], modules: ['crops'], load: cropKpiGroup },
  feed: { permissions: ['feed.view', 'inventory.view', AGGREGATES], modules: ['feed', 'inventory'], load: feedKpis },
  staff: { permissions: ['hr.view', AGGREGATES], modules: ['hr'], load: staffKpis },
  machinery: { permissions: ['assets.view', AGGREGATES], modules: ['assets'], load: machineryKpis },
};

export async function kpis(q: z.infer<typeof kpiQuery>, log: FastifyBaseLogger) {
  const period = resolvePeriod(q);
  const modules = await enabledModules();
  const groups: Record<string, Block<unknown>> = {};
  for (const [key, group] of Object.entries(GROUPS)) {
    if (!holdsAny(...group.permissions)) continue;
    if (group.modules && !group.modules.some((m) => modules.has(m))) continue;
    groups[key] = await isolate(`kpi.${key}`, log, () => group.load(period));
  }
  return { period: { from: period.from, to: period.to }, groups };
}
