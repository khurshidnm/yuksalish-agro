import { and, desc, eq, sql } from 'drizzle-orm';
import { rankCropOptions, type CropOption } from '@yap/shared/formulas/ai';
import { monthOf } from '@yap/shared';
import { ctx, today, tx } from '../../../core/context';
import { schema } from '../../../db/client';
import { winterPlan } from '../../feed/balance.service';
import { groupDigits } from '../render';
import { cropPricesPerTon } from './prices';
import { coverage, type AnalyzerResult } from './types';

const { cropPlans, crops, fields, seasons, techCards } = schema;

const MIN_PRICED_CROPS = 2;
/** Grown for years on one field, so repeating it is the plan, not a rotation fault. */
const PERENNIAL = new Set(['alfalfa']);

/** Next-season options per field from history, cost, price and feed need (spec 15.1.6). */
export async function cropSuggestion(): Promise<AnalyzerResult> {
  const farmId = ctx().farmId;
  const cropRows = await tx()
    .select({ id: crops.id, key: crops.key, name: sql<string>`${crops.name}->>'uz'`, isFeed: crops.isFeed })
    .from(crops)
    .where(and(eq(crops.tenantId, ctx().tenantId), eq(crops.active, true)));

  // Newest plan first, so each crop takes its latest expected yield and cost.
  const plans = await tx()
    .select({
      fieldId: cropPlans.fieldId,
      cropId: cropPlans.cropId,
      areaHa: cropPlans.areaHa,
      expectedYieldTHa: cropPlans.expectedYieldTHa,
      plannedCost: cropPlans.plannedCost,
    })
    .from(cropPlans)
    .innerJoin(seasons, eq(seasons.id, cropPlans.seasonId))
    .where(eq(cropPlans.farmId, farmId))
    .orderBy(desc(seasons.startDate));

  const cards = await tx().select().from(techCards).where(eq(techCards.tenantId, ctx().tenantId));
  const prices = await cropPricesPerTon();

  // A crop the farm is short of as feed saves a purchase.
  const shortCrops = new Set(
    (await winterPlan({})).rows.filter((row) => (row.shortageKg ?? 0) > 0 && row.cropId).map((row) => row.cropId),
  );

  const yieldOf = (cropId: string) =>
    plans.find((p) => p.cropId === cropId && p.expectedYieldTHa !== null)?.expectedYieldTHa ??
    cards.find((c) => c.cropId === cropId)?.expectedYieldTHa ??
    null;

  const costPerHaOf = (cropId: string) => {
    const plan = plans.find((p) => p.cropId === cropId && p.plannedCost !== null && p.areaHa > 0);
    if (plan) return plan.plannedCost! / plan.areaHa;
    const card = cards.find((c) => c.cropId === cropId);
    if (!card) return null;
    const lines = card.lines.filter((l) => l.costPerHa !== undefined);
    return lines.length > 0 ? lines.reduce((sum, l) => sum + (l.costPerHa ?? 0), 0) : null;
  };

  const baseOptions = cropRows.map((crop): CropOption => ({
    key: crop.key,
    yieldTHa: yieldOf(crop.id),
    pricePerT: prices.get(crop.id) ?? null,
    costPerHa: costPerHaOf(crop.id),
    isFeed: crop.isFeed,
    perennial: PERENNIAL.has(crop.key),
    grownLastSeason: false,
    feedShortage: shortCrops.has(crop.id),
  }));

  const complete = baseOptions.filter((o) => o.yieldTHa !== null && o.pricePerT !== null && o.costPerHa !== null);
  const cover = coverage('crop_suggestion', complete.length, MIN_PRICED_CROPS, 'crops');
  if (!cover.enough) return { coverage: cover, findings: [] };

  const fieldRows = await tx()
    .select({ id: fields.id, number: fields.number, areaHa: fields.areaHa, salinity: fields.salinityLevel })
    .from(fields)
    .where(and(eq(fields.farmId, farmId), eq(fields.landUse, 'arable'), eq(fields.status, 'active')));
  if (fieldRows.length === 0) return { coverage: cover, findings: [] };

  const keyOfCrop = new Map(cropRows.map((c) => [c.id, c.key]));
  const nameOfCrop = new Map(cropRows.map((c) => [c.key, c.name]));

  const rows = fieldRows.map((field) => {
    const lastCrop = plans.find((p) => p.fieldId === field.id)?.cropId;
    const lastKey = lastCrop ? keyOfCrop.get(lastCrop) : undefined;
    const ranked = rankCropOptions(baseOptions.map((o) => ({ ...o, grownLastSeason: o.key === lastKey })));
    const best = ranked[0];
    return {
      field: field.number,
      areaHa: field.areaHa,
      lastCrop: lastKey ? nameOfCrop.get(lastKey) ?? null : null,
      crop: nameOfCrop.get(best.key) ?? best.key,
      marginPerHa: best.marginPerHa,
      reasons: best.reasons,
      options: ranked.slice(0, 3).map((r) => ({ crop: nameOfCrop.get(r.key) ?? r.key, marginPerHa: r.marginPerHa })),
    };
  });

  const example = rows[0];
  return {
    coverage: cover,
    findings: [
      {
        type: 'crop_suggestion',
        dedupKey: `crop_suggestion:${monthOf(today())}`,
        severity: 'info',
        confidence: 0.5,
        containsMoney: true,
        params: {
          fields: rows.length,
          field: example.field,
          crop: example.crop,
          margin: groupDigits(example.marginPerHa),
          currency: ctx().currency,
        },
        sources: {
          tables: ['crop_plans', 'tech_cards', 'prices', 'items', 'stock_batches'],
          cropsCompared: complete.length,
          feedShortCrops: shortCrops.size,
          note: 'planned_figures',
        },
        data: { rows },
        periodFrom: today(),
        link: '/crops/plans',
        alertable: false,
      },
    ],
  };
}
