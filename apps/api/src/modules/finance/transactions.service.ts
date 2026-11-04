import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { COST_TREATMENTS, CURRENCIES, PAYMENT_METHODS, TRANSACTION_STATUSES, TRANSACTION_TYPES } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, hasPermission, tx } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { deleteUnapprovedTransactions, postTransaction, type PostTransactionInput, voidTransactions } from '../../core/ledger';
import { hidePii } from '../../core/privacy';
import { clientId, isoDate, listQuery, searchAny, sortBy, sumOf } from '../../core/query';

const { accounts, costCenters, counterparties, financeCategories: cat, transactions: t, users } = schema;

const toAccount = alias(accounts, 'to_account');
const creator = alias(users, 'creator');
const approver = alias(users, 'approver');

const amount = z.number().positive().max(1e14);

export const transactionInput = z.object({
  id: clientId,
  date: isoDate,
  /** Debt settlements and loan payments have their own endpoints. */
  type: z.enum(['expense', 'income', 'transfer']),
  amount,
  categoryId: z.uuid().nullish(),
  currency: z.enum(CURRENCIES).optional(),
  fxRate: z.number().positive().nullish(),
  paymentMethod: z.enum(PAYMENT_METHODS).exclude(['non_cash']),
  accountId: z.uuid().nullish(),
  toAccountId: z.uuid().nullish(),
  counterpartyId: z.uuid().nullish(),
  costCenterId: z.uuid().nullish(),
  costTreatment: z.enum(COST_TREATMENTS).optional(),
  description: z.string().trim().max(500).nullish(),
  dueDate: isoDate.nullish(),
  fileId: z.uuid().nullish(),
});
export type TransactionInput = z.infer<typeof transactionInput>;

export const transactionListQuery = listQuery.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  categoryId: z.uuid().optional(),
  group: z.string().max(40).optional(),
  accountId: z.uuid().optional(),
  counterpartyId: z.uuid().optional(),
  costCenterId: z.uuid().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
});
export type TransactionListQuery = z.infer<typeof transactionListQuery>;

function filters(q: Omit<TransactionListQuery, 'page' | 'pageSize' | 'sort'>) {
  return and(
    eq(t.farmId, ctx().farmId),
    q.from ? gte(t.date, q.from) : undefined,
    q.to ? lte(t.date, q.to) : undefined,
    q.type ? eq(t.type, q.type) : undefined,
    q.status ? eq(t.status, q.status) : undefined,
    q.categoryId ? eq(t.categoryId, q.categoryId) : undefined,
    q.group ? eq(cat.group, q.group) : undefined,
    q.accountId ? sql`(${t.accountId} = ${q.accountId} or ${t.toAccountId} = ${q.accountId})` : undefined,
    q.counterpartyId ? eq(t.counterpartyId, q.counterpartyId) : undefined,
    q.costCenterId ? eq(t.costCenterId, q.costCenterId) : undefined,
    q.paymentMethod ? eq(t.paymentMethod, q.paymentMethod) : undefined,
    searchAny(q.search, [t.description, counterparties.name]),
  );
}

const journalColumns = {
  id: t.id,
  date: t.date,
  type: t.type,
  status: t.status,
  amount: t.amount,
  currency: t.currency,
  fxRate: t.fxRate,
  amountBase: t.amountBase,
  paymentMethod: t.paymentMethod,
  costTreatment: t.costTreatment,
  description: t.description,
  dueDate: t.dueDate,
  fileId: t.fileId,
  sourceType: t.sourceType,
  sourceId: t.sourceId,
  rejectedReason: t.rejectedReason,
  categoryId: t.categoryId,
  categoryName: cat.name,
  categoryGroup: cat.group,
  accountId: t.accountId,
  accountName: accounts.name,
  toAccountId: t.toAccountId,
  toAccountName: toAccount.name,
  counterpartyId: t.counterpartyId,
  counterpartyName: counterparties.name,
  counterpartyTin: counterparties.tin,
  costCenterId: t.costCenterId,
  costCenterName: costCenters.name,
  costCenterType: costCenters.type,
  createdBy: t.createdBy,
  createdByName: creator.fullName,
  approvedBy: t.approvedBy,
  approvedByName: approver.fullName,
  approvedAt: t.approvedAt,
  createdAt: t.createdAt,
};

function journalQuery() {
  return tx()
    .select(journalColumns)
    .from(t)
    .leftJoin(cat, eq(cat.id, t.categoryId))
    .leftJoin(accounts, eq(accounts.id, t.accountId))
    .leftJoin(toAccount, eq(toAccount.id, t.toAccountId))
    .leftJoin(counterparties, eq(counterparties.id, t.counterpartyId))
    .leftJoin(costCenters, eq(costCenters.id, t.costCenterId))
    .leftJoin(creator, eq(creator.id, t.createdBy))
    .leftJoin(approver, eq(approver.id, t.approvedBy));
}

export async function list(q: TransactionListQuery) {
  const where = filters(q);
  const rows = hidePii(await journalPage(q, where), ['createdByName', 'approvedByName']);
  const [{ total }] = await tx()
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(t)
    .leftJoin(cat, eq(cat.id, t.categoryId))
    .leftJoin(counterparties, eq(counterparties.id, t.counterpartyId))
    .where(where);
  return { data: rows, meta: { page: q.page, pageSize: q.pageSize, total } };
}

function journalPage(q: TransactionListQuery, where: ReturnType<typeof filters>) {
  return journalQuery()
    .where(where)
    .orderBy(
      ...sortBy(
        q.sort,
        { date: t.date, amountBase: t.amountBase, status: t.status, createdAt: t.createdAt },
        [desc(t.date), desc(t.createdAt)],
        t.id,
      ),
    )
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
}

/** Totals over the same filters as the journal. Only approved entries count. */
export async function totals(q: Omit<TransactionListQuery, 'page' | 'pageSize' | 'sort'>) {
  const where = and(filters({ ...q, status: undefined }), eq(t.status, 'approved'));
  const rows = await tx()
    .select({ type: t.type, total: sumOf(t.amountBase) })
    .from(t)
    .leftJoin(cat, eq(cat.id, t.categoryId))
    .leftJoin(counterparties, eq(counterparties.id, t.counterpartyId))
    .where(where)
    .groupBy(t.type);
  const by = Object.fromEntries(rows.map((row) => [row.type, row.total]));
  return { income: by.income ?? 0, expense: by.expense ?? 0, net: (by.income ?? 0) - (by.expense ?? 0) };
}

export async function pendingCount() {
  const [row] = await tx()
    .select({ count: sql<number>`count(*)`.mapWith(Number), total: sumOf(t.amountBase) })
    .from(t)
    .where(and(eq(t.farmId, ctx().farmId), eq(t.status, 'pending')));
  return row;
}

export async function get(id: string) {
  const rows = await journalQuery().where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!rows[0]) throw notFound('Transaction');
  return hidePii(rows, ['createdByName', 'approvedByName'])[0];
}

async function assertBelongsToFarm(input: Partial<TransactionInput>) {
  const farm = ctx().farmId;
  const checks: [string | null | undefined, typeof accounts | typeof costCenters | typeof counterparties, string][] = [
    [input.accountId, accounts, 'Account'],
    [input.toAccountId, accounts, 'Account'],
    [input.costCenterId, costCenters, 'Cost center'],
    [input.counterpartyId, counterparties, 'Counterparty'],
  ];
  for (const [id, table, what] of checks) {
    if (!id) continue;
    const [row] = await tx()
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.farmId, farm)));
    if (!row) throw notFound(what);
  }
}

async function validate(input: TransactionInput) {
  await assertBelongsToFarm(input);
  const c = ctx();

  if (input.categoryId) {
    const [category] = await tx().select({ kind: cat.kind }).from(cat).where(eq(cat.id, input.categoryId));
    if (!category) throw notFound('Category');
    if (input.type !== 'transfer' && category.kind !== input.type) {
      throw badRequest('CATEGORY_KIND_MISMATCH', 'This category does not fit the transaction type');
    }
  }

  if (input.type === 'transfer' && input.paymentMethod === 'debt') {
    throw badRequest('INVALID_PAYMENT_METHOD', 'A transfer moves real money, it cannot be on credit');
  }

  const currency = input.currency ?? c.currency;
  const accountIds = [input.accountId, input.toAccountId].filter(Boolean) as string[];
  const rows = [];
  for (const id of accountIds) {
    const [row] = await tx().select({ currency: accounts.currency }).from(accounts).where(eq(accounts.id, id));
    rows.push(row);
  }
  // A foreign account only moves its own currency. A base account can settle anything at the base amount.
  for (const row of rows) {
    if (row.currency !== c.currency && row.currency !== currency) {
      throw badRequest('CURRENCY_MISMATCH', 'This account holds a different currency');
    }
  }
  if (input.type === 'transfer' && rows.length === 2 && rows[0].currency !== rows[1].currency) {
    throw badRequest('CURRENCY_MISMATCH', 'A transfer needs two accounts in the same currency');
  }
}

export async function create(input: TransactionInput) {
  await validate(input);
  return postTransaction({ ...input, categoryId: input.type === 'transfer' ? null : input.categoryId });
}

/** An approved entry is history, and an entry from another module is owned by that module. */
function assertEditable(row: typeof t.$inferSelect) {
  if (row.status === 'approved') {
    throw conflict('TRANSACTION_APPROVED', 'An approved transaction cannot be changed; void it instead');
  }
  if (row.sourceType) {
    throw conflict('TRANSACTION_HAS_SOURCE', 'This entry was created by another module; change it there');
  }
}

async function lockRow(id: string) {
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)))
    .for('update');
  if (!row) throw notFound('Transaction');
  return row;
}

function toPostInput(row: typeof t.$inferSelect): PostTransactionInput {
  return {
    id: row.id,
    date: row.date,
    type: row.type as PostTransactionInput['type'],
    amount: row.amount,
    categoryId: row.categoryId,
    currency: row.currency,
    fxRate: row.fxRate,
    paymentMethod: row.paymentMethod as PostTransactionInput['paymentMethod'],
    accountId: row.accountId,
    toAccountId: row.toAccountId,
    counterpartyId: row.counterpartyId,
    costCenterId: row.costCenterId,
    costTreatment: row.costTreatment as PostTransactionInput['costTreatment'],
    description: row.description,
    dueDate: row.dueDate,
    fileId: row.fileId,
  };
}

/**
 * Editing replaces the row through the ledger, so validation, FX and approval rules stay in one
 * place. The editor becomes the maker: whoever typed the final numbers must not approve them.
 */
export async function update(id: string, input: Partial<TransactionInput>) {
  const row = await lockRow(id);
  assertEditable(row);
  // A settlement is limited by the debt it pays, so changing it means entering it again.
  if (row.type === 'debt_payment' || row.type === 'debt_receipt') {
    throw conflict('SETTLEMENT_NOT_EDITABLE', 'Delete this settlement and enter it again');
  }
  const merged = { ...toPostInput(row), ...input, id } as TransactionInput;
  await validate(merged);
  await deleteUnapprovedTransactions([id]);
  return postTransaction(merged);
}

export async function remove(id: string) {
  const row = await lockRow(id);
  assertEditable(row);
  await deleteUnapprovedTransactions([id]);
  await recordEvent({
    type: 'transaction.deleted',
    entityType: 'transaction',
    entityId: id,
    data: { amountBase: row.amountBase, type: row.type },
  });
  return { id };
}

/**
 * Cancel an approved entry made by mistake. It stays in the journal as rejected and stops counting
 * everywhere, because only approved entries count. Bound by the same two-person rule as approval.
 */
export async function voidTransaction(id: string, reason: string) {
  const row = await lockRow(id);
  if (row.status !== 'approved') throw conflict('NOT_APPROVED', 'Only an approved transaction can be voided');
  if (row.sourceType) {
    throw conflict('TRANSACTION_HAS_SOURCE', 'This entry was created by another module; change it there');
  }
  const c = ctx();
  if (!hasPermission('finance.approve')) throw forbidden();
  if (c.settings.finance.makerChecker && row.createdBy === c.userId) {
    throw forbidden('The person who entered a transaction cannot void it', 'SAME_MAKER_CHECKER');
  }
  const [voided] = await voidTransactions({ id }, reason);
  return voided;
}

/** Export rows, oldest first, approved only. */
export async function exportRows(q: { from?: string; to?: string }) {
  return journalQuery()
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        eq(t.status, 'approved'),
        q.from ? gte(t.date, q.from) : undefined,
        q.to ? lte(t.date, q.to) : undefined,
      ),
    )
    .orderBy(asc(t.date), asc(t.createdAt));
}
