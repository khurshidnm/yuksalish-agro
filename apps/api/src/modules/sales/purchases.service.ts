/**
 * Purchase flow (spec 13.3): the storekeeper or zootechnician requests, the manager approves,
 * finance pays, the storekeeper receives. Each step can only follow the one before it.
 */
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { round } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { generalCostCenterId } from '../../core/costCenters';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { getItemOrThrow, receiveStock } from '../../core/inventory';
import { recordEvent } from '../../core/journal';
import { postTransaction } from '../../core/ledger';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, searchAny, sortBy } from '../../core/query';
import { MAX_MONEY, MAX_QTY, SALE_PAYMENT_METHODS } from './constants';
import { notifyPurchaseApproved, notifyPurchasePaid, notifyPurchaseRequested } from './notify';
import { assertAccount, assertCounterparty, assertFile, assertWarehouses } from './refs';

const { counterparties, financeCategories, items, purchaseRequests, stockBatches, warehouses } = schema;

type Request = typeof purchaseRequests.$inferSelect;

const PURCHASE_STATUSES = ['requested', 'approved', 'rejected', 'paid', 'received'] as const;
const MONEY_FIELDS = ['expectedPrice', 'paidAmount', 'unitCost', 'diffAmount'] as const;

export const purchaseInput = z.object({
  id: clientId,
  itemId: z.uuid(),
  qty: z.number().positive().max(MAX_QTY),
  expectedPrice: z.number().min(0).max(MAX_MONEY).nullish(),
  counterpartyId: z.uuid().nullish(),
  neededBy: isoDate.nullish(),
  notes: z.string().max(1000).nullish(),
});
export type PurchaseInput = z.infer<typeof purchaseInput>;

export const purchaseListQuery = listQuery.extend({
  status: z.enum(PURCHASE_STATUSES).optional(),
  itemId: z.uuid().optional(),
});

export const payInput = z.object({
  date: isoDate,
  amount: z.number().positive().max(MAX_MONEY),
  paymentMethod: z.enum(SALE_PAYMENT_METHODS),
  accountId: z.uuid().nullish(),
  counterpartyId: z.uuid().nullish(),
  dueDate: isoDate.nullish(),
  fileId: z.uuid().nullish(),
});

export const receiveInput = z.object({
  date: isoDate,
  qty: z.number().positive().max(MAX_QTY),
  warehouseId: z.uuid(),
  quality: z.string().trim().max(200).nullish(),
  batchNo: z.string().trim().max(60).nullish(),
  expiryDate: isoDate.nullish(),
  notes: z.string().max(1000).nullish(),
});

/** Which expense category a purchase of this kind of item belongs to (spec 10.1). */
const CATEGORY_BY_ITEM: Record<string, string> = {
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

function baseSelect() {
  return tx()
    .select({
      request: purchaseRequests,
      itemName: items.name,
      itemCategory: items.category,
      unit: items.unit,
      counterpartyName: counterparties.name,
      warehouseName: warehouses.name,
    })
    .from(purchaseRequests)
    .innerJoin(items, eq(items.id, purchaseRequests.itemId))
    .leftJoin(counterparties, eq(counterparties.id, purchaseRequests.counterpartyId))
    .leftJoin(warehouses, eq(warehouses.id, purchaseRequests.warehouseId));
}

type Row = Awaited<ReturnType<typeof baseSelect>>[number];

function present(rows: Row[]) {
  return hideMoney(
    rows.map((r) => ({
      ...r.request,
      itemName: r.itemName,
      itemCategory: r.itemCategory,
      unit: r.unit,
      counterpartyName: r.counterpartyName,
      warehouseName: r.warehouseName,
    })),
    [...MONEY_FIELDS],
  );
}

export async function list(q: z.infer<typeof purchaseListQuery>) {
  const where = and(
    eq(purchaseRequests.farmId, ctx().farmId),
    q.status ? eq(purchaseRequests.status, q.status) : undefined,
    q.itemId ? eq(purchaseRequests.itemId, q.itemId) : undefined,
    searchAny(q.search, [items.name, counterparties.name, purchaseRequests.notes]),
  );
  const rows = await baseSelect()
    .where(where)
    .orderBy(
      ...sortBy(
        q.sort,
        { createdAt: purchaseRequests.createdAt, status: purchaseRequests.status, neededBy: purchaseRequests.neededBy },
        desc(purchaseRequests.createdAt),
        purchaseRequests.id,
      ),
    )
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [{ total }] = await tx()
    .select({ total: count() })
    .from(purchaseRequests)
    .innerJoin(items, eq(items.id, purchaseRequests.itemId))
    .leftJoin(counterparties, eq(counterparties.id, purchaseRequests.counterpartyId))
    .where(where);
  return { data: present(rows), meta: { page: q.page, pageSize: q.pageSize, total } };
}

export async function get(id: string) {
  const rows = await baseSelect().where(and(eq(purchaseRequests.id, id), eq(purchaseRequests.farmId, ctx().farmId)));
  if (!rows[0]) throw notFound('Purchase request');
  return present(rows)[0];
}

async function lock(id: string): Promise<Request> {
  const [row] = await tx()
    .select()
    .from(purchaseRequests)
    .where(and(eq(purchaseRequests.id, id), eq(purchaseRequests.farmId, ctx().farmId)))
    .for('update');
  if (!row) throw notFound('Purchase request');
  return row;
}

function assertStatus(row: Request, expected: Request['status']): void {
  if (row.status !== expected) {
    throw conflict('PURCHASE_WRONG_STATE', `This request is ${row.status}, it must be ${expected} first`, {
      status: row.status,
      expected,
    });
  }
}

export async function create(input: PurchaseInput) {
  const item = await getItemOrThrow(input.itemId);
  await assertCounterparty(input.counterpartyId);
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(purchaseRequests)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({
    type: 'purchase.requested',
    entityType: 'purchase_request',
    entityId: row.id,
    data: { itemId: row.itemId, qty: row.qty },
  });
  await notifyPurchaseRequested(item.name);
  return get(row.id);
}

export async function update(id: string, input: Partial<PurchaseInput>) {
  const row = await lock(id);
  assertStatus(row, 'requested');
  const { id: _ignored, ...values } = input;
  if (values.itemId) await getItemOrThrow(values.itemId);
  await assertCounterparty(values.counterpartyId);
  await tx().update(purchaseRequests).set(values).where(eq(purchaseRequests.id, id));
  return get(id);
}

export async function remove(id: string) {
  const row = await lock(id);
  assertStatus(row, 'requested');
  await tx().delete(purchaseRequests).where(eq(purchaseRequests.id, id));
  return { id };
}

function assertSecondPerson(row: Request): void {
  const c = ctx();
  if (c.settings.finance.makerChecker && row.createdBy === c.userId) {
    throw forbidden('The person who made a request cannot decide on it', 'SAME_MAKER_CHECKER');
  }
}

export async function approve(id: string) {
  const row = await lock(id);
  assertStatus(row, 'requested');
  assertSecondPerson(row);
  await tx()
    .update(purchaseRequests)
    .set({ status: 'approved', approvedBy: ctx().userId, approvedAt: new Date() })
    .where(eq(purchaseRequests.id, id));
  await recordEvent({ type: 'purchase.approved', entityType: 'purchase_request', entityId: id });
  await notifyPurchaseApproved((await getItemOrThrow(row.itemId)).name);
  return get(id);
}

export async function reject(id: string, reason: string) {
  const row = await lock(id);
  assertStatus(row, 'requested');
  assertSecondPerson(row);
  await tx()
    .update(purchaseRequests)
    .set({ status: 'rejected', approvedBy: ctx().userId, approvedAt: new Date(), rejectedReason: reason })
    .where(eq(purchaseRequests.id, id));
  await recordEvent({ type: 'purchase.rejected', entityType: 'purchase_request', entityId: id, data: { reason } });
  return get(id);
}

async function expenseCategoryFor(itemId: string): Promise<string> {
  const item = await getItemOrThrow(itemId);
  const key = CATEGORY_BY_ITEM[item.category];
  if (!key) throw badRequest('CATEGORY_REQUIRED', `No expense category for items of type ${item.category}`);
  const [category] = await tx()
    .select({ id: financeCategories.id })
    .from(financeCategories)
    .where(and(eq(financeCategories.tenantId, ctx().tenantId), eq(financeCategories.key, key)));
  if (!category) throw badRequest('CATEGORY_REQUIRED', `Expense category "${key}" is missing`);
  return category.id;
}

/**
 * Pay for an approved request. The cost is capitalised into stock (costTreatment 'inventory'),
 * so it reaches a cost center only when the goods are issued.
 * Within the approved estimate the manager has already decided, so the posting is approved.
 * Above it, or with no estimate, the ledger applies its usual threshold.
 */
export async function pay(id: string, input: z.infer<typeof payInput>) {
  const row = await lock(id);
  assertStatus(row, 'approved');
  await assertAccount(input.accountId);
  await assertCounterparty(input.counterpartyId);
  await assertFile(input.fileId);
  const counterpartyId = input.counterpartyId ?? row.counterpartyId;
  const estimate = row.expectedPrice === null ? null : round(row.qty * row.expectedPrice, 2);

  const transaction = await postTransaction({
    date: input.date,
    type: 'expense',
    amount: input.amount,
    categoryId: await expenseCategoryFor(row.itemId),
    costCenterId: await generalCostCenterId(),
    costTreatment: 'inventory',
    paymentMethod: input.paymentMethod,
    accountId: input.accountId,
    counterpartyId,
    dueDate: input.dueDate,
    fileId: input.fileId,
    sourceType: 'purchase_request',
    sourceId: id,
    autoApprove: estimate !== null && input.amount <= estimate,
  });

  await tx()
    .update(purchaseRequests)
    .set({
      status: 'paid',
      counterpartyId,
      transactionId: transaction.id,
      paidAmount: transaction.amountBase,
      unitCost: transaction.amountBase / row.qty,
    })
    .where(eq(purchaseRequests.id, id));
  await recordEvent({
    type: 'purchase.paid',
    entityType: 'purchase_request',
    entityId: id,
    occurredAt: input.date,
    data: { amountBase: transaction.amountBase, transactionStatus: transaction.status },
  });
  await notifyPurchasePaid((await getItemOrThrow(row.itemId)).name);
  return get(id);
}

/**
 * Receive the goods. A difference between requested and received quantity is recorded as an
 * act (spec 13.3): stock takes what really arrived, valued at the paid unit cost, and a shortfall
 * is the value still owed by the supplier.
 */
export async function receive(id: string, input: z.infer<typeof receiveInput>) {
  const row = await lock(id);
  assertStatus(row, 'paid');
  await assertWarehouses([input.warehouseId]);
  const unitCost = row.unitCost!;
  const { batch } = await receiveStock({
    itemId: row.itemId,
    warehouseId: input.warehouseId,
    qty: input.qty,
    unitCost,
    date: input.date,
    source: 'purchase',
    counterpartyId: row.counterpartyId,
    batchNo: input.batchNo,
    expiryDate: input.expiryDate,
    refType: 'purchase_request',
    refId: id,
    notes: input.notes,
  });
  const diffQty = round(input.qty - row.qty, 3);
  await tx()
    .update(purchaseRequests)
    .set({
      status: 'received',
      warehouseId: input.warehouseId,
      receivedQty: input.qty,
      receivedOn: input.date,
      batchId: batch.id,
      quality: input.quality,
      diffQty,
      diffAmount: round(diffQty * unitCost, 2),
      notes: input.notes ?? row.notes,
    })
    .where(eq(purchaseRequests.id, id));
  await recordEvent({
    type: 'purchase.received',
    entityType: 'purchase_request',
    entityId: id,
    occurredAt: input.date,
    severity: diffQty === 0 ? 'info' : 'attention',
    data: { requested: row.qty, received: input.qty, diffQty },
  });
  return get(id);
}

/** Price history of one item by supplier, from what was really bought (spec 13.3). */
export async function supplierPrices(itemId: string) {
  const item = await getItemOrThrow(itemId);
  const farmId = ctx().farmId;
  const purchases = and(
    eq(stockBatches.farmId, farmId),
    eq(stockBatches.itemId, itemId),
    eq(stockBatches.source, 'purchase'),
    sql`${stockBatches.counterpartyId} is not null`,
  );

  const history = await tx()
    .select({
      batchId: stockBatches.id,
      date: stockBatches.receivedDate,
      counterpartyId: stockBatches.counterpartyId,
      name: counterparties.name,
      qty: stockBatches.qtyReceived,
      unitCost: stockBatches.unitCost,
    })
    .from(stockBatches)
    .innerJoin(counterparties, eq(counterparties.id, stockBatches.counterpartyId))
    .where(purchases)
    .orderBy(asc(stockBatches.receivedDate), asc(stockBatches.createdAt));

  const bySupplier = new Map<
    string,
    { counterpartyId: string; name: string; purchases: number; totalQty: number; totalCost: number; lastDate: string; lastPrice: number; minPrice: number; maxPrice: number }
  >();
  for (const h of history) {
    const s = bySupplier.get(h.counterpartyId!) ?? {
      counterpartyId: h.counterpartyId!,
      name: h.name,
      purchases: 0,
      totalQty: 0,
      totalCost: 0,
      lastDate: h.date,
      lastPrice: h.unitCost,
      minPrice: h.unitCost,
      maxPrice: h.unitCost,
    };
    s.purchases += 1;
    s.totalQty += h.qty;
    s.totalCost += h.qty * h.unitCost;
    s.lastDate = h.date;
    s.lastPrice = h.unitCost;
    s.minPrice = Math.min(s.minPrice, h.unitCost);
    s.maxPrice = Math.max(s.maxPrice, h.unitCost);
    bySupplier.set(h.counterpartyId!, s);
  }

  const suppliers = [...bySupplier.values()]
    .map(({ totalCost, ...s }) => ({
      ...s,
      totalQty: round(s.totalQty, 3),
      avgPrice: s.totalQty > 0 ? round(totalCost / s.totalQty, 2) : null,
    }))
    .sort((a, b) => (a.avgPrice ?? 0) - (b.avgPrice ?? 0));

  return {
    item: { id: item.id, name: item.name, unit: item.unit },
    suppliers: hideMoney(suppliers, ['avgPrice', 'lastPrice', 'minPrice', 'maxPrice']),
    history: hideMoney(history, ['unitCost']),
  };
}
