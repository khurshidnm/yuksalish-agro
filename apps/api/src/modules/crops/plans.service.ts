import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CROP_PLAN_STATUSES, addDays, round } from '@yap/shared';
import { expectedHarvestT, harvestSplit, planCostEstimate, techCardNorms } from '@yap/shared/formulas/crops';
import { cropFamilyOf, rotationNotes, type RotationNote } from '@yap/shared/formulas/rotation';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy, sumOf } from '../../core/query';
import { getCrop } from './seasons.service';
import * as techCards from './tech-cards.service';

const { cropPlans: t, crops, fieldOperations, fields, harvests, seasons } = schema;

/** A drawn boundary and a typed plan area rarely match to the last decimal. */
const AREA_TOLERANCE = 1.02;

export const planInput = z.object({
  id: clientId,
  seasonId: z.uuid(),
  fieldId: z.uuid(),
  cropId: z.uuid(),
  techCardId: z.uuid().nullish(),
  variety: z.string().trim().max(120).nullish(),
  areaHa: z.number().positive().optional(),
  sowingDatePlan: isoDate.nullish(),
  /** For sowing done outside the journal, e.g. imported from Excel. */
  sowingDateFact: isoDate.nullish(),
  seedRateKgHa: z.number().min(0).nullish(),
  expectedYieldTHa: z.number().min(0).nullish(),
  plannedCost: z.number().min(0).nullish(),
  ownUsePct: z.number().min(0).max(100).optional(),
  status: z.enum(CROP_PLAN_STATUSES).optional(),
  notes: z.string().trim().max(1000).nullish(),
});
export type PlanInput = z.infer<typeof planInput>;

export const planListQuery = listQuery.extend({
  seasonId: z.uuid().optional(),
  fieldId: z.uuid().optional(),
  status: z.enum(CROP_PLAN_STATUSES).optional(),
});

type Plan = typeof t.$inferSelect;

export async function getFieldRow(fieldId: string) {
  const [row] = await tx()
    .select()
    .from(fields)
    .where(and(eq(fields.id, fieldId), eq(fields.farmId, ctx().farmId)));
  if (!row) throw notFound('Field');
  return row;
}

async function getPlanRow(id: string): Promise<Plan> {
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Crop plan');
  return row;
}

async function assertSeason(seasonId: string): Promise<void> {
  const [row] = await tx()
    .select({ id: seasons.id })
    .from(seasons)
    .where(and(eq(seasons.id, seasonId), eq(seasons.farmId, ctx().farmId)));
  if (!row) throw notFound('Season');
}

/** A field cannot carry more crop than it has land, within one season. */
async function assertAreaFits(fieldId: string, seasonId: string, areaHa: number, excludePlanId?: string) {
  const field = await getFieldRow(fieldId);
  if (field.landUse !== 'arable') throw conflict('FIELD_NOT_ARABLE', 'Crops can only be planned on arable land');
  const [{ used }] = await tx()
    .select({ used: sumOf(t.areaHa) })
    .from(t)
    .where(
      and(
        eq(t.fieldId, fieldId),
        eq(t.seasonId, seasonId),
        ne(t.status, 'cancelled'),
        excludePlanId ? ne(t.id, excludePlanId) : undefined,
      ),
    );
  const free = field.areaHa - used;
  if (field.areaHa > 0 && areaHa > free * AREA_TOLERANCE) {
    throw conflict('PLAN_AREA_EXCEEDS_FIELD', `Only ${round(free, 2)} ha of this field is free in this season`, {
      fieldAreaHa: field.areaHa,
      freeHa: round(free, 2),
    });
  }
  return field;
}

/** Cost and yield from the tech card (spec 7.1). Internal: `plannedCost` here is not masked. */
async function computeEstimate(input: { cropId: string; areaHa: number; techCardId?: string | null }) {
  const crop = await getCrop(input.cropId);
  const card = input.techCardId ? await techCards.getRow(input.techCardId) : await techCards.findForCrop(input.cropId);
  const norms = techCardNorms(card?.lines ?? []);
  const expectedYieldTHa = card?.expectedYieldTHa ?? crop.defaultYieldTHa;
  return {
    techCardId: card?.id ?? null,
    techCardName: card?.name ?? null,
    seedRateKgHa: norms.seedKgHa || null,
    expectedYieldTHa,
    expectedHarvestT: expectedHarvestT(input.areaHa, expectedYieldTHa),
    costPerHa: card ? norms.costPerHa : null,
    plannedCost: card ? round(planCostEstimate(card.lines, input.areaHa), 2) : null,
  };
}

export async function estimate(input: { cropId: string; areaHa: number; techCardId?: string | null }) {
  return hideMoney([await computeEstimate(input)], ['costPerHa', 'plannedCost'], 'crops.approve')[0];
}

const planColumns = {
  id: t.id,
  seasonId: t.seasonId,
  seasonName: seasons.name,
  fieldId: t.fieldId,
  fieldNumber: fields.number,
  fieldName: fields.name,
  fieldAreaHa: fields.areaHa,
  cropId: t.cropId,
  cropKey: crops.key,
  cropName: crops.name,
  isFeed: crops.isFeed,
  techCardId: t.techCardId,
  variety: t.variety,
  areaHa: t.areaHa,
  sowingDatePlan: t.sowingDatePlan,
  sowingDateFact: t.sowingDateFact,
  seedRateKgHa: t.seedRateKgHa,
  expectedYieldTHa: t.expectedYieldTHa,
  plannedCost: t.plannedCost,
  ownUsePct: t.ownUsePct,
  status: t.status,
  notes: t.notes,
  createdAt: t.createdAt,
};

function planQuery() {
  return tx()
    .select(planColumns)
    .from(t)
    .innerJoin(fields, eq(fields.id, t.fieldId))
    .innerJoin(crops, eq(crops.id, t.cropId))
    .innerJoin(seasons, eq(seasons.id, t.seasonId));
}

type PlanView = Awaited<ReturnType<typeof planQuery>>[number];

/** Physical progress for each plan: harvested tons, work done, work overdue. */
async function withProgress(rows: PlanView[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const harvested = await tx()
    .select({ planId: harvests.cropPlanId, tons: sumOf(harvests.grossT) })
    .from(harvests)
    .where(inArray(harvests.cropPlanId, ids))
    .groupBy(harvests.cropPlanId);
  const operations = await tx()
    .select({
      planId: fieldOperations.cropPlanId,
      done: sql<number>`count(*) filter (where ${fieldOperations.status} = 'done')`.mapWith(Number),
      overdue: sql<number>`count(*) filter (where ${fieldOperations.status} = 'planned' and ${fieldOperations.date} < ${today()})`.mapWith(Number),
      irrigations: sql<number>`count(*) filter (where ${fieldOperations.status} = 'done' and ${fieldOperations.type} = 'irrigation')`.mapWith(Number),
      lastWork: sql<string | null>`max(${fieldOperations.date}) filter (where ${fieldOperations.status} = 'done')`,
    })
    .from(fieldOperations)
    .where(inArray(fieldOperations.cropPlanId, ids))
    .groupBy(fieldOperations.cropPlanId);

  const tons = new Map(harvested.map((h) => [h.planId, h.tons]));
  const work = new Map(operations.map((o) => [o.planId, o]));

  const data = rows.map((row) => {
    const expected = expectedHarvestT(row.areaHa, row.expectedYieldTHa);
    const stats = work.get(row.id);
    return {
      ...row,
      expectedHarvestT: expected,
      planned: expected === null ? null : harvestSplit(expected, row.ownUsePct),
      harvestedT: tons.get(row.id) ?? 0,
      operationsDone: stats?.done ?? 0,
      operationsOverdue: stats?.overdue ?? 0,
      irrigations: stats?.irrigations ?? 0,
      lastWorkDate: stats?.lastWork ?? null,
    };
  });
  return hideMoney(data, ['plannedCost'], 'crops.approve');
}

export async function list(q: z.infer<typeof planListQuery>) {
  const where = and(
    eq(t.farmId, ctx().farmId),
    q.seasonId ? eq(t.seasonId, q.seasonId) : undefined,
    q.fieldId ? eq(t.fieldId, q.fieldId) : undefined,
    q.status ? eq(t.status, q.status) : undefined,
    q.search
      ? inArray(t.fieldId, tx().select({ id: fields.id }).from(fields).where(searchAny(q.search, [fields.number, fields.name])))
      : undefined,
  );
  const page = await paged(q, t, where, (limit, offset) =>
    planQuery()
      .where(where)
      .orderBy(
        ...sortBy(q.sort, { areaHa: t.areaHa, status: t.status, sowingDatePlan: t.sowingDatePlan }, asc(fields.number), t.id),
      )
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: await withProgress(page.data) };
}

export async function get(id: string) {
  const rows = await planQuery().where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!rows[0]) throw notFound('Crop plan');
  return (await withProgress(rows))[0];
}

export const rotationQuery = z.object({
  fieldId: z.uuid(),
  seasonId: z.uuid(),
  cropId: z.uuid(),
  /** The plan being edited, so it is not read as its own predecessor. */
  planId: z.uuid().optional(),
});

/**
 * What the rotation rules say about a crop on a field in a season (formulas/rotation.ts), with the
 * earlier crops they were read from. History is one crop per earlier season, the one on most land,
 * newest first. Notes warn and never block: saving a plan does not depend on them.
 */
export async function rotationCheck(input: z.infer<typeof rotationQuery>) {
  const farmId = ctx().farmId;
  const [season] = await tx()
    .select({ startDate: seasons.startDate })
    .from(seasons)
    .where(and(eq(seasons.id, input.seasonId), eq(seasons.farmId, farmId)));
  if (!season) throw notFound('Season');
  const [crop] = await tx()
    .select({ key: crops.key, family: crops.family })
    .from(crops)
    .where(and(eq(crops.id, input.cropId), eq(crops.tenantId, ctx().tenantId)));
  if (!crop) throw notFound('Crop');

  const earlier = await tx()
    .select({
      seasonId: t.seasonId,
      seasonName: seasons.name,
      cropKey: crops.key,
      cropName: crops.name,
      family: crops.family,
    })
    .from(t)
    .innerJoin(seasons, eq(seasons.id, t.seasonId))
    .innerJoin(crops, eq(crops.id, t.cropId))
    .where(
      and(
        eq(t.farmId, farmId),
        eq(t.fieldId, input.fieldId),
        ne(t.status, 'cancelled'),
        sql`${seasons.startDate} < ${season.startDate}`,
        input.planId ? ne(t.id, input.planId) : undefined,
      ),
    )
    .orderBy(desc(seasons.startDate), desc(t.areaHa), t.id);

  const seen = new Set<string>();
  const history = earlier
    .filter((row) => !seen.has(row.seasonId) && seen.add(row.seasonId))
    .map((row) => ({ key: row.cropKey, family: cropFamilyOf(row.cropKey, row.family), name: row.cropName, seasonName: row.seasonName }));

  const notes: RotationNote[] = rotationNotes({ key: crop.key, family: cropFamilyOf(crop.key, crop.family) }, history);
  return { notes, history: history.slice(0, 3) };
}

async function withRotation(id: string) {
  const plan = await get(id);
  const rotation = await rotationCheck({ fieldId: plan.fieldId, seasonId: plan.seasonId, cropId: plan.cropId, planId: plan.id });
  return { ...plan, rotation };
}

export async function create(input: PlanInput) {
  const c = ctx();
  await assertSeason(input.seasonId);
  const field = await getFieldRow(input.fieldId);
  const areaHa = input.areaHa ?? field.areaHa;
  if (areaHa <= 0) throw badRequest('AREA_REQUIRED', 'Enter the planned area');
  await assertAreaFits(input.fieldId, input.seasonId, areaHa);
  const est = await computeEstimate({ cropId: input.cropId, areaHa, techCardId: input.techCardId });

  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({
      ...(id ? { id } : {}),
      ...values,
      areaHa,
      techCardId: input.techCardId ?? est.techCardId,
      seedRateKgHa: input.seedRateKgHa ?? est.seedRateKgHa,
      expectedYieldTHa: input.expectedYieldTHa ?? est.expectedYieldTHa,
      plannedCost: input.plannedCost ?? est.plannedCost,
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
    })
    .returning();

  await recordEvent({
    type: 'crop_plan.created',
    entityType: 'crop_plan',
    entityId: row.id,
    data: { fieldId: row.fieldId, cropId: row.cropId, seasonId: row.seasonId, areaHa },
  });
  return withRotation(row.id);
}

export async function update(id: string, input: Partial<PlanInput>) {
  const before = await getPlanRow(id);
  const areaHa = input.areaHa ?? before.areaHa;
  const fieldId = input.fieldId ?? before.fieldId;
  const seasonId = input.seasonId ?? before.seasonId;
  if (input.seasonId) await assertSeason(input.seasonId);
  await assertAreaFits(fieldId, seasonId, areaHa, id);

  const { id: _ignored, ...values } = input;
  // Cost follows the card and area unless someone typed one; clearing the field asks for it again.
  const cardChanged = input.techCardId !== undefined && input.techCardId !== before.techCardId;
  const areaChanged = input.areaHa !== undefined && input.areaHa !== before.areaHa;
  const reprice = input.plannedCost === null || (input.plannedCost === undefined && (cardChanged || areaChanged));
  const est = reprice
    ? await computeEstimate({ cropId: input.cropId ?? before.cropId, areaHa, techCardId: input.techCardId ?? before.techCardId })
    : null;

  // Marking a plan sown by hand needs a date, or the next journal refresh would undo it.
  const sownByHand = (input.status === 'sown' || input.status === 'growing') && !before.sowingDateFact;
  await tx()
    .update(t)
    .set({
      ...values,
      ...(est && est.plannedCost !== null ? { plannedCost: est.plannedCost } : {}),
      ...(sownByHand && !input.sowingDateFact ? { sowingDateFact: before.sowingDatePlan ?? today() } : {}),
    })
    .where(eq(t.id, id));
  return withRotation(id);
}

/** A plan with recorded work or harvest answers 409 PLAN_HAS_WORK: cancel it instead. */
export async function remove(id: string) {
  await getPlanRow(id);
  const [work] = await tx()
    .select({ id: fieldOperations.id })
    .from(fieldOperations)
    .where(and(eq(fieldOperations.cropPlanId, id), eq(fieldOperations.status, 'done')))
    .limit(1);
  const [harvest] = await tx().select({ id: harvests.id }).from(harvests).where(eq(harvests.cropPlanId, id)).limit(1);
  if (work || harvest) throw conflict('PLAN_HAS_WORK', 'This plan has recorded work: cancel it instead of deleting');

  await tx().delete(fieldOperations).where(and(eq(fieldOperations.cropPlanId, id), eq(fieldOperations.status, 'planned')));
  await tx().delete(t).where(eq(t.id, id));
  return { id };
}

/**
 * Turn the tech card into planned operations in the journal, dated from sowing.
 * Safe to repeat: a card line already in the journal for this plan is skipped.
 *
 * Once work on the plan has started, the journal already holds what was done before today, so
 * only the card's lines from today on are added, dated from the actual sowing, and never a
 * second sowing. Otherwise a sown field would get its ploughing, sowing and first watering again,
 * all at once overdue.
 */
export async function generateOperations(id: string) {
  const plan = await getPlanRow(id);
  if (!plan.techCardId) throw conflict('PLAN_HAS_NO_TECH_CARD', 'Choose a tech card for this plan first');
  if (!plan.sowingDatePlan) throw conflict('SOWING_DATE_REQUIRED', 'Set the planned sowing date first');
  if (plan.status === 'harvested' || plan.status === 'cancelled') {
    throw conflict('PLAN_CLOSED', 'This plan is harvested or cancelled');
  }
  const card = await techCards.getRow(plan.techCardId);
  const c = ctx();
  const now = today();

  const existing = await tx()
    .select({ type: fieldOperations.type, status: fieldOperations.status, details: fieldOperations.details })
    .from(fieldOperations)
    .where(and(eq(fieldOperations.cropPlanId, id), eq(fieldOperations.farmId, c.farmId)));
  const done = new Set(existing.map((e) => (e.details as { cardLine?: string }).cardLine));
  const doneTypes = new Set(existing.filter((e) => e.status === 'done').map((e) => e.type));
  const started = plan.status !== 'planned' || doneTypes.size > 0;
  const anchor = plan.sowingDateFact ?? plan.sowingDatePlan;

  const rows = card.lines
    .map((line, index) => ({ line, cardLine: `${card.id}:${index}`, date: addDays(anchor, line.offsetDays) }))
    .filter(({ cardLine }) => !done.has(cardLine))
    .filter(({ line, date }) => !started || (date >= now && !(line.type === 'sowing' && doneTypes.has('sowing'))))
    .map(({ line, cardLine, date }) => {
      return {
        tenantId: c.tenantId,
        farmId: c.farmId,
        createdBy: c.userId,
        type: line.type,
        status: 'planned',
        date,
        plannedDate: date,
        fieldId: plan.fieldId,
        cropPlanId: id,
        areaDoneHa: plan.areaHa,
        waterM3: line.waterM3Ha ? round(line.waterM3Ha * plan.areaHa, 2) : null,
        details: { name: line.name, cardLine },
      };
    });
  if (rows.length > 0) await tx().insert(fieldOperations).values(rows);
  return { created: rows.length, total: card.lines.length };
}

/**
 * Recompute a plan's status from the journal after work was added, edited or deleted, so the
 * status cannot drift from what was recorded.
 *
 * A sowing date can also come from outside the journal: Excel import of the autumn sowing, which
 * happened before the platform started (spec 23.1). So it only changes when a sowing record
 * itself changed (`sowingChanged`); an irrigation must not erase it.
 */
export async function refreshPlanStatus(planId: string | null | undefined, sowingChanged = false): Promise<void> {
  if (!planId) return;
  const plan = await getPlanRow(planId);
  if (plan.status === 'cancelled') return;

  const [harvest] = await tx().select({ id: harvests.id }).from(harvests).where(eq(harvests.cropPlanId, planId)).limit(1);
  const [{ firstSowing }] = await tx()
    .select({ firstSowing: sql<string | null>`min(${fieldOperations.date})` })
    .from(fieldOperations)
    .where(
      and(
        eq(fieldOperations.cropPlanId, planId),
        eq(fieldOperations.type, 'sowing'),
        eq(fieldOperations.status, 'done'),
      ),
    );

  const sowingDateFact = sowingChanged ? firstSowing : (firstSowing ?? plan.sowingDateFact);
  const status = harvest ? 'harvested' : !sowingDateFact ? 'planned' : plan.status === 'growing' ? 'growing' : 'sown';
  await tx().update(t).set({ status, sowingDateFact }).where(eq(t.id, planId));
}

/** The plan a piece of field work belongs to: the one named, or the field's plan on that date. */
export async function resolvePlanId(fieldId: string, date: string, explicit?: string | null): Promise<string | null> {
  if (explicit) {
    const plan = await getPlanRow(explicit);
    if (plan.fieldId !== fieldId) throw badRequest('PLAN_FIELD_MISMATCH', 'This plan belongs to another field');
    return plan.id;
  }
  const [match] = await tx()
    .select({ id: t.id })
    .from(t)
    .innerJoin(seasons, eq(seasons.id, t.seasonId))
    .where(
      and(
        eq(t.fieldId, fieldId),
        ne(t.status, 'cancelled'),
        sql`${seasons.startDate} <= ${date} and ${seasons.endDate} >= ${date}`,
      ),
    )
    .orderBy(desc(seasons.startDate))
    .limit(1);
  return match?.id ?? null;
}
