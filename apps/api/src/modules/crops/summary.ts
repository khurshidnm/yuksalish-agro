import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { yieldPerHectare } from '@yap/shared';
import { onTimePercent, waterPerTon } from '@yap/shared/formulas/crops';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { overdue } from './operations.service';
import { planFact } from './plan-fact.service';
import { currentSeason } from './seasons.service';

const { cropPlans, fieldOperations, fields } = schema;

/** Fields sown, irrigated and harvested in the current season (spec 14.1). */
export async function fieldStatus() {
  const farmId = ctx().farmId;
  const [{ total }] = await tx()
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(fields)
    .where(and(eq(fields.farmId, farmId), eq(fields.landUse, 'arable'), eq(fields.status, 'active')));

  const season = await currentSeason();
  if (!season) return { sown: 0, irrigated: 0, harvested: 0, total };

  const [plans] = await tx()
    .select({
      sown: sql<number>`count(distinct ${cropPlans.fieldId}) filter (where ${cropPlans.status} in ('sown', 'growing', 'harvested'))`.mapWith(Number),
      harvested: sql<number>`count(distinct ${cropPlans.fieldId}) filter (where ${cropPlans.status} = 'harvested')`.mapWith(Number),
    })
    .from(cropPlans)
    .where(and(eq(cropPlans.seasonId, season.id), ne(cropPlans.status, 'cancelled')));

  const [{ irrigated }] = await tx()
    .select({ irrigated: sql<number>`count(distinct ${fieldOperations.fieldId})`.mapWith(Number) })
    .from(fieldOperations)
    .where(
      and(
        eq(fieldOperations.farmId, farmId),
        eq(fieldOperations.type, 'irrigation'),
        eq(fieldOperations.status, 'done'),
        sql`${fieldOperations.date} between ${season.startDate} and ${season.endDate}`,
      ),
    );
  return { sown: plans.sown, irrigated, harvested: plans.harvested, total };
}

export async function overdueOperations() {
  const rows = await overdue();
  return rows.map((row) => ({ id: row.id, type: row.type, date: row.date, fieldNumber: row.fieldNumber }));
}

export async function harvestPlanFact(seasonId?: string) {
  const { totals } = await planFact(seasonId);
  return { plannedT: totals?.expectedHarvestT ?? 0, actualT: totals?.harvestedT ?? 0 };
}

/** Dehqonchilik KPIs (spec 14.3). Cost per ton comes from finance fieldCosts. */
export async function cropKpis(seasonId?: string) {
  const { rows, totals } = await planFact(seasonId);
  const planIds = rows.map((r) => r.planId);
  const [work] =
    planIds.length === 0
      ? [{ planned: 0, onTime: 0 }]
      : await tx()
          .select({
            planned: sql<number>`count(*) filter (where ${fieldOperations.plannedDate} is not null and ${fieldOperations.status} = 'done')`.mapWith(Number),
            onTime: sql<number>`count(*) filter (where ${fieldOperations.plannedDate} is not null and ${fieldOperations.status} = 'done' and ${fieldOperations.date} <= ${fieldOperations.plannedDate})`.mapWith(Number),
          })
          .from(fieldOperations)
          .where(inArray(fieldOperations.cropPlanId, planIds));

  const harvested = rows.filter((r) => r.harvestedT > 0);
  const harvestedArea = harvested.reduce((sum, r) => sum + r.areaHa, 0);
  return {
    yieldTHa: yieldPerHectare(totals?.harvestedT ?? 0, harvestedArea),
    onTimePercent: onTimePercent(work.onTime, work.planned),
    waterM3PerTon: waterPerTon(totals?.waterM3 ?? 0, totals?.harvestedT ?? 0),
  };
}
