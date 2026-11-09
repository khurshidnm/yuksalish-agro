import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { yieldPerHectare } from '@yap/shared';
import { onTimePercent, waterPerTon } from '@yap/shared/formulas/crops';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { overdue } from './operations.service';
import { planFact } from './plan-fact.service';
import { currentSeason, getSeason } from './seasons.service';

const { cropPlans, fieldOperations, fields, harvests, seasons } = schema;

/**
 * Fields sown, irrigated and harvested in a season, the current one unless another is named
 * (spec 14.1). Watering counts for the season of the crop it was given to: seasons overlap here,
 * autumn sowing starts before the summer crops are off, so a date window alone would count
 * September's watering in both. Watering with no crop plan falls back to the season's dates.
 */
export async function fieldStatus(seasonId?: string) {
  const farmId = ctx().farmId;
  const [{ total }] = await tx()
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(fields)
    .where(and(eq(fields.farmId, farmId), eq(fields.landUse, 'arable'), eq(fields.status, 'active')));

  const season = seasonId ? await getSeason(seasonId) : await currentSeason();
  if (!season) return { sown: 0, irrigated: 0, harvested: 0, total };

  const inSeason = and(eq(cropPlans.farmId, farmId), eq(cropPlans.seasonId, season.id), ne(cropPlans.status, 'cancelled'));
  const [plans] = await tx()
    .select({
      sown: sql<number>`count(distinct ${cropPlans.fieldId}) filter (where ${cropPlans.status} in ('sown', 'growing', 'harvested'))`.mapWith(Number),
      harvested: sql<number>`count(distinct ${cropPlans.fieldId}) filter (where ${cropPlans.status} = 'harvested')`.mapWith(Number),
    })
    .from(cropPlans)
    .where(inSeason);

  const [{ irrigated }] = await tx()
    .select({ irrigated: sql<number>`count(distinct ${fieldOperations.fieldId})`.mapWith(Number) })
    .from(fieldOperations)
    .where(
      and(
        eq(fieldOperations.farmId, farmId),
        eq(fieldOperations.type, 'irrigation'),
        eq(fieldOperations.status, 'done'),
        or(
          inArray(fieldOperations.cropPlanId, tx().select({ id: cropPlans.id }).from(cropPlans).where(inSeason)),
          and(
            isNull(fieldOperations.cropPlanId),
            sql`${fieldOperations.date} between ${season.startDate} and ${season.endDate}`,
          ),
        ),
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

/**
 * The last season with a harvest, of the same kind as the current one where there is one: a yield
 * means little mixed with crops of another season, such as silage counted beside wheat.
 */
export async function lastHarvestedSeason() {
  const current = await currentSeason();
  const rows = await tx()
    .selectDistinct({ id: seasons.id, name: seasons.name, kind: seasons.kind, endDate: seasons.endDate })
    .from(seasons)
    .innerJoin(cropPlans, eq(cropPlans.seasonId, seasons.id))
    .innerJoin(harvests, eq(harvests.cropPlanId, cropPlans.id))
    .where(eq(seasons.farmId, ctx().farmId))
    .orderBy(desc(seasons.endDate));
  return rows.find((season) => season.kind === current?.kind) ?? rows[0] ?? null;
}

/** Dehqonchilik KPIs (spec 14.3). Cost per ton comes from finance fieldCosts. */
export async function cropKpis(seasonId?: string) {
  return (await cropFigures(seasonId)).kpis;
}

/** The KPIs and each crop's own yield, from one plan-fact pass. */
export async function cropFigures(seasonId?: string) {
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
    kpis: {
      yieldTHa: yieldPerHectare(totals?.harvestedT ?? 0, harvestedArea),
      onTimePercent: onTimePercent(work.onTime, work.planned),
      waterM3PerTon: waterPerTon(totals?.waterM3 ?? null, totals?.harvestedT ?? 0),
    },
    yields: yieldByCrop(harvested),
  };
}

type PlanFactRow = Awaited<ReturnType<typeof planFact>>['rows'][number];

/**
 * Yield crop by crop, largest harvest first. Tons of hay, silage green mass and grain do not add
 * up to one meaningful t/ha, so a page that shows several crops shows each on its own.
 */
function yieldByCrop(harvested: PlanFactRow[]) {
  const byCrop = new Map<string, { cropKey: string; cropName: unknown; areaHa: number; harvestedT: number }>();
  for (const row of harvested) {
    const entry = byCrop.get(row.cropKey) ?? { cropKey: row.cropKey, cropName: row.cropName, areaHa: 0, harvestedT: 0 };
    entry.areaHa += row.areaHa;
    entry.harvestedT += row.harvestedT;
    byCrop.set(row.cropKey, entry);
  }
  return [...byCrop.values()]
    .map((c) => ({ ...c, yieldTHa: yieldPerHectare(c.harvestedT, c.areaHa) }))
    .sort((a, b) => b.harvestedT - a.harvestedT);
}
