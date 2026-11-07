import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { LAND_USES, round, yieldPerHectare } from '@yap/shared';
import { ctx, today, tx } from '../../core/context';
import { deactivateCostCenter, ensureCostCenter, renameCostCenter } from '../../core/costCenters';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, listQuery, paged, searchAny, sortBy, sumOf } from '../../core/query';
import { schema } from '../../db/client';
import { areaGeometry, measureBoundary } from './geometry';

const { costCenters, cropPlans, crops, fields: t, harvests, seasons } = schema;

const textField = (max: number) => z.string().trim().max(max).nullish();

export const fieldInput = z.object({
  id: clientId,
  number: z.string().trim().min(1).max(20),
  name: textField(120),
  landUse: z.enum(LAND_USES).default('arable'),
  /** Entered by hand. Ignored when a boundary is saved: then PostGIS measures the area. */
  areaHa: z.number().positive().max(10_000_000).nullish(),
  boundary: areaGeometry.nullish(),
  soilType: textField(80),
  salinityLevel: textField(40),
  irrigationSource: textField(120),
  notes: textField(1000),
});
export type FieldInput = z.input<typeof fieldInput>;

export const fieldPatch = fieldInput.omit({ id: true }).partial().extend({
  landUse: z.enum(LAND_USES).optional(),
});
export type FieldPatch = z.input<typeof fieldPatch>;

export const fieldListQuery = listQuery.extend({
  landUse: z.enum(LAND_USES).optional(),
  status: z.enum(['active', 'archived']).default('active'),
});

type Field = typeof t.$inferSelect;

/** The cost center and reports need a label in every language; the number is one. */
export function fieldLabel(field: Pick<Field, 'number' | 'name'>): string {
  return field.name ? `№${field.number} ${field.name}` : `№${field.number}`;
}

/** Land people spend money on, such as a pasture's fence or water. A yard or a road is overhead: it goes to the general center. */
const HAS_COST_CENTER: readonly string[] = ['arable', 'pasture', 'reserve'];

async function assertNumberFree(number: string, exceptId?: string): Promise<void> {
  const [taken] = await tx()
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.farmId, ctx().farmId), eq(t.number, number), exceptId ? ne(t.id, exceptId) : undefined));
  if (taken) throw conflict('FIELD_NUMBER_TAKEN', `Field number ${number} is already in use`, { number });
}

/** Computes the area and creates the cost center (docs/contracts.md). */
export async function createField(input: FieldInput): Promise<Field> {
  const c = ctx();
  await assertNumberFree(input.number);

  let areaHa: number;
  if (input.boundary) areaHa = await measureBoundary(input.boundary);
  else if (input.areaHa) areaHa = input.areaHa;
  else throw badRequest('AREA_REQUIRED', 'Draw the field on the map or enter its area');

  const { id, boundary, areaHa: _manual, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({
      ...(id ? { id } : {}),
      ...values,
      areaHa,
      boundary: boundary ?? null,
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
    })
    .returning();

  let field = row;
  if (HAS_COST_CENTER.includes(row.landUse)) {
    const costCenterId = await ensureCostCenter('field', row.id, fieldLabel(row));
    [field] = await tx().update(t).set({ costCenterId }).where(eq(t.id, row.id)).returning();
  }
  await recordEvent({
    type: 'field.created',
    entityType: 'field',
    entityId: row.id,
    data: { number: row.number, areaHa, landUse: row.landUse },
  });
  return field;
}

/** Plans still relevant to a field: the current season first, otherwise what is planned next. */
async function currentPlans(fieldIds: string[]) {
  const result = new Map<string, Awaited<ReturnType<typeof plansFor>>[number]>();
  if (fieldIds.length === 0) return result;
  for (const plan of await plansFor(fieldIds)) {
    if (result.has(plan.fieldId)) continue;
    if (plan.status === 'harvested' && !plan.isCurrentSeason) continue;
    result.set(plan.fieldId, plan);
  }
  return result;
}

function plansFor(fieldIds: string[]) {
  return tx()
    .select({
      planId: cropPlans.id,
      fieldId: cropPlans.fieldId,
      cropId: cropPlans.cropId,
      cropKey: crops.key,
      cropName: crops.name,
      variety: cropPlans.variety,
      seasonId: seasons.id,
      seasonName: seasons.name,
      isCurrentSeason: seasons.isCurrent,
      status: cropPlans.status,
      areaHa: cropPlans.areaHa,
      sowingDatePlan: cropPlans.sowingDatePlan,
      sowingDateFact: cropPlans.sowingDateFact,
      expectedYieldTHa: cropPlans.expectedYieldTHa,
    })
    .from(cropPlans)
    .innerJoin(seasons, eq(seasons.id, cropPlans.seasonId))
    .innerJoin(crops, eq(crops.id, cropPlans.cropId))
    .where(and(eq(cropPlans.farmId, ctx().farmId), inArray(cropPlans.fieldId, fieldIds), ne(cropPlans.status, 'cancelled')))
    .orderBy(desc(seasons.isCurrent), desc(seasons.startDate), desc(cropPlans.areaHa));
}

export { currentPlans };

const listColumns = {
  id: t.id,
  number: t.number,
  name: t.name,
  landUse: t.landUse,
  areaHa: t.areaHa,
  soilType: t.soilType,
  salinityLevel: t.salinityLevel,
  irrigationSource: t.irrigationSource,
  status: t.status,
  notes: t.notes,
  hasBoundary: sql<boolean>`${t.boundary} is not null`,
  createdAt: t.createdAt,
};

/** Numbers are text ("1", "10", "Y-1"): shorter first gives 2 before 10. */
const naturalOrder = (): SQL[] => [sql`length(${t.number})`, asc(t.number)];

export async function listFields(q: z.infer<typeof fieldListQuery>) {
  const where = and(
    eq(t.farmId, ctx().farmId),
    eq(t.status, q.status),
    q.landUse ? eq(t.landUse, q.landUse) : undefined,
    searchAny(q.search, [t.number, t.name, t.soilType, t.irrigationSource]),
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select(listColumns)
      .from(t)
      .where(where)
      .orderBy(...sortBy(q.sort, { areaHa: t.areaHa, landUse: t.landUse, name: t.name, createdAt: t.createdAt }, naturalOrder(), t.id))
      .limit(limit)
      .offset(offset),
  );
  const plans = await currentPlans(page.data.map((f) => f.id));
  return { ...page, data: page.data.map((f) => ({ ...f, currentCrop: plans.get(f.id) ?? null })) };
}

/** Number and area only, for dropdowns in other modules. */
export async function lookupFields(q: { search?: string; landUse?: (typeof LAND_USES)[number] }) {
  const rows = await tx()
    .select({ id: t.id, number: t.number, label: t.name, areaHa: t.areaHa, landUse: t.landUse })
    .from(t)
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        eq(t.status, 'active'),
        q.landUse ? eq(t.landUse, q.landUse) : undefined,
        searchAny(q.search, [t.number, t.name]),
      ),
    )
    .orderBy(...naturalOrder())
    .limit(50);
  return rows.map(({ label, ...row }) => ({ ...row, name: fieldLabel({ number: row.number, name: label }) }));
}

export async function getField(id: string): Promise<Field> {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Field');
  return row;
}

export async function updateField(id: string, input: FieldPatch): Promise<Field> {
  const field = await getField(id);
  if (input.number !== undefined && input.number !== field.number) await assertNumberFree(input.number, id);

  const { boundary, areaHa: manualArea, ...values } = input;
  const patch: Partial<typeof t.$inferInsert> = { ...values };

  if (boundary) {
    patch.boundary = boundary;
    patch.areaHa = await measureBoundary(boundary);
  } else {
    // Removing the outline keeps the last measured area until someone enters a new one.
    const keepsBoundary = boundary === undefined && field.boundary !== null;
    if (boundary === null) patch.boundary = null;
    if (manualArea != null && manualArea !== field.areaHa) {
      if (keepsBoundary) {
        throw badRequest('AREA_FROM_BOUNDARY', 'The area comes from the map outline; remove the outline to enter it by hand');
      }
      patch.areaHa = manualArea;
    }
  }

  const [row] = await tx().update(t).set(patch).where(eq(t.id, id)).returning();

  if (HAS_COST_CENTER.includes(row.landUse) && !row.costCenterId) {
    const costCenterId = await ensureCostCenter('field', row.id, fieldLabel(row));
    await tx().update(t).set({ costCenterId }).where(eq(t.id, id));
    row.costCenterId = costCenterId;
  } else if (row.costCenterId && (row.number !== field.number || row.name !== field.name)) {
    // Reports show the cost center's name, so it follows a rename.
    await renameCostCenter(row.costCenterId, fieldLabel(row));
  }

  await recordEvent({
    type: 'field.updated',
    entityType: 'field',
    entityId: id,
    data: { number: row.number, areaHa: row.areaHa, previousAreaHa: field.areaHa },
  });
  return row;
}

/**
 * Other contours sharing ground with this one. Their hectares count twice in the land balance,
 * so a save reports this instead of leaving the balance quietly wrong. Touching edges are ignored:
 * below 100 m² is the width of a shared boundary, not an overlap.
 */
export async function overlappingContours(fieldId: string): Promise<{ number: string; overlapHa: number }[]> {
  const result = await tx().execute(sql`
    select other.number,
           ST_Area(ST_Intersection(mine.geom, other.geom)::geography) / 10000 as overlap_ha
    from fields mine
    join fields other on other.farm_id = mine.farm_id and other.id <> mine.id and other.status = 'active'
    where mine.id = ${fieldId} and ST_Intersects(mine.geom, other.geom)`);
  return (result.rows as { number: string; overlap_ha: number }[])
    .map((row) => ({ number: row.number, overlapHa: round(Number(row.overlap_ha), 4) }))
    .filter((row) => row.overlapHa >= 0.01);
}

/** Fields are archived, never deleted: operations and costs keep pointing at them. */
export async function archiveField(id: string): Promise<{ id: string }> {
  const field = await getField(id);
  const [active] = await tx()
    .select({ id: cropPlans.id })
    .from(cropPlans)
    .where(and(eq(cropPlans.fieldId, id), inArray(cropPlans.status, ['planned', 'sown', 'growing'])))
    .limit(1);
  if (active) throw conflict('FIELD_HAS_ACTIVE_CROP', 'This field has a crop in progress');

  await tx().update(t).set({ status: 'archived' }).where(eq(t.id, id));
  if (field.costCenterId) {
    await deactivateCostCenter(field.costCenterId);
  }
  await recordEvent({ type: 'field.archived', entityType: 'field', entityId: id, data: { number: field.number } });
  return { id };
}

/** Last five years of crops on one field, newest first (spec 6.1.3, 6.1.7). */
export async function rotationHistory(fieldId: string) {
  const now = today();
  const since = `${Number(now.slice(0, 4)) - 5}${now.slice(4)}`;
  const plans = await tx()
    .select({
      planId: cropPlans.id,
      seasonId: seasons.id,
      seasonName: seasons.name,
      seasonKind: seasons.kind,
      startDate: seasons.startDate,
      endDate: seasons.endDate,
      cropId: cropPlans.cropId,
      cropKey: crops.key,
      cropName: crops.name,
      variety: cropPlans.variety,
      areaHa: cropPlans.areaHa,
      status: cropPlans.status,
      expectedYieldTHa: cropPlans.expectedYieldTHa,
    })
    .from(cropPlans)
    .innerJoin(seasons, eq(seasons.id, cropPlans.seasonId))
    .innerJoin(crops, eq(crops.id, cropPlans.cropId))
    .where(and(eq(cropPlans.fieldId, fieldId), ne(cropPlans.status, 'cancelled'), sql`${seasons.startDate} >= ${since}`))
    .orderBy(desc(seasons.startDate));

  const totals = await tx()
    .select({ planId: harvests.cropPlanId, harvestT: sumOf(harvests.grossT) })
    .from(harvests)
    .where(eq(harvests.fieldId, fieldId))
    .groupBy(harvests.cropPlanId);
  const harvestByPlan = new Map(totals.map((h) => [h.planId, h.harvestT]));

  return plans.map((plan) => {
    const harvestT = harvestByPlan.get(plan.planId) ?? null;
    return { ...plan, harvestT, yieldTHa: harvestT === null ? null : yieldPerHectare(harvestT, plan.areaHa) };
  });
}
