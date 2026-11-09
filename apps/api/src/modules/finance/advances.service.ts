/**
 * Cash held by people who spend it for the farm (docs/cash-holders.md). The owner hands the manager
 * money for the week; the manager confirms it arrived and records what is spent from it.
 *
 * A holder's cash is an ordinary cash account, so balances, reports and approval work as for any other.
 * Nothing moves when cash is handed over: the money is posted only when the holder says it arrived, under
 * the holder's name, and approved by the sender when the sender may approve payments. Maker and checker
 * are then two people, as the rule asks. From the owner's own pocket it is a `contribution`, from a farm
 * account a `transfer`; neither is income or expense.
 */
import { and, asc, desc, eq, gte, inArray, lte, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { CASH_HANDOVER_SOURCES, CASH_HANDOVER_STATUSES, CURRENCIES, FINANCE_CAPITAL, addDays, round } from '@yap/shared';
import { weekStartOf } from '@yap/shared/formulas/ai';
import { schema } from '../../db/client';
import { assertPermission, ctx, hasPermission, today, tx } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { postTransaction, rejectTransaction, resolveFxRate, voidTransactions } from '../../core/ledger';
import { memberHolds } from '../../core/members';
import { clientId, isoDate } from '../../core/query';
import { registerAction } from '../notifications/actions.service';
import { moneyText, tr } from '../notifications/i18n';
import { notifyUser } from '../notifications/notify.service';
import * as accounts from './accounts.service';

const { accounts: a, cashHandovers: h, cashHolders: holders, costCenters, employees, financeCategories: cat, transactions: t, users } = schema;

type Handover = typeof h.$inferSelect;

const amount = z.number().positive().max(1e14);
const note = z.string().trim().max(500).nullish();

export const openHolderInput = z.object({
  employeeId: z.uuid(),
  currency: z.enum(CURRENCIES).optional(),
});

export const handoverInput = z.object({
  id: clientId,
  employeeId: z.uuid(),
  amount,
  /** Own money in another currency; from an account it is that account's. */
  currency: z.enum(CURRENCIES).optional(),
  fxRate: z.number().positive().nullish(),
  date: isoDate.optional(),
  source: z.enum(CASH_HANDOVER_SOURCES),
  fromAccountId: z.uuid().nullish(),
  note,
});
export type HandoverInput = z.infer<typeof handoverInput>;

export const reasonInput = z.object({ reason: z.string().trim().min(1).max(500) });

export const returnInput = z.object({
  amount,
  date: isoDate.optional(),
  /** Back to the owner's pocket, or into a farm account. */
  to: z.enum(['owner', 'account']),
  toAccountId: z.uuid().nullish(),
  note,
});
export type ReturnInput = z.infer<typeof returnInput>;

export const handoverListQuery = z.object({
  holderId: z.uuid().optional(),
  status: z.enum(CASH_HANDOVER_STATUSES).optional(),
});

export const periodQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});
type Period = z.infer<typeof periodQuery>;

function assertNotFuture(date: string) {
  if (date > today()) throw badRequest('DATE_IN_FUTURE', 'The date is in the future');
}

/** This week, Monday to today at the farm, unless the caller names a period. */
function period(q: Period): { from: string; to: string } {
  const to = q.to ?? today();
  const from = q.from ?? weekStartOf(to);
  if (from > to) throw badRequest('INVALID_PERIOD', 'The period starts after it ends');
  return { from, to };
}

// ─── Holders ────────────────────────────────────────────────────────────────

interface Person {
  id: string;
  fullName: string;
  userId: string;
}

/**
 * Who may hold cash: someone still working here, with a login that can record what they spend and see
 * their own cash. A driver without finance rights waits for the narrower right in docs/cash-holders.md.
 */
async function eligibleEmployee(employeeId: string): Promise<Person> {
  const [row] = await tx()
    .select({ id: employees.id, fullName: employees.fullName, userId: employees.userId, status: employees.status })
    .from(employees)
    .where(and(eq(employees.id, employeeId), eq(employees.farmId, ctx().farmId)))
    .for('update');
  if (!row) throw notFound('Employee');
  if (row.status === 'terminated') throw conflict('EMPLOYEE_TERMINATED', 'This person no longer works here');
  if (!row.userId) throw conflict('HOLDER_NEEDS_LOGIN', 'Link this person to a login first, so they can confirm the cash');
  const allowed = (await memberHolds(row.userId, 'finance.view')) && (await memberHolds(row.userId, 'finance.create'));
  if (!allowed) {
    throw conflict('HOLDER_NEEDS_FINANCE', 'This person cannot record expenses yet: give their role finance view and create first');
  }
  return { id: row.id, fullName: row.fullName, userId: row.userId };
}

/** The person's open cash account in a currency, opened when it is first needed. */
async function holderAccountFor(person: Person, currency: string) {
  const c = ctx();
  const [existing] = await tx()
    .select({ holderId: holders.id, accountId: a.id })
    .from(holders)
    .innerJoin(a, eq(a.id, holders.accountId))
    .where(and(eq(holders.employeeId, person.id), eq(holders.active, true), eq(a.active, true), eq(a.currency, currency)));
  if (existing) return { ...existing, created: false };

  // The type says it is cash and the currency shows beside it, so the name is only whose it is.
  const account = await accounts.create({ name: person.fullName, type: 'cash', currency: currency as never });
  const [row] = await tx()
    .insert(holders)
    .values({ tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId, accountId: account.id, employeeId: person.id })
    .returning();
  await recordEvent({ type: 'cash_holder.opened', entityType: 'employee', entityId: person.id, data: { accountId: account.id, currency } });
  return { holderId: row.id, accountId: account.id, created: true };
}

export async function openHolderAccount(employeeId: string, currency?: string) {
  return holderAccountFor(await eligibleEmployee(employeeId), currency ?? ctx().currency);
}

async function holderOrThrow(holderId: string) {
  const [row] = await tx()
    .select({
      id: holders.id,
      accountId: holders.accountId,
      employeeId: holders.employeeId,
      active: holders.active,
      fullName: employees.fullName,
      userId: employees.userId,
      currency: a.currency,
    })
    .from(holders)
    .innerJoin(employees, eq(employees.id, holders.employeeId))
    .innerJoin(a, eq(a.id, holders.accountId))
    .where(and(eq(holders.id, holderId), eq(holders.farmId, ctx().farmId)));
  if (!row) throw notFound('Cash holder');
  return row;
}

async function waitingHandovers(accountId: string): Promise<number> {
  const [row] = await tx()
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(h)
    .where(and(eq(h.holderAccountId, accountId), eq(h.status, 'sent')));
  return row?.count ?? 0;
}

/** Closed only when no cash is left, counted or waiting, and nothing handed over waits for an answer. */
export async function closeHolderAccount(holderId: string) {
  const holder = await holderOrThrow(holderId);
  if (!holder.active) throw conflict('HOLDER_CLOSED', 'This cash account is already closed');
  await accounts.get(holder.accountId, { lock: true });
  if ((await waitingHandovers(holder.accountId)) > 0) {
    throw conflict('HANDOVER_OPEN', 'Cash handed over is still waiting for this person to confirm it');
  }
  const cash = await expectedCashOf(holder.accountId);
  if (cash !== 0) throw conflict('HOLDER_HAS_CASH', 'This person still holds cash: take it back first', { expectedCash: cash });
  // Marked closed first, because the account refuses to close while it belongs to a holder.
  await tx().update(holders).set({ active: false }).where(eq(holders.id, holderId));
  await accounts.remove(holder.accountId);
  await recordEvent({ type: 'cash_holder.closed', entityType: 'employee', entityId: holder.employeeId, data: { accountId: holder.accountId } });
  return { id: holderId, active: false };
}

/** Whether this person still has farm cash, or cash on its way to them. Checked before they leave. */
export async function holdsCash(employeeId: string): Promise<boolean> {
  const rows = await tx()
    .select({ accountId: holders.accountId })
    .from(holders)
    .where(and(eq(holders.farmId, ctx().farmId), eq(holders.employeeId, employeeId), eq(holders.active, true)));
  for (const row of rows) {
    if ((await waitingHandovers(row.accountId)) > 0 || (await expectedCashOf(row.accountId)) !== 0) return true;
  }
  return false;
}

/** Whether an account is the cash of someone other than the person asking. */
export async function heldByAnother(accountId: string): Promise<boolean> {
  const [row] = await tx()
    .select({ userId: employees.userId })
    .from(holders)
    .innerJoin(employees, eq(employees.id, holders.employeeId))
    .where(and(eq(holders.accountId, accountId), eq(holders.active, true)));
  return !!row && row.userId !== ctx().userId;
}

/** The holder account of the person asking, in a currency, if they hold one. */
export async function myHolderAccount(currency?: string): Promise<{ holderId: string; accountId: string } | null> {
  const c = ctx();
  if (!c.userId) return null;
  const [row] = await tx()
    .select({ holderId: holders.id, accountId: a.id })
    .from(holders)
    .innerJoin(employees, eq(employees.id, holders.employeeId))
    .innerJoin(a, eq(a.id, holders.accountId))
    .where(
      and(
        eq(holders.farmId, c.farmId),
        eq(holders.active, true),
        eq(employees.userId, c.userId),
        eq(a.active, true),
        eq(a.currency, currency ?? c.currency),
      ),
    );
  return row ?? null;
}

// ─── What a holder has ──────────────────────────────────────────────────────

interface Figures {
  /** Approved, in the account's currency. */
  opening: number;
  received: number;
  spent: number;
  returned: number;
  closing: number;
  balance: number;
  /** Waiting for approval, at any date: the cash already arrived or left. */
  pendingIn: number;
  pendingOut: number;
  pendingCount: number;
  /** The same in the farm's base currency, for totals across currencies. */
  balanceBase: number;
  pendingInBase: number;
  pendingOutBase: number;
}

const EMPTY: Figures = {
  opening: 0,
  received: 0,
  spent: 0,
  returned: 0,
  closing: 0,
  balance: 0,
  pendingIn: 0,
  pendingOut: 0,
  pendingCount: 0,
  balanceBase: 0,
  pendingInBase: 0,
  pendingOutBase: 0,
};

/**
 * What came into and went out of each holder account over a period, counted as the balances count it:
 * real money only, from the opening date, another currency at its base amount.
 */
async function figures(accountIds: string[], from: string, to: string): Promise<Map<string, Figures>> {
  const result = new Map<string, Figures>();
  if (accountIds.length === 0) return result;
  const before = await accounts.listWithBalances(addDays(from, -1));
  const atEnd = await accounts.listWithBalances(to);
  const now = await accounts.listWithBalances();
  const balanceIn = (list: accounts.AccountBalance[], id: string) => list.find((b) => b.id === id)?.balance ?? 0;
  const baseIn = (list: accounts.AccountBalance[], id: string) => list.find((b) => b.id === id)?.balanceBase ?? 0;

  const native = sql`case when ${t.currency} = ${a.currency} then ${t.amount} else ${t.amountBase} end`;
  const approvedInPeriod = sql`${t.status} = 'approved' and ${t.date} >= ${from} and ${t.date} <= ${to}`;
  const pending = sql`${t.status} = 'pending'`;
  const counted = and(
    eq(t.farmId, ctx().farmId),
    inArray(t.status, ['approved', 'pending']),
    notInArray(t.paymentMethod, ['debt', 'non_cash']),
    sql`${t.date} >= coalesce(${a.openingDate}, ${t.date})`,
  );
  const sum = (condition: SQL) => sql`coalesce(sum(case when ${condition} then ${native} end), 0)`.mapWith(Number);
  const sumBase = (condition: SQL) => sql`coalesce(sum(case when ${condition} then ${t.amountBase} end), 0)`.mapWith(Number);
  const moneyIn = inArray(t.type, ['income', 'debt_receipt', 'contribution']);
  const spending = inArray(t.type, ['expense', 'debt_payment']);
  const leaving = inArray(t.type, ['transfer', 'withdrawal']);

  const onAccount = await tx()
    .select({
      accountId: a.id,
      received: sum(sql`${approvedInPeriod} and ${moneyIn}`),
      spent: sum(sql`${approvedInPeriod} and ${spending}`),
      returned: sum(sql`${approvedInPeriod} and ${leaving}`),
      pendingIn: sum(sql`${pending} and ${moneyIn}`),
      pendingOut: sum(sql`${pending} and not ${moneyIn}`),
      pendingInBase: sumBase(sql`${pending} and ${moneyIn}`),
      pendingOutBase: sumBase(sql`${pending} and not ${moneyIn}`),
      pendingCount: sql`count(*) filter (where ${pending})`.mapWith(Number),
    })
    .from(t)
    .innerJoin(a, eq(a.id, t.accountId))
    .where(and(counted, inArray(t.accountId, accountIds)))
    .groupBy(a.id);
  const transfersIn = await tx()
    .select({
      accountId: a.id,
      received: sum(approvedInPeriod),
      pendingIn: sum(pending),
      pendingInBase: sumBase(pending),
      pendingCount: sql`count(*) filter (where ${pending})`.mapWith(Number),
    })
    .from(t)
    .innerJoin(a, eq(a.id, t.toAccountId))
    .where(and(counted, eq(t.type, 'transfer'), inArray(t.toAccountId, accountIds)))
    .groupBy(a.id);

  for (const id of accountIds) {
    result.set(id, {
      ...EMPTY,
      opening: balanceIn(before, id),
      closing: balanceIn(atEnd, id),
      balance: balanceIn(now, id),
      balanceBase: baseIn(now, id),
    });
  }
  for (const row of onAccount) {
    const f = result.get(row.accountId)!;
    f.received += row.received;
    f.spent = row.spent;
    f.returned = row.returned;
    f.pendingIn += row.pendingIn;
    f.pendingOut = row.pendingOut;
    f.pendingInBase += row.pendingInBase;
    f.pendingOutBase = row.pendingOutBase;
    f.pendingCount += row.pendingCount;
  }
  for (const row of transfersIn) {
    const f = result.get(row.accountId)!;
    f.received += row.received;
    f.pendingIn += row.pendingIn;
    f.pendingInBase += row.pendingInBase;
    f.pendingCount += row.pendingCount;
  }
  return result;
}

/** The cash a person should have in hand: the balance, and what waits for approval but already moved. */
const expected = (f: Figures) => round(f.balance + f.pendingIn - f.pendingOut, 2);

async function expectedCashOf(accountId: string): Promise<number> {
  const day = today();
  return expected((await figures([accountId], day, day)).get(accountId)!);
}

/**
 * Taking handed-over cash off the books: refused once part of it is spent, because the holder would then
 * show spending from money they never had. Keep it, and take back what is left instead.
 */
async function assertUnspent(row: Handover): Promise<void> {
  // The lock holds off spending from this cash while it is counted.
  await accounts.get(row.holderAccountId, { lock: true });
  const cash = await expectedCashOf(row.holderAccountId);
  if (cash < round(row.amount, 2)) {
    throw conflict('HOLDER_CASH_SPENT', 'Part of this cash has been spent already. Keep it and take back what is left instead', {
      expectedCash: cash,
      amount: row.amount,
    });
  }
}

/** For finance: refusing the money of cash that was handed over follows the same rule as reversing it. */
export async function assertHandoverMoneyRemovable(transactionId: string): Promise<void> {
  const [row] = await tx()
    .select()
    .from(h)
    .where(and(eq(h.transactionId, transactionId), eq(h.farmId, ctx().farmId)))
    .for('update');
  if (row?.status === 'accepted') await assertUnspent(row);
}

// ─── Handovers ──────────────────────────────────────────────────────────────

async function handoverOrThrow(id: string, lock = false): Promise<Handover> {
  const query = tx().select().from(h).where(and(eq(h.id, id), eq(h.farmId, ctx().farmId)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw notFound('Cash handover');
  return row;
}

async function personOf(row: Handover): Promise<{ userId: string | null; fullName: string }> {
  const [person] = await tx()
    .select({ userId: employees.userId, fullName: employees.fullName })
    .from(employees)
    .where(eq(employees.id, row.employeeId));
  return person ?? { userId: null, fullName: '' };
}

async function userName(userId: string | null): Promise<string> {
  if (!userId) return '';
  const [row] = await tx().select({ fullName: users.fullName }).from(users).where(eq(users.id, userId));
  return row?.fullName ?? '';
}

const amountText = (row: Pick<Handover, 'amount' | 'currency'>, locale: string) => moneyText(row.amount, row.currency, locale);

function present(row: Handover) {
  return {
    id: row.id,
    holderAccountId: row.holderAccountId,
    employeeId: row.employeeId,
    amount: row.amount,
    currency: row.currency,
    date: row.date,
    source: row.source,
    fromAccountId: row.fromAccountId,
    note: row.note,
    status: row.status,
    sentBy: row.createdBy,
    decidedAt: row.decidedAt,
    disputeReason: row.disputeReason,
    transactionId: row.transactionId,
    reversedReason: row.reversedReason,
    createdAt: row.createdAt,
  };
}

/**
 * Hand cash to a holder. Nothing moves yet: the holder is asked, and the money is posted when they say
 * it arrived. Own money needs the owner's right; a farm account needs finance.create.
 */
export async function sendHandover(input: HandoverInput) {
  const c = ctx();
  const date = input.date ?? today();
  assertNotFuture(date);
  const person = await eligibleEmployee(input.employeeId);
  if (person.userId === c.userId) {
    throw badRequest('HANDOVER_TO_SELF', 'Cash you hand yourself is not a handover: enter it in Finance as a transfer or a contribution');
  }

  let currency = input.currency ?? c.currency;
  if (input.source === 'own_funds') {
    if (!hasPermission(FINANCE_CAPITAL)) throw forbidden("Only the owner can hand over the owner's own money", 'CAPITAL_NOT_ALLOWED');
    if (input.fromAccountId) throw badRequest('FROM_ACCOUNT_NOT_EXPECTED', 'Own money comes from no farm account');
    // Checked now, so the holder never presses Received on money that cannot be valued.
    if (currency !== c.currency) await resolveFxRate(currency, date, input.fxRate);
  } else {
    assertPermission('finance.create');
    if (!input.fromAccountId) throw badRequest('FROM_ACCOUNT_REQUIRED', 'Choose the account the cash comes from');
    const from = await accounts.get(input.fromAccountId);
    if (!from.active) throw conflict('ACCOUNT_CLOSED', 'This account is closed');
    if (input.currency && input.currency !== from.currency) {
      throw badRequest('ACCOUNT_CURRENCY_MISMATCH', 'Cash from this account is in its own currency');
    }
    currency = from.currency;
  }

  const holder = await holderAccountFor(person, currency);
  if (input.fromAccountId === holder.accountId) throw badRequest('SAME_ACCOUNT', 'This is already their cash');

  const [row] = await tx()
    .insert(h)
    .values({
      ...(input.id ? { id: input.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      holderAccountId: holder.accountId,
      employeeId: person.id,
      amount: input.amount,
      currency,
      fxRate: input.source === 'own_funds' && currency !== c.currency ? (input.fxRate ?? null) : null,
      date,
      source: input.source,
      fromAccountId: input.fromAccountId ?? null,
      note: input.note ?? null,
    })
    .returning();

  await recordEvent({
    type: 'cash_handover.sent',
    entityType: 'cash_handover',
    entityId: row.id,
    occurredAt: date,
    data: { amount: row.amount, currency, source: row.source, employeeId: row.employeeId },
  });
  const sender = await userName(c.userId);
  await notifyUser(person.userId, {
    severity: 'attention',
    eventType: 'cash_handover',
    title: (locale) => tr(locale, 'finance', 'cashHolders.notify.sent.title', { amount: amountText(row, locale) }),
    body: (locale) => [tr(locale, 'finance', 'cashHolders.notify.sent.body', { sender, date: row.date }), row.note].filter(Boolean).join('\n'),
    link: '/finance/cash-holders',
    action: { kind: 'cash_handover', id: row.id },
  });
  return { ...present(row), holderId: holder.holderId };
}

/**
 * The holder says the cash arrived: only now does money move. Posted under the holder's name, approved by
 * the sender when the sender may approve payments, so it does not wait for a third person.
 */
export async function acceptHandover(id: string) {
  const c = ctx();
  // Accepting posts money in this person's name.
  assertPermission('finance.create');
  const row = await handoverOrThrow(id, true);
  if (row.status !== 'sent') throw conflict('HANDOVER_DECIDED', 'This handover has already been answered');
  const person = await personOf(row);
  if (!person.userId || person.userId !== c.userId) throw forbidden('Only the person who received the cash can confirm it', 'NOT_THE_HOLDER');

  const sender = row.createdBy!;
  const stillAllowed = await memberHolds(sender, row.source === 'own_funds' ? FINANCE_CAPITAL : 'finance.create');
  if (!stillAllowed) throw conflict('SENDER_NO_LONGER_ALLOWED', 'The person who sent this may no longer hand over this money');

  const approvedBy = (await memberHolds(sender, 'finance.approve')) ? sender : null;
  const common = {
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    description: row.note,
    approvedBy,
    sourceType: 'cash_handover',
    sourceId: row.id,
  };
  const posted =
    row.source === 'own_funds'
      ? await postTransaction({ ...common, type: 'contribution', fxRate: row.fxRate, paymentMethod: 'cash', accountId: row.holderAccountId })
      : await postTransaction({
          ...common,
          type: 'transfer',
          paymentMethod: (await accounts.get(row.fromAccountId!)).type as 'cash' | 'bank' | 'card',
          accountId: row.fromAccountId,
          toAccountId: row.holderAccountId,
        });

  const [updated] = await tx()
    .update(h)
    .set({ status: 'accepted', decidedBy: c.userId, decidedAt: new Date(), transactionId: posted.id })
    .where(eq(h.id, id))
    .returning();
  await recordEvent({
    type: 'cash_handover.accepted',
    entityType: 'cash_handover',
    entityId: id,
    data: { transactionId: posted.id, status: posted.status },
  });
  await notifyUser(sender, {
    eventType: 'cash_handover',
    title: (locale) => tr(locale, 'finance', 'cashHolders.notify.accepted.title', { holder: person.fullName, amount: amountText(row, locale) }),
    body: posted.status === 'pending' ? (locale) => tr(locale, 'finance', 'cashHolders.notify.accepted.pending') : undefined,
    link: '/finance/cash-holders',
  });
  return { ...present(updated), transactionStatus: posted.status };
}

/** The holder says it did not arrive, or not all of it: nothing moves, and the sender is told why. */
export async function disputeHandover(id: string, reason: string) {
  const c = ctx();
  assertPermission('finance.view');
  const row = await handoverOrThrow(id, true);
  if (row.status !== 'sent') throw conflict('HANDOVER_DECIDED', 'This handover has already been answered');
  const person = await personOf(row);
  if (!person.userId || person.userId !== c.userId) throw forbidden('Only the person who received the cash can answer', 'NOT_THE_HOLDER');
  const [updated] = await tx()
    .update(h)
    .set({ status: 'disputed', decidedBy: c.userId, decidedAt: new Date(), disputeReason: reason })
    .where(eq(h.id, id))
    .returning();
  await recordEvent({ type: 'cash_handover.disputed', entityType: 'cash_handover', entityId: id, severity: 'attention', data: { reason } });
  await notifyUser(row.createdBy!, {
    severity: 'attention',
    eventType: 'cash_handover',
    title: (locale) => tr(locale, 'finance', 'cashHolders.notify.disputed.title', { holder: person.fullName, amount: amountText(row, locale) }),
    body: reason,
    link: '/finance/cash-holders',
  });
  return present(updated);
}

/** The sender takes it back while it still waits for an answer. */
export async function cancelHandover(id: string) {
  const c = ctx();
  const row = await handoverOrThrow(id, true);
  if (row.status !== 'sent') throw conflict('HANDOVER_DECIDED', 'This handover has already been answered');
  if (row.createdBy !== c.userId) throw forbidden('Only the person who sent it can cancel it', 'NOT_THE_SENDER');
  const [updated] = await tx()
    .update(h)
    .set({ status: 'cancelled', decidedBy: c.userId, decidedAt: new Date() })
    .where(eq(h.id, id))
    .returning();
  await recordEvent({ type: 'cash_handover.cancelled', entityType: 'cash_handover', entityId: id });
  return present(updated);
}

/**
 * Accepted cash that was a mistake: its money is refused if it still waits for approval, voided if it was
 * approved, and the ledger marks the handover reversed. Never by the holder, and not once it is spent.
 */
export async function reverseHandover(id: string, reason: string) {
  const c = ctx();
  const first = await handoverOrThrow(id);
  if (!first.transactionId) throw conflict('HANDOVER_NOT_ACCEPTED', 'Only cash that arrived can be reversed');
  // The same order as refusing it in finance: the money, then the handover, then the cash.
  const [money] = await tx().select({ status: t.status }).from(t).where(eq(t.id, first.transactionId)).for('update');
  const row = await handoverOrThrow(id, true);
  if (row.status !== 'accepted' || !money) throw conflict('HANDOVER_NOT_ACCEPTED', 'Only cash that arrived can be reversed');
  if ((await personOf(row)).userId === c.userId) {
    throw forbidden('The person holding the cash cannot reverse it', 'HOLDER_CANNOT_APPROVE');
  }
  await assertUnspent(row);
  if (money.status === 'pending') await rejectTransaction(row.transactionId!, reason);
  else await voidTransactions({ id: row.transactionId! }, reason, { cashHandoverId: id });
  await recordEvent({ type: 'cash_handover.reversed', entityType: 'cash_handover', entityId: id, severity: 'attention', data: { reason } });
  return present(await handoverOrThrow(id));
}

/**
 * Cash a holder gives back: into the owner's pocket as a withdrawal, which takes the owner's right, or into
 * a farm account as a transfer. Never more than they hold; approval follows the usual threshold.
 */
export async function returnCash(holderId: string, input: ReturnInput) {
  const holder = await holderOrThrow(holderId);
  if (!holder.active) throw conflict('HOLDER_CLOSED', 'This cash account is closed');
  const date = input.date ?? today();
  assertNotFuture(date);
  if (input.to === 'owner' && !hasPermission(FINANCE_CAPITAL)) {
    throw forbidden("Only the owner can take money back to the owner's pocket", 'CAPITAL_NOT_ALLOWED');
  }
  if (input.to === 'account' && !input.toAccountId) throw badRequest('ACCOUNT_REQUIRED', 'Choose the account the cash goes into');

  await accounts.get(holder.accountId, { lock: true });
  const cash = await expectedCashOf(holder.accountId);
  if (round(input.amount, 2) > cash) {
    throw conflict('HOLDER_CASH_SHORT', 'This is more than the cash this person holds', { expectedCash: cash });
  }
  const common = {
    date,
    amount: input.amount,
    currency: holder.currency,
    paymentMethod: 'cash' as const,
    accountId: holder.accountId,
    description: input.note ?? null,
  };
  const posted =
    input.to === 'owner'
      ? await postTransaction({ ...common, type: 'withdrawal' })
      : await postTransaction({ ...common, type: 'transfer', toAccountId: input.toAccountId });
  await recordEvent({
    type: 'cash_holder.returned',
    entityType: 'employee',
    entityId: holder.employeeId,
    data: { transactionId: posted.id, amount: input.amount, to: input.to === 'owner' ? 'owner' : input.toAccountId },
  });
  return posted;
}

export async function listHandovers(q: z.infer<typeof handoverListQuery>) {
  const me = ctx().userId;
  const rows = await tx()
    .select({
      row: h,
      holderId: holders.id,
      holderName: employees.fullName,
      holderUserId: employees.userId,
      sentByName: users.fullName,
    })
    .from(h)
    .innerJoin(employees, eq(employees.id, h.employeeId))
    .leftJoin(holders, eq(holders.accountId, h.holderAccountId))
    .leftJoin(users, eq(users.id, h.createdBy))
    .where(and(eq(h.farmId, ctx().farmId), q.holderId ? eq(holders.id, q.holderId) : undefined, q.status ? eq(h.status, q.status) : undefined))
    .orderBy(desc(h.date), desc(h.createdAt))
    .limit(200);
  const pii = hasPermission('pii.view');
  return rows.map(({ row, holderId, holderName, holderUserId, sentByName }) => {
    const toMe = holderUserId === me;
    const byMe = row.createdBy === me;
    return {
      ...present(row),
      holderId,
      holderName: pii || toMe ? holderName : null,
      sentByName: pii || byMe ? sentByName : null,
      toMe,
      byMe,
    };
  });
}

// ─── What a holder did with it ──────────────────────────────────────────────

/**
 * One holder over a period (this week unless named): what came in, what went out by category and by cost
 * center (a machine is a cost center), what waits for approval, and the cash they should have now.
 */
export async function holderSummary(holderId: string, q: Period = {}) {
  const holder = await holderOrThrow(holderId);
  const { from, to } = period(q);
  const account = holder.accountId;
  const f = (await figures([account], from, to)).get(account)!;

  const native = sql`case when ${t.currency} = ${holder.currency} then ${t.amount} else ${t.amountBase} end`;
  const spentHere = and(
    eq(t.farmId, ctx().farmId),
    eq(t.accountId, account),
    eq(t.status, 'approved'),
    notInArray(t.paymentMethod, ['debt', 'non_cash']),
    gte(t.date, from),
    lte(t.date, to),
  );
  const byCategory = await tx()
    .select({ categoryId: t.categoryId, key: cat.key, name: cat.name, amount: sql`coalesce(sum(${native}), 0)`.mapWith(Number) })
    .from(t)
    .leftJoin(cat, eq(cat.id, t.categoryId))
    .where(and(spentHere, inArray(t.type, ['expense', 'debt_payment'])))
    .groupBy(t.categoryId, cat.key, cat.name)
    .orderBy(desc(sql`sum(${native})`));
  const byCostCenter = await tx()
    .select({
      costCenterId: t.costCenterId,
      type: costCenters.type,
      name: costCenters.name,
      amount: sql`coalesce(sum(${native}), 0)`.mapWith(Number),
    })
    .from(t)
    .leftJoin(costCenters, eq(costCenters.id, t.costCenterId))
    .where(and(spentHere, eq(t.type, 'expense')))
    .groupBy(t.costCenterId, costCenters.type, costCenters.name)
    .orderBy(desc(sql`sum(${native})`));

  const entries = await tx()
    .select({
      id: t.id,
      date: t.date,
      type: t.type,
      amount: native.mapWith(Number),
      status: t.status,
      description: t.description,
      categoryName: cat.name,
      costCenterName: costCenters.name,
      incoming: sql<boolean>`(${t.toAccountId} = ${account} or ${t.type} in ('income', 'debt_receipt', 'contribution'))`,
    })
    .from(t)
    .leftJoin(cat, eq(cat.id, t.categoryId))
    .leftJoin(costCenters, eq(costCenters.id, t.costCenterId))
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        or(eq(t.accountId, account), eq(t.toAccountId, account)),
        ne(t.status, 'rejected'),
        notInArray(t.paymentMethod, ['debt', 'non_cash']),
        gte(t.date, from),
        lte(t.date, to),
      ),
    )
    .orderBy(asc(t.date), asc(t.createdAt))
    .limit(500);

  const isMe = holder.userId === ctx().userId;
  return {
    holder: {
      id: holder.id,
      employeeId: holder.employeeId,
      name: hasPermission('pii.view') || isMe ? holder.fullName : null,
      accountId: account,
      currency: holder.currency,
      active: holder.active,
      isMe,
    },
    from,
    to,
    opening: round(f.opening, 2),
    received: round(f.received, 2),
    spent: round(f.spent, 2),
    returned: round(f.returned, 2),
    closing: round(f.closing, 2),
    balance: round(f.balance, 2),
    pending: { count: f.pendingCount, in: round(f.pendingIn, 2), out: round(f.pendingOut, 2) },
    expectedCash: expected(f),
    handoversWaiting: await waitingHandovers(account),
    byCategory,
    byCostCenter,
    entries,
  };
}

/** Every open holder with their cash and this week, for the Cash holders page. */
export async function listHolders() {
  const rows = await tx()
    .select({
      id: holders.id,
      accountId: holders.accountId,
      employeeId: holders.employeeId,
      fullName: employees.fullName,
      userId: employees.userId,
      currency: a.currency,
    })
    .from(holders)
    .innerJoin(employees, eq(employees.id, holders.employeeId))
    .innerJoin(a, eq(a.id, holders.accountId))
    .where(and(eq(holders.farmId, ctx().farmId), eq(holders.active, true)))
    .orderBy(asc(employees.fullName));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.accountId);
  const { from, to } = period({});
  const all = await figures(ids, from, to);
  const waiting = await tx()
    .select({ accountId: h.holderAccountId, count: sql`count(*)`.mapWith(Number) })
    .from(h)
    .where(and(eq(h.farmId, ctx().farmId), eq(h.status, 'sent'), inArray(h.holderAccountId, ids)))
    .groupBy(h.holderAccountId);
  const waitingFor = new Map(waiting.map((w) => [w.accountId, w.count]));
  const pii = hasPermission('pii.view');
  const me = ctx().userId;
  return rows.map((row) => {
    const f = all.get(row.accountId) ?? EMPTY;
    const isMe = row.userId === me;
    return {
      id: row.id,
      employeeId: row.employeeId,
      name: pii || isMe ? row.fullName : null,
      accountId: row.accountId,
      currency: row.currency,
      isMe,
      balance: round(f.balance, 2),
      expectedCash: expected(f),
      week: { from, to, received: round(f.received, 2), spent: round(f.spent, 2) },
      pendingApproval: f.pendingCount,
      handoversWaiting: waitingFor.get(row.accountId) ?? 0,
    };
  });
}

// ─── Accounts, saying whose cash ────────────────────────────────────────────

async function holderAccounts() {
  const rows = await tx()
    .select({ holderId: holders.id, accountId: holders.accountId, employeeId: holders.employeeId, userId: employees.userId })
    .from(holders)
    .innerJoin(employees, eq(employees.id, holders.employeeId))
    .where(and(eq(holders.farmId, ctx().farmId), eq(holders.active, true)));
  return new Map(rows.map((r) => [r.accountId, r]));
}

/** Accounts with balances, saying which are a person's cash. Another person's name takes pii.view. */
export async function accountsWithHolders(until?: string) {
  const list = await accounts.listWithBalances(until);
  const held = await holderAccounts();
  const pii = hasPermission('pii.view');
  return list.map((row) => {
    const holder = held.get(row.id);
    if (!holder) return { ...row, holder: null };
    const isMe = holder.userId === ctx().userId;
    return { ...row, name: pii || isMe ? row.name : null, holder: { id: holder.holderId, employeeId: holder.employeeId, isMe } };
  });
}

/**
 * Accounts for dropdowns. Another person's cash is not someone else's to pay from without finance.view, so
 * it is left out; without pii.view it is not named, nor found by the name.
 */
export async function lookupAccounts(search?: string) {
  const list = await accounts.lookup(search);
  const held = await holderAccounts();
  const seesFinance = hasPermission('finance.view');
  const pii = hasPermission('pii.view');
  const result = [];
  for (const row of list) {
    const holder = held.get(row.id);
    if (!holder) {
      result.push({ ...row, holder: null });
      continue;
    }
    const isMe = holder.userId === ctx().userId;
    if (!isMe && !seesFinance) continue;
    if (!isMe && !pii && search) continue;
    result.push({ ...row, name: pii || isMe ? row.name : null, holder: { id: holder.holderId, isMe } });
  }
  return result;
}

/**
 * For the dashboard: the owner's own money put in so far, and the cash in people's hands now. In hands, not
 * on the books: a purchase waiting for approval has already left the pocket.
 */
export async function capitalTiles() {
  const [row] = await tx()
    .select({
      contributed: sql`coalesce(sum(case when ${t.type} = 'contribution' then ${t.amountBase} else 0 end), 0)`.mapWith(Number),
      withdrawn: sql`coalesce(sum(case when ${t.type} = 'withdrawal' then ${t.amountBase} else 0 end), 0)`.mapWith(Number),
    })
    .from(t)
    .where(and(eq(t.farmId, ctx().farmId), eq(t.status, 'approved'), inArray(t.type, ['contribution', 'withdrawal'])));
  const held = await holderAccounts();
  const day = today();
  const all = await figures([...held.keys()], day, day);
  const withPeople = [...all.values()].reduce((total, f) => total + f.balanceBase + f.pendingInBase - f.pendingOutBase, 0);
  return {
    invested: round((row?.contributed ?? 0) - (row?.withdrawn ?? 0), 2),
    contributed: round(row?.contributed ?? 0, 2),
    withdrawn: round(row?.withdrawn ?? 0, 2),
    cashWithPeople: round(withPeople, 2),
    holders: held.size,
  };
}

// ─── Buttons on the message ─────────────────────────────────────────────────

registerAction('cash_handover', {
  async buttons(id) {
    const [row] = await tx().select().from(h).where(and(eq(h.id, id), eq(h.farmId, ctx().farmId)));
    if (!row || row.status !== 'sent') return [];
    if ((await personOf(row)).userId !== ctx().userId) return [];
    return [
      ...(hasPermission('finance.create') ? [{ key: 'accept', label: 'finance:cashHolders.actions.accept', tone: 'primary' as const }] : []),
      ...(hasPermission('finance.view')
        ? [{ key: 'dispute', label: 'finance:cashHolders.actions.dispute', tone: 'danger' as const, needsReason: true }]
        : []),
    ];
  },
  async run(id, button, { reason }) {
    if (button === 'accept') {
      const accepted = await acceptHandover(id);
      return {
        message: accepted.transactionStatus === 'pending' ? 'finance:cashHolders.actions.acceptedPending' : 'finance:cashHolders.actions.accepted',
      };
    }
    await disputeHandover(id, reason ?? '');
    return { message: 'finance:cashHolders.actions.disputed' };
  },
});
