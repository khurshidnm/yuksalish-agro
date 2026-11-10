import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { IRRIGATION_NODE_TYPES } from '@yap/shared';
import { waterLimitUsePercent } from '@yap/shared/formulas/land';
import { ctx, today, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy, sumOf } from '../../core/query';
import { schema } from '../../db/client';
import { networkGeometry } from './geometry';

const { fieldOperations, fields, irrigationNodes: t } = schema;

export const irrigationInput = z.object({
  id: clientId,
  type: z.enum(IRRIGATION_NODE_TYPES),
  name: z.string().trim().min(1).max(120),
  capacityM3h: z.number().min(0).nullish(),
  limitM3: z.number().min(0).nullish(),
  geometry: networkGeometry.nullish(),
  fieldIds: z.array(z.uuid()).max(500).default([]),
  notes: z.string().trim().max(1000).nullish(),
});
export type IrrigationInput = z.input<typeof irrigationInput>;

export const irrigationPatch = irrigationInput.omit({ id: true }).partial().extend({
  fieldIds: z.array(z.uuid()).max(500).optional(),
});

export const irrigationListQuery = listQuery.extend({
  /** Period for actual water use. Defaults to the current calendar year. */
  from: isoDate.optional(),
  to: isoDate.optional(),
});

async function assertFields(fieldIds: string[] | undefined): Promise<void> {
  if (!fieldIds?.length) return;
  const found = await tx()
    .select({ id: fields.id })
    .from(fields)
    .where(and(eq(fields.farmId, ctx().farmId), inArray(fields.id, fieldIds)));
  if (found.length !== new Set(fieldIds).size) throw badRequest('INVALID_FIELD', 'A linked field was not found');
}

/** Work that draws water from the network: watering a crop, and washing salts out of the soil. */
const WATER_USE_TYPES = ['irrigation', 'leaching'];

/** Water actually applied per field in a period, from the irrigation and leaching journal. */
async function waterByField(from: string, to: string): Promise<Map<string, number>> {
  const rows = await tx()
    .select({ fieldId: fieldOperations.fieldId, waterM3: sumOf(fieldOperations.waterM3) })
    .from(fieldOperations)
    .where(
      and(
        eq(fieldOperations.farmId, ctx().farmId),
        inArray(fieldOperations.type, WATER_USE_TYPES),
        eq(fieldOperations.status, 'done'),
        gte(fieldOperations.date, from),
        lte(fieldOperations.date, to),
      ),
    )
    .groupBy(fieldOperations.fieldId);
  return new Map(rows.map((r) => [r.fieldId, r.waterM3]));
}

/** Limit against actual use for every node (spec 6.1.5). */
export async function listIrrigation(q: z.infer<typeof irrigationListQuery>) {
  const year = today().slice(0, 4);
  const from = q.from ?? `${year}-01-01`;
  const to = q.to ?? `${year}-12-31`;
  const where = and(eq(t.farmId, ctx().farmId), searchAny(q.search, [t.name, t.notes]));
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select()
      .from(t)
      .where(where)
      .orderBy(...sortBy(q.sort, { name: t.name, type: t.type }, [asc(t.type), asc(t.name)], t.id))
      .limit(limit)
      .offset(offset),
  );
  const water = await waterByField(from, to);
  return {
    ...page,
    data: page.data.map((node) => {
      const actualM3 = node.fieldIds.reduce((sum, id) => sum + (water.get(id) ?? 0), 0);
      return {
        ...node,
        period: { from, to },
        actualM3,
        usedPercent: waterLimitUsePercent(actualM3, node.limitM3),
        overLimit: node.limitM3 != null && node.limitM3 > 0 && actualM3 > node.limitM3,
      };
    }),
  };
}

async function getNode(id: string) {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Irrigation node');
  return row;
}

export async function createIrrigation(input: z.infer<typeof irrigationInput>) {
  await assertFields(input.fieldIds);
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({ type: 'irrigation.created', entityType: 'irrigation_node', entityId: row.id, data: { name: row.name, type: row.type } });
  return row;
}

export async function updateIrrigation(id: string, input: z.infer<typeof irrigationPatch>) {
  await getNode(id);
  await assertFields(input.fieldIds);
  const [row] = await tx().update(t).set(input).where(eq(t.id, id)).returning();
  return row;
}

export async function removeIrrigation(id: string) {
  const node = await getNode(id);
  await tx().delete(t).where(eq(t.id, id));
  await recordEvent({ type: 'irrigation.deleted', entityType: 'irrigation_node', entityId: id, data: { name: node.name } });
  return { id };
}
