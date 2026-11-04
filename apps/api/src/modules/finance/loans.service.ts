import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { LOAN_METHODS, addDays, loanSchedule, round } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { generalCostCenterId } from '../../core/costCenters';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { deleteUnapprovedTransactions, postTransaction } from '../../core/ledger';
import { clientId, isoDate, sumOf } from '../../core/query';

const { accounts, counterparties, financeCategories, loanInstalments: i, loans: l, transactions: t } = schema;

export const loanInput = z.object({
  id: clientId,
  counterpartyId: z.uuid(),
  name: z.string().trim().min(1).max(160),
  principal: z.number().positive().max(1e14),
  annualRate: z.number().min(0).max(100),
  termMonths: z.number().int().min(1).max(360),
  startDate: isoDate,
  method: z.enum(LOAN_METHODS).optional(),
  preferential: z.boolean().optional(),
  terms: z.string().trim().max(1000).nullish(),
  /** When set, the loan money is posted into this account on the start date. */
  disburseToAccountId: z.uuid().nullish(),
});

export const loanPatch = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  preferential: z.boolean().optional(),
  terms: z.string().trim().max(1000).nullish(),
});

export const payInput = z.object({ date: isoDate, accountId: z.uuid() });

/** Same day of the month, clamped: 31 Jan + 1 month is 28 Feb. */
export function addMonths(isoDateValue: string, months: number): string {
  const [year, month, day] = isoDateValue.split('-').map(Number);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = index % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const date = new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
  return date.toISOString().slice(0, 10);
}

async function getLoan(id: string) {
  const [row] = await tx().select().from(l).where(and(eq(l.id, id), eq(l.farmId, ctx().farmId)));
  if (!row) throw notFound('Loan');
  return row;
}

async function loanTotals() {
  return tx()
    .select({
      loanId: i.loanId,
      paidPrincipal: sql`coalesce(sum(case when ${i.paidDate} is not null then ${i.principal} else 0 end), 0)`.mapWith(Number),
      paidInterest: sql`coalesce(sum(case when ${i.paidDate} is not null then ${i.interest} else 0 end), 0)`.mapWith(Number),
      unpaid: sql`count(*) filter (where ${i.paidDate} is null)`.mapWith(Number),
      nextDueDate: sql<string | null>`min(${i.dueDate}) filter (where ${i.paidDate} is null)`,
      nextPayment: sql<string | null>`(array_agg(${i.payment} order by ${i.dueDate}) filter (where ${i.paidDate} is null))[1]`,
    })
    .from(i)
    .where(eq(i.farmId, ctx().farmId))
    .groupBy(i.loanId);
}

export async function list() {
  const rows = await tx()
    .select({ loan: l, counterpartyName: counterparties.name })
    .from(l)
    .leftJoin(counterparties, eq(counterparties.id, l.counterpartyId))
    .where(eq(l.farmId, ctx().farmId))
    .orderBy(desc(l.startDate));
  const totals = new Map((await loanTotals()).map((row) => [row.loanId, row]));
  const asOf = today();
  return rows.map(({ loan, counterpartyName }) => {
    const total = totals.get(loan.id);
    return {
      ...loan,
      counterpartyName,
      outstanding: round(loan.principal - (total?.paidPrincipal ?? 0), 2),
      paidPrincipal: total?.paidPrincipal ?? 0,
      paidInterest: total?.paidInterest ?? 0,
      nextDueDate: total?.nextDueDate ?? null,
      nextPayment: total?.nextPayment == null ? null : Number(total.nextPayment),
      overdue: !!total?.nextDueDate && total.nextDueDate < asOf,
    };
  });
}

export async function get(id: string) {
  const loan = await getLoan(id);
  const instalments = await tx().select().from(i).where(eq(i.loanId, id)).orderBy(asc(i.period));
  const [summary] = (await list()).filter((row) => row.id === id);
  return { ...summary, ...loan, instalments };
}

export async function create(input: z.infer<typeof loanInput>) {
  const c = ctx();
  const [lender] = await tx()
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(and(eq(counterparties.id, input.counterpartyId), eq(counterparties.farmId, c.farmId)));
  if (!lender) throw notFound('Counterparty');

  const { id, disburseToAccountId, ...values } = input;
  const [loan] = await tx()
    .insert(l)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();

  const schedule = loanSchedule(loan.principal, loan.annualRate, loan.termMonths, loan.method as 'annuity' | 'equal_principal');
  await tx()
    .insert(i)
    .values(
      schedule.map((row) => ({
        tenantId: c.tenantId,
        farmId: c.farmId,
        createdBy: c.userId,
        loanId: loan.id,
        period: row.period,
        dueDate: addMonths(loan.startDate, row.period),
        principal: row.principal,
        interest: row.interest,
        payment: row.payment,
        balance: row.balance,
      })),
    );

  await recordEvent({
    type: 'loan.created',
    entityType: 'loan',
    entityId: loan.id,
    occurredAt: loan.startDate,
    data: { principal: loan.principal, annualRate: loan.annualRate, termMonths: loan.termMonths },
  });

  if (disburseToAccountId) {
    const [account] = await tx()
      .select({ type: accounts.type })
      .from(accounts)
      .where(and(eq(accounts.id, disburseToAccountId), eq(accounts.farmId, c.farmId)));
    if (!account) throw notFound('Account');
    await postTransaction({
      date: loan.startDate,
      type: 'debt_receipt',
      amount: loan.principal,
      paymentMethod: account.type as 'cash' | 'bank' | 'card',
      accountId: disburseToAccountId,
      counterpartyId: loan.counterpartyId,
      description: loan.name,
      sourceType: 'loan',
      sourceId: loan.id,
    });
  }
  return get(loan.id);
}

export async function update(id: string, input: z.infer<typeof loanPatch>) {
  await getLoan(id);
  await tx()
    .update(l)
    .set(input)
    .where(and(eq(l.id, id), eq(l.farmId, ctx().farmId)));
  return get(id);
}

/** A loan can be removed only while nothing has really happened on it. */
export async function remove(id: string) {
  await getLoan(id);
  const [paid] = await tx()
    .select({ id: i.id })
    .from(i)
    .where(and(eq(i.loanId, id), sql`${i.paidDate} is not null`))
    .limit(1);
  if (paid) throw conflict('LOAN_HAS_PAYMENTS', 'A loan with payments cannot be deleted');
  const disbursement = await tx()
    .select({ id: t.id, status: t.status })
    .from(t)
    .where(and(eq(t.farmId, ctx().farmId), eq(t.sourceType, 'loan'), eq(t.sourceId, id)));
  if (disbursement.some((row) => row.status === 'approved')) {
    throw conflict('LOAN_HAS_PAYMENTS', 'The loan money is already in an account');
  }
  await deleteUnapprovedTransactions(disbursement.map((row) => row.id));
  await tx().delete(l).where(eq(l.id, id));
  await recordEvent({ type: 'loan.deleted', entityType: 'loan', entityId: id });
  return { id };
}

/**
 * Pay one instalment: principal as debt_payment (not an expense), interest as an expense.
 * The amounts are contractual and were accepted with the loan, and only someone with
 * finance.approve may run this, so both postings are approved at once. That also means an
 * instalment can never end up half paid with one leg waiting and the other rejected.
 */
export async function payInstalment(loanId: string, instalmentId: string, input: z.infer<typeof payInput>) {
  const c = ctx();
  const loan = await getLoan(loanId);
  if (!loan.counterpartyId) throw badRequest('COUNTERPARTY_REQUIRED', 'This loan has no lender');

  const [instalment] = await tx()
    .select()
    .from(i)
    .where(and(eq(i.id, instalmentId), eq(i.loanId, loanId)))
    .for('update');
  if (!instalment) throw notFound('Instalment');
  if (instalment.paidDate) throw conflict('ALREADY_PAID', 'This instalment is already paid');

  const [earlier] = await tx()
    .select({ id: i.id })
    .from(i)
    .where(and(eq(i.loanId, loanId), isNull(i.paidDate), sql`${i.period} < ${instalment.period}`))
    .limit(1);
  if (earlier) throw conflict('EARLIER_INSTALMENT_UNPAID', 'Pay the earlier instalment first');

  const [account] = await tx()
    .select({ type: accounts.type })
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.farmId, c.farmId)));
  if (!account) throw notFound('Account');
  const paymentMethod = account.type as 'cash' | 'bank' | 'card';

  const source = { sourceType: 'loan_instalment', sourceId: instalment.id, autoApprove: true };
  const principal = await postTransaction({
    ...source,
    date: input.date,
    type: 'debt_payment',
    amount: instalment.principal,
    paymentMethod,
    accountId: input.accountId,
    counterpartyId: loan.counterpartyId,
    description: `${loan.name}: ${instalment.period}`,
  });
  if (instalment.interest > 0) {
    const [category] = await tx()
      .select({ id: financeCategories.id })
      .from(financeCategories)
      .where(and(eq(financeCategories.tenantId, c.tenantId), eq(financeCategories.key, 'loan_interest')));
    await postTransaction({
      ...source,
      date: input.date,
      type: 'expense',
      amount: instalment.interest,
      paymentMethod,
      accountId: input.accountId,
      counterpartyId: loan.counterpartyId,
      categoryId: category?.id,
      costCenterId: await generalCostCenterId(),
      description: `${loan.name}: ${instalment.period}`,
    });
  }

  await tx().update(i).set({ paidDate: input.date, transactionId: principal.id }).where(eq(i.id, instalmentId));

  const [left] = await tx()
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(i)
    .where(and(eq(i.loanId, loanId), isNull(i.paidDate)));
  if (left.count === 0) await tx().update(l).set({ status: 'closed' }).where(eq(l.id, loanId));

  await recordEvent({
    type: 'loan.instalment_paid',
    entityType: 'loan',
    entityId: loanId,
    occurredAt: input.date,
    data: { period: instalment.period, payment: instalment.payment },
  });
  return get(loanId);
}

/** Unpaid instalments due within `days`, overdue ones included. Drives reminders. */
export async function upcoming(days: number) {
  return tx()
    .select({
      id: i.id,
      loanId: i.loanId,
      loanName: l.name,
      period: i.period,
      dueDate: i.dueDate,
      payment: i.payment,
    })
    .from(i)
    .innerJoin(l, eq(l.id, i.loanId))
    .where(and(eq(i.farmId, ctx().farmId), isNull(i.paidDate), lte(i.dueDate, addDays(today(), days))))
    .orderBy(asc(i.dueDate));
}

export async function outstandingTotal(): Promise<number> {
  const [row] = await tx()
    .select({ total: sumOf(i.principal) })
    .from(i)
    .where(and(eq(i.farmId, ctx().farmId), isNull(i.paidDate)));
  return row.total;
}
