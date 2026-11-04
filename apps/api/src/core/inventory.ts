/**
 * Stock posting engine. The ONLY code allowed to change quantities (CLAUDE.md rule 2).
 * Every call runs inside the request transaction and locks the batches it touches, so two
 * concurrent issues cannot both spend the same stock.
 */
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { consumeBatches, round, weightedAverageCost } from '@yap/shared';
import { schema } from '../db/client';
import { ctx, tx } from './context';
import { generalCostCenterId } from './costCenters';
import { badRequest, conflict, notFound } from './errors';
import { recordEvent } from './journal';
import { sumOf } from './query';

const { items, stockBatches, stockMovements } = schema;

/**
 * Movement types that consume value into a cost center. `adjustment_in` is the opposite sign.
 * Costing code must use these constants rather than repeat the list.
 */
export const COST_MOVEMENT_TYPES = ['issue', 'adjustment_out'] as const;
export const COST_CREDIT_MOVEMENT_TYPES = ['adjustment_in'] as const;

type Batch = typeof stockBatches.$inferSelect;
type Movement = typeof stockMovements.$inferSelect;

export interface ReceiveInput {
  itemId: string;
  warehouseId: string;
  qty: number;
  unitCost: number;
  date: string;
  source: 'opening' | 'purchase' | 'own_harvest' | 'return' | 'adjustment' | 'transfer';
  batchNo?: string | null;
  expiryDate?: string | null;
  counterpartyId?: string | null;
  fieldId?: string | null;
  docNo?: string | null;
  refType?: string | null;
  refId?: string | null;
  notes?: string | null;
}

export interface IssueInput {
  itemId: string;
  warehouseId: string;
  qty: number;
  date: string;
  /** Required: each issue must land on a cost center (spec 9). Only sales may omit it. */
  costCenterId?: string | null;
  /** 'ration', 'field_operation', 'fuel', 'treatment', 'sale', 'write_off', ... */
  reason: string;
  docNo?: string | null;
  refType?: string | null;
  refId?: string | null;
  notes?: string | null;
}

export interface IssueResult {
  movements: Movement[];
  totalCost: number;
}

function assertPositive(qty: number): void {
  if (!(qty > 0)) throw badRequest('INVALID_QUANTITY', 'Quantity must be greater than zero');
}

async function lockBatches(itemId: string, warehouseId: string): Promise<Batch[]> {
  return tx()
    .select()
    .from(stockBatches)
    .where(
      and(
        eq(stockBatches.farmId, ctx().farmId),
        eq(stockBatches.itemId, itemId),
        eq(stockBatches.warehouseId, warehouseId),
        gt(stockBatches.qtyRemaining, 0),
      ),
    )
    .orderBy(asc(stockBatches.receivedDate), asc(stockBatches.createdAt))
    .for('update');
}

async function insertMovement(values: Omit<typeof stockMovements.$inferInsert, 'tenantId' | 'farmId' | 'createdBy'>) {
  const c = ctx();
  const [row] = await tx()
    .insert(stockMovements)
    .values({ ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  return row;
}

/** Add stock as a new batch. */
export async function receiveStock(i: ReceiveInput): Promise<{ batch: Batch; movement: Movement }> {
  assertPositive(i.qty);
  if (i.unitCost < 0) throw badRequest('INVALID_COST', 'Unit cost cannot be negative');
  const c = ctx();
  const [batch] = await tx()
    .insert(stockBatches)
    .values({
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      itemId: i.itemId,
      warehouseId: i.warehouseId,
      batchNo: i.batchNo,
      receivedDate: i.date,
      qtyReceived: i.qty,
      qtyRemaining: i.qty,
      unitCost: i.unitCost,
      expiryDate: i.expiryDate,
      source: i.source,
      counterpartyId: i.counterpartyId,
      fieldId: i.fieldId,
      notes: i.notes,
    })
    .returning();
  const movement = await insertMovement({
    type: 'receipt',
    date: i.date,
    itemId: i.itemId,
    batchId: batch.id,
    warehouseId: i.warehouseId,
    qty: i.qty,
    unitCost: i.unitCost,
    totalCost: round(i.qty * i.unitCost, 2),
    reason: i.source,
    docNo: i.docNo,
    refType: i.refType,
    refId: i.refId,
    notes: i.notes,
  });
  await recordEvent({
    type: 'stock.received',
    entityType: 'item',
    entityId: i.itemId,
    occurredAt: i.date,
    data: { qty: i.qty, unitCost: i.unitCost, warehouseId: i.warehouseId, source: i.source },
  });
  return { batch, movement };
}

async function consume(
  i: IssueInput,
  type: 'issue' | 'adjustment_out' | 'transfer_out',
): Promise<IssueResult & { consumed: { batch: Batch; qty: number; unitCost: number }[] }> {
  const batches = await lockBatches(i.itemId, i.warehouseId);
  const result = consumeBatches(batches, i.qty, ctx().settings.inventory.costingMethod);
  if (result.shortage > 0) {
    const available = round(i.qty - result.shortage, 3);
    throw conflict('INSUFFICIENT_STOCK', `Not enough stock: ${available} available, ${i.qty} requested`, {
      itemId: i.itemId,
      warehouseId: i.warehouseId,
      requested: i.qty,
      available,
    });
  }

  const movements: Movement[] = [];
  const consumed: { batch: Batch; qty: number; unitCost: number }[] = [];
  let totalCost = 0;
  for (const line of result.lines) {
    await tx()
      .update(stockBatches)
      .set({ qtyRemaining: sql`${stockBatches.qtyRemaining} - ${line.qty}` })
      .where(eq(stockBatches.id, line.batchId));
    const cost = round(line.qty * line.unitCost, 2);
    totalCost += cost;
    movements.push(
      await insertMovement({
        type,
        date: i.date,
        itemId: i.itemId,
        batchId: line.batchId,
        warehouseId: i.warehouseId,
        qty: line.qty,
        unitCost: line.unitCost,
        totalCost: cost,
        costCenterId: i.costCenterId,
        reason: i.reason,
        docNo: i.docNo,
        refType: i.refType,
        refId: i.refId,
        notes: i.notes,
      }),
    );
    consumed.push({ batch: batches.find((b) => b.id === line.batchId)!, qty: line.qty, unitCost: line.unitCost });
  }
  return { movements, totalCost: round(totalCost, 2), consumed };
}

/** Consume stock oldest-first and charge its cost to a cost center. */
export async function issueStock(i: IssueInput): Promise<IssueResult> {
  assertPositive(i.qty);
  if (!i.costCenterId && i.reason !== 'sale') {
    throw badRequest('COST_CENTER_REQUIRED', 'A stock issue must be charged to a cost center');
  }
  const { movements, totalCost } = await consume(i, 'issue');
  await recordEvent({
    type: 'stock.issued',
    entityType: 'item',
    entityId: i.itemId,
    occurredAt: i.date,
    data: { qty: i.qty, totalCost, reason: i.reason, costCenterId: i.costCenterId, warehouseId: i.warehouseId },
  });
  return { movements, totalCost };
}

/** Move stock between warehouses. Cost is unchanged, so this never reaches a cost center. */
export async function transferStock(i: {
  itemId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  qty: number;
  date: string;
  docNo?: string | null;
  notes?: string | null;
}): Promise<void> {
  assertPositive(i.qty);
  if (i.fromWarehouseId === i.toWarehouseId) {
    throw badRequest('SAME_WAREHOUSE', 'Source and destination warehouses must differ');
  }
  const out = await consume(
    { itemId: i.itemId, warehouseId: i.fromWarehouseId, qty: i.qty, date: i.date, reason: 'transfer', docNo: i.docNo, notes: i.notes },
    'transfer_out',
  );
  const c = ctx();
  for (const part of out.consumed) {
    const [batch] = await tx()
      .insert(stockBatches)
      .values({
        tenantId: c.tenantId,
        farmId: c.farmId,
        createdBy: c.userId,
        itemId: i.itemId,
        warehouseId: i.toWarehouseId,
        batchNo: part.batch.batchNo,
        // Keep the original date so FIFO order survives the move.
        receivedDate: part.batch.receivedDate,
        qtyReceived: part.qty,
        qtyRemaining: part.qty,
        unitCost: part.unitCost,
        expiryDate: part.batch.expiryDate,
        source: 'transfer',
        counterpartyId: part.batch.counterpartyId,
      })
      .returning();
    await insertMovement({
      type: 'transfer_in',
      date: i.date,
      itemId: i.itemId,
      batchId: batch.id,
      warehouseId: i.toWarehouseId,
      qty: part.qty,
      unitCost: part.unitCost,
      totalCost: round(part.qty * part.unitCost, 2),
      reason: 'transfer',
      docNo: i.docNo,
      notes: i.notes,
    });
  }
  await recordEvent({
    type: 'stock.transferred',
    entityType: 'item',
    entityId: i.itemId,
    occurredAt: i.date,
    data: { qty: i.qty, from: i.fromWarehouseId, to: i.toWarehouseId },
  });
}

/**
 * Set stock to the counted quantity (spec 9.2). The difference is charged to the general
 * cost center: a shortfall is a cost, a surplus reduces cost.
 */
export async function adjustStock(i: {
  itemId: string;
  warehouseId: string;
  actualQty: number;
  date: string;
  docNo?: string | null;
  refType?: string | null;
  refId?: string | null;
  notes?: string | null;
}): Promise<{ systemQty: number; diffQty: number; diffCost: number }> {
  if (i.actualQty < 0) throw badRequest('INVALID_QUANTITY', 'Counted quantity cannot be negative');
  const batches = await lockBatches(i.itemId, i.warehouseId);
  const systemQty = round(batches.reduce((sum, b) => sum + b.qtyRemaining, 0), 3);
  const diffQty = round(i.actualQty - systemQty, 3);
  const costCenterId = await generalCostCenterId();
  if (diffQty === 0) return { systemQty, diffQty: 0, diffCost: 0 };

  if (diffQty < 0) {
    const { totalCost } = await consume(
      {
        itemId: i.itemId,
        warehouseId: i.warehouseId,
        qty: -diffQty,
        date: i.date,
        costCenterId,
        reason: 'count',
        docNo: i.docNo,
        refType: i.refType,
        refId: i.refId,
        notes: i.notes,
      },
      'adjustment_out',
    );
    return { systemQty, diffQty, diffCost: -totalCost };
  }

  let unitCost = weightedAverageCost(batches);
  if (unitCost === 0) {
    const [last] = await tx()
      .select({ unitCost: stockBatches.unitCost })
      .from(stockBatches)
      .where(and(eq(stockBatches.farmId, ctx().farmId), eq(stockBatches.itemId, i.itemId)))
      .orderBy(desc(stockBatches.receivedDate))
      .limit(1);
    unitCost = last?.unitCost ?? 0;
  }
  const c = ctx();
  const [batch] = await tx()
    .insert(stockBatches)
    .values({
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      itemId: i.itemId,
      warehouseId: i.warehouseId,
      receivedDate: i.date,
      qtyReceived: diffQty,
      qtyRemaining: diffQty,
      unitCost,
      source: 'adjustment',
      notes: i.notes,
    })
    .returning();
  const diffCost = round(diffQty * unitCost, 2);
  await insertMovement({
    type: 'adjustment_in',
    date: i.date,
    itemId: i.itemId,
    batchId: batch.id,
    warehouseId: i.warehouseId,
    qty: diffQty,
    unitCost,
    totalCost: diffCost,
    costCenterId,
    reason: 'count',
    docNo: i.docNo,
    refType: i.refType,
    refId: i.refId,
    notes: i.notes,
  });
  return { systemQty, diffQty, diffCost };
}

/**
 * Undo every movement of a source record, e.g. when a daily log is edited or deleted.
 * Quantities return to their batches and the rows are removed, so cost reports need no special
 * case. The audit trigger keeps the history of what was removed.
 */
export async function reverseMovements(refType: string, refId: string): Promise<void> {
  const rows = await tx()
    .select()
    .from(stockMovements)
    .where(and(eq(stockMovements.farmId, ctx().farmId), eq(stockMovements.refType, refType), eq(stockMovements.refId, refId)));
  if (rows.length === 0) return;

  const batchIds = [...new Set(rows.map((m) => m.batchId))];
  const batches = await tx().select().from(stockBatches).where(inArray(stockBatches.id, batchIds)).for('update');
  const byId = new Map(batches.map((b) => [b.id, b]));

  for (const m of rows) {
    const adds = m.type === 'receipt' || m.type === 'transfer_in' || m.type === 'adjustment_in';
    if (adds && byId.get(m.batchId)!.qtyRemaining < m.qty) {
      throw conflict('BATCH_ALREADY_USED', 'This stock has already been used and cannot be reversed');
    }
    const delta = adds ? -m.qty : m.qty;
    await tx()
      .update(stockBatches)
      .set({ qtyRemaining: sql`${stockBatches.qtyRemaining} + ${delta}` })
      .where(eq(stockBatches.id, m.batchId));
  }
  await tx()
    .delete(stockMovements)
    .where(and(eq(stockMovements.farmId, ctx().farmId), eq(stockMovements.refType, refType), eq(stockMovements.refId, refId)));
}

/** Current quantity of an item, optionally in one warehouse. */
export async function stockOnHand(itemId: string, warehouseId?: string): Promise<number> {
  const [row] = await tx()
    .select({ qty: sumOf(stockBatches.qtyRemaining) })
    .from(stockBatches)
    .where(
      and(
        eq(stockBatches.farmId, ctx().farmId),
        eq(stockBatches.itemId, itemId),
        warehouseId ? eq(stockBatches.warehouseId, warehouseId) : undefined,
      ),
    );
  return row.qty;
}

/** Item row within the current farm, or 404. */
export async function getItemOrThrow(itemId: string) {
  const [item] = await tx()
    .select()
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.farmId, ctx().farmId)));
  if (!item) throw notFound('Item');
  return item;
}
