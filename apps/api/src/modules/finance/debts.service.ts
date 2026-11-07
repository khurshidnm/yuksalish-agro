import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { CURRENCIES, diffDays, round } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { PAYROLL_COUNTERPARTY } from '../../core/defaults';
import { conflict, notFound } from '../../core/errors';
import { amountInBase, lockDebt, postTransaction, tradeSettlement, type DebtDirection, type RecordSource } from '../../core/ledger';
import { clientId, isoDate } from '../../core/query';

const { accounts, counterparties, transactions: t } = schema;

export const settleInput = z.object({
  id: clientId,
  counterpartyId: z.uuid(),
  /** payable: we pay a supplier. receivable: a buyer pays us. */
  direction: z.enum(['payable', 'receivable']),
  amount: z.number().positive().max(1e14),
  /** Defaults to the account's own currency. */
  currency: z.enum(CURRENCIES).optional(),
  fxRate: z.number().positive().nullish(),
  date: isoDate,
  accountId: z.uuid(),
  description: z.string().trim().max(500).nullish(),
  fileId: z.uuid().nullish(),
});
export type SettleInput = z.infer<typeof settleInput>;

export type Direction = DebtDirection;

const AGING_BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90Plus'] as const;
type Aging = Record<(typeof AGING_BUCKETS)[number], number>;

const emptyAging = (): Aging => ({ notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90Plus: 0 });

function agingBucket(dueDate: string | null, asOf: string): keyof Aging {
  if (!dueDate) return 'notDue';
  const late = diffDays(dueDate, asOf);
  if (late <= 0) return 'notDue';
  if (late <= 30) return 'd1_30';
  if (late <= 60) return 'd31_60';
  if (late <= 90) return 'd61_90';
  return 'd90Plus';
}

export interface OpenDocument {
  id: string;
  date: string;
  dueDate: string | null;
  description: string | null;
  amount: number;
  outstanding: number;
  daysOverdue: number;
}

interface DebtDoc {
  id: string;
  date: string;
  dueDate: string | null;
  description: string | null;
  amountBase: number;
}

/** Settlements pay off the oldest documents first. */
export function applyFifo(docs: DebtDoc[], paid: number, asOf: string): OpenDocument[] {
  let left = paid;
  const open: OpenDocument[] = [];
  for (const doc of docs) {
    const covered = Math.min(left, doc.amountBase);
    left = round(left - covered, 2);
    const outstanding = round(doc.amountBase - covered, 2);
    if (outstanding > 0) {
      open.push({
        id: doc.id,
        date: doc.date,
        dueDate: doc.dueDate,
        description: doc.description,
        amount: doc.amountBase,
        outstanding,
        daysOverdue: doc.dueDate ? Math.max(0, diffDays(doc.dueDate, asOf)) : 0,
      });
    }
  }
  return open;
}

async function loadDebtRows() {
  const farm = ctx().farmId;
  const docs = await tx()
    .select({
      id: t.id,
      date: t.date,
      dueDate: t.dueDate,
      description: t.description,
      amountBase: t.amountBase,
      type: t.type,
      counterpartyId: t.counterpartyId,
    })
    .from(t)
    .where(
      and(
        eq(t.farmId, farm),
        eq(t.status, 'approved'),
        eq(t.paymentMethod, 'debt'),
        inArray(t.type, ['expense', 'income']),
      ),
    )
    .orderBy(asc(t.dueDate), asc(t.date), asc(t.createdAt));
  const settlements = await tx()
    .select({ type: t.type, counterpartyId: t.counterpartyId, amountBase: t.amountBase, status: t.status })
    .from(t)
    .where(
      and(
        eq(t.farmId, farm),
        inArray(t.status, ['approved', 'pending']),
        inArray(t.type, ['debt_payment', 'debt_receipt']),
        tradeSettlement,
      ),
    );
  return { docs, settlements };
}

export interface CounterpartyDebt {
  counterpartyId: string;
  counterpartyName: string;
  /** Wages owed. Paid from the payroll run: paying them here too would pay them twice. */
  isPayroll: boolean;
  direction: Direction;
  total: number;
  paid: number;
  outstanding: number;
  /** Settlements still waiting for approval. */
  pendingSettlement: number;
  overdue: number;
  nextDueDate: string | null;
  aging: Aging;
  documents: OpenDocument[];
}

/** Open debts per counterparty, one row per direction, with aging by due date. */
export async function listDebts(direction?: Direction): Promise<CounterpartyDebt[]> {
  const asOf = today();
  const { docs, settlements } = await loadDebtRows();
  const groups = new Map<string, { counterpartyId: string; direction: Direction; docs: DebtDoc[] }>();
  for (const doc of docs) {
    const dir: Direction = doc.type === 'expense' ? 'payable' : 'receivable';
    const key = `${doc.counterpartyId}:${dir}`;
    const group = groups.get(key) ?? { counterpartyId: doc.counterpartyId!, direction: dir, docs: [] };
    group.docs.push(doc);
    groups.set(key, group);
  }

  const ids = [...new Set([...groups.values()].map((g) => g.counterpartyId))];
  const names = ids.length
    ? await tx().select({ id: counterparties.id, name: counterparties.name }).from(counterparties).where(inArray(counterparties.id, ids))
    : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name]));

  const result: CounterpartyDebt[] = [];
  for (const group of groups.values()) {
    if (direction && group.direction !== direction) continue;
    const settlementType = group.direction === 'payable' ? 'debt_payment' : 'debt_receipt';
    const matching = settlements.filter((s) => s.counterpartyId === group.counterpartyId && s.type === settlementType);
    const paid = round(matching.filter((s) => s.status === 'approved').reduce((sum, s) => sum + s.amountBase, 0), 2);
    const pendingSettlement = round(matching.filter((s) => s.status === 'pending').reduce((sum, s) => sum + s.amountBase, 0), 2);
    const documents = applyFifo(group.docs, paid, asOf);
    const outstanding = round(documents.reduce((sum, d) => sum + d.outstanding, 0), 2);
    if (outstanding <= 0) continue;

    const aging = emptyAging();
    for (const doc of documents) {
      const bucket = agingBucket(doc.dueDate, asOf);
      aging[bucket] = round(aging[bucket] + doc.outstanding, 2);
    }
    const due = documents.map((d) => d.dueDate).filter((d): d is string => !!d).sort();
    result.push({
      counterpartyId: group.counterpartyId,
      counterpartyName: nameOf.get(group.counterpartyId) ?? '',
      isPayroll: nameOf.get(group.counterpartyId) === PAYROLL_COUNTERPARTY,
      direction: group.direction,
      total: round(group.docs.reduce((sum, d) => sum + d.amountBase, 0), 2),
      paid,
      outstanding,
      pendingSettlement,
      overdue: round(outstanding - aging.notDue, 2),
      nextDueDate: due[0] ?? null,
      aging,
      documents,
    });
  }
  return result.sort((a, b) => b.outstanding - a.outstanding);
}

/**
 * Record a payment against a debt. It cannot exceed what is still owed. Debts are kept in the base
 * currency, so a foreign payment counts at what it comes to there. The difference to the rate a
 * foreign debt was booked at is not posted: the spec has no rule for it yet, so it shows as debt
 * left open, or as AMOUNT_EXCEEDS_DEBT.
 */
export async function settle(input: SettleInput, source?: RecordSource) {
  const [counterparty] = await tx()
    .select({ id: counterparties.id, name: counterparties.name })
    .from(counterparties)
    .where(and(eq(counterparties.id, input.counterpartyId), eq(counterparties.farmId, ctx().farmId)));
  if (!counterparty) throw notFound('Counterparty');
  if (counterparty.name === PAYROLL_COUNTERPARTY) {
    throw conflict('WAGES_PAID_FROM_PAYROLL', 'Wages are paid from the payroll run, not from the debts page');
  }
  const [account] = await tx()
    .select({ id: accounts.id, type: accounts.type, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.farmId, ctx().farmId)));
  if (!account) throw notFound('Account');

  await lockDebt(input.counterpartyId, input.direction);
  const debts = await listDebts(input.direction);
  const debt = debts.find((d) => d.counterpartyId === input.counterpartyId);
  // Pending settlements already spoken for this debt, so two entries cannot pay it twice.
  const open = round((debt?.outstanding ?? 0) - (debt?.pendingSettlement ?? 0), 2);
  const currency = input.currency ?? account.currency;
  if ((await amountInBase(input.amount, currency, input.date, input.fxRate)) > open) {
    throw conflict('AMOUNT_EXCEEDS_DEBT', `Only ${open} is outstanding`, { outstanding: open });
  }

  return postTransaction({
    id: input.id,
    date: input.date,
    type: input.direction === 'payable' ? 'debt_payment' : 'debt_receipt',
    amount: input.amount,
    currency,
    fxRate: input.fxRate,
    paymentMethod: account.type as 'cash' | 'bank' | 'card',
    accountId: input.accountId,
    counterpartyId: input.counterpartyId,
    description: input.description,
    fileId: input.fileId,
    sourceType: source?.type,
    sourceId: source?.id,
  });
}
