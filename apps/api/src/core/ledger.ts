/**
 * Money posting. The ONLY code allowed to create or change `transactions` (CLAUDE.md rule 2).
 * Validation, currency conversion and the approval flow live here so that purchases, sales,
 * payroll and manual entries all behave the same way.
 */
import { and, desc, eq, inArray, lte, ne } from 'drizzle-orm';
import { toBaseAmount, type CostTreatment, type TransactionType } from '@yap/shared';
import { schema } from '../db/client';
import { ctx, hasPermission, tx } from './context';
import { badRequest, conflict, forbidden, notFound } from './errors';
import { recordEvent } from './journal';

const { fxRates, transactions } = schema;

type Transaction = typeof transactions.$inferSelect;

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
}

async function resolveFxRate(currency: string, date: string, given?: number | null): Promise<number> {
  const c = ctx();
  if (currency === c.currency) return 1;
  if (given && given > 0) return given;
  const [rate] = await tx()
    .select({ rate: fxRates.rate })
    .from(fxRates)
    .where(and(eq(fxRates.tenantId, c.tenantId), eq(fxRates.currency, currency), lte(fxRates.date, date)))
    .orderBy(desc(fxRates.date))
    .limit(1);
  if (!rate) throw badRequest('FX_RATE_REQUIRED', `No exchange rate for ${currency} on ${date}`);
  return rate.rate;
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
  const fxRate = await resolveFxRate(currency, i.date, i.fxRate);
  const amountBase = toBaseAmount(i.amount, fxRate);

  const needsApproval =
    !i.autoApprove && c.settings.finance.makerChecker && amountBase >= c.settings.finance.approvalThreshold;

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

export async function rejectTransaction(id: string, reason: string): Promise<Transaction> {
  const row = await getPendingForUpdate(id);
  assertCanDecide(row);
  const c = ctx();
  const [updated] = await tx()
    .update(transactions)
    .set({ status: 'rejected', approvedBy: c.userId, approvedAt: new Date(), rejectedReason: reason })
    .where(eq(transactions.id, id))
    .returning();
  await recordEvent({
    type: 'transaction.rejected',
    entityType: 'transaction',
    entityId: id,
    data: { reason },
  });
  return updated;
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
 * Cancel approved entries: by id, or every entry of a source record such as a sale. They stay in
 * the journal as rejected and stop counting, because only approved entries count. A compensating
 * entry would leave both sides of a debt open for something that never happened.
 * Callers decide who may do this; the write and the journal event live here.
 */
export async function voidTransactions(
  match: { id: string } | { sourceType: string; sourceId: string },
  reason: string,
  eventData: Record<string, unknown> = {},
): Promise<Transaction[]> {
  const c = ctx();
  const voided = await tx()
    .update(transactions)
    .set({ status: 'rejected', approvedBy: c.userId, approvedAt: new Date(), rejectedReason: reason })
    .where(
      and(
        eq(transactions.farmId, c.farmId),
        eq(transactions.status, 'approved'),
        'id' in match
          ? eq(transactions.id, match.id)
          : and(eq(transactions.sourceType, match.sourceType), eq(transactions.sourceId, match.sourceId)),
      ),
    )
    .returning();
  for (const row of voided) {
    await recordEvent({
      type: 'transaction.voided',
      entityType: 'transaction',
      entityId: row.id,
      data: { reason, amountBase: row.amountBase, ...eventData },
    });
  }
  return voided;
}
