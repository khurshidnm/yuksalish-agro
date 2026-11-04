import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ctx, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate } from '../../core/query';
import { schema } from '../../db/client';
import { getField } from './fields.service';

const { files, soilAnalyses: t } = schema;

const measure = z.number().min(0).max(1_000_000).nullish();

export const soilInput = z.object({
  id: clientId,
  date: isoDate,
  n: measure,
  p: measure,
  k: measure,
  ph: z.number().min(0).max(14).nullish(),
  humus: z.number().min(0).max(100).nullish(),
  salinity: measure,
  lab: z.string().trim().max(160).nullish(),
  fileId: z.uuid().nullish(),
  notes: z.string().trim().max(1000).nullish(),
});
export type SoilInput = z.infer<typeof soilInput>;

async function assertFile(fileId: string | null | undefined): Promise<void> {
  if (!fileId) return;
  const [file] = await tx().select({ id: files.id }).from(files).where(and(eq(files.id, fileId), eq(files.farmId, ctx().farmId)));
  if (!file) throw badRequest('FILE_NOT_FOUND', 'The attached file was not found');
}

/** Oldest first, ready for a trend chart (spec 6.1.8). */
export async function listSoil(fieldId: string) {
  await getField(fieldId);
  return tx().select().from(t).where(eq(t.fieldId, fieldId)).orderBy(asc(t.date), asc(t.id));
}

export async function createSoil(fieldId: string, input: SoilInput) {
  await getField(fieldId);
  await assertFile(input.fileId);
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, fieldId, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({ type: 'field.soil_analysed', entityType: 'field', entityId: fieldId, occurredAt: input.date, data: { analysisId: row.id } });
  return row;
}

async function getSoil(id: string) {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Soil analysis');
  return row;
}

export async function updateSoil(id: string, input: Partial<SoilInput>) {
  await getSoil(id);
  await assertFile(input.fileId);
  const { id: _ignored, ...values } = input;
  const [row] = await tx().update(t).set(values).where(eq(t.id, id)).returning();
  return row;
}

export async function removeSoil(id: string) {
  const row = await getSoil(id);
  await tx().delete(t).where(eq(t.id, id));
  await recordEvent({ type: 'field.soil_analysis_deleted', entityType: 'field', entityId: row.fieldId, data: { analysisId: id, date: row.date } });
  return { id };
}
