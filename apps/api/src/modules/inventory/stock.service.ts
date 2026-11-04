/**
 * Warehouse documents on top of the kernel in core/inventory.
 * A document is one receipt, issue or transfer with one or more lines. Its lines share a `docNo`,
 * and receipts and issues also share a `refId`, so the whole document can be reversed.
 */
import { addDays, round } from '@yap/shared';
import { and, asc, desc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { schema } from '../../db/client';
import { assertPermission, ctx, today, tx } from '../../core/context';
import { generalCostCenterId } from '../../core/costCenters';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getItemOrThrow, issueStock, receiveStock, reverseMovements, transferStock } from '../../core/inventory';
import { recordEvent } from '../../core/journal';
import { postTransaction } from '../../core/ledger';
import { hideMoney } from '../../core/privacy';
import { isoDate, listQuery, searchAny, sortBy, sumOf, type Page } from '../../core/query';

const { accounts, costCenters, counterparties, financeCategories, items, stockBatches, stockMovements, transactions, users, warehouses } =
  schema;

/** Reference type of documents created here. reverseDocument only handles these. */
const DOC_REF_TYPE = 'stock_doc';

export const DOC_PREFIX = { receipt: 'KO', issue: 'CT', transfer: 'KN', count: 'IA' } as const;
export type DocKind = keyof typeof DOC_PREFIX;

/** Expense category per item category. Spare parts, seed and so on have their own lines in spec 10.1. */
const CATEGORY_BY_ITEM: Record<string, string | undefined> = {
  feed: 'feed',
  seed: 'seed',
  fertilizer: 'fertilizer',
  chemical: 'crop_protection',
  vet_drug: 'veterinary',
  vaccine: 'veterinary',
  fuel: 'fuel',
  lubricant: 'fuel',
  spare_part: 'spare_parts',
};

/**
 * Next number such as KO-2026-0007. The advisory lock serialises numbering per farm, so two
 * people saving at once cannot get the same number.
 */
export async function nextDocNo(kind: DocKind, date: string): Promise<string> {
  const c = ctx();
  await tx().execute(sql`select pg_advisory_xact_lock(hashtext(${`docno:${c.farmId}`}))`);
  const prefix = `${DOC_PREFIX[kind]}-${date.slice(0, 4)}-`;
  const [row] =
    kind === 'count'
      ? await tx()
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(schema.stockCounts)
          .where(and(eq(schema.stockCounts.farmId, c.farmId), sql`${schema.stockCounts.docNo} like ${`${prefix}%`}`))
      : await tx()
          .select({ n: sql<number>`count(distinct ${stockMovements.docNo})`.mapWith(Number) })
          .from(stockMovements)
          .where(and(eq(stockMovements.farmId, c.farmId), sql`${stockMovements.docNo} like ${`${prefix}%`}`));
  return `${prefix}${String(row.n + 1).padStart(4, '0')}`;
}

const positive = z.number().positive();
const note = z.string().max(1000).nullish();

const receiptLine = z.object({
  itemId: z.uuid(),
  qty: positive,
  /** Per item unit, in the receipt's currency. */
  unitCost: z.number().min(0),
  batchNo: z.string().trim().max(60).nullish(),
  expiryDate: isoDate.nullish(),
});

const paymentInput = z.object({
  paymentMethod: z.enum(['cash', 'bank', 'card', 'debt']),
  accountId: z.uuid().nullish(),
  /** Overrides the category chosen from the item. Required for items with no default. */
  categoryId: z.uuid().nullish(),
  dueDate: isoDate.nullish(),
  fileId: z.uuid().nullish(),
});

export const receiptInput = z.object({
  warehouseId: z.uuid(),
  date: isoDate,
  source: z.enum(['purchase', 'opening', 'return']).default('purchase'),
  counterpartyId: z.uuid().nullish(),
  invoiceNo: z.string().trim().max(60).nullish(),
  currency: z.string().length(3).optional(),
  /** Rate to the base currency, required when `currency` is foreign. */
  fxRate: z.number().positive().nullish(),
  notes: note,
  lines: z.array(receiptLine).min(1).max(100),
  /** Post the payment or debt in the same step. Needs finance.create. */
  payment: paymentInput.optional(),
});
export type ReceiptInput = z.infer<typeof receiptInput>;

export const issueInput = z.object({
  warehouseId: z.uuid(),
  date: isoDate,
  costCenterId: z.uuid(),
  reason: z.enum(['ration', 'field_operation', 'fuel', 'treatment', 'repair', 'write_off', 'manual']).default('manual'),
  notes: note,
  lines: z.array(z.object({ itemId: z.uuid(), qty: positive })).min(1).max(100),
});
export type IssueInput = z.infer<typeof issueInput>;

export const transferInput = z.object({
  fromWarehouseId: z.uuid(),
  toWarehouseId: z.uuid(),
  date: isoDate,
  notes: note,
  lines: z.array(z.object({ itemId: z.uuid(), qty: positive })).min(1).max(100),
});
export type TransferInput = z.infer<typeof transferInput>;

async function assertWarehouse(id: string): Promise<void> {
  const [row] = await tx()
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.id, id), eq(warehouses.farmId, ctx().farmId), eq(warehouses.active, true)));
  if (!row) throw notFound('Warehouse');
}

async function categoryIdFor(itemCategory: string, explicit?: string | null): Promise<string> {
  const key = CATEGORY_BY_ITEM[itemCategory];
  if (!explicit && !key) throw badRequest('CATEGORY_REQUIRED', 'Choose a category for this purchase');
  const [row] = await tx()
    .select({ id: financeCategories.id })
    .from(financeCategories)
    .where(
      and(
        eq(financeCategories.tenantId, ctx().tenantId),
        explicit ? eq(financeCategories.id, explicit) : eq(financeCategories.key, key!),
      ),
    );
  if (!row) throw badRequest('CATEGORY_REQUIRED', 'Choose a category for this purchase');
  return row.id;
}

/**
 * Foreign key checks ignore RLS, so an id from another tenant would pass them.
 * Every reference that comes from the client is confirmed against this farm first.
 */
async function assertCounterparty(id: string): Promise<void> {
  const [row] = await tx()
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(and(eq(counterparties.id, id), eq(counterparties.farmId, ctx().farmId)));
  if (!row) throw notFound('Counterparty');
}

async function assertAccount(id: string): Promise<void> {
  const [row] = await tx()
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.farmId, ctx().farmId)));
  if (!row) throw notFound('Account');
}

export async function createReceipt(input: ReceiptInput) {
  if (input.payment) assertPermission('finance.create');
  if (input.source === 'purchase' && !input.counterpartyId) {
    throw badRequest('COUNTERPARTY_REQUIRED', 'A purchase needs a supplier');
  }
  await assertWarehouse(input.warehouseId);
  if (input.counterpartyId) await assertCounterparty(input.counterpartyId);
  if (input.payment?.accountId) await assertAccount(input.payment.accountId);

  const c = ctx();
  const currency = input.currency ?? c.currency;
  const foreign = currency !== c.currency;
  if (foreign && !input.fxRate) throw badRequest('FX_RATE_REQUIRED', `Enter the exchange rate for ${currency}`);
  const toBase = foreign ? input.fxRate! : 1;

  const docId = uuidv7();
  const docNo = await nextDocNo('receipt', input.date);
  const lines = [];
  for (const line of input.lines) {
    const item = await getItemOrThrow(line.itemId);
    const { batch } = await receiveStock({
      itemId: line.itemId,
      warehouseId: input.warehouseId,
      qty: line.qty,
      unitCost: line.unitCost * toBase,
      date: input.date,
      source: input.source,
      batchNo: line.batchNo,
      expiryDate: line.expiryDate,
      counterpartyId: input.counterpartyId,
      docNo,
      refType: DOC_REF_TYPE,
      refId: docId,
      notes: input.notes,
    });
    if (input.invoiceNo) {
      await tx().update(stockBatches).set({ invoiceNo: input.invoiceNo }).where(eq(stockBatches.id, batch.id));
    }
    lines.push({ item, batch, amount: round(line.qty * line.unitCost, 2) });
  }

  // One transaction per expense category, so a mixed invoice lands on the right budget lines.
  const paymentRows = [];
  if (input.payment) {
    const groups = new Map<string, { amount: number; batchId: string }>();
    for (const line of lines) {
      const categoryId = await categoryIdFor(line.item.category, input.payment.categoryId);
      const group = groups.get(categoryId) ?? { amount: 0, batchId: line.batch.id };
      group.amount = round(group.amount + line.amount, 2);
      groups.set(categoryId, group);
    }
    const costCenterId = await generalCostCenterId();
    for (const [categoryId, group] of groups) {
      if (group.amount <= 0) continue;
      paymentRows.push(
        await postTransaction({
          date: input.date,
          type: 'expense',
          amount: group.amount,
          categoryId,
          currency,
          fxRate: input.fxRate,
          paymentMethod: input.payment.paymentMethod,
          accountId: input.payment.paymentMethod === 'debt' ? null : input.payment.accountId,
          counterpartyId: input.counterpartyId,
          costCenterId,
          // Reaches a cost center when issued from the warehouse, not now (CLAUDE.md rule 3).
          costTreatment: 'inventory',
          description: input.invoiceNo ? `${docNo} / ${input.invoiceNo}` : docNo,
          dueDate: input.payment.dueDate,
          fileId: input.payment.fileId,
          sourceType: 'stock_batch',
          sourceId: group.batchId,
        }),
      );
    }
  }

  return {
    docNo,
    batches: hideMoney(lines.map((l) => l.batch), ['unitCost']),
    transactions: paymentRows.map((p) => ({ id: p.id, status: p.status })),
  };
}

export async function createIssue(input: IssueInput) {
  await assertWarehouse(input.warehouseId);
  const [costCenter] = await tx()
    .select({ id: costCenters.id })
    .from(costCenters)
    .where(and(eq(costCenters.id, input.costCenterId), eq(costCenters.farmId, ctx().farmId)));
  if (!costCenter) throw notFound('Cost center');

  const docId = uuidv7();
  const docNo = await nextDocNo('issue', input.date);
  for (const line of input.lines) {
    await getItemOrThrow(line.itemId);
    await issueStock({
      itemId: line.itemId,
      warehouseId: input.warehouseId,
      qty: line.qty,
      date: input.date,
      costCenterId: input.costCenterId,
      reason: input.reason,
      docNo,
      refType: DOC_REF_TYPE,
      refId: docId,
      notes: input.notes,
    });
  }
  return { docNo };
}

export async function createTransfer(input: TransferInput) {
  await assertWarehouse(input.fromWarehouseId);
  await assertWarehouse(input.toWarehouseId);
  const docNo = await nextDocNo('transfer', input.date);
  for (const line of input.lines) {
    await getItemOrThrow(line.itemId);
    await transferStock({
      itemId: line.itemId,
      fromWarehouseId: input.fromWarehouseId,
      toWarehouseId: input.toWarehouseId,
      qty: line.qty,
      date: input.date,
      docNo,
      notes: input.notes,
    });
  }
  return { docNo };
}

/**
 * Undo a mistaken receipt or issue. Records from other modules (daily logs, operations) are
 * corrected where they were entered, and a receipt with a live payment goes through finance first.
 */
export async function reverseDocument(docNo: string) {
  const farmId = ctx().farmId;
  const rows = await tx()
    .select({
      refType: stockMovements.refType,
      refId: stockMovements.refId,
      batchId: stockMovements.batchId,
      type: stockMovements.type,
    })
    .from(stockMovements)
    .where(and(eq(stockMovements.farmId, farmId), eq(stockMovements.docNo, docNo)));
  if (rows.length === 0) throw notFound('Document');

  const first = rows[0];
  if (first.refType !== DOC_REF_TYPE || !first.refId) {
    throw conflict('DOCUMENT_NOT_REVERSIBLE', 'This document cannot be reversed here');
  }

  const batchIds = [...new Set(rows.map((r) => r.batchId))];
  if (first.type === 'receipt') {
    const paid = await tx()
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.farmId, farmId),
          eq(transactions.sourceType, 'stock_batch'),
          inArray(transactions.sourceId, batchIds),
          sql`${transactions.status} <> 'rejected'`,
        ),
      );
    if (paid.length > 0) {
      throw conflict('DOCUMENT_HAS_PAYMENT', 'Cancel the linked payment in finance first', {
        transactionIds: paid.map((p) => p.id),
      });
    }
  }

  await reverseMovements(DOC_REF_TYPE, first.refId);

  // A reversed receipt leaves empty batches with no history; they would only clutter the lists.
  if (first.type === 'receipt') {
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
  await recordEvent({ type: 'stock.document_reversed', entityType: 'stock_doc', entityId: first.refId, data: { docNo } });
  return { docNo };
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export const balanceQuery = listQuery.extend({
  warehouseId: z.uuid().optional(),
  category: z.string().optional(),
  /** Also list items with nothing in stock. */
  includeEmpty: z.coerce.boolean().optional(),
});

/** One row per item and warehouse. */
export async function balances(q: z.infer<typeof balanceQuery>): Promise<Page<Record<string, unknown>>> {
  const farmId = ctx().farmId;
  const stock = tx()
    .select({
      itemId: stockBatches.itemId,
      warehouseId: stockBatches.warehouseId,
      qty: sumOf(stockBatches.qtyRemaining).as('qty'),
      value: sql<number>`sum(${stockBatches.qtyRemaining} * ${stockBatches.unitCost})`.mapWith(Number).as('value'),
      nearestExpiry: sql<string | null>`min(${stockBatches.expiryDate}) filter (where ${stockBatches.qtyRemaining} > 0)`.as('nearest_expiry'),
    })
    .from(stockBatches)
    .where(and(eq(stockBatches.farmId, farmId), q.warehouseId ? eq(stockBatches.warehouseId, q.warehouseId) : undefined))
    .groupBy(stockBatches.itemId, stockBatches.warehouseId)
    .having(sql`sum(${stockBatches.qtyRemaining}) > 0`)
    .as('stock');

  const categories = q.category?.split(',').filter(Boolean);
  const where = and(
    eq(items.farmId, farmId),
    eq(items.active, true),
    categories?.length ? inArray(items.category, categories) : undefined,
    searchAny(q.search, [items.name, items.sku, items.barcode]),
    q.includeEmpty ? undefined : gt(stock.qty, 0),
  );

  const qty = sql<number>`coalesce(${stock.qty}, 0)`.mapWith(Number);
  const rows = await tx()
    .select({
      itemId: items.id,
      name: items.name,
      category: items.category,
      unit: items.unit,
      minQty: items.minQty,
      warehouseId: stock.warehouseId,
      warehouseName: warehouses.name,
      qty,
      value: sql<number>`coalesce(${stock.value}, 0)`.mapWith(Number),
      nearestExpiry: stock.nearestExpiry,
    })
    .from(items)
    .leftJoin(stock, eq(stock.itemId, items.id))
    .leftJoin(warehouses, eq(warehouses.id, stock.warehouseId))
    .where(where)
    .orderBy(...sortBy(q.sort, { name: items.name, category: items.category, qty }, asc(items.name), items.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  const [{ total }] = await tx()
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(items)
    .leftJoin(stock, eq(stock.itemId, items.id))
    .where(where);

  const data = rows.map((row) => ({
    ...row,
    avgCost: row.qty > 0 ? row.value / row.qty : null,
    belowMinimum: row.minQty != null && row.qty < row.minQty,
  }));
  return {
    data: hideMoney(data, ['value', 'avgCost']),
    meta: { page: q.page, pageSize: q.pageSize, total },
  };
}

export const batchesQuery = z.object({
  warehouseId: z.uuid().optional(),
  /** Include finished batches. */
  all: z.coerce.boolean().optional(),
});

export async function batches(itemId: string, q: z.infer<typeof batchesQuery>) {
  await getItemOrThrow(itemId);
  const rows = await tx()
    .select({
      id: stockBatches.id,
      batchNo: stockBatches.batchNo,
      invoiceNo: stockBatches.invoiceNo,
      warehouseId: stockBatches.warehouseId,
      warehouseName: warehouses.name,
      receivedDate: stockBatches.receivedDate,
      qtyReceived: stockBatches.qtyReceived,
      qtyRemaining: stockBatches.qtyRemaining,
      unitCost: stockBatches.unitCost,
      expiryDate: stockBatches.expiryDate,
      source: stockBatches.source,
      counterpartyName: counterparties.name,
    })
    .from(stockBatches)
    .innerJoin(warehouses, eq(warehouses.id, stockBatches.warehouseId))
    .leftJoin(counterparties, eq(counterparties.id, stockBatches.counterpartyId))
    .where(
      and(
        eq(stockBatches.farmId, ctx().farmId),
        eq(stockBatches.itemId, itemId),
        q.warehouseId ? eq(stockBatches.warehouseId, q.warehouseId) : undefined,
        q.all ? undefined : gt(stockBatches.qtyRemaining, 0),
      ),
    )
    .orderBy(asc(stockBatches.receivedDate), asc(stockBatches.createdAt));
  return hideMoney(rows, ['unitCost']);
}

export const movementsQuery = listQuery.extend({
  type: z.string().optional(),
  itemId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  costCenterId: z.uuid().optional(),
  docNo: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export async function movements(q: z.infer<typeof movementsQuery>): Promise<Page<Record<string, unknown>>> {
  const m = stockMovements;
  const types = q.type?.split(',').filter(Boolean);
  const where = and(
    eq(m.farmId, ctx().farmId),
    types?.length ? inArray(m.type, types) : undefined,
    q.itemId ? eq(m.itemId, q.itemId) : undefined,
    q.warehouseId ? eq(m.warehouseId, q.warehouseId) : undefined,
    q.costCenterId ? eq(m.costCenterId, q.costCenterId) : undefined,
    q.docNo ? eq(m.docNo, q.docNo) : undefined,
    q.from ? gte(m.date, q.from) : undefined,
    q.to ? lte(m.date, q.to) : undefined,
    searchAny(q.search, [items.name, m.docNo]),
  );
  const rows = await tx()
    .select({
      id: m.id,
      type: m.type,
      date: m.date,
      itemId: m.itemId,
      itemName: items.name,
      unit: items.unit,
      warehouseId: m.warehouseId,
      warehouseName: warehouses.name,
      qty: m.qty,
      unitCost: m.unitCost,
      totalCost: m.totalCost,
      costCenterId: m.costCenterId,
      costCenterName: costCenters.name,
      reason: m.reason,
      docNo: m.docNo,
      refType: m.refType,
      notes: m.notes,
      createdByName: users.fullName,
      createdAt: m.createdAt,
    })
    .from(m)
    .innerJoin(items, eq(items.id, m.itemId))
    .innerJoin(warehouses, eq(warehouses.id, m.warehouseId))
    .leftJoin(costCenters, eq(costCenters.id, m.costCenterId))
    .leftJoin(users, eq(users.id, m.createdBy))
    .where(where)
    .orderBy(...sortBy(q.sort, { date: m.date, qty: m.qty, itemName: items.name }, [desc(m.date), desc(m.createdAt)], m.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  const [{ total }] = await tx()
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(m)
    .innerJoin(items, eq(items.id, m.itemId))
    .where(where);

  return { data: hideMoney(rows, ['unitCost', 'totalCost']), meta: { page: q.page, pageSize: q.pageSize, total } };
}

export const expiringQuery = z.object({ days: z.coerce.number().int().min(0).max(730).default(60) });

/** Batches that expire within `days`, expired ones first (spec 9.2). */
export async function expiring(days: number) {
  const now = today();
  const rows = await tx()
    .select({
      batchId: stockBatches.id,
      itemId: stockBatches.itemId,
      itemName: items.name,
      category: items.category,
      unit: items.unit,
      warehouseName: warehouses.name,
      batchNo: stockBatches.batchNo,
      qtyRemaining: stockBatches.qtyRemaining,
      expiryDate: stockBatches.expiryDate,
      unitCost: stockBatches.unitCost,
    })
    .from(stockBatches)
    .innerJoin(items, eq(items.id, stockBatches.itemId))
    .innerJoin(warehouses, eq(warehouses.id, stockBatches.warehouseId))
    .where(
      and(
        eq(stockBatches.farmId, ctx().farmId),
        gt(stockBatches.qtyRemaining, 0),
        lte(stockBatches.expiryDate, addDays(now, days)),
      ),
    )
    .orderBy(asc(stockBatches.expiryDate));
  return hideMoney(
    rows.map((row) => ({ ...row, expired: row.expiryDate! < now })),
    ['unitCost'],
  );
}
