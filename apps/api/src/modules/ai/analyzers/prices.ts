import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { ctx, tx } from '../../../core/context';
import { schema } from '../../../db/client';

const { cropPlans, crops, harvests, items, prices } = schema;

const TONS_PER_UNIT: Record<string, number> = { kg: 1000, t: 1 };

/**
 * Price per ton by crop: from the item its harvests went into, otherwise an item linked to the
 * crop, using the latest sale price or the internal transfer price. A crop with no price is left
 * out, and the forecast says so.
 */
export async function cropPricesPerTon(): Promise<Map<string, number>> {
  const farmId = ctx().farmId;
  const cropRows = await tx().select({ id: crops.id }).from(crops).where(eq(crops.tenantId, ctx().tenantId));

  const harvested = await tx()
    .selectDistinct({ cropId: cropPlans.cropId, itemId: harvests.itemId })
    .from(harvests)
    .innerJoin(cropPlans, eq(cropPlans.id, harvests.cropPlanId))
    .where(eq(harvests.farmId, farmId));

  const result = new Map<string, number>();
  for (const crop of cropRows) {
    const itemIds = harvested.filter((h) => h.cropId === crop.id && h.itemId).map((h) => h.itemId!);
    const candidates = await tx()
      .select({ id: items.id, unit: items.unit, transferPrice: items.transferPrice })
      .from(items)
      .where(
        and(
          eq(items.farmId, farmId),
          itemIds.length > 0 ? inArray(items.id, itemIds) : and(eq(items.cropId, crop.id), ne(items.category, 'seed')),
        ),
      );
    for (const item of candidates) {
      const [latest] = await tx()
        .select({ price: prices.price })
        .from(prices)
        .where(and(eq(prices.itemId, item.id), eq(prices.kind, 'sale')))
        .orderBy(desc(prices.date))
        .limit(1);
      const price = latest?.price ?? item.transferPrice;
      const factor = TONS_PER_UNIT[item.unit];
      if (price && factor) {
        result.set(crop.id, price * factor);
        break;
      }
    }
  }
  return result;
}
