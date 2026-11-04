import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { detectAnomalies, seasonForecast, type SeasonLine } from '@yap/shared/formulas/ai';
import { monthOf, monthRange, round } from '@yap/shared';
import { ctx, today, tx } from '../../../core/context';
import { schema } from '../../../db/client';
import { currentSeason } from '../facts';
import { fieldCosts } from '../../finance/summary';
import { groupDigits, monthText } from '../render';
import { cropPricesPerTon } from './prices';
import { coverage, type AnalyzerResult, type Finding } from './types';

const { cropPlans, crops, fields, financeCategories, harvests, transactions } = schema;

const MIN_BASELINE_MONTHS = 3;
const MIN_FORECAST_LINES = 2;

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

/** Last complete month by category against the months before (spec 15.1.2). */
export async function expenseSpikes(): Promise<AnalyzerResult> {
  const thisMonth = monthOf(today());
  const firstConsidered = addMonths(thisMonth, -13);
  const lastMonth = addMonths(thisMonth, -1);

  const rows = await tx()
    .select({
      key: financeCategories.key,
      name: sql<string>`${financeCategories.name}->>'uz'`,
      month: sql<string>`to_char(${transactions.date}, 'YYYY-MM')`,
      amount: sql<number>`sum(${transactions.amountBase})`.mapWith(Number),
    })
    .from(transactions)
    .innerJoin(financeCategories, eq(financeCategories.id, transactions.categoryId))
    .where(
      and(
        eq(transactions.farmId, ctx().farmId),
        eq(transactions.status, 'approved'),
        eq(transactions.type, 'expense'),
        // One-off asset and livestock purchases are investments, not a rising cost.
        inArray(transactions.costTreatment, ['expense', 'inventory']),
        gte(transactions.date, `${firstConsidered}-01`),
        lt(transactions.date, `${thisMonth}-01`),
      ),
    )
    .groupBy(financeCategories.key, financeCategories.name, sql`to_char(${transactions.date}, 'YYYY-MM')`);

  const seen = rows.map((r) => r.month).sort();
  const firstMonth = seen[0];
  const months: string[] = [];
  if (firstMonth) {
    for (let m = firstMonth; m <= lastMonth; m = addMonths(m, 1)) months.push(m);
  }
  const cover = coverage('expense_spike', months.length, MIN_BASELINE_MONTHS + 1, 'months');
  if (!cover.enough) return { coverage: cover, findings: [] };

  const findings: Finding[] = [];
  for (const key of new Set(rows.map((r) => r.key))) {
    const series = months.map((m) => rows.find((r) => r.key === key && r.month === m)?.amount ?? 0);
    const [anomaly] = detectAnomalies(series, {
      window: 6,
      minBaseline: MIN_BASELINE_MONTHS,
      lookback: 1,
      direction: 'up',
      minDeviationPercent: 30,
    });
    if (!anomaly) continue;
    const name = rows.find((r) => r.key === key)!.name;
    const { from, to } = monthRange(lastMonth);
    findings.push({
      type: 'expense_spike',
      dedupKey: `expense_spike:${key}:${lastMonth}`,
      severity: 'attention',
      confidence: anomaly.confidence,
      containsMoney: true,
      params: {
        category: name,
        month: monthText(lastMonth),
        actual: groupDigits(anomaly.value),
        expected: groupDigits(anomaly.baselineMean),
        deviation: anomaly.deviationPercent,
        currency: ctx().currency,
      },
      sources: {
        tables: ['transactions', 'finance_categories'],
        months: months.length,
        baselineMonths: anomaly.baselineSize,
        z: anomaly.z,
        from: `${months[0]}-01`,
        to,
      },
      data: { series: months.map((month, i) => ({ month, amount: series[i] })) },
      periodFrom: from,
      periodTo: to,
      link: '/finance/transactions',
    });
  }
  return { coverage: cover, findings };
}

/** Season profit from plan, actual and expected yield (spec 15.3 scenario 3). */
export async function seasonProfit(): Promise<AnalyzerResult> {
  const season = await currentSeason();
  if (!season) return { coverage: coverage('season_profit', 0, MIN_FORECAST_LINES, 'lines'), findings: [] };

  const plans = await tx()
    .select({
      id: cropPlans.id,
      fieldId: cropPlans.fieldId,
      field: fields.number,
      cropId: cropPlans.cropId,
      crop: sql<string>`${crops.name}->>'uz'`,
      areaHa: cropPlans.areaHa,
      expectedYieldTHa: cropPlans.expectedYieldTHa,
      plannedCost: cropPlans.plannedCost,
    })
    .from(cropPlans)
    .innerJoin(fields, eq(fields.id, cropPlans.fieldId))
    .innerJoin(crops, eq(crops.id, cropPlans.cropId))
    .where(and(eq(cropPlans.farmId, ctx().farmId), eq(cropPlans.seasonId, season.id)));

  const harvested = await tx()
    .select({ planId: harvests.cropPlanId, tons: sql<number>`sum(${harvests.grossT})`.mapWith(Number) })
    .from(harvests)
    .where(eq(harvests.farmId, ctx().farmId))
    .groupBy(harvests.cropPlanId);

  const prices = await cropPricesPerTon();
  // Actual cost comes from the finance engine only: nothing here recomputes it.
  const costs = await fieldCosts(season.id);
  const actualByPlan = new Map(costs.map((c) => [c.cropPlanId, c.actual]));

  const lines: (SeasonLine & { field: string; crop: string })[] = plans.map((plan) => ({
    field: plan.field,
    crop: plan.crop,
    areaHa: plan.areaHa,
    expectedYieldTHa: plan.expectedYieldTHa,
    pricePerT: prices.get(plan.cropId) ?? null,
    plannedCost: plan.plannedCost,
    actualCost: actualByPlan.get(plan.id) ?? null,
    harvestedT: harvested.find((h) => h.planId === plan.id)?.tons ?? null,
  }));

  const forecast = seasonForecast(lines);
  const cover = coverage('season_profit', forecast.linesUsed, MIN_FORECAST_LINES, 'lines');
  if (!cover.enough) return { coverage: cover, findings: [] };

  const covered = (forecast.areaCoveredPercent ?? 0) / 100;
  const anySpent = lines.some((l) => (l.actualCost ?? 0) > 0);
  const confidence = round(0.35 + 0.35 * covered + (anySpent ? 0.1 : 0), 2);
  return {
    coverage: cover,
    findings: [
      {
        type: 'season_profit',
        dedupKey: `season_profit:${season.id}:${monthOf(today())}`,
        severity: 'info',
        confidence,
        containsMoney: true,
        textKey: forecast.linesSkipped === 0 ? 'season_profit_complete' : undefined,
        params: {
          season: season.name,
          profit: groupDigits(forecast.profit),
          revenue: groupDigits(forecast.revenue),
          cost: groupDigits(forecast.cost),
          covered: forecast.areaCoveredPercent ?? 0,
          skipped: forecast.linesSkipped,
          currency: ctx().currency,
        },
        sources: {
          tables: ['crop_plans', 'harvests', 'prices', 'items'],
          lines: lines.length,
          linesUsed: forecast.linesUsed,
          linesSkipped: forecast.linesSkipped,
          skippedFields: lines
            .filter((l) => l.pricePerT === null || (l.plannedCost === null && l.actualCost === null))
            .map((l) => l.field),
        },
        data: { ...forecast, lines },
        periodFrom: season.startDate,
        periodTo: season.endDate,
        link: '/finance/costs',
        alertable: false,
      },
    ],
  };
}
