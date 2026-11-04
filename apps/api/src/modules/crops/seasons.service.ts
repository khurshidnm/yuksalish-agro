import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { clientId, isoDate } from '../../core/query';

const { crops, seasons: t } = schema;

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

export async function list() {
  const rows = await tx()
    .select()
    .from(t)
    .where(eq(t.farmId, ctx().farmId))
    .orderBy(desc(t.startDate));
  const current = pickCurrent(rows, today());
  return rows.map((row) => ({ ...row, isCurrent: row.id === current?.id }));
}

export async function currentSeason(): Promise<Season | null> {
  const rows = await list();
  return rows.find((s) => s.isCurrent) ?? rows[0] ?? null;
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
});

function cropRow(row: typeof crops.$inferSelect) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    isFeed: row.isFeed,
    defaultYieldTHa: row.defaultYieldTHa === null ? null : Number(row.defaultYieldTHa),
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
    })
    .returning();
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
