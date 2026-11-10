import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { groundwaterRisk } from '@yap/shared/formulas/salinity';
import { ctx, tx } from '../../core/context';
import { notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate } from '../../core/query';
import { schema } from '../../db/client';
import { getField } from './fields.service';

const { groundwaterObservations: t } = schema;

export const groundwaterInput = z.object({
  id: clientId,
  date: isoDate,
  /** Depth from the surface to the water, m. */
  depthM: z.number().min(0).max(200),
  /** Salt content of the water, g/l. */
  mineralisationGl: z.number().min(0).max(400).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});
export type GroundwaterInput = z.infer<typeof groundwaterInput>;

type Row = typeof t.$inferSelect;

/** The depth judged against the published critical range; mineralisation is passed on as measured. */
const view = (row: Row) => ({
  id: row.id,
  fieldId: row.fieldId,
  date: row.date,
  depthM: row.depthM,
  mineralisationGl: row.mineralisationGl,
  notes: row.notes,
  risk: groundwaterRisk(row.depthM),
});

/** Oldest first, ready for a chart. */
export async function listGroundwater(fieldId: string) {
  await getField(fieldId);
  const rows = await tx()
    .select()
    .from(t)
    .where(and(eq(t.fieldId, fieldId), eq(t.farmId, ctx().farmId)))
    .orderBy(asc(t.date), asc(t.id));
  return rows.map(view);
}

export async function createGroundwater(fieldId: string, input: GroundwaterInput) {
  await getField(fieldId);
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, fieldId, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({
    type: 'field.groundwater_observed',
    entityType: 'field',
    entityId: fieldId,
    occurredAt: input.date,
    data: { observationId: row.id, depthM: row.depthM, mineralisationGl: row.mineralisationGl },
  });
  return view(row);
}

async function getRow(id: string): Promise<Row> {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Groundwater observation');
  return row;
}

export async function updateGroundwater(id: string, input: Partial<GroundwaterInput>) {
  const before = await getRow(id);
  const { id: _ignored, ...values } = input;
  if (Object.values(values).every((v) => v === undefined)) return view(before);
  const [row] = await tx()
    .update(t)
    .set(values)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)))
    .returning();
  await recordEvent({
    type: 'field.groundwater_corrected',
    entityType: 'field',
    entityId: row.fieldId,
    occurredAt: row.date,
    data: { observationId: id, depthM: row.depthM, mineralisationGl: row.mineralisationGl },
  });
  return view(row);
}

export async function removeGroundwater(id: string) {
  const row = await getRow(id);
  await tx().delete(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  await recordEvent({
    type: 'field.groundwater_deleted',
    entityType: 'field',
    entityId: row.fieldId,
    data: { observationId: id, date: row.date, depthM: row.depthM },
  });
  return { id };
}
