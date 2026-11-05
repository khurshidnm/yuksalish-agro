/**
 * Money posting. The ONLY code allowed to create or change `transactions` (CLAUDE.md rule 2).
 * Validation, currency conversion and the approval flow live here so that purchases, sales,
 * payroll and manual entries all behave the same way.
 */
import { and, asc, desc, eq, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { round, toBaseAmount, type CostTreatment, type TransactionType } from '@yap/shared';
import { schema } from '../db/client';
import { ctx, hasPermission, tx } from './context';
import { badRequest, conflict, forbidden, notFound } from './errors';
import { receiptOfBatch, removeEmptyBatches, reverseMovements, reverseStockDocument } from './inventory';
import { recordEvent } from './journal';

const { accounts, animalExits, assetUsageLogs, costCenters, fxRates, maintenanceRecords, purchaseRequests, transactions } = schema;

type Transaction = typeof transactions.$inferSelect;

/** The record that created an entry: fills sourceType and sourceId (CLAUDE.md cross-module rules). */
export interface RecordSource {
  type: string;
  id: string;
}

export type DebtDirection = 'payable' | 'receivable';

const FX_RATE_TOLERANCE = 2;

/** False for a typed rate so far from the stored one that it is a slip, such as 1 for a dollar. */
export function fxRateIsPlausible(given: number, stored: number): boolean {
  return given <= stored * FX_RATE_TOLERANCE && given >= stored / FX_RATE_TOLERANCE;
}

const DEBT_KIND = {
  payable: { document: 'expense', settlement: 'debt_payment' },
  receivable: { document: 'income', settlement: 'debt_receipt' },
} as const;

/** Loans are tracked in their own schedule, so their money never settles a trade debt. */
export const tradeSettlement = or(isNull(transactions.sourceType), notInArray(transactions.sourceType, ['loan', 'loan_instalment']));

export interface PostTransactionInput {
  id?: string;
  date: string;
  type: TransactionType;
  amount: number;
  categoryId?: string | null;
  currency?: string;
  /** Rate to the base currency. Looked up in fx_rates when omitted. */
  fxRate?: number | null;
  paymentMethod: 'cash' | 'bank' | 'card' | 'debt' | 'non_cash';
  accountId?: string | null;
  toAccountId?: string | null;
  counterpartyId?: string | null;
  costCenterId?: string | null;
  /** See COST_TREATMENTS in shared/enums.ts. Purchases for stock must pass 'inventory'. */
  costTreatment?: CostTreatment;
  description?: string | null;
  dueDate?: string | null;
  fileId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  /** System postings already approved elsewhere, e.g. depreciation or an approved payroll run. */
  autoApprove?: boolean;
  /** Base amount of the whole document when it posts several rows, so splitting it cannot dodge approval. */
  documentBase?: number;
}

/** The rate to the base currency: the one given, or the stored one for that date. */
export async function resolveFxRate(currency: string, date: string, given?: number | null): Promise<number> {
  const c = ctx();
  if (currency === c.currency) return 1;
  const [stored] = await tx()
    .select({ rate: fxRates.rate })
    .from(fxRates)
    .where(and(eq(fxRates.tenantId, c.tenantId), eq(fxRates.currency, currency), lte(fxRates.date, date)))
    .orderBy(desc(fxRates.date))
    .limit(1);
  if (!given || given <= 0) {
    if (!stored) throw badRequest('FX_RATE_REQUIRED', `No exchange rate for ${currency} on ${date}`);
    return stored.rate;
  }
  if (stored && !fxRateIsPlausible(given, stored.rate)) {
    throw badRequest('FX_RATE_OUT_OF_RANGE', `${given} is too far from the stored ${currency} rate of ${stored.rate}`, {
      currency,
      given,
      stored: stored.rate,
    });
  }
  return given;
}

/** What an amount comes to in the base currency, at the given rate or the stored one for that date. */
export async function amountInBase(amount: number, currency: string, date: string, fxRate?: number | null): Promise<number> {
  return toBaseAmount(amount, await resolveFxRate(currency, date, fxRate));
}

/** A foreign account only moves its own currency. A base account can settle anything at the base amount. */
export function accountTakesCurrency(accountCurrency: string, currency: string): boolean {
  return accountCurrency === ctx().currency || accountCurrency === currency;
}

/**
 * A closed account drops out of every balance, so money moved through it would vanish from sight.
 * The shared lock holds off closing the account, or changing its currency, until this money lands.
 */
async function assertAccounts(i: Pick<Transaction, 'accountId' | 'toAccountId' | 'type'> | PostTransactionInput, currency: string): Promise<void> {
  const ids = new Set([i.accountId, i.toAccountId].filter((id): id is string => !!id));
  if (ids.size === 0) return;
  const rows = await tx()
    .select({ currency: accounts.currency, active: accounts.active })
    .from(accounts)
    .where(and(eq(accounts.farmId, ctx().farmId), inArray(accounts.id, [...ids])))
    .for('share');
  if (rows.length !== ids.size) throw notFound('Account');
  if (rows.some((row) => !row.active)) throw conflict('ACCOUNT_CLOSED', 'This account is closed');
  if (rows.some((row) => !accountTakesCurrency(row.currency, currency))) {
    throw badRequest('ACCOUNT_CURRENCY_MISMATCH', 'This account holds a different currency');
  }
  if (i.type === 'transfer' && rows[0].currency !== rows[1].currency) {
    throw badRequest('ACCOUNT_CURRENCY_MISMATCH', 'A transfer needs two accounts in the same currency');
  }
}

/**
 * For a cost center a person chose. Postings worked out from a record skip this, because an old
 * field can still get a late bill for work done before it was archived.
 */
export async function assertCostCenterOpen(id: string): Promise<void> {
  const [row] = await tx()
    .select({ active: costCenters.active })
    .from(costCenters)
    .where(and(eq(costCenters.id, id), eq(costCenters.farmId, ctx().farmId)));
  if (!row) throw notFound('Cost center');
  if (!row.active) throw conflict('COST_CENTER_CLOSED', 'This cost center is closed. Choose another one');
}

function validate(i: PostTransactionInput): void {
  if (!(i.amount > 0)) throw badRequest('INVALID_AMOUNT', 'Amount must be greater than zero');

  if (i.type === 'transfer') {
    if (!i.accountId || !i.toAccountId) {
      throw badRequest('ACCOUNTS_REQUIRED', 'A transfer needs a source and a destination account');
    }
    if (i.accountId === i.toAccountId) {
      throw badRequest('SAME_ACCOUNT', 'Source and destination accounts must differ');
    }
    return;
  }

  if (i.type === 'expense' || i.type === 'income') {
    if (!i.categoryId) throw badRequest('CATEGORY_REQUIRED', 'Choose a category');
    if (!i.costCenterId) throw badRequest('COST_CENTER_REQUIRED', 'Choose a cost center');
  }
  if (i.paymentMethod === 'non_cash') {
    if (!i.autoApprove || i.type !== 'expense') {
      throw badRequest('INVALID_PAYMENT_METHOD', 'Only system expenses can be non-cash');
    }
  } else if (i.paymentMethod === 'debt') {
    if (!i.counterpartyId) throw badRequest('COUNTERPARTY_REQUIRED', 'A debt needs a counterparty');
    if (i.type === 'debt_payment' || i.type === 'debt_receipt') {
      throw badRequest('INVALID_PAYMENT_METHOD', 'A debt settlement must move real money');
    }
  } else if (!i.accountId) {
    throw badRequest('ACCOUNT_REQUIRED', 'Choose a cash or bank account');
  }
  if ((i.type === 'debt_payment' || i.type === 'debt_receipt') && !i.counterpartyId) {
    throw badRequest('COUNTERPARTY_REQUIRED', 'A debt settlement needs a counterparty');
  }
}

/** Create a transaction. At or above the approval threshold it stays `pending`. */
export async function postTransaction(i: PostTransactionInput): Promise<Transaction> {
  validate(i);
  const c = ctx();
  const currency = i.currency ?? c.currency;
  await assertAccounts(i, currency);
  const fxRate = await resolveFxRate(currency, i.date, i.fxRate);
  const amountBase = toBaseAmount(i.amount, fxRate);

  const needsApproval =
    !i.autoApprove &&
    c.settings.finance.makerChecker &&
    Math.max(amountBase, i.documentBase ?? 0) >= c.settings.finance.approvalThreshold;

  const [row] = await tx()
    .insert(transactions)
    .values({
      ...(i.id ? { id: i.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      date: i.date,
      type: i.type,
      categoryId: i.categoryId,
      amount: i.amount,
      currency,
      fxRate,
      amountBase,
      paymentMethod: i.paymentMethod,
      accountId: i.accountId,
      toAccountId: i.toAccountId,
      counterpartyId: i.counterpartyId,
      costCenterId: i.costCenterId,
      costTreatment: i.costTreatment ?? 'expense',
      status: needsApproval ? 'pending' : 'approved',
      description: i.description,
      dueDate: i.dueDate,
      fileId: i.fileId,
      sourceType: i.sourceType,
      sourceId: i.sourceId,
    })
    .returning();

  await recordEvent({
    type: `transaction.${i.type}`,
    entityType: 'transaction',
    entityId: row.id,
    occurredAt: i.date,
    data: { amountBase, status: row.status, categoryId: i.categoryId, costCenterId: i.costCenterId },
  });
  return row;
}

async function getPendingForUpdate(id: string): Promise<Transaction> {
  const [row] = await tx()
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.farmId, ctx().farmId)))
    .for('update');
  if (!row) throw notFound('Transaction');
  if (row.status !== 'pending') throw conflict('NOT_PENDING', 'This transaction is not waiting for approval');
  return row;
}

function assertCanDecide(row: Transaction): void {
  const c = ctx();
  if (!hasPermission('finance.approve')) throw forbidden();
  if (c.settings.finance.makerChecker && row.createdBy === c.userId) {
    throw forbidden('The person who entered a transaction cannot approve it', 'SAME_MAKER_CHECKER');
  }
}

export async function approveTransaction(id: string): Promise<Transaction> {
  const row = await getPendingForUpdate(id);
  assertCanDecide(row);
  // Approval is when the money moves, and the account may have closed while it waited.
  await assertAccounts(row, row.currency);
  const c = ctx();
  const [updated] = await tx()
    .update(transactions)
    .set({ status: 'approved', approvedBy: c.userId, approvedAt: new Date() })
    .where(eq(transactions.id, id))
    .returning();
  await recordEvent({
    type: 'transaction.approved',
    entityType: 'transaction',
    entityId: id,
    data: { amountBase: row.amountBase },
  });
  return updated;
}

const rejectedAs = (reason: string) => ({
  status: 'rejected',
  approvedBy: ctx().userId,
  approvedAt: new Date(),
  rejectedReason: reason,
});

/**
 * Their money can be cancelled in finance. An animal sale, a repair and a rental act are then
 * corrected where they were entered; a purchase request is put right here: see reopenPurchaseRequest.
 */
export const SOURCES_RELEASED_BY_CANCEL = ['animal_exit', 'maintenance', 'rental_act', 'purchase_request'];

/**
 * A purchase request is paid once, so cancelling that payment undoes everything after it: goods
 * with no money behind them leave, and the request waits to be paid again. Refused with
 * BATCH_ALREADY_USED or AVERAGE_COST_USED once the goods were used, as a stock purchase is.
 */
async function reopenPurchaseRequest(row: Transaction): Promise<void> {
  const [request] = await tx().select().from(purchaseRequests).where(eq(purchaseRequests.transactionId, row.id)).for('update');
  if (!request) return;
  await reverseMovements('purchase_request', request.id);
  await tx()
    .update(purchaseRequests)
    .set({
      status: 'approved',
      transactionId: null,
      paidAmount: null,
      unitCost: null,
      warehouseId: null,
      receivedQty: null,
      receivedOn: null,
      batchId: null,
      quality: null,
      diffQty: null,
      diffAmount: null,
    })
    .where(eq(purchaseRequests.id, request.id));
  if (request.batchId) await removeEmptyBatches([request.batchId]);
  await recordEvent({
    type: 'purchase.payment_cancelled',
    entityType: 'purchase_request',
    entityId: request.id,
    severity: 'attention',
    data: { transactionId: row.id, reason: row.rejectedReason, receivedQty: request.receivedQty },
  });
}

/** These records refuse to be undone, billed again or moved on while they point at money. */
async function releaseSource(row: Transaction): Promise<void> {
  if (row.sourceType === 'animal_exit') {
    await tx().update(animalExits).set({ transactionId: null }).where(eq(animalExits.transactionId, row.id));
  } else if (row.sourceType === 'maintenance') {
    await tx().update(maintenanceRecords).set({ transactionId: null }).where(eq(maintenanceRecords.transactionId, row.id));
  } else if (row.sourceType === 'rental_act') {
    await tx().update(assetUsageLogs).set({ billedTransactionId: null }).where(eq(assetUsageLogs.billedTransactionId, row.id));
  } else if (row.sourceType === 'purchase_request') {
    await reopenPurchaseRequest(row);
  }
}

async function rejectPending(id: string, reason: string): Promise<Transaction> {
  const [updated] = await tx().update(transactions).set(rejectedAs(reason)).where(eq(transactions.id, id)).returning();
  await releaseSource(updated);
  await recordEvent({
    type: 'transaction.rejected',
    entityType: 'transaction',
    entityId: id,
    data: { reason },
  });
  return updated;
}

/** Refuse money waiting for approval. A stock purchase goes whole: see cancelStockPurchase. */
export async function rejectTransaction(id: string, reason: string): Promise<Transaction> {
  const row = await getPendingForUpdate(id);
  assertCanDecide(row);
  if (row.sourceType !== 'stock_batch') return rejectPending(id, reason);
  const cancelled = await cancelStockPurchase(row.sourceId!, reason);
  return cancelled.find((entry) => entry.id === id)!;
}

/**
 * A stock purchase stands or falls whole: cancelling any of its money cancels all of it and takes
 * the receipt back, in this transaction. Refused with BATCH_ALREADY_USED or AVERAGE_COST_USED once
 * the stock has been used, because money refused while the goods stay leaves stock with no cost
 * behind it, and with DEBT_ALREADY_SETTLED when a payment stands on its debt.
 * Callers decide who may do this.
 */
export async function cancelStockPurchase(batchId: string, reason: string): Promise<Transaction[]> {
  const receipt = await receiptOfBatch(batchId);
  const live = await tx()
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.farmId, ctx().farmId),
        eq(transactions.sourceType, 'stock_batch'),
        inArray(transactions.sourceId, receipt?.batchIds ?? [batchId]),
        inArray(transactions.status, ['pending', 'approved']),
      ),
    )
    .orderBy(asc(transactions.id))
    .for('update');
  const cancelled: Transaction[] = [];
  for (const row of live) {
    if (row.status === 'pending') cancelled.push(await rejectPending(row.id, reason));
    else cancelled.push(...(await voidTransactions({ id: row.id }, reason)));
  }
  if (receipt) await reverseStockDocument(receipt.refId);
  return cancelled;
}

/**
 * Remove entries that never counted. Approved money stays in the books and must be voided, so a
 * row that turned out to be approved fails the whole call rather than vanishing.
 */
export async function deleteUnapprovedTransactions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const deleted = await tx()
    .delete(transactions)
    .where(and(eq(transactions.farmId, ctx().farmId), inArray(transactions.id, ids), ne(transactions.status, 'approved')))
    .returning({ id: transactions.id });
  if (deleted.length !== ids.length) {
    throw conflict('TRANSACTION_APPROVED', 'An approved entry cannot be deleted, only voided');
  }
}

/**
 * Serialises everything that reads a debt and then changes it, per counterparty and direction,
 * until the transaction ends. Every such path takes this before it reads.
 */
export async function lockDebt(counterpartyId: string, direction: DebtDirection): Promise<void> {
  await tx().execute(sql`select pg_advisory_xact_lock(hashtext(${`debt:${ctx().farmId}:${counterpartyId}:${direction}`}))`);
}

/**
 * Refuse with DEBT_ALREADY_SETTLED if removing these entries would leave more settled than is still
 * owed. A payment left behind would stand against nothing and quietly cancel the next debt.
 * Settlements waiting for approval count, because approving one later must not strand it.
 * voidTransactions does this itself; call it directly to check before acting.
 */
export async function assertDebtRemovable(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const c = ctx();
  const documents = await tx()
    .select({ counterpartyId: transactions.counterpartyId, type: transactions.type, amountBase: transactions.amountBase })
    .from(transactions)
    .where(
      and(
        eq(transactions.farmId, c.farmId),
        inArray(transactions.id, ids),
        eq(transactions.status, 'approved'),
        eq(transactions.paymentMethod, 'debt'),
        inArray(transactions.type, ['expense', 'income']),
      ),
    );

  const debts = new Map<string, { counterpartyId: string; direction: DebtDirection; removing: number }>();
  for (const doc of documents) {
    const direction: DebtDirection = doc.type === 'expense' ? 'payable' : 'receivable';
    const key = `${doc.counterpartyId}:${direction}`;
    const debt = debts.get(key) ?? { counterpartyId: doc.counterpartyId!, direction, removing: 0 };
    debt.removing += doc.amountBase;
    debts.set(key, debt);
  }

  // In a fixed order, so two calls covering the same debts cannot deadlock on the locks.
  for (const key of [...debts.keys()].sort()) {
    const { counterpartyId, direction, removing } = debts.get(key)!;
    await lockDebt(counterpartyId, direction);
    const kind = DEBT_KIND[direction];
    const [totals] = await tx()
      .select({
        owed: sql<number>`coalesce(sum(${transactions.amountBase}) filter (where ${transactions.type} = ${kind.document}
          and ${transactions.status} = 'approved' and ${transactions.paymentMethod} = 'debt'), 0)`.mapWith(Number),
        settled: sql<number>`coalesce(sum(${transactions.amountBase}) filter (where ${transactions.type} = ${kind.settlement}
          and ${transactions.status} in ('approved', 'pending') and ${tradeSettlement}), 0)`.mapWith(Number),
      })
      .from(transactions)
      .where(and(eq(transactions.farmId, c.farmId), eq(transactions.counterpartyId, counterpartyId)));
    const remaining = round(totals.owed - removing, 2);
    const settled = round(totals.settled, 2);
    if (settled > remaining) {
      throw conflict('DEBT_ALREADY_SETTLED', 'A payment already covers this debt. Cancel the payment first', {
        counterpartyId,
        direction,
        settled,
        remaining,
      });
    }
  }
}

/**
 * Cancel approved entries: by id, or every entry of a source record such as a sale. They stay in
 * the journal as rejected and stop counting, because only approved entries count. A compensating
 * entry would leave both sides of a debt open for something that never happened.
 * Callers decide who may do this; the write and the journal event live here.
 * Refused with DEBT_ALREADY_SETTLED when a settlement stands on the debt: see assertDebtRemovable.
 */
export async function voidTransactions(
  match: { id: string } | { sourceType: string; sourceId: string },
  reason: string,
  eventData: Record<string, unknown> = {},
): Promise<Transaction[]> {
  const where = and(
    eq(transactions.farmId, ctx().farmId),
    eq(transactions.status, 'approved'),
    'id' in match
      ? eq(transactions.id, match.id)
      : and(eq(transactions.sourceType, match.sourceType), eq(transactions.sourceId, match.sourceId)),
  );
  const matching = await tx().select({ id: transactions.id }).from(transactions).where(where);
  await assertDebtRemovable(matching.map((row) => row.id));
  const voided = await tx().update(transactions).set(rejectedAs(reason)).where(where).returning();
  for (const row of voided) {
    await releaseSource(row);
    await recordEvent({
      type: 'transaction.voided',
      entityType: 'transaction',
      entityId: row.id,
      data: { reason, amountBase: row.amountBase, ...eventData },
    });
  }
  return voided;
}
