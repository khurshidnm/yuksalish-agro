import { and, desc, eq } from 'drizzle-orm';
import { allocateCrops, MAX_CROP_SHARE, type CropField, type CropOption } from '@yap/shared/formulas/ai';
import { cropFamilyOf, type RotationCrop } from '@yap/shared/formulas/rotation';
import { latinToCyrillic, type LanguageCode } from '@yap/shared/i18n';
import { hectaresForShortage, monthOf, round } from '@yap/shared';
import { ctx, today, tx } from '../../../core/context';
import { schema } from '../../../db/client';
import type { I18nName } from '../../../db/schema';
import { winterPlan } from '../../feed/balance.service';
import { aiText, asLanguage, groupDigits } from '../render';
import { cropPricesPerTon } from './prices';
import { coverage, type AnalyzerResult } from './types';

const { cropPlans, crops, fields, seasons, techCards, tenants } = schema;

const MIN_PRICED_CROPS = 2;

/** A name as a reader of `language` writes it. Uzbek Cyrillic is derived from the Latin. */
function nameIn(name: I18nName, language: LanguageCode): string {
  return language === 'uz-Cyrl' ? latinToCyrillic(name.uz) : name[language] || name.uz;
}

/** One text in each dictionary language, so the web app can show it to a reader of any of them. */
const inEachLanguage = (render: (language: LanguageCode) => string): I18nName => ({
  uz: render('uz'),
  ru: render('ru'),
  en: render('en'),
});

/** The language the farm's stored texts are written in. */
async function farmLanguage(): Promise<LanguageCode> {
  const [tenant] = await tx().select({ locale: tenants.locale }).from(tenants).where(eq(tenants.id, ctx().tenantId));
  return asLanguage(tenant?.locale);
}

/**
 * Next crop for each free field from history, cost, price and feed need (spec 15.1.6), planned for the whole
 * farm rather than field by field, which gave every field the same best-paying crop. A field under a perennial
 * stand, or already planned for a season still to start, keeps its crop and counts towards that crop's share.
 */
export async function cropSuggestion(): Promise<AnalyzerResult> {
  const farmId = ctx().farmId;
  const cropRows = await tx()
    .select({ id: crops.id, key: crops.key, name: crops.name, isFeed: crops.isFeed, active: crops.active, family: crops.family })
    .from(crops)
    .where(eq(crops.tenantId, ctx().tenantId));

  // Newest plan first, so each crop takes its latest expected yield and cost, and each field its latest crop.
  const plans = await tx()
    .select({
      fieldId: cropPlans.fieldId,
      cropId: cropPlans.cropId,
      areaHa: cropPlans.areaHa,
      expectedYieldTHa: cropPlans.expectedYieldTHa,
      plannedCost: cropPlans.plannedCost,
      seasonStart: seasons.startDate,
    })
    .from(cropPlans)
    .innerJoin(seasons, eq(seasons.id, cropPlans.seasonId))
    .where(eq(cropPlans.farmId, farmId))
    .orderBy(desc(seasons.startDate), desc(cropPlans.createdAt));

  const cards = await tx().select().from(techCards).where(eq(techCards.tenantId, ctx().tenantId));
  const prices = await cropPricesPerTon();
  const winter = await winterPlan({});

  // A crop the farm is short of as feed saves a purchase.
  const shortCrops = new Set(winter.rows.filter((row) => (row.shortageKg ?? 0) > 0 && row.cropId).map((row) => row.cropId));

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

  const options = cropRows
    .filter((crop) => crop.active)
    .map((crop): CropOption => ({
      key: crop.key,
      yieldTHa: yieldOf(crop.id),
      pricePerT: prices.get(crop.id) ?? null,
      costPerHa: costPerHaOf(crop.id),
      isFeed: crop.isFeed,
      family: cropFamilyOf(crop.key, crop.family),
      feedShortage: shortCrops.has(crop.id),
    }));

  const complete = options.filter((o) => o.yieldTHa !== null && o.pricePerT !== null && o.costPerHa !== null);
  const cover = coverage('crop_suggestion', complete.length, MIN_PRICED_CROPS, 'crops');
  if (!cover.enough) return { coverage: cover, findings: [] };

  const fieldRows = await tx()
    .select({ id: fields.id, number: fields.number, areaHa: fields.areaHa })
    .from(fields)
    .where(and(eq(fields.farmId, farmId), eq(fields.landUse, 'arable'), eq(fields.status, 'active')));

  const cropById = new Map(cropRows.map((c) => [c.id, c]));
  const nameOf = (key: string): I18nName => cropRows.find((c) => c.key === key)?.name ?? { uz: key, ru: key, en: key };

  // A perennial stand stays, and a field planned for a season still to come already has its next crop.
  const committedHa: Record<string, number> = {};
  const free: (CropField & { number: string })[] = [];
  for (const field of fieldRows) {
    // What the field carried, newest first: the rotation rules read more than the last season.
    const history: RotationCrop[] = [];
    for (const p of plans) {
      const crop = p.fieldId === field.id ? cropById.get(p.cropId) : undefined;
      if (crop) history.push({ key: crop.key, family: cropFamilyOf(crop.key, crop.family) });
    }
    const latest = plans.find((p) => p.fieldId === field.id);
    const lastKey = latest ? (cropById.get(latest.cropId)?.key ?? null) : null;
    // Grown for years on one field, so a perennial stand is the plan, not a field to fill.
    const perennial = history[0]?.family === 'perennial_grass';
    if (latest && lastKey && (perennial || latest.seasonStart > today())) {
      committedHa[lastKey] = (committedHa[lastKey] ?? 0) + field.areaHa;
    } else {
      free.push({ id: field.id, number: field.number, areaHa: field.areaHa, lastCropKey: lastKey, history });
    }
  }

  // Next winter needs at least this winter's feed. One field gives both grain and straw, so a crop needs the
  // larger of its feeds' hectares, not their sum.
  const feedNeedHa: Record<string, number> = {};
  for (const row of winter.rows) {
    const key = row.cropId ? cropById.get(row.cropId)?.key : undefined;
    const hectares = key && row.yieldTHa ? hectaresForShortage(row.requiredKg, row.yieldTHa) : null;
    if (key && hectares) feedNeedHa[key] = Math.max(feedNeedHa[key] ?? 0, hectares);
  }

  const plan = allocateCrops(free, options, { committedHa, feedNeedHa, maxShare: MAX_CROP_SHARE });
  if (plan.assignments.length === 0) return { coverage: cover, findings: [] };

  const language = await farmLanguage();
  const fieldOf = new Map(free.map((field) => [field.id, field]));
  const rows = plan.assignments.map((assignment) => {
    const field = fieldOf.get(assignment.fieldId)!;
    return {
      field: field.number,
      areaHa: field.areaHa,
      lastCropKey: field.lastCropKey,
      lastCrop: field.lastCropKey ? nameIn(nameOf(field.lastCropKey), language) : null,
      cropKey: assignment.key,
      crop: nameIn(nameOf(assignment.key), language),
      cropName: nameOf(assignment.key),
      marginPerHa: assignment.marginPerHa,
      reasons: assignment.reasons,
      options: assignment.ranked
        .slice(0, 3)
        .map((r) => ({ cropKey: r.key, crop: nameIn(nameOf(r.key), language), marginPerHa: r.marginPerHa })),
    };
  });
  const margin = rows.reduce((sum, row) => sum + row.areaHa * row.marginPerHa, 0);
  const mix = Object.entries(plan.areaHa)
    .filter(([, ha]) => ha > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b));

  const planIn = (lang: LanguageCode) =>
    rows.map((row) => aiText(lang, 'insight.crop_plan.item', { field: row.field, crop: nameIn(row.cropName, lang) })).join(', ');
  const mixIn = (lang: LanguageCode) =>
    mix.map(([key, ha]) => `${nameIn(nameOf(key), lang)} ${Math.round((ha / plan.totalHa) * 100)}%`).join(', ');
  const shortIn = (lang: LanguageCode) => plan.feedShort.map((key) => nameIn(nameOf(key), lang)).join(', ');

  const feedShort = plan.feedShort.length > 0;
  const localized: Record<string, I18nName> = { plan: inEachLanguage(planIn), mix: inEachLanguage(mixIn) };
  if (feedShort) localized.feedShort = inEachLanguage(shortIn);

  return {
    coverage: cover,
    findings: [
      {
        type: 'crop_suggestion',
        textKey: feedShort ? 'crop_plan_feed_short' : Object.keys(feedNeedHa).length > 0 ? 'crop_plan' : 'crop_plan_no_feed',
        dedupKey: `crop_suggestion:${monthOf(today())}`,
        severity: 'info',
        confidence: 0.5,
        containsMoney: true,
        params: {
          plan: planIn(language),
          mix: mixIn(language),
          ...(feedShort ? { feedShort: shortIn(language) } : {}),
          fields: rows.length,
          margin: groupDigits(margin),
          currency: ctx().currency,
        },
        sources: {
          tables: ['crop_plans', 'tech_cards', 'prices', 'items', 'stock_batches', 'ration_lines'],
          cropsCompared: complete.length,
          fieldsSuggested: rows.length,
          fieldsKept: fieldRows.length - free.length,
          maxCropSharePercent: Math.round((plan.capHa / plan.totalHa) * 100),
          feedShortCrops: shortCrops.size,
          method: 'farm_allocation',
          note: 'planned_figures',
        },
        data: {
          rows,
          areaHa: plan.areaHa,
          totalHa: plan.totalHa,
          feedNeedHa: Object.fromEntries(Object.entries(feedNeedHa).map(([key, ha]) => [key, round(ha, 2)])),
          feedShort: plan.feedShort,
          // Each reader sees the crop names in their own language.
          localized,
        },
        periodFrom: today(),
        link: '/crops/plans',
        alertable: false,
      },
    ],
  };
}
