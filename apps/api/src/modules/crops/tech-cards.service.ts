import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { OPERATION_TYPES } from '@yap/shared';
import { techCardNorms } from '@yap/shared/formulas/crops';
import { schema } from '../../db/client';
import { canSeeMoney, ctx, tx } from '../../core/context';
import { notFound } from '../../core/errors';
import { clientId } from '../../core/query';

const { crops, techCards: t } = schema;

const lineInput = z.object({
  type: z.enum(OPERATION_TYPES),
  name: z.string().trim().min(1).max(160),
  /** Days from the planned sowing date; negative for work before sowing. */
  offsetDays: z.number().int().min(-365).max(730),
  seedKgHa: z.number().min(0).optional(),
  fertilizerKgHa: z.number().min(0).optional(),
  waterM3Ha: z.number().min(0).optional(),
  laborDaysHa: z.number().min(0).optional(),
  costPerHa: z.number().min(0).optional(),
});

export const techCardInput = z.object({
  id: clientId,
  cropId: z.uuid(),
  name: z.string().trim().min(1).max(160),
  lines: z.array(lineInput).max(60),
  expectedYieldTHa: z.number().min(0).nullish(),
});
export type TechCardInput = z.infer<typeof techCardInput>;

type Row = typeof t.$inferSelect;

/** Line costs are money too (CLAUDE.md rule 7). */
function present(rows: Row[]) {
  const money = canSeeMoney('crops.approve');
  return rows.map((row) => {
    const { costPerHa, ...norms } = techCardNorms(row.lines);
    return {
      ...row,
      norms,
      costPerHa: money ? costPerHa : null,
      lines: money ? row.lines : row.lines.map(({ costPerHa: _hidden, ...line }) => line),
    };
  });
}

/**
 * An agronomist edits a card without seeing its prices, so the lines they send carry none.
 * Keep the stored price of each line instead of wiping it.
 */
function keepHiddenCosts(previous: Row['lines'], next: TechCardInput['lines']): TechCardInput['lines'] {
  if (canSeeMoney('crops.approve')) return next;
  const stored = new Map(previous.map((line) => [`${line.type}:${line.name}`, line.costPerHa]));
  return next.map((line) => ({ ...line, costPerHa: stored.get(`${line.type}:${line.name}`) }));
}

export async function list(cropId?: string) {
  const rows = await tx()
    .select()
    .from(t)
    .where(and(eq(t.tenantId, ctx().tenantId), cropId ? eq(t.cropId, cropId) : undefined))
    .orderBy(asc(t.name));
  return present(rows);
}

export async function getRow(id: string): Promise<Row> {
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, ctx().tenantId)));
  if (!row) throw notFound('Tech card');
  return row;
}

export const get = async (id: string) => present([await getRow(id)])[0];

/** The card for a crop when the plan does not name one. */
export async function findForCrop(cropId: string): Promise<Row | null> {
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.tenantId, ctx().tenantId), eq(t.cropId, cropId)))
    .orderBy(asc(t.createdAt))
    .limit(1);
  return row ?? null;
}

async function assertCrop(cropId: string): Promise<void> {
  const [row] = await tx()
    .select({ id: crops.id })
    .from(crops)
    .where(and(eq(crops.id, cropId), eq(crops.tenantId, ctx().tenantId)));
  if (!row) throw notFound('Crop');
}

export async function create(input: TechCardInput) {
  await assertCrop(input.cropId);
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: ctx().tenantId })
    .returning();
  return present([row])[0];
}

export async function update(id: string, input: Partial<TechCardInput>) {
  const before = await getRow(id);
  if (input.cropId) await assertCrop(input.cropId);
  const { id: _ignored, ...values } = input;
  const lines = values.lines ? keepHiddenCosts(before.lines, values.lines) : undefined;
  const [row] = await tx()
    .update(t)
    .set({ ...values, ...(lines ? { lines } : {}) })
    .where(eq(t.id, id))
    .returning();
  return present([row])[0];
}

export async function remove(id: string) {
  await getRow(id);
  await tx().delete(t).where(eq(t.id, id));
  return { id };
}
