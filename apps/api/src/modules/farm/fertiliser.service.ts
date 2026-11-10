import { and, asc, desc, eq } from 'drizzle-orm';
import {
  cropRemoval,
  fertiliserNeed,
  fertiliserProducts,
  soilTestIsStale,
  type FertiliserProduct,
} from '@yap/shared/formulas/fertiliser';
import { cropFamilyOf } from '@yap/shared/formulas/rotation';
import { ctx, today, tx } from '../../core/context';
import { schema } from '../../db/client';

const { crops, items, soilAnalyses } = schema;

interface PlanRef {
  planId: string;
  cropId: string;
  expectedYieldTHa: number | null;
}

/**
 * Fertiliser rate for a field's current plan from its latest soil analysis (formulas/fertiliser.ts),
 * with every input it used, and the same need in kilograms of the fertilisers the farm keeps.
 * Null without a plan. A nutrient the data cannot support carries a reason instead of a rate.
 */
export async function fieldFertiliser(fieldId: string, plan: PlanRef | null) {
  if (!plan) return null;
  const farmId = ctx().farmId;
  const [crop] = await tx()
    .select()
    .from(crops)
    .where(and(eq(crops.id, plan.cropId), eq(crops.tenantId, ctx().tenantId)));
  if (!crop) return null;

  const [analysis] = await tx()
    .select({ id: soilAnalyses.id, date: soilAnalyses.date, n: soilAnalyses.n, p: soilAnalyses.p, k: soilAnalyses.k })
    .from(soilAnalyses)
    .where(and(eq(soilAnalyses.fieldId, fieldId), eq(soilAnalyses.farmId, farmId)))
    .orderBy(desc(soilAnalyses.date), desc(soilAnalyses.id))
    .limit(1);

  const family = cropFamilyOf(crop.key, crop.family);
  const { removal, source } = cropRemoval(crop.key, { n: crop.removalNKgT, p2o5: crop.removalP2o5KgT, k2o: crop.removalK2oKgT });
  const nutrients = fertiliserNeed({
    cropKey: crop.key,
    family,
    targetYieldTHa: plan.expectedYieldTHa,
    removal,
    soil: { n: analysis?.n ?? null, p2o5: analysis?.p ?? null, k2o: analysis?.k ?? null },
  });

  const stocked = await tx()
    .select({ id: items.id, name: items.name, nPct: items.nPct, p2o5Pct: items.p2o5Pct, k2oPct: items.k2oPct })
    .from(items)
    .where(and(eq(items.farmId, farmId), eq(items.category, 'fertilizer'), eq(items.active, true)))
    .orderBy(asc(items.name));
  const described: FertiliserProduct[] = stocked.filter((p) => p.nPct !== null || p.p2o5Pct !== null || p.k2oPct !== null);
  const rates = { n: nutrients.n.rateKgHa, p2o5: nutrients.p2o5.rateKgHa, k2o: nutrients.k2o.rateKgHa };
  const anyRate = Object.values(rates).some((rate) => rate !== null && rate > 0);

  return {
    planId: plan.planId,
    cropId: crop.id,
    cropKey: crop.key,
    family,
    targetYieldTHa: plan.expectedYieldTHa,
    /** Whose removal figures were used: the farm's own, the typical ones, or none. */
    removalSource: source,
    analysis: analysis ? { id: analysis.id, date: analysis.date, stale: soilTestIsStale(analysis.date, today()) } : null,
    nutrients,
    /** Null when no nutrient has a rate to spread; otherwise kilograms of each stocked product. */
    products: anyRate ? fertiliserProducts(rates, described) : null,
    /** Stocked fertilisers the farm has not given percentages for, so they could not be counted. */
    productsWithoutContent: stocked.filter((p) => !described.includes(p)).map((p) => ({ id: p.id, name: p.name })),
  };
}
