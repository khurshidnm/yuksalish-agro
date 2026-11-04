/** Dashboard and report figures for inventory and feed (docs/contracts.md). */
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { sumOf } from '../../core/query';
import { feedBalance, feedConsumption, type FeedBalanceRow } from '../feed/balance.service';

export { feedBalance, feedConsumption };
export type { FeedBalanceRow };

const { items, stockBatches } = schema;

export interface LowStockRow {
  itemId: string;
  name: string;
  unit: string;
  stockQty: number;
  minQty: number | null;
  /** Days of stock left, for feed. */
  days: number | null;
  minDays: number | null;
  /** Which minimum was broken. */
  reason: 'qty' | 'days';
}

/** Anything below its minimum quantity, plus feed covering too few days (spec 9.2). */
export async function lowStock(): Promise<LowStockRow[]> {
  const stock = tx()
    .select({ itemId: stockBatches.itemId, qty: sumOf(stockBatches.qtyRemaining).as('qty') })
    .from(stockBatches)
    .where(eq(stockBatches.farmId, ctx().farmId))
    .groupBy(stockBatches.itemId)
    .as('stock');

  const qty = sql<number>`coalesce(${stock.qty}, 0)`.mapWith(Number);
  const belowQty = await tx()
    .select({ itemId: items.id, name: items.name, unit: items.unit, stockQty: qty, minQty: items.minQty })
    .from(items)
    .leftJoin(stock, eq(stock.itemId, items.id))
    .where(
      and(
        eq(items.farmId, ctx().farmId),
        eq(items.active, true),
        isNotNull(items.minQty),
        sql`coalesce(${stock.qty}, 0) < ${items.minQty}`,
      ),
    )
    .orderBy(asc(items.name));

  const rows = new Map<string, LowStockRow>(
    belowQty.map((row) => [row.itemId, { ...row, days: null, minDays: null, reason: 'qty' }]),
  );
  for (const feed of await feedBalance()) {
    if (!feed.belowMinimum) continue;
    const existing = rows.get(feed.itemId);
    if (existing) {
      existing.days = feed.days;
      existing.minDays = feed.minDays;
    } else {
      rows.set(feed.itemId, {
        itemId: feed.itemId,
        name: feed.name,
        unit: feed.unit,
        stockQty: feed.stockQty,
        minQty: null,
        days: feed.days,
        minDays: feed.minDays,
        reason: 'days',
      });
    }
  }
  return [...rows.values()];
}
