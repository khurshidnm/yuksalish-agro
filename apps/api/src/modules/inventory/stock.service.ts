/**
 * Warehouse documents on top of the kernel in core/inventory.
 * A document is one receipt, issue or transfer with one or more lines. Its lines share a `docNo`,
 * and receipts and issues also share a `refId`, so the whole document can be reversed.
 */
import { addDays, CURRENCIES, round, toBaseAmount } from '@yap/shared';
import { and, asc, count, desc, eq, exists, gt, gte, inArray, isNull, lte, notExists, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { schema } from '../../db/client';
import { assertPermission, ctx, today, tx } from '../../core/context';
import { generalCostCenterId } from '../../core/costCenters';
import { badRequest, conflict, notFound } from '../../core/errors';
import {
  DOCUMENT_REVERSED_EVENT,
  getItemOrThrow,
  issueStock,
  moneyOfReceipt,
  receiveStock,
  reverseStockDocument,
  STOCK_DOC_REF,
  transferStock,
} from '../../core/inventory';
import { assertCostCenterOpen, postTransaction, resolveFxRate, type RecordSource } from '../../core/ledger';
import { hideMoney } from '../../core/privacy';
import { isoDate, listQuery, searchAny, sortBy, sumOf, type Page } from '../../core/query';

const { accounts, costCenters, counterparties, financeCategories, items, purchaseRequests, stockBatches, stockMovements, transactions, users, warehouses } = schema;

/** Undoes exactly one receipt, by the refId createReceipt returned. */
export { reverseStockDocument as reverseReceipt } from '../../core/inventory';

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
 * people saving at once cannot get the same number. A reversal deletes the movements of its
 * document, so the journal keeps the number from coming back. One statement, because a reversal
 * committing between two reads could hide its number from both.
 */
export async function nextDocNo(kind: DocKind, date: string): Promise<string> {
  const c = ctx();
  await tx().execute(sql`select pg_advisory_xact_lock(hashtext(${`docno:${c.farmId}`}))`);
  const prefix = `${DOC_PREFIX[kind]}-${date.slice(0, 4)}-`;
  const { rows } = await tx().execute(sql`
    select coalesce(max(substring(doc_no from '[0-9]+$')::bigint), 0) as last
    from (
      select doc_no from stock_movements where farm_id = ${c.farmId}
      union all
      select doc_no from stock_counts where farm_id = ${c.farmId}
      union all
      select data->>'docNo' from events where farm_id = ${c.farmId} and type = ${DOCUMENT_REVERSED_EVENT}
    ) numbers
    where doc_no ~ ${`^${prefix}[0-9]+$`}`);
  return `${prefix}${String(Number(rows[0].last) + 1).padStart(4, '0')}`;
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

type PaymentInput = z.infer<typeof paymentInput>;

export const receiptInput = z.object({
  warehouseId: z.uuid(),
  date: isoDate,
  source: z.enum(['purchase', 'opening', 'return']).default('purchase'),
  counterpartyId: z.uuid().nullish(),
  invoiceNo: z.string().trim().max(60).nullish(),
  currency: z.enum(CURRENCIES).optional(),
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

async function expenseCategoryId(match: SQL): Promise<string | null> {
  const [row] = await tx()
    .select({ id: financeCategories.id })
    .from(financeCategories)
    .where(and(eq(financeCategories.tenantId, ctx().tenantId), eq(financeCategories.kind, 'expense'), match));
  return row?.id ?? null;
}

/** The expense category a purchase of this kind of item posts to, or null when a person must choose. */
export async function defaultExpenseCategoryId(itemCategory: string): Promise<string | null> {
  const key = CATEGORY_BY_ITEM[itemCategory];
  return key ? expenseCategoryId(eq(financeCategories.key, key)) : null;
}

async function categoryIdFor(item: { id: string; name: string; category: string }, explicit?: string | null): Promise<string> {
  const id = explicit ? await expenseCategoryId(eq(financeCategories.id, explicit)) : await defaultExpenseCategoryId(item.category);
  if (!id) {
    throw badRequest('CATEGORY_REQUIRED', `Choose an expense category for ${item.name}`, { itemId: item.id, itemName: item.name });
  }
  return id;
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

interface MoneyGroup {
  categoryId: string;
  amount: number;
  amountBase: number;
  source: RecordSource;
}

/**
 * The money of a purchase, one row per expense category, so a mixed invoice lands on the right
 * budget lines. Approval looks at the whole document, so splitting it cannot dodge the second person.
 */
async function postPurchaseMoney(
  groups: MoneyGroup[],
  purchase: {
    date: string;
    currency: string;
    fxRate: number;
    counterpartyId?: string | null;
    description: string;
    payment: Pick<PaymentInput, 'paymentMethod' | 'accountId' | 'dueDate' | 'fileId'>;
  },
) {
  const { payment } = purchase;
  const costCenterId = await generalCostCenterId();
  const documentBase = round(groups.reduce((sum, group) => sum + group.amountBase, 0), 2);
  const rows = [];
  for (const group of groups) {
    if (group.amount <= 0) continue;
    rows.push(
      await postTransaction({
        date: purchase.date,
        type: 'expense',
        amount: group.amount,
        categoryId: group.categoryId,
        currency: purchase.currency,
        fxRate: purchase.fxRate,
        documentBase,
        paymentMethod: payment.paymentMethod,
        accountId: payment.paymentMethod === 'debt' ? null : payment.accountId,
        counterpartyId: purchase.counterpartyId,
        costCenterId,
        // Reaches a cost center when issued from the warehouse, not now (CLAUDE.md rule 3).
        costTreatment: 'inventory',
        description: purchase.description,
        dueDate: payment.dueDate,
        fileId: payment.fileId,
        sourceType: group.source.type,
        sourceId: group.source.id,
      }),
    );
  }
  return rows;
}

const describeDocument = (docNo: string | null, invoiceNo?: string | null, notes?: string | null) =>
  [docNo, invoiceNo, notes].filter(Boolean).join(' / ');

/** Stock moves today or earlier: a later date would leave the cost out of every report up to today. */
function assertNotFuture(date: string): void {
  if (date > today()) throw badRequest('FUTURE_DATE', 'The date cannot be in the future');
}

export async function createReceipt(input: ReceiptInput) {
  assertNotFuture(input.date);
  const { payment } = input;
  if (payment) assertPermission('finance.create');
  // Paid on the spot, nothing is owed to anyone, so the supplier may stay unnamed.
  const owed = !payment || payment.paymentMethod === 'debt';
  if (input.source === 'purchase' && owed && !input.counterpartyId) {
    throw badRequest('COUNTERPARTY_REQUIRED', 'A purchase on credit needs a supplier');
  }
  await assertWarehouse(input.warehouseId);
  if (input.counterpartyId) await assertCounterparty(input.counterpartyId);
  if (payment?.accountId) await assertAccount(payment.accountId);
  if (payment && input.source === 'purchase') {
    await assertNoPaidRequest(input.lines.map((line) => line.itemId), input.counterpartyId ?? null);
  }

  const currency = input.currency ?? ctx().currency;
  if (currency !== ctx().currency && !input.fxRate) throw badRequest('FX_RATE_REQUIRED', `Enter the exchange rate for ${currency}`);
  const fxRate = await resolveFxRate(currency, input.date, input.fxRate);

  const lines = [];
  for (const line of input.lines) {
    const item = await getItemOrThrow(line.itemId);
    lines.push({ line, categoryId: payment ? await categoryIdFor(item, payment.categoryId) : null });
  }

  const refId = uuidv7();
  const docNo = await nextDocNo('receipt', input.date);
  const batches = [];
  // One transaction per expense category, so a mixed invoice lands on the right budget lines.
  const groups = new Map<string | null, { amount: number; amountBase: number; batchId?: string }>();
  for (const { line, categoryId } of lines) {
    const group = groups.get(categoryId) ?? { amount: 0, amountBase: 0 };
    group.amount = round(group.amount + round(line.qty * line.unitCost, 2), 2);
    // What this line adds to the group's base amount, so stock costs exactly what the money comes to.
    const lineBase = round(toBaseAmount(group.amount, fxRate) - group.amountBase, 2);
    group.amountBase = round(group.amountBase + lineBase, 2);
    const qty = round(line.qty, 3);
    const { batch } = await receiveStock({
      itemId: line.itemId,
      warehouseId: input.warehouseId,
      qty,
      unitCost: lineBase / qty,
      date: input.date,
      source: input.source,
      batchNo: line.batchNo,
      expiryDate: line.expiryDate,
      counterpartyId: input.counterpartyId,
      docNo,
      refType: STOCK_DOC_REF,
      refId,
      notes: input.notes,
    });
    if (input.invoiceNo) {
      await tx().update(stockBatches).set({ invoiceNo: input.invoiceNo }).where(eq(stockBatches.id, batch.id));
    }
    batches.push(batch);
    group.batchId ??= batch.id;
    groups.set(categoryId, group);
  }

  const paymentRows = payment
    ? await postPurchaseMoney(
        [...groups].map(([categoryId, group]) => ({ ...group, categoryId: categoryId!, source: { type: 'stock_batch', id: group.batchId! } })),
        {
          date: input.date,
          currency,
          fxRate,
          counterpartyId: input.counterpartyId,
          description: describeDocument(docNo, input.invoiceNo, input.notes),
          payment,
        },
      )
    : [];

  return {
    docNo,
    /** Names exactly this receipt, for reverseReceipt. */
    refId,
    batches: hideMoney(batches, ['unitCost']),
    transactions: paymentRows.map((p) => ({ id: p.id, status: p.status })),
  };
}

// ─── Receipts with no money ────────────────────────────────────────────────

/** A paid request naming no supplier could be any delivery of the item. */
const paidRequestFor = (farmId: SQLWrapper | string, itemId: SQLWrapper | string, counterpartyId: SQLWrapper | string | null) =>
  and(
    eq(purchaseRequests.farmId, farmId),
    eq(purchaseRequests.status, 'paid'),
    eq(purchaseRequests.itemId, itemId),
    or(isNull(purchaseRequests.counterpartyId), counterpartyId ? eq(purchaseRequests.counterpartyId, counterpartyId) : undefined),
  );

/** Money for goods a paid request is still waiting for would count twice. */
async function assertNoPaidRequest(itemIds: string[], counterpartyId: string | null, docNo?: string | null): Promise<void> {
  const [request] = await tx()
    .select({ id: purchaseRequests.id })
    .from(purchaseRequests)
    .where(or(...itemIds.map((itemId) => paidRequestFor(ctx().farmId, itemId, counterpartyId))))
    .limit(1);
  if (request) {
    throw conflict('RECEIPT_PAID_BY_REQUEST', 'A paid purchase request is waiting for these goods, so money here would count twice', {
      docNo,
      requestId: request.id,
    });
  }
}

/**
 * A storekeeper receives goods but cannot post money, and money is never posted for them: the same
 * purchase may already be paid. So a purchase from a supplier with nothing recorded stays visible to
 * finance until a person says what it was. Goods of a purchase request carry its reference, not a
 * warehouse document, because the request holds their money.
 */
function unpaidDocuments() {
  const m = stockMovements;
  const line = alias(m, 'line');
  const batchIds = tx()
    .select({ id: line.batchId })
    .from(line)
    .where(and(eq(line.farmId, m.farmId), eq(line.refType, STOCK_DOC_REF), eq(line.refId, m.refId)));
  const money = tx()
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.farmId, m.farmId), moneyOfReceipt(m.refId, batchIds)));
  const paidRequest = tx()
    .select({ id: purchaseRequests.id })
    .from(purchaseRequests)
    .where(paidRequestFor(m.farmId, m.itemId, stockBatches.counterpartyId));
  return tx()
    .select({
      id: m.refId,
      docNo: m.docNo,
      date: m.date,
      counterpartyId: stockBatches.counterpartyId,
      supplier: counterparties.name,
      invoiceNo: sql<string | null>`max(${stockBatches.invoiceNo})`.as('invoice_no'),
      value: sumOf(m.totalCost).as('value'),
      goods: sql<string>`string_agg(${items.name}, ', ' order by ${m.id})`.as('goods'),
      lines: sql<{ itemName: string; itemCategory: string; unit: string; qty: number; value: number }[]>`json_agg(
        json_build_object('itemName', ${items.name}, 'itemCategory', ${items.category}, 'unit', ${items.unit}, 'qty', ${m.qty}, 'value', ${m.totalCost})
        order by ${m.id})`.as('lines'),
      /** These may be the goods a request already paid for, entered as a plain receipt: money here would count twice. */
      paidRequest: sql<boolean>`bool_or(${exists(paidRequest)})`.as('paid_request'),
    })
    .from(m)
    .innerJoin(stockBatches, eq(stockBatches.id, m.batchId))
    .innerJoin(counterparties, eq(counterparties.id, stockBatches.counterpartyId))
    .innerJoin(items, eq(items.id, m.itemId))
    .where(and(eq(m.farmId, ctx().farmId), eq(m.type, 'receipt'), eq(m.reason, 'purchase'), eq(m.refType, STOCK_DOC_REF), notExists(money)))
    .groupBy(m.refId, m.docNo, m.date, stockBatches.counterpartyId, counterparties.name)
    // Free goods have nothing to record, so they would stay here for good.
    .having(sql`sum(${m.totalCost}) > 0`)
    .as('unpaid');
}

/** Oldest first: those are the ones a supplier is waiting on. Value is in the base currency. */
export async function unpaidReceipts(q: z.infer<typeof listQuery>): Promise<Page<Record<string, unknown>>> {
  const docs = unpaidDocuments();
  const where = searchAny(q.search, [docs.supplier, docs.docNo, sql`${docs.invoiceNo}`, sql`${docs.goods}`]);
  const data = await tx()
    .select()
    .from(docs)
    .where(where)
    .orderBy(...sortBy(q.sort, { date: docs.date, supplier: docs.supplier, value: sql`${docs.value}` }, asc(docs.date), docs.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [{ total }] = await tx().select({ total: count() }).from(docs).where(where);
  return { data, meta: { page: q.page, pageSize: q.pageSize, total } };
}

/** Every one of them, for the alert rule, which must see them all to resolve what has gone. */
export const allUnpaidReceipts = () => tx().select().from(unpaidDocuments());

export const receiptMoneyInput = paymentInput.omit({ fileId: true }).extend({
  /** The day the money moved or the debt arose. The day of the receipt when left out. */
  date: isoDate.optional(),
});

/**
 * Say what an unpaid receipt was: paid, or owed. The amount is what the receipt put in stock, in the
 * base currency, so stock and money agree. The rows carry the document, not a batch: refusing them
 * later puts the receipt back on the list and leaves the goods alone (see core/ledger). Refused while
 * a paid request waits for these goods: they would be paid twice, and receiving that request later
 * would double the stock too.
 */
export async function recordReceiptMoney(refId: string, input: z.infer<typeof receiptMoneyInput>) {
  const m = stockMovements;
  const c = ctx();
  // The lock holds off a second entry and a reversal of this receipt until this one lands.
  const lines = await tx()
    .select({
      batchId: m.batchId,
      itemId: m.itemId,
      docNo: m.docNo,
      date: m.date,
      value: m.totalCost,
      notes: m.notes,
      counterpartyId: stockBatches.counterpartyId,
      invoiceNo: stockBatches.invoiceNo,
    })
    .from(m)
    .innerJoin(stockBatches, eq(stockBatches.id, m.batchId))
    .where(and(eq(m.farmId, c.farmId), eq(m.type, 'receipt'), eq(m.reason, 'purchase'), eq(m.refType, STOCK_DOC_REF), eq(m.refId, refId)))
    .orderBy(asc(m.id))
    .for('update', { of: m });
  if (lines.length === 0) throw notFound('Receipt');
  const [{ docNo, date, counterpartyId, invoiceNo, notes }] = lines;

  const [money] = await tx()
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.farmId, c.farmId), moneyOfReceipt(refId, lines.map((line) => line.batchId))))
    .limit(1);
  if (money) throw conflict('RECEIPT_HAS_MONEY', 'Money is already recorded for this receipt', { docNo });

  await assertNoPaidRequest(lines.map((line) => line.itemId), counterpartyId, docNo);

  const groups = new Map<string, MoneyGroup>();
  for (const line of lines) {
    const categoryId = await categoryIdFor(await getItemOrThrow(line.itemId), input.categoryId);
    const group = groups.get(categoryId) ?? { categoryId, amount: 0, amountBase: 0, source: { type: STOCK_DOC_REF, id: refId } };
    group.amount = group.amountBase = round(group.amount + line.value, 2);
    groups.set(categoryId, group);
  }
  if (![...groups.values()].some((group) => group.amount > 0)) throw badRequest('INVALID_AMOUNT', 'This receipt has no value to record');

  const rows = await postPurchaseMoney([...groups.values()], {
    date: input.date ?? date,
    currency: c.currency,
    fxRate: 1,
    counterpartyId,
    description: describeDocument(docNo, invoiceNo, notes),
    payment: input,
  });
  return { docNo, transactions: rows.map((row) => ({ id: row.id, status: row.status })) };
}

export async function createIssue(input: IssueInput) {
  assertNotFuture(input.date);
  await assertWarehouse(input.warehouseId);
  await assertCostCenterOpen(input.costCenterId);

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
      refType: STOCK_DOC_REF,
      refId: docId,
      notes: input.notes,
    });
  }
  return { docNo };
}

export async function createTransfer(input: TransferInput) {
  assertNotFuture(input.date);
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
 * Undo a mistaken receipt or issue a person names by its number. Records from other modules (daily
 * logs, operations) are corrected where they were entered, and a receipt with a live payment goes
 * through finance first. Code holding a refId calls reverseReceipt.
 */
export async function reverseDocument(docNo: string) {
  const documents = await tx()
    .selectDistinct({ refType: stockMovements.refType, refId: stockMovements.refId })
    .from(stockMovements)
    .where(and(eq(stockMovements.farmId, ctx().farmId), eq(stockMovements.docNo, docNo)));
  if (documents.length === 0) throw notFound('Document');
  // Numbers used to be reissued after a reversal, so older documents can share one.
  if (documents.length > 1) {
    throw conflict('DOCUMENT_NUMBER_AMBIGUOUS', 'Two documents share this number', { docNo });
  }
  const [{ refType, refId }] = documents;
  if (refType !== STOCK_DOC_REF || !refId) {
    throw conflict('DOCUMENT_NOT_REVERSIBLE', 'This document cannot be reversed here');
  }
  return reverseStockDocument(refId);
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
      // The farm-wide center is stored as "General"; the type lets the screen show it translated.
      costCenterType: costCenters.type,
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
