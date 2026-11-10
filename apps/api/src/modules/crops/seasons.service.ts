import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CROP_FAMILIES } from '@yap/shared';
import { TYPICAL_REMOVAL_KG_T } from '@yap/shared/formulas/fertiliser';
import { TYPICAL_CROP_FAMILY } from '@yap/shared/formulas/rotation';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate } from '../../core/query';

const { cropPlans, crops, harvests, seasons: t } = schema;

export const SEASON_KINDS = ['autumn', 'spring', 'summer'] as const;

export const seasonInput = z.object({
  id: clientId,
  name: z.string().trim().min(1).max(120),
  kind: z.enum(SEASON_KINDS),
  startDate: isoDate,
  endDate: isoDate,
  isCurrent: z.boolean().optional(),
});
export type SeasonInput = z.infer<typeof seasonInput>;

type Season = typeof t.$inferSelect;

function assertRange(startDate: string, endDate: string): void {
  if (endDate < startDate) throw badRequest('INVALID_PERIOD', 'The season ends before it starts');
}

/** The season work is happening in: flagged by the user, otherwise the one containing today. */
function pickCurrent(rows: Season[], date: string): Season | undefined {
  return rows.find((s) => s.isCurrent) ?? rows.find((s) => s.startDate <= date && date <= s.endDate);
}

async function seasonRows() {
  const rows = await tx()
    .select()
    .from(t)
    .where(eq(t.farmId, ctx().farmId))
    .orderBy(desc(t.startDate));
  const current = pickCurrent(rows, today());
  return rows.map((row) => ({ ...row, isCurrent: row.id === current?.id }));
}

/**
 * Seasons, newest first. Each carries the date of its last harvest, so the harvest page can open
 * on the season that has a crop in instead of a current season with nothing harvested yet.
 */
export async function list() {
  const rows = await seasonRows();
  const last = await tx()
    .select({ seasonId: cropPlans.seasonId, date: sql<string>`max(${harvests.date})::text` })
    .from(harvests)
    .innerJoin(cropPlans, eq(cropPlans.id, harvests.cropPlanId))
    .where(eq(harvests.farmId, ctx().farmId))
    .groupBy(cropPlans.seasonId);
  const lastHarvest = new Map(last.map((row) => [row.seasonId, row.date]));
  return rows.map((row) => ({ ...row, lastHarvestDate: lastHarvest.get(row.id) ?? null }));
}

export async function currentSeason(): Promise<Season | null> {
  const rows = await seasonRows();
  return rows.find((s) => s.isCurrent) ?? rows[0] ?? null;
}

/** One season of this farm; 404 for any other id. */
export async function getSeason(id: string): Promise<Season> {
  return getRow(id);
}

async function clearCurrent(exceptId?: string): Promise<void> {
  await tx()
    .update(t)
    .set({ isCurrent: false })
    .where(and(eq(t.farmId, ctx().farmId), eq(t.isCurrent, true), exceptId ? ne(t.id, exceptId) : undefined));
}

export async function create(input: SeasonInput) {
  assertRange(input.startDate, input.endDate);
  const c = ctx();
  if (input.isCurrent) await clearCurrent();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  return row;
}

async function getRow(id: string): Promise<Season> {
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Season');
  return row;
}

export async function update(id: string, input: Partial<SeasonInput>) {
  const before = await getRow(id);
  assertRange(input.startDate ?? before.startDate, input.endDate ?? before.endDate);
  if (input.isCurrent) await clearCurrent(id);
  const { id: _ignored, ...values } = input;
  const [row] = await tx().update(t).set(values).where(eq(t.id, id)).returning();
  return row;
}

/** A season with plans answers 409 IN_USE. */
export async function remove(id: string) {
  await getRow(id);
  await tx().delete(t).where(eq(t.id, id));
  return { id };
}

// ─── Crops reference ───────────────────────────────────────────────────────

const nameSchema = z.object({
  uz: z.string().trim().min(1).max(120),
  ru: z.string().trim().min(1).max(120),
  en: z.string().trim().min(1).max(120),
});

export const cropInput = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{2,40}$/),
  name: nameSchema,
  isFeed: z.boolean().optional(),
  defaultYieldTHa: z.number().min(0).nullish(),
  /** Place in the rotation. Null falls back to the typical family for the key. */
  family: z.enum(CROP_FAMILIES).nullish(),
  /** Nutrients one tonne of produce takes from the field, kg/t. Null falls back to the typical figure. */
  removalNKgT: z.number().min(0).max(500).nullish(),
  removalP2o5KgT: z.number().min(0).max(500).nullish(),
  removalK2oKgT: z.number().min(0).max(500).nullish(),
});

/** What can be changed on a crop later. The key stays: plans, feeds and rules are filed under it. */
export const cropPatch = cropInput.omit({ key: true }).partial();

function cropRow(row: typeof crops.$inferSelect) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    isFeed: row.isFeed,
    defaultYieldTHa: row.defaultYieldTHa === null ? null : Number(row.defaultYieldTHa),
    family: row.family,
    removalNKgT: row.removalNKgT,
    removalP2o5KgT: row.removalP2o5KgT,
    removalK2oKgT: row.removalK2oKgT,
    /** Reference values used while the farm's own are empty, so the form can show them as typical. */
    typical: { family: TYPICAL_CROP_FAMILY[row.key] ?? null, removal: TYPICAL_REMOVAL_KG_T[row.key] ?? null },
  };
}

export async function listCrops() {
  const rows = await tx()
    .select()
    .from(crops)
    .where(and(eq(crops.tenantId, ctx().tenantId), eq(crops.active, true)))
    .orderBy(asc(crops.key));
  return rows.map(cropRow);
}

export async function createCrop(input: z.infer<typeof cropInput>) {
  const [row] = await tx()
    .insert(crops)
    .values({
      tenantId: ctx().tenantId,
      key: input.key,
      name: input.name,
      isFeed: input.isFeed ?? false,
      defaultYieldTHa: input.defaultYieldTHa === null || input.defaultYieldTHa === undefined ? null : String(input.defaultYieldTHa),
      family: input.family ?? null,
      removalNKgT: input.removalNKgT ?? null,
      removalP2o5KgT: input.removalP2o5KgT ?? null,
      removalK2oKgT: input.removalK2oKgT ?? null,
    })
    .returning();
  return cropRow(row);
}

export async function updateCrop(id: string, input: z.infer<typeof cropPatch>) {
  await getCrop(id);
  const { defaultYieldTHa, ...rest } = input;
  const [row] = await tx()
    .update(crops)
    .set({
      ...rest,
      ...(defaultYieldTHa === undefined ? {} : { defaultYieldTHa: defaultYieldTHa === null ? null : String(defaultYieldTHa) }),
    })
    .where(and(eq(crops.id, id), eq(crops.tenantId, ctx().tenantId)))
    .returning();
  await recordEvent({ type: 'crop.updated', entityType: 'crop', entityId: id, data: { key: row.key, changed: Object.keys(input) } });
  return cropRow(row);
}

export async function getCrop(id: string) {
  const [row] = await tx()
    .select()
    .from(crops)
    .where(and(eq(crops.id, id), eq(crops.tenantId, ctx().tenantId)));
  if (!row) throw notFound('Crop');
  return cropRow(row);
}
