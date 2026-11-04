import { and, desc, eq, getTableColumns, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { getItemOrThrow, receiveStock, reverseMovements } from '../../core/inventory';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate, listQuery, paged, sortBy, sumOf } from '../../core/query';
import { assertInFarm, assertNotFuture, getAnimalOrThrow, getHerdOrThrow } from './refs';

const { animals, herds, shearingRecords: t, warehouses } = schema;

export const shearingInput = z.object({
  id: clientId,
  /** One animal, or the total of a herd sheared together. */
  animalId: z.uuid().nullish(),
  herdId: z.uuid().nullish(),
  date: isoDate.optional(),
  woolKg: z.number().positive().max(100_000),
  quality: z.string().trim().max(60).nullish(),
  itemId: z.uuid(),
  warehouseId: z.uuid(),
  notes: z.string().max(500).nullish(),
});

export const shearingListQuery = listQuery.extend({
  herdId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export async function createShearing(input: z.infer<typeof shearingInput>) {
  const c = ctx();
  const date = input.date ?? today();
  assertNotFuture(date);
  if (!input.animalId && !input.herdId) throw badRequest('TARGET_REQUIRED', 'Choose an animal or a herd');

  const animal = input.animalId ? await getAnimalOrThrow(input.animalId) : null;
  if (input.herdId) await getHerdOrThrow(input.herdId);
  const item = await getItemOrThrow(input.itemId);
  await assertInFarm(warehouses, input.warehouseId, 'Warehouse');

  const [record] = await tx()
    .insert(t)
    .values({
      ...(input.id ? { id: input.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      animalId: input.animalId,
      herdId: input.herdId ?? animal?.herdId,
      date,
      woolKg: input.woolKg,
      quality: input.quality,
      notes: input.notes,
    })
    .returning();

  // Wool is valued at the internal transfer price: its cost already sits on the herd.
  const { batch } = await receiveStock({
    itemId: input.itemId,
    warehouseId: input.warehouseId,
    qty: input.woolKg,
    unitCost: item.transferPrice ?? 0,
    date,
    source: 'own_harvest',
    refType: 'shearing',
    refId: record.id,
    notes: input.quality,
  });
  const [row] = await tx().update(t).set({ batchId: batch.id }).where(eq(t.id, record.id)).returning();
  await recordEvent({
    type: 'animal.sheared',
    entityType: animal ? 'animal' : 'herd',
    entityId: input.animalId ?? input.herdId,
    occurredAt: date,
    data: { woolKg: input.woolKg, quality: input.quality },
  });
  return row;
}

export async function listShearing(q: z.infer<typeof shearingListQuery>) {
  const where = and(
    eq(t.farmId, ctx().farmId),
    q.herdId ? eq(t.herdId, q.herdId) : undefined,
    q.from ? gte(t.date, q.from) : undefined,
    q.to ? lte(t.date, q.to) : undefined,
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select({ ...getTableColumns(t), tag: animals.tag, herdName: herds.name })
      .from(t)
      .leftJoin(animals, eq(animals.id, t.animalId))
      .leftJoin(herds, eq(herds.id, t.herdId))
      .where(where)
      .orderBy(...sortBy(q.sort, { date: t.date, woolKg: t.woolKg }, desc(t.date), t.id))
      .limit(limit)
      .offset(offset),
  );
  const [total] = await tx().select({ woolKg: sumOf(t.woolKg) }).from(t).where(where);
  return { data: page.data, meta: { ...page.meta, totalWoolKg: total.woolKg } };
}

export async function deleteShearing(id: string) {
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Shearing record');
  await reverseMovements('shearing', id);
  await tx().delete(t).where(eq(t.id, id));
  return { id };
}
