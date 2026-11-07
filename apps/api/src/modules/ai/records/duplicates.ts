/**
 * Has this already been recorded, or is it already waiting on another card? The answer changes while
 * a card waits, so this runs every time a card is shown and again at confirm, never just once.
 * The older of two open cards goes first, so the second is the one that needs the explicit yes.
 */
import { and, eq, gt, gte, inArray, lt, lte, type SQL } from 'drizzle-orm';
import { addDays, diffDays } from '@yap/shared';
import { ctx, tx } from '../../../core/context';
import { schema } from '../../../db/client';
import { DUPLICATE_WINDOW_DAYS, type RecordKind } from './routing';
import type { ProposalFields } from './types';

const { aiProposals: p, stockBatches: b, transactions: t } = schema;

export interface Duplicate {
  transactionId?: string;
  batchId?: string;
  proposalId?: string;
}

/** What makes two records the same thing, besides the amount and the day. */
const identity = (f: ProposalFields) =>
  [f.category?.id, f.target?.costCenterId, f.item?.id, f.qty, f.counterparty?.id, f.direction, f.account?.id, f.toAccount?.id];

const isSameRecord = (kind: string, a: ProposalFields, b: ProposalFields) => {
  const key = (f: ProposalFields) => {
    const [category, target, item, qty, counterparty, direction, account, toAccount] = identity(f);
    if (kind === 'stock_purchase') return [item, qty];
    if (kind === 'debt_payment') return [counterparty, direction];
    if (kind === 'transfer') return [account, toAccount];
    return [category, target];
  };
  return (
    a.amountBase === b.amountBase &&
    Math.abs(diffDays(a.date, b.date)) <= DUPLICATE_WINDOW_DAYS &&
    JSON.stringify(key(a)) === JSON.stringify(key(b))
  );
};

function bookedMatch(kind: RecordKind, f: ProposalFields): SQL | undefined {
  switch (kind) {
    case 'debt_payment':
      return and(eq(t.type, f.direction === 'receivable' ? 'debt_receipt' : 'debt_payment'), eq(t.counterpartyId, f.counterparty!.id));
    case 'transfer':
      return and(eq(t.type, 'transfer'), eq(t.accountId, f.account!.id), eq(t.toAccountId, f.toAccount!.id));
    case 'expense':
    case 'income':
      return and(eq(t.type, kind), eq(t.categoryId, f.category!.id), f.target ? eq(t.costCenterId, f.target.costCenterId) : undefined);
    default:
      return undefined;
  }
}

export async function findDuplicate(kind: RecordKind, f: ProposalFields, self: string): Promise<Duplicate | null> {
  const c = ctx();
  const from = addDays(f.date, -DUPLICATE_WINDOW_DAYS);
  const to = addDays(f.date, DUPLICATE_WINDOW_DAYS);

  if (kind === 'stock_purchase') {
    // A receipt may have no money row at all, so the stock itself is what to look at.
    const [batch] = await tx()
      .select({ id: b.id })
      .from(b)
      .where(and(eq(b.farmId, c.farmId), eq(b.itemId, f.item!.id), eq(b.qtyReceived, f.qty!), gt(b.qtyRemaining, 0), gte(b.receivedDate, from), lte(b.receivedDate, to)))
      .limit(1);
    if (batch) return { batchId: batch.id };
  } else {
    const [booked] = await tx()
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.farmId, c.farmId), inArray(t.status, ['approved', 'pending']), eq(t.amountBase, f.amountBase!), gte(t.date, from), lte(t.date, to), bookedMatch(kind, f)))
      .limit(1);
    if (booked) return { transactionId: booked.id };
  }

  const open = await tx()
    .select({ id: p.id, fields: p.fields })
    .from(p)
    .where(and(eq(p.farmId, c.farmId), eq(p.kind, kind), eq(p.status, 'pending'), gt(p.expiresAt, new Date()), lt(p.id, self)));
  const twin = open.find((row) => isSameRecord(kind, row.fields as unknown as ProposalFields, f));
  return twin ? { proposalId: twin.id } : null;
}
