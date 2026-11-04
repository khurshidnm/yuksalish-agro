import { and, desc, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { round } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getItemOrThrow, receiveStock, reverseMovements } from '../../core/inventory';
import { recordEvent } from '../../core/journal';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, paged, sortBy } from '../../core/query';
import { activeWithdrawal } from './operations.service';
import { getFieldRow, refreshPlanStatus, resolvePlanId } from './plans.service';

const { assets, cropPlans, crops, employees, fieldOperations, fields, harvests: t, items, stockMovements, warehouses } = schema;

const destination = {
  itemId: z.uuid().nullish(),
  warehouseId: z.uuid().nullish(),
  /** Quantity in the item's own unit. Required for units that are not weight, such as bales. */
  stockQty: z.number().positive().nullish(),
};

const harvestFields = {
  fieldId: z.uuid(),
  cropPlanId: z.uuid().nullish(),
  date: isoDate,
  grossT: z.number().positive(),
  moisturePct: z.number().min(0).max(100).nullish(),
  quality: z.string().trim().max(120).nullish(),
  assetId: z.uuid().nullish(),
  employeeId: z.uuid().nullish(),
  areaDoneHa: z.number().positive().nullish(),
  notes: z.string().trim().max(1000).nullish(),
};

export const harvestInput = z.object({
  id: clientId,
  /** The planned harvest operation this closes, if any. */
  operationId: z.uuid().nullish(),
  ...harvestFields,
  ...destination,
});
export type HarvestInput = z.infer<typeof harvestInput>;

export const harvestPatch = z.object({ ...harvestFields, ...destination }).partial().omit({ fieldId: true });
export const receiveInput = z.object({ itemId: z.uuid(), warehouseId: z.uuid(), stockQty: z.number().positive().nullish() });

export const harvestListQuery = listQuery.extend({
  fieldId: z.uuid().optional(),
  cropPlanId: z.uuid().optional(),
  seasonId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

type Harvest = typeof t.$inferSelect;

/** Tons to the item's unit. Other units have no fixed weight, so the person must count them. */
function quantityInItemUnit(unit: string, grossT: number, stockQty?: number | null): number {
  if (stockQty) return stockQty;
  if (unit === 't') return grossT;
  if (unit === 'kg') return round(grossT * 1000, 3);
  throw badRequest('STOCK_QTY_REQUIRED', `Enter the quantity received, in ${unit}`, { unit });
}

/**
 * Put a harvest in the warehouse as its own batch (spec 7.2), valued at the item's internal
 * transfer price (spec 7.3). An item with no transfer price comes in at zero and costs nothing
 * when issued, so the response says so.
 */
async function receive(harvest: Harvest, input: { itemId: string; warehouseId: string; stockQty?: number | null }) {
  const item = await getItemOrThrow(input.itemId);
  const qty = quantityInItemUnit(item.unit, harvest.grossT, input.stockQty);
  const { batch } = await receiveStock({
    itemId: item.id,
    warehouseId: input.warehouseId,
    qty,
    unitCost: item.transferPrice ?? 0,
    date: harvest.date,
    source: 'own_harvest',
    fieldId: harvest.fieldId,
    refType: 'harvest',
    refId: harvest.id,
  });
  const [saved] = await tx()
    .update(t)
    .set({ itemId: item.id, warehouseId: input.warehouseId, batchId: batch.id })
    .where(eq(t.id, harvest.id))
    .returning();
  return saved;
}

async function journalRow(harvest: Harvest, input: { operationId?: string | null; areaDoneHa?: number | null; employeeId?: string | null }) {
  const details = {
    harvestId: harvest.id,
    grossT: harvest.grossT,
    moisturePct: harvest.moisturePct,
    quality: harvest.quality,
  };
  if (input.operationId) {
    const [planned] = await tx()
      .select()
      .from(fieldOperations)
      .where(and(eq(fieldOperations.id, input.operationId), eq(fieldOperations.farmId, ctx().farmId)));
    if (!planned) throw notFound('Field operation');
    if (planned.type !== 'harvest' || planned.status !== 'planned') {
      throw conflict('NOT_PLANNED', 'This is not a planned harvest');
    }
    await tx()
      .update(fieldOperations)
      .set({
        status: 'done',
        date: harvest.date,
        assetId: harvest.assetId,
        employeeId: input.employeeId,
        areaDoneHa: input.areaDoneHa,
        details: { ...planned.details, ...details },
      })
      .where(eq(fieldOperations.id, planned.id));
    return;
  }
  const c = ctx();
  await tx().insert(fieldOperations).values({
    tenantId: c.tenantId,
    farmId: c.farmId,
    createdBy: c.userId,
    type: 'harvest',
    status: 'done',
    date: harvest.date,
    fieldId: harvest.fieldId,
    cropPlanId: harvest.cropPlanId,
    assetId: harvest.assetId,
    employeeId: input.employeeId,
    areaDoneHa: input.areaDoneHa,
    details,
  });
}

async function removeJournalRow(harvestId: string): Promise<void> {
  await tx()
    .delete(fieldOperations)
    .where(
      and(
        eq(fieldOperations.farmId, ctx().farmId),
        eq(fieldOperations.type, 'harvest'),
        sql`${fieldOperations.details}->>'harvestId' = ${harvestId}`,
      ),
    );
}

export async function createHarvest(input: HarvestInput) {
  if (input.date > today()) throw badRequest('FUTURE_DATE', 'A harvest cannot be dated in the future');
  if (Boolean(input.itemId) !== Boolean(input.warehouseId)) {
    throw badRequest('DESTINATION_INCOMPLETE', 'Choose both the product and the warehouse');
  }
  await getFieldRow(input.fieldId);
  const c = ctx();
  const id = input.id ?? uuidv7();
  const cropPlanId = await resolvePlanId(input.fieldId, input.date, input.cropPlanId);

  const [row] = await tx()
    .insert(t)
    .values({
      id,
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      fieldId: input.fieldId,
      cropPlanId,
      date: input.date,
      grossT: input.grossT,
      moisturePct: input.moisturePct,
      quality: input.quality,
      assetId: input.assetId,
      notes: input.notes,
    })
    .returning();

  if (input.itemId && input.warehouseId) {
    await receive(row, { itemId: input.itemId, warehouseId: input.warehouseId, stockQty: input.stockQty });
  }
  await journalRow(row, input);
  await refreshPlanStatus(cropPlanId);
  await recordEvent({
    type: 'field.harvested',
    entityType: 'field',
    entityId: input.fieldId,
    occurredAt: input.date,
    data: { harvestId: id, grossT: input.grossT, moisturePct: input.moisturePct },
  });

  const safeFrom = await activeWithdrawal(input.fieldId, input.date);
  return { ...(await getHarvest(id)), withdrawalWarning: safeFrom ? { safeFrom } : null };
}

/** Ombor kirimi as a second step, when the field crew records the harvest first (spec 7.2). */
export async function receiveHarvest(id: string, input: z.infer<typeof receiveInput>) {
  const row = await getRow(id);
  if (row.batchId) throw conflict('HARVEST_ALREADY_RECEIVED', 'This harvest is already in a warehouse');
  await receive(row, input);
  return getHarvest(id);
}

async function getRow(id: string): Promise<Harvest> {
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Harvest');
  return row;
}

export async function updateHarvest(id: string, input: z.infer<typeof harvestPatch>) {
  const before = await getRow(id);
  const { itemId, warehouseId, stockQty, employeeId, areaDoneHa, ...changes } = input;
  const next = { ...before, ...changes };
  if (next.date > today()) throw badRequest('FUTURE_DATE', 'A harvest cannot be dated in the future');

  const destinationChanged =
    (itemId !== undefined && itemId !== before.itemId) ||
    (warehouseId !== undefined && warehouseId !== before.warehouseId) ||
    stockQty !== undefined;
  const repost = before.batchId !== null && (destinationChanged || next.grossT !== before.grossT || next.date !== before.date);

  if (repost) {
    // Throws BATCH_ALREADY_USED if this harvest has been spent, which is what we want.
    await reverseMovements('harvest', id);
    await tx().update(t).set({ batchId: null }).where(eq(t.id, id));
  }

  const cropPlanId = await resolvePlanId(before.fieldId, next.date, input.cropPlanId ?? before.cropPlanId);
  const [row] = await tx().update(t).set({ ...changes, cropPlanId }).where(eq(t.id, id)).returning();

  const targetItem = itemId ?? before.itemId;
  const targetWarehouse = warehouseId ?? before.warehouseId;
  if (repost && targetItem && targetWarehouse) {
    await receive(row, { itemId: targetItem, warehouseId: targetWarehouse, stockQty });
  }

  await removeJournalRow(id);
  await journalRow(row, { employeeId, areaDoneHa });
  await refreshPlanStatus(before.cropPlanId);
  if (cropPlanId !== before.cropPlanId) await refreshPlanStatus(cropPlanId);
  return getHarvest(id);
}

/** Fails with BATCH_ALREADY_USED when the grain has already been fed or sold. */
export async function removeHarvest(id: string) {
  const row = await getRow(id);
  await reverseMovements('harvest', id);
  await removeJournalRow(id);
  await tx().delete(t).where(eq(t.id, id));
  await refreshPlanStatus(row.cropPlanId);
  await recordEvent({ type: 'field.harvest_deleted', entityType: 'field', entityId: row.fieldId, data: { harvestId: id, grossT: row.grossT } });
  return { id };
}

const columns = {
  id: t.id,
  fieldId: t.fieldId,
  fieldNumber: fields.number,
  fieldName: fields.name,
  cropPlanId: t.cropPlanId,
  cropName: crops.name,
  date: t.date,
  grossT: t.grossT,
  moisturePct: t.moisturePct,
  quality: t.quality,
  assetId: t.assetId,
  assetName: assets.name,
  itemId: t.itemId,
  itemName: items.name,
  unit: items.unit,
  warehouseId: t.warehouseId,
  warehouseName: warehouses.name,
  batchId: t.batchId,
  notes: t.notes,
  employeeId: fieldOperations.employeeId,
  employeeName: employees.fullName,
  areaDoneHa: fieldOperations.areaDoneHa,
  /** Value at the transfer price (spec 7.3). */
  value: sql<number | null>`(select sum(${stockMovements.totalCost}) from ${stockMovements}
    where ${stockMovements.refType} = 'harvest' and ${stockMovements.refId} = ${t.id})`.mapWith((v) =>
    v === null ? null : Number(v),
  ),
};

function base() {
  return tx()
    .select(columns)
    .from(t)
    .innerJoin(fields, eq(fields.id, t.fieldId))
    .leftJoin(cropPlans, eq(cropPlans.id, t.cropPlanId))
    .leftJoin(crops, eq(crops.id, cropPlans.cropId))
    .leftJoin(assets, eq(assets.id, t.assetId))
    .leftJoin(items, eq(items.id, t.itemId))
    .leftJoin(warehouses, eq(warehouses.id, t.warehouseId))
    .leftJoin(
      fieldOperations,
      and(
        eq(fieldOperations.fieldId, t.fieldId),
        eq(fieldOperations.type, 'harvest'),
        sql`${fieldOperations.details}->>'harvestId' = ${t.id}::text`,
      ),
    )
    .leftJoin(employees, eq(employees.id, fieldOperations.employeeId));
}

export async function listHarvests(q: z.infer<typeof harvestListQuery>) {
  const where = and(
    eq(t.farmId, ctx().farmId),
    q.fieldId ? eq(t.fieldId, q.fieldId) : undefined,
    q.cropPlanId ? eq(t.cropPlanId, q.cropPlanId) : undefined,
    q.seasonId
      ? sql`${t.cropPlanId} in (select id from crop_plans where season_id = ${q.seasonId})`
      : undefined,
    q.from ? sql`${t.date} >= ${q.from}` : undefined,
    q.to ? sql`${t.date} <= ${q.to}` : undefined,
  );
  const page = await paged(q, t, where, (limit, offset) =>
    base()
      .where(where)
      .orderBy(...sortBy(q.sort, { date: t.date, grossT: t.grossT }, desc(t.date), t.id))
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: hideMoney(page.data, ['value'], 'crops.approve') };
}

export async function getHarvest(id: string) {
  const rows = await base().where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!rows[0]) throw notFound('Harvest');
  return hideMoney(rows, ['value'], 'crops.approve')[0];
}
