import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { WAREHOUSE_TYPES } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { hideMoney } from '../../core/privacy';
import { clientId, listQuery, paged, searchAny, sortBy } from '../../core/query';

const { facilities, stockBatches, warehouses: t } = schema;

export const warehouseInput = z.object({
  id: clientId,
  name: z.string().trim().min(1).max(120),
  type: z.enum(WAREHOUSE_TYPES),
  facilityId: z.uuid().nullish(),
  notes: z.string().max(1000).nullish(),
});
export type WarehouseInput = z.infer<typeof warehouseInput>;

export const warehouseListQuery = listQuery.extend({ type: z.enum(WAREHOUSE_TYPES).optional() });

export async function list(q: z.infer<typeof warehouseListQuery>) {
  const stock = tx()
    .select({
      warehouseId: stockBatches.warehouseId,
      positions: sql<number>`count(distinct ${stockBatches.itemId})`.mapWith(Number).as('positions'),
      value: sql<number>`sum(${stockBatches.qtyRemaining} * ${stockBatches.unitCost})`.mapWith(Number).as('value'),
    })
    .from(stockBatches)
    .where(and(eq(stockBatches.farmId, ctx().farmId), sql`${stockBatches.qtyRemaining} > 0`))
    .groupBy(stockBatches.warehouseId)
    .as('stock');

  const where = and(
    eq(t.farmId, ctx().farmId),
    eq(t.active, true),
    q.type ? eq(t.type, q.type) : undefined,
    searchAny(q.search, [t.name]),
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select({
        id: t.id,
        name: t.name,
        type: t.type,
        facilityId: t.facilityId,
        notes: t.notes,
        createdAt: t.createdAt,
        positions: sql<number>`coalesce(${stock.positions}, 0)`.mapWith(Number),
        value: sql<number>`coalesce(${stock.value}, 0)`.mapWith(Number),
      })
      .from(t)
      .leftJoin(stock, eq(stock.warehouseId, t.id))
      .where(where)
      .orderBy(...sortBy(q.sort, { name: t.name, type: t.type }, asc(t.name), t.id))
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: hideMoney(page.data, ['value']) };
}

export async function lookup(q: { search?: string; type?: (typeof WAREHOUSE_TYPES)[number] }) {
  return tx()
    .select({ id: t.id, name: t.name, type: t.type })
    .from(t)
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        eq(t.active, true),
        q.type ? eq(t.type, q.type) : undefined,
        searchAny(q.search, [t.name]),
      ),
    )
    .orderBy(asc(t.name))
    .limit(50);
}

export async function get(id: string) {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Warehouse');
  return row;
}

/** Foreign key checks ignore RLS, so confirm the facility belongs to this farm. */
async function assertFacility(facilityId?: string | null) {
  if (!facilityId) return;
  const [row] = await tx()
    .select({ id: facilities.id })
    .from(facilities)
    .where(and(eq(facilities.id, facilityId), eq(facilities.farmId, ctx().farmId)));
  if (!row) throw notFound('Facility');
}

export async function create(input: WarehouseInput) {
  await assertFacility(input.facilityId);
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({ type: 'warehouse.created', entityType: 'warehouse', entityId: row.id, data: { name: row.name } });
  return row;
}

export async function update(id: string, input: Partial<WarehouseInput>) {
  const { id: _ignored, ...values } = input;
  if (Object.values(values).every((v) => v === undefined)) return get(id);
  await assertFacility(values.facilityId);
  const [row] = await tx()
    .update(t)
    .set(values)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)))
    .returning();
  if (!row) throw notFound('Warehouse');
  return row;
}

/** Soft delete: movements keep pointing at the warehouse. Stock must be moved out first. */
export async function remove(id: string) {
  await get(id);
  const [stock] = await tx()
    .select({ qty: sql<number>`coalesce(sum(${stockBatches.qtyRemaining}), 0)`.mapWith(Number) })
    .from(stockBatches)
    .where(and(eq(stockBatches.farmId, ctx().farmId), eq(stockBatches.warehouseId, id)));
  if (stock.qty > 0) throw conflict('WAREHOUSE_HAS_STOCK', 'Move the remaining stock out of this warehouse first');
  await tx()
    .update(t)
    .set({ active: false })
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  await recordEvent({ type: 'warehouse.archived', entityType: 'warehouse', entityId: id });
  return { id };
}
