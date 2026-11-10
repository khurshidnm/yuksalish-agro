import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ITEM_CATEGORIES, UNITS } from '@yap/shared';
import { schema } from '../../db/client';
import { canSeeMoney, ctx, tx } from '../../core/context';
import { conflict, notFound } from '../../core/errors';
import { getItemOrThrow, stockOnHand } from '../../core/inventory';
import { recordEvent } from '../../core/journal';
import { hideMoney } from '../../core/privacy';
import { clientId, listQuery, paged, searchAny, sortBy, sumOf } from '../../core/query';

const { crops, items: t, stockBatches, warehouses } = schema;

export const itemInput = z.object({
  id: clientId,
  name: z.string().trim().min(1).max(200),
  category: z.enum(ITEM_CATEGORIES),
  unit: z.enum(UNITS),
  sku: z.string().trim().max(60).nullish(),
  barcode: z.string().trim().max(60).nullish(),
  dryMatterPct: z.number().min(0).max(100).nullish(),
  meMjPerKgDm: z.number().min(0).max(40).nullish(),
  crudeProteinPctDm: z.number().min(0).max(100).nullish(),
  calciumGPerKgDm: z.number().min(0).max(1000).nullish(),
  phosphorusGPerKgDm: z.number().min(0).max(1000).nullish(),
  isRoughage: z.boolean().nullish(),
  /** Fertiliser nutrients, percent of the product as sold. */
  nPct: z.number().min(0).max(100).nullish(),
  p2o5Pct: z.number().min(0).max(100).nullish(),
  k2oPct: z.number().min(0).max(100).nullish(),
  minQty: z.number().min(0).nullish(),
  minDays: z.number().min(0).nullish(),
  defaultWarehouseId: z.uuid().nullish(),
  withdrawalDays: z.number().int().min(0).nullish(),
  transferPrice: z.number().min(0).nullish(),
  kgPerUnit: z.number().positive().nullish(),
  cropId: z.uuid().nullish(),
  notes: z.string().max(1000).nullish(),
});
export type ItemInput = z.infer<typeof itemInput>;

/** `category` accepts one value or a comma-separated list, e.g. `vaccine,vet_drug`. */
const categoryList = z
  .string()
  .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
  .pipe(z.array(z.enum(ITEM_CATEGORIES)));

export const itemListQuery = listQuery.extend({ category: categoryList.optional() });
export const itemLookupQuery = z.object({
  search: z.string().trim().optional(),
  category: categoryList.optional(),
  warehouseId: z.uuid().optional(),
});

/** Quantity on hand per item, optionally in one warehouse. */
function stockSubquery(warehouseId?: string) {
  return tx()
    .select({
      itemId: stockBatches.itemId,
      qty: sumOf(stockBatches.qtyRemaining).as('qty'),
    })
    .from(stockBatches)
    .where(
      and(
        eq(stockBatches.farmId, ctx().farmId),
        warehouseId ? eq(stockBatches.warehouseId, warehouseId) : undefined,
      ),
    )
    .groupBy(stockBatches.itemId)
    .as('stock');
}

export async function list(q: z.infer<typeof itemListQuery>) {
  const stock = stockSubquery();
  const where = and(
    eq(t.farmId, ctx().farmId),
    eq(t.active, true),
    q.category?.length ? inArray(t.category, q.category) : undefined,
    searchAny(q.search, [t.name, t.sku, t.barcode]),
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select({
        id: t.id,
        name: t.name,
        category: t.category,
        unit: t.unit,
        sku: t.sku,
        barcode: t.barcode,
        dryMatterPct: t.dryMatterPct,
        meMjPerKgDm: t.meMjPerKgDm,
        crudeProteinPctDm: t.crudeProteinPctDm,
        calciumGPerKgDm: t.calciumGPerKgDm,
        phosphorusGPerKgDm: t.phosphorusGPerKgDm,
        isRoughage: t.isRoughage,
        nPct: t.nPct,
        p2o5Pct: t.p2o5Pct,
        k2oPct: t.k2oPct,
        minQty: t.minQty,
        minDays: t.minDays,
        defaultWarehouseId: t.defaultWarehouseId,
        defaultWarehouseName: warehouses.name,
        withdrawalDays: t.withdrawalDays,
        transferPrice: t.transferPrice,
        kgPerUnit: t.kgPerUnit,
        cropId: t.cropId,
        notes: t.notes,
        qtyOnHand: sql<number>`coalesce(${stock.qty}, 0)`.mapWith(Number),
      })
      .from(t)
      .leftJoin(stock, eq(stock.itemId, t.id))
      .leftJoin(warehouses, eq(warehouses.id, t.defaultWarehouseId))
      .where(where)
      .orderBy(...sortBy(q.sort, { name: t.name, category: t.category }, asc(t.name), t.id))
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: hideMoney(page.data, ['transferPrice']) };
}

/** For dropdowns in any module. Never includes money. */
export async function lookup(q: z.infer<typeof itemLookupQuery>) {
  const stock = stockSubquery(q.warehouseId);
  return tx()
    .select({
      id: t.id,
      name: t.name,
      category: t.category,
      unit: t.unit,
      defaultWarehouseId: t.defaultWarehouseId,
      qtyOnHand: sql<number>`coalesce(${stock.qty}, 0)`.mapWith(Number),
    })
    .from(t)
    .leftJoin(stock, eq(stock.itemId, t.id))
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        eq(t.active, true),
        q.category?.length ? inArray(t.category, q.category) : undefined,
        searchAny(q.search, [t.name, t.sku, t.barcode]),
      ),
    )
    .orderBy(asc(t.name))
    .limit(50);
}

export async function get(id: string) {
  const item = await getItemOrThrow(id);
  const byWarehouse = await tx()
    .select({
      warehouseId: stockBatches.warehouseId,
      warehouseName: warehouses.name,
      qty: sumOf(stockBatches.qtyRemaining),
    })
    .from(stockBatches)
    .innerJoin(warehouses, eq(warehouses.id, stockBatches.warehouseId))
    .where(and(eq(stockBatches.farmId, ctx().farmId), eq(stockBatches.itemId, id)))
    .groupBy(stockBatches.warehouseId, warehouses.name)
    .having(sql`sum(${stockBatches.qtyRemaining}) > 0`);
  const [visible] = hideMoney([item], ['transferPrice']);
  return { ...visible, qtyOnHand: byWarehouse.reduce((sum, w) => sum + w.qty, 0), byWarehouse };
}

async function assertNameFree(name: string, exceptId?: string) {
  const [taken] = await tx()
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        eq(t.active, true),
        sql`lower(${t.name}) = lower(${name})`,
        exceptId ? ne(t.id, exceptId) : undefined,
      ),
    );
  if (taken) throw conflict('ITEM_NAME_EXISTS', 'An item with this name already exists', { id: taken.id });
}

/** Foreign key checks ignore RLS, so confirm client-supplied references belong to this farm. */
async function assertReferences(input: Partial<ItemInput>) {
  if (input.defaultWarehouseId) {
    const [row] = await tx()
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(and(eq(warehouses.id, input.defaultWarehouseId), eq(warehouses.farmId, ctx().farmId)));
    if (!row) throw notFound('Warehouse');
  }
  if (input.cropId) {
    const [row] = await tx()
      .select({ id: crops.id })
      .from(crops)
      .where(and(eq(crops.id, input.cropId), eq(crops.tenantId, ctx().tenantId)));
    if (!row) throw notFound('Crop');
  }
}

export async function createItem(input: ItemInput) {
  await assertNameFree(input.name);
  await assertReferences(input);
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({ type: 'item.created', entityType: 'item', entityId: row.id, data: { name: row.name } });
  const [visible] = hideMoney([row], ['transferPrice']);
  return visible;
}

/** Quantities are plain numbers in the item's unit, so a new label would turn 253 kg into 253 t. */
async function assertUnitCanChange(id: string, unit: string): Promise<void> {
  const item = await getItemOrThrow(id);
  if (item.unit === unit) return;
  const [used] = await tx().select({ id: stockBatches.id }).from(stockBatches).where(eq(stockBatches.itemId, id)).limit(1);
  if (used) throw conflict('ITEM_UNIT_LOCKED', 'This item has stock history, so its unit cannot change');
}

export async function update(id: string, input: Partial<ItemInput>) {
  const { id: _ignored, ...values } = input;
  if (values.name) await assertNameFree(values.name, id);
  await assertReferences(values);
  if (values.unit) await assertUnitCanChange(id, values.unit);
  // Someone who cannot see the price receives it as null. Saving that form must not erase it.
  if (!canSeeMoney()) delete values.transferPrice;
  if (Object.values(values).every((v) => v === undefined)) return get(id);
  const [row] = await tx()
    .update(t)
    .set(values)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)))
    .returning();
  if (!row) throw notFound('Item');
  const [visible] = hideMoney([row], ['transferPrice']);
  return visible;
}

/** Soft delete: batches and movements keep pointing at the item. */
export async function remove(id: string) {
  await getItemOrThrow(id);
  if ((await stockOnHand(id)) > 0) throw conflict('ITEM_HAS_STOCK', 'This item still has stock');
  await tx()
    .update(t)
    .set({ active: false })
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  await recordEvent({ type: 'item.archived', entityType: 'item', entityId: id });
  return { id };
}
