/**
 * Stock posting engine. The ONLY code allowed to change quantities (CLAUDE.md rule 2).
 * Every call runs inside the request transaction and locks the batches it touches, so two
 * concurrent issues cannot both spend the same stock.
 */
import { and, asc, desc, eq, gt, inArray, ne, or, sql, type SQLWrapper } from 'drizzle-orm';
import { consumeBatches, round, weightedAverageCost } from '@yap/shared';
import { consumeInProportion } from '@yap/shared/formulas/stock';
import { schema } from '../db/client';
import { ctx, tx } from './context';
import { generalCostCenterId } from './costCenters';
import { badRequest, conflict, notFound } from './errors';
import { recordEvent } from './journal';
import { sumOf } from './query';

const { items, stockBatches, stockMovements, transactions } = schema;

/** Movements of a warehouse document carry this refType and the document's own refId. */
export const STOCK_DOC_REF = 'stock_doc';
/** Its `docNo` outlives the movements, so the number of a reversed document is never issued again. */
export const DOCUMENT_REVERSED_EVENT = 'stock.document_reversed';

/**
 * The money standing on a receipt: posted with it on one of its batches, or entered for it
 * afterwards under the document itself. Money that was refused stands on nothing.
 */
export const moneyOfReceipt = (refId: string | SQLWrapper, batchIds: string[] | SQLWrapper) =>
  and(
    ne(transactions.status, 'rejected'),
    or(
      and(eq(transactions.sourceType, 'stock_batch'), inArray(transactions.sourceId, batchIds)),
      and(eq(transactions.sourceType, STOCK_DOC_REF), eq(transactions.sourceId, refId)),
    ),
  );

/**
 * Movement types that consume value into a cost center. `adjustment_in` is the opposite sign.
 * Costing code must use these constants rather than repeat the list.
 */
export const COST_MOVEMENT_TYPES = ['issue', 'adjustment_out'] as const;
export const COST_CREDIT_MOVEMENT_TYPES = ['adjustment_in'] as const;
/** Under average costing these are priced on everything in stock at that moment. */
const PRICED_ON_AVERAGE = ['issue', 'adjustment_out', 'transfer_out', 'adjustment_in'];

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

/** Quantities keep three decimals, so anything smaller would be stored as nothing. */
function assertPositive(qty: number): void {
  if (!(round(qty, 3) > 0)) throw badRequest('INVALID_QUANTITY', 'Quantity must be at least 0.001');
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

/** What is left of a batch's value: everything that came in, less everything that went out. */
async function batchValueLeft(batchId: string): Promise<number> {
  const [row] = await tx()
    .select({
      value: sql<number>`coalesce(sum(case when ${stockMovements.type} in ('receipt', 'transfer_in', 'adjustment_in')
        then ${stockMovements.totalCost} else -${stockMovements.totalCost} end), 0)`.mapWith(Number),
    })
    .from(stockMovements)
    .where(eq(stockMovements.batchId, batchId));
  return round(row.value, 2);
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

interface Consumed {
  batch: Batch;
  qty: number;
  unitCost: number;
  cost: number;
}

async function consume(
  i: IssueInput,
  type: 'issue' | 'adjustment_out' | 'transfer_out',
): Promise<IssueResult & { consumed: Consumed[] }> {
  const batches = await lockBatches(i.itemId, i.warehouseId);
  const result =
    ctx().settings.inventory.costingMethod === 'avg' ? consumeInProportion(batches, i.qty) : consumeBatches(batches, i.qty);
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
  const consumed: Consumed[] = [];
  let totalCost = 0;
  for (const line of result.lines) {
    const batch = batches.find((b) => b.id === line.batchId)!;
    await tx()
      .update(stockBatches)
      .set({ qtyRemaining: sql`${stockBatches.qtyRemaining} - ${line.qty}` })
      .where(eq(stockBatches.id, line.batchId));
    // The stored unit cost is rounded, so the movement that empties a batch takes what is left of its
    // value and a purchase issued in full costs exactly what was paid.
    const left = line.qty === batch.qtyRemaining ? await batchValueLeft(batch.id) : 0;
    const cost = left > 0 ? left : round(line.qty * line.unitCost, 2);
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
    consumed.push({ batch, qty: line.qty, unitCost: line.unitCost, cost });
  }
  return { movements, totalCost: round(totalCost, 2), consumed };
}

/** Consume stock and charge its cost to a cost center. FIFO takes the oldest first, average costing every batch in proportion. */
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
        // Own produce stays own produce wherever it moves: farm-level cost leaves it out.
        source: part.batch.source === 'own_harvest' ? 'own_harvest' : 'transfer',
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
      totalCost: part.cost,
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
 * Under average costing a receipt's price reaches every later issue of that item in that warehouse.
 * Taking the receipt back would leave those issues priced on stock that never came. Later means by
 * id, which is made at insert: created_at is when the transaction began, and one that began before
 * the receipt can still read it.
 */
async function assertNotPricedLater(receipt: Movement): Promise<void> {
  const [later] = await tx()
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.farmId, receipt.farmId),
        eq(stockMovements.itemId, receipt.itemId),
        eq(stockMovements.warehouseId, receipt.warehouseId),
        inArray(stockMovements.type, PRICED_ON_AVERAGE),
        gt(stockMovements.id, receipt.id),
      ),
    )
    .limit(1);
  if (later) {
    throw conflict('AVERAGE_COST_USED', 'Stock issued after this receipt was priced on an average that includes it', {
      itemId: receipt.itemId,
      warehouseId: receipt.warehouseId,
    });
  }
}

/**
 * Undo every movement of a source record, e.g. when a daily log is edited or deleted.
 * Quantities return to their batches and the rows are removed, so cost reports need no special
 * case. The audit trigger keeps the history of what was removed.
 * The rows are locked first, so a second reversal at the same moment finds nothing left to undo.
 */
export async function reverseMovements(refType: string, refId: string): Promise<void> {
  const rows = await tx()
    .select()
    .from(stockMovements)
    .where(and(eq(stockMovements.farmId, ctx().farmId), eq(stockMovements.refType, refType), eq(stockMovements.refId, refId)))
    .for('update');
  if (rows.length === 0) return;

  const batchIds = [...new Set(rows.map((m) => m.batchId))];
  const batches = await tx().select().from(stockBatches).where(inArray(stockBatches.id, batchIds)).for('update');
  const byId = new Map(batches.map((b) => [b.id, b]));
  const average = ctx().settings.inventory.costingMethod === 'avg';

  for (const m of rows) {
    const adds = m.type === 'receipt' || m.type === 'transfer_in' || m.type === 'adjustment_in';
    if (adds && average) await assertNotPricedLater(m);
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

/** A reversed receipt leaves empty batches with no history; they would only clutter the lists. */
export async function removeEmptyBatches(batchIds: string[]): Promise<void> {
  await tx()
    .delete(stockBatches)
    .where(
      and(
        inArray(stockBatches.id, batchIds),
        sql`${stockBatches.qtyRemaining} = 0`,
        sql`not exists (select 1 from stock_movements m where m.batch_id = ${stockBatches.id})`,
      ),
    );
}

/** The warehouse receipt a batch came in on, with every batch of that receipt. */
export async function receiptOfBatch(batchId: string): Promise<{ refId: string; batchIds: string[] } | null> {
  const farmId = ctx().farmId;
  const isReceipt = and(eq(stockMovements.farmId, farmId), eq(stockMovements.type, 'receipt'), eq(stockMovements.refType, STOCK_DOC_REF));
  const [own] = await tx()
    .select({ refId: stockMovements.refId })
    .from(stockMovements)
    .where(and(isReceipt, eq(stockMovements.batchId, batchId)));
  if (!own?.refId) return null;
  const lines = await tx()
    .select({ batchId: stockMovements.batchId })
    .from(stockMovements)
    .where(and(isReceipt, eq(stockMovements.refId, own.refId)));
  return { refId: own.refId, batchIds: lines.map((line) => line.batchId) };
}

/**
 * Take one warehouse document out of the books, by the refId it was created with. Exactly that
 * document goes: a number is only how people refer to it. A receipt whose money is still live is
 * refused, because stock must not leave while its cost stays (see cancelStockPurchase in core/ledger).
 */
export async function reverseStockDocument(refId: string): Promise<{ docNo: string | null }> {
  const farmId = ctx().farmId;
  const rows = await tx()
    .select({ batchId: stockMovements.batchId, type: stockMovements.type, docNo: stockMovements.docNo })
    .from(stockMovements)
    .where(and(eq(stockMovements.farmId, farmId), eq(stockMovements.refType, STOCK_DOC_REF), eq(stockMovements.refId, refId)))
    .for('update');
  if (rows.length === 0) throw notFound('Document');

  const [{ type, docNo }] = rows;
  const batchIds = [...new Set(rows.map((row) => row.batchId))];
  if (type === 'receipt') {
    const paid = await tx()
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.farmId, farmId), moneyOfReceipt(refId, batchIds)));
    if (paid.length > 0) {
      throw conflict('DOCUMENT_HAS_PAYMENT', 'Cancel the linked payment in finance first', {
        transactionIds: paid.map((p) => p.id),
      });
    }
  }

  await reverseMovements(STOCK_DOC_REF, refId);
  if (type === 'receipt') await removeEmptyBatches(batchIds);
  await recordEvent({ type: DOCUMENT_REVERSED_EVENT, entityType: 'stock_doc', entityId: refId, data: { docNo } });
  return { docNo };
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
