/**
 * Where we stand with one counterparty (spec 13.1): every document and payment, and what is owed.
 * Only credit moves the balance: a sale paid on the spot owes nothing. Positive means they owe us.
 */
import { and, desc, eq } from 'drizzle-orm';
import { round } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { notFound } from '../../core/errors';
import { hideMoney } from '../../core/privacy';

const { contracts, counterparties, financeCategories, purchaseRequests, sales, transactions, items } = schema;

type Movement = { type: string; paymentMethod: string; amountBase: number };

/** What one approved transaction does to the balance with its counterparty. */
export function balanceEffect(t: Movement): number {
  if (t.type === 'debt_receipt') return -t.amountBase;
  if (t.type === 'debt_payment') return t.amountBase;
  if (t.paymentMethod !== 'debt') return 0;
  if (t.type === 'income') return t.amountBase;
  if (t.type === 'expense') return -t.amountBase;
  return 0;
}

export async function settlement(counterpartyId: string) {
  const farmId = ctx().farmId;
  const [counterparty] = await tx()
    .select({ id: counterparties.id, name: counterparties.name, tin: counterparties.tin, type: counterparties.type, phone: counterparties.phone })
    .from(counterparties)
    .where(and(eq(counterparties.id, counterpartyId), eq(counterparties.farmId, farmId)));
  if (!counterparty) throw notFound('Counterparty');

  const postings = await tx()
    .select({
      id: transactions.id,
      date: transactions.date,
      type: transactions.type,
      status: transactions.status,
      paymentMethod: transactions.paymentMethod,
      amountBase: transactions.amountBase,
      categoryName: financeCategories.name,
      description: transactions.description,
      dueDate: transactions.dueDate,
      sourceType: transactions.sourceType,
      sourceId: transactions.sourceId,
    })
    .from(transactions)
    .leftJoin(financeCategories, eq(financeCategories.id, transactions.categoryId))
    .where(and(eq(transactions.farmId, farmId), eq(transactions.counterpartyId, counterpartyId)))
    .orderBy(desc(transactions.date), desc(transactions.createdAt));

  const saleDocuments = await tx()
    .select({ id: sales.id, number: sales.number, date: sales.date, status: sales.status, totalAmount: sales.totalAmount, currency: sales.currency })
    .from(sales)
    .where(and(eq(sales.farmId, farmId), eq(sales.counterpartyId, counterpartyId)))
    .orderBy(desc(sales.date));

  const purchaseDocuments = await tx()
    .select({
      id: purchaseRequests.id,
      itemName: items.name,
      qty: purchaseRequests.qty,
      unit: items.unit,
      status: purchaseRequests.status,
      paidAmount: purchaseRequests.paidAmount,
      createdAt: purchaseRequests.createdAt,
    })
    .from(purchaseRequests)
    .innerJoin(items, eq(items.id, purchaseRequests.itemId))
    .where(and(eq(purchaseRequests.farmId, farmId), eq(purchaseRequests.counterpartyId, counterpartyId)))
    .orderBy(desc(purchaseRequests.createdAt));

  const contractRows = await tx()
    .select({ id: contracts.id, number: contracts.number, title: contracts.title, endDate: contracts.endDate, amount: contracts.amount, status: contracts.status })
    .from(contracts)
    .where(and(eq(contracts.farmId, farmId), eq(contracts.counterpartyId, counterpartyId)));

  // Pending and rejected transactions have not happened yet, so they do not move the balance.
  const approved = postings.filter((p) => p.status === 'approved');
  const balance = round(approved.reduce((sum, p) => sum + balanceEffect(p), 0), 2);

  const sum = (pick: (p: (typeof approved)[number]) => boolean) => round(approved.filter(pick).reduce((s, p) => s + p.amountBase, 0), 2);
  // Paid and received are all the money that moved, on the spot or later against the debt, so
  // sold − received and bought − paid are what is still owed.
  const paidAtOnce = (p: Movement) => p.paymentMethod !== 'debt' && p.paymentMethod !== 'non_cash';
  const totals = {
    sold: sum((p) => p.type === 'income'),
    bought: sum((p) => p.type === 'expense'),
    received: sum((p) => p.type === 'debt_receipt' || (p.type === 'income' && paidAtOnce(p))),
    paid: sum((p) => p.type === 'debt_payment' || (p.type === 'expense' && paidAtOnce(p))),
    balance,
    receivable: balance > 0 ? balance : 0,
    payable: balance < 0 ? -balance : 0,
  };

  return {
    counterparty,
    totals: hideMoney([totals], ['sold', 'bought', 'received', 'paid', 'balance', 'receivable', 'payable'])[0],
    transactions: hideMoney(postings, ['amountBase']),
    sales: hideMoney(saleDocuments, ['totalAmount']),
    purchases: hideMoney(purchaseDocuments, ['paidAmount']),
    contracts: hideMoney(contractRows, ['amount']),
  };
}
