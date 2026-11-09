import { and, asc, desc, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { ctx, tx } from '../../../core/context';
import { schema } from '../../../db/client';

const { cropPlans, harvests, items, prices } = schema;

const TONS_PER_UNIT: Record<string, number> = { kg: 1000, t: 1 };

interface PricedItem {
  id: string;
  perTon: number;
  /** The farm sells it: the item has a sale price of its own. */
  sold: boolean;
}

/** The farm's product first, then the dearest per ton, then the oldest item: grain before its straw. */
const mainProductFirst = (a: PricedItem, b: PricedItem) =>
  Number(b.sold) - Number(a.sold) || b.perTon - a.perTon || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Price per ton by crop, from the crop's main product: the item its harvests went into, otherwise an item
 * linked to the crop, seed aside. One crop gives several items, wheat its grain and its straw, and the
 * expected yield is the grain's. So of several, the one the farm sells comes first, then the dearest per
 * ton; the order never depends on how rows happen to lie in the table. The price is the latest sale price,
 * otherwise the internal transfer price. A crop with no price is left out, and the forecast says so.
 */
export async function cropPricesPerTon(): Promise<Map<string, number>> {
  const farmId = ctx().farmId;

  const harvested = await tx()
    .selectDistinct({ cropId: cropPlans.cropId, itemId: harvests.itemId })
    .from(harvests)
    .innerJoin(cropPlans, eq(cropPlans.id, harvests.cropPlanId))
    .where(and(eq(harvests.farmId, farmId), isNotNull(harvests.itemId)));
  const harvestedIds = [...new Set(harvested.map((h) => h.itemId!))];

  const rows = await tx()
    .select({ id: items.id, cropId: items.cropId, category: items.category, unit: items.unit, transferPrice: items.transferPrice })
    .from(items)
    .where(
      and(
        eq(items.farmId, farmId),
        or(isNotNull(items.cropId), harvestedIds.length > 0 ? inArray(items.id, harvestedIds) : undefined),
      ),
    )
    .orderBy(asc(items.id));
  if (rows.length === 0) return new Map();

  // The latest sale price of each item. Same-day prices are settled by the one entered last.
  const sales = await tx()
    .selectDistinctOn([prices.itemId], { itemId: prices.itemId, price: prices.price })
    .from(prices)
    .where(
      and(
        eq(prices.farmId, farmId),
        eq(prices.kind, 'sale'),
        inArray(prices.itemId, rows.map((r) => r.id)),
      ),
    )
    .orderBy(prices.itemId, desc(prices.date), desc(prices.createdAt), desc(prices.id));
  const saleOf = new Map(sales.map((s) => [s.itemId, s.price]));

  const priced = new Map<string, PricedItem>();
  for (const row of rows) {
    const sale = saleOf.get(row.id) ?? null;
    const price = sale ?? row.transferPrice;
    const factor = TONS_PER_UNIT[row.unit];
    if (price && price > 0 && factor) priced.set(row.id, { id: row.id, perTon: price * factor, sold: sale !== null });
  }

  const cropIds = new Set([...harvested.map((h) => h.cropId), ...rows.flatMap((r) => (r.cropId ? [r.cropId] : []))]);
  const result = new Map<string, number>();
  for (const cropId of cropIds) {
    const intoHarvest = harvested.filter((h) => h.cropId === cropId).map((h) => h.itemId!);
    // What the harvest went into is the product. Without a harvest, the items made from the crop are.
    const candidates =
      intoHarvest.length > 0
        ? intoHarvest
        : rows.filter((r) => r.cropId === cropId && r.category !== 'seed').map((r) => r.id);
    const [best] = candidates.flatMap((id) => priced.get(id) ?? []).sort(mainProductFirst);
    if (best) result.set(cropId, best.perTon);
  }
  return result;
}
