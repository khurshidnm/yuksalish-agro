import { and, eq, inArray, sql } from 'drizzle-orm';
import { deviationPercent, round, yieldPerHectare } from '@yap/shared';
import { waterPerTon } from '@yap/shared/formulas/crops';
import { schema } from '../../db/client';
import { canSeeMoney, tx } from '../../core/context';
import { sumOf } from '../../core/query';
import { fieldCosts } from '../finance/summary';
import { list as listPlans } from './plans.service';
import { currentSeason } from './seasons.service';

const { fieldOperations, harvests, stockMovements } = schema;

/**
 * Plan against fact per field (spec 7.3): area, yield and tons are measured here; every cost
 * figure comes from the finance engine, the single place that computes cost. Without finance.view
 * the cost columns are null.
 *
 * A plan with no watering recorded has unknown water use, and one with no cost recorded has an
 * unknown cost: both are null, never 0 (CLAUDE.md rule 5). Irrigated wheat at 0 m³ and 0 so'm
 * a ton is a gap in the records, not a result.
 */
export async function planFact(seasonId?: string) {
  const season = seasonId ?? (await currentSeason())?.id;
  if (!season) return { seasonId: null, rows: [], totals: null };

  const { data: plans } = await listPlans({ page: 1, pageSize: 200, seasonId: season });
  const planIds = plans.map((p) => p.id);
  if (planIds.length === 0) return { seasonId: season, rows: [], totals: null };

  const water = await tx()
    .select({ planId: fieldOperations.cropPlanId, m3: sumOf(fieldOperations.waterM3) })
    .from(fieldOperations)
    .where(and(inArray(fieldOperations.cropPlanId, planIds), eq(fieldOperations.status, 'done')))
    .groupBy(fieldOperations.cropPlanId);
  const waterByPlan = new Map(water.map((w) => [w.planId, w.m3]));

  const value = await tx()
    .select({ planId: harvests.cropPlanId, amount: sumOf(stockMovements.totalCost) })
    .from(harvests)
    .innerJoin(
      stockMovements,
      and(eq(stockMovements.refType, 'harvest'), sql`${stockMovements.refId} = ${harvests.id}`),
    )
    .where(inArray(harvests.cropPlanId, planIds))
    .groupBy(harvests.cropPlanId);
  const valueByPlan = new Map(value.map((v) => [v.planId, v.amount]));

  const money = canSeeMoney('crops.approve');
  const costs = money ? await fieldCosts(season) : [];
  const costByPlan = new Map(costs.map((c) => [c.cropPlanId, c]));

  const rows = plans.map((plan) => {
    const cost = costByPlan.get(plan.id);
    const actualCost = cost?.actual || null;
    const waterM3 = waterByPlan.get(plan.id) || null;
    const harvested = plan.harvestedT > 0;
    const actualYieldTHa = harvested ? yieldPerHectare(plan.harvestedT, plan.areaHa) : null;
    return {
      planId: plan.id,
      fieldId: plan.fieldId,
      fieldNumber: plan.fieldNumber,
      cropKey: plan.cropKey,
      cropName: plan.cropName,
      status: plan.status,
      areaHa: plan.areaHa,
      expectedYieldTHa: plan.expectedYieldTHa,
      expectedHarvestT: plan.expectedHarvestT,
      harvestedT: plan.harvestedT,
      actualYieldTHa,
      yieldDeviationPercent:
        actualYieldTHa !== null && plan.expectedYieldTHa ? deviationPercent(actualYieldTHa, plan.expectedYieldTHa) : null,
      waterM3,
      waterM3PerTon: waterPerTon(waterM3, plan.harvestedT),
      plannedCost: money ? plan.plannedCost : null,
      actualCost,
      costDeviation: actualCost === null ? null : (cost?.deviation ?? null),
      costPerTon: actualCost === null ? null : cost?.costPerTon || null,
      // The internal price of what went to the warehouse (spec 7.3).
      harvestValue: money ? (valueByPlan.get(plan.id) ?? null) : null,
    };
  });

  const sum = (pick: (row: (typeof rows)[number]) => number | null) =>
    rows.reduce<number | null>((total, row) => {
      const value = pick(row);
      return value === null ? total : (total ?? 0) + value;
    }, null);

  return {
    seasonId: season,
    rows,
    totals: {
      areaHa: round(sum((r) => r.areaHa) ?? 0, 4),
      expectedHarvestT: sum((r) => r.expectedHarvestT),
      harvestedT: sum((r) => r.harvestedT) ?? 0,
      waterM3: sum((r) => r.waterM3),
      plannedCost: sum((r) => r.plannedCost),
      actualCost: sum((r) => r.actualCost),
    },
  };
}
