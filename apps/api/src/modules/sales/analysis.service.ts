/**
 * Sales analysis (spec 13.2): volume and average price by product, buyer and month, compared
 * with the cost recorded on each line when the sale was confirmed. Only confirmed sales count,
 * and every amount is in the base currency.
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { profitabilityPercent, round } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { hideMoney } from '../../core/privacy';
import { isoDate } from '../../core/query';

const { animals, counterparties, items, saleLines, sales } = schema;

export const analysisQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });
export type AnalysisQuery = z.infer<typeof analysisQuery>;

const amountBase = sql<number>`sum(${saleLines.amount} * coalesce(${sales.fxRate}, 1))`.mapWith(Number);
const costTotal = sql<number>`sum(${saleLines.costAmount})`.mapWith(Number);
const qtyTotal = sql<number>`sum(${saleLines.qty})`.mapWith(Number);

function withMargin<T extends { amount: number; cost: number; qty?: number }>(row: T) {
  return {
    ...row,
    amount: round(row.amount, 2),
    cost: round(row.cost, 2),
    avgPrice: row.qty ? round(row.amount / row.qty, 2) : null,
    margin: round(row.amount - row.cost, 2),
    marginPercent: nullableRound(profitabilityPercent(row.amount, row.cost)),
  };
}

function nullableRound(value: number | null): number | null {
  return value === null ? null : round(value, 1);
}

const MONEY = ['amount', 'cost', 'avgPrice', 'margin', 'marginPercent'] as const;

export async function salesAnalysis(q: AnalysisQuery) {
  const confirmed = and(
    eq(sales.farmId, ctx().farmId),
    eq(sales.status, 'confirmed'),
    q.from ? gte(sales.date, q.from) : undefined,
    q.to ? lte(sales.date, q.to) : undefined,
  );

  const productKey = sql<string>`coalesce(${saleLines.itemId}::text, ${animals.category})`;
  const byProduct = await tx()
    .select({
      key: sql<string>`${productKey} || ':' || ${saleLines.unit}`,
      itemId: saleLines.itemId,
      itemName: items.name,
      animalCategory: animals.category,
      unit: saleLines.unit,
      qty: qtyTotal,
      amount: amountBase,
      cost: costTotal,
    })
    .from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .leftJoin(items, eq(items.id, saleLines.itemId))
    .leftJoin(animals, eq(animals.id, saleLines.animalId))
    .where(confirmed)
    .groupBy(productKey, saleLines.itemId, items.name, animals.category, saleLines.unit)
    .orderBy(desc(amountBase));

  const byBuyer = await tx()
    .select({
      counterpartyId: sales.counterpartyId,
      name: counterparties.name,
      documents: sql<number>`count(distinct ${sales.id})`.mapWith(Number),
      amount: amountBase,
      cost: costTotal,
    })
    .from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .innerJoin(counterparties, eq(counterparties.id, sales.counterpartyId))
    .where(confirmed)
    .groupBy(sales.counterpartyId, counterparties.name)
    .orderBy(desc(amountBase));

  const month = sql<string>`to_char(${sales.date}::date, 'YYYY-MM')`;
  const byMonth = await tx()
    .select({ month, amount: amountBase, cost: costTotal })
    .from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .where(confirmed)
    .groupBy(month)
    .orderBy(month);

  const amount = byMonth.reduce((sum, m) => sum + m.amount, 0);
  const cost = byMonth.reduce((sum, m) => sum + m.cost, 0);

  return {
    totals: hideMoney([withMargin({ amount, cost })], [...MONEY])[0],
    byProduct: hideMoney(byProduct.map(withMargin), [...MONEY]),
    byBuyer: hideMoney(byBuyer.map(withMargin), [...MONEY]),
    byMonth: hideMoney(byMonth.map(withMargin), [...MONEY]),
  };
}
