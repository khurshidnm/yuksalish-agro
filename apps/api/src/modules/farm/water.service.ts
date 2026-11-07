/**
 * Irrigation advice from the FAO-56 soil water balance: how much water each crop used, how much of
 * the root zone's store is gone, when the crop starts to suffer, and how many cubic metres refill it.
 * Every number comes from formulas/agro-weather.ts and formulas/water-balance.ts.
 *
 * Assumption, said on screen: the root zone is full at sowing, as after the usual pre-sowing
 * watering ("sug'orib ekish"). Rain of less than a fifth of the day's ET0 is taken as evaporated.
 */
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { addDays, diffDays, round } from '@yap/shared';
import { et0PenmanMonteith } from '@yap/shared/formulas/agro-weather';
import {
  CROP_WATER_PRESETS,
  cropCoefficient,
  growthStage,
  irrigationDepthMm,
  projectDueDate,
  readilyAvailableWaterMm,
  refillVolumeM3,
  seasonStart,
  soilWaterBalance,
  totalAvailableWaterMm,
  type CropWaterKey,
  type GrowthStage,
  type SoilTexture,
} from '@yap/shared/formulas/water-balance';
import { ctx, today, tx } from '../../core/context';
import { schema } from '../../db/client';
import { currentPlans } from './fields.service';
import { weatherRange, type WeatherSnapshot } from './weather.service';

const { farms, fieldOperations: ops, fields } = schema;

/** Furrow irrigation, the usual method here: about 60 % of the water reaches the root zone. */
export const DEFAULT_IRRIGATION_EFFICIENCY = 0.6;
/** The balance looks back at most this far, so a long-forgotten plan cannot ask for years of weather. */
const MAX_SEASON_DAYS = 300;
/** Watering counts as due soon within this many days. */
export const DUE_SOON_DAYS = 2;

export type AdviceGap = 'crop_unknown' | 'no_sowing_date' | 'not_sown_yet' | 'season_over' | 'flooded' | 'no_soil_texture' | 'no_weather';

export interface WaterAdvice {
  fieldId: string;
  number: string;
  areaHa: number;
  cropKey: string;
  cropName: unknown;
  sowingDate: string | null;
  stage: GrowthStage | null;
  kc: number | null;
  et0TodayMm: number | null;
  /** Crop water use over the last 7 days, mm. Null when a day is unknown. */
  etcLast7Mm: number | null;
  /** Forecast crop water use over the next 7 days, mm. */
  etcNext7Mm: number | null;
  soilTexture: string | null;
  tawMm: number | null;
  rawMm: number | null;
  depletionMm: number | null;
  /** Share of the readily available water already used, percent. 100 means the crop starts to suffer. */
  rawUsedPct: number | null;
  /** The day watering is due: today when it already is, null when not within the forecast. */
  dueDate: string | null;
  /** Water to bring the root zone back to full, at the irrigation efficiency, m³. */
  refillM3: number | null;
  efficiency: number;
  lastIrrigation: { date: string; m3: number | null } | null;
  /** What is missing for the full advice, when something is. */
  gap: AdviceGap | null;
}

function isPreset(key: string): key is CropWaterKey {
  return Object.hasOwn(CROP_WATER_PRESETS, key);
}

function sum(values: (number | null)[]): number | null {
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return round((values as number[]).reduce((a, b) => a + b, 0), 1);
}

function et0Of(day: WeatherSnapshot, latitudeDeg: number, elevationM: number): number | null {
  return et0PenmanMonteith({
    date: day.date,
    latitudeDeg,
    elevationM,
    tMinC: day.tempMin,
    tMaxC: day.tempMax,
    dewPointC: day.dewPointC,
    rhMeanPct: day.rhMeanPct,
    windSpeed2mMs: day.windMeanMs,
    solarRadiationMj: day.solarMj,
  });
}

/** Every date from `from` to `to`, with the stored weather or null. */
function calendar(from: string, to: string, stored: WeatherSnapshot[]): { date: string; weather: WeatherSnapshot | null }[] {
  const byDate = new Map(stored.map((d) => [d.date, d]));
  const out = [];
  for (let date = from; date <= to; date = addDays(date, 1)) out.push({ date, weather: byDate.get(date) ?? null });
  return out;
}

/** Advice for every field with a sown or growing crop, by field number. */
export async function waterAdvice(fieldIds?: string[]): Promise<WaterAdvice[]> {
  const c = ctx();
  const now = today();
  const [farm] = await tx().select({ lat: farms.lat, elevationM: farms.elevationM }).from(farms).where(eq(farms.id, c.farmId));
  const fieldRows = await tx()
    .select({ id: fields.id, number: fields.number, areaHa: fields.areaHa, soilTexture: fields.soilTexture })
    .from(fields)
    .where(and(eq(fields.farmId, c.farmId), eq(fields.status, 'active'), fieldIds ? inArray(fields.id, fieldIds) : undefined))
    .orderBy(asc(fields.number));
  const plans = await currentPlans(fieldRows.map((f) => f.id));
  const growing = fieldRows.filter((f) => ['sown', 'growing'].includes(plans.get(f.id)?.status ?? ''));
  if (growing.length === 0) return [];

  const sowings = growing.map((f) => plans.get(f.id)!.sowingDateFact).filter((d): d is string => d !== null);
  const earliest = sowings.length ? sowings.reduce((a, b) => (a < b ? a : b)) : now;
  const from = earliest < addDays(now, -MAX_SEASON_DAYS) ? addDays(now, -MAX_SEASON_DAYS) : earliest;
  const weather = await weatherRange(from, addDays(now, 9));
  const irrigations = await tx()
    .select({ fieldId: ops.fieldId, date: ops.date, m3: sql<number | null>`sum(${ops.waterM3})::float8` })
    .from(ops)
    .where(
      and(
        eq(ops.farmId, c.farmId),
        inArray(ops.fieldId, growing.map((f) => f.id)),
        eq(ops.type, 'irrigation'),
        eq(ops.status, 'done'),
        gte(ops.date, from),
      ),
    )
    .groupBy(ops.fieldId, ops.date)
    .orderBy(asc(ops.date));

  return growing.map((field) => {
    const plan = plans.get(field.id)!;
    const lastIrrigation = irrigations.filter((i) => i.fieldId === field.id).at(-1);
    const advice: WaterAdvice = {
      fieldId: field.id,
      number: field.number,
      areaHa: field.areaHa,
      cropKey: plan.cropKey,
      cropName: plan.cropName,
      sowingDate: plan.sowingDateFact,
      stage: null,
      kc: null,
      et0TodayMm: null,
      etcLast7Mm: null,
      etcNext7Mm: null,
      soilTexture: field.soilTexture,
      tawMm: null,
      rawMm: null,
      depletionMm: null,
      rawUsedPct: null,
      dueDate: null,
      refillM3: null,
      efficiency: DEFAULT_IRRIGATION_EFFICIENCY,
      lastIrrigation: lastIrrigation ? { date: lastIrrigation.date, m3: lastIrrigation.m3 } : null,
      gap: null,
    };
    const fail = (gap: AdviceGap) => ({ ...advice, gap });

    if (!isPreset(plan.cropKey)) return fail('crop_unknown');
    const preset = CROP_WATER_PRESETS[plan.cropKey];
    if (!plan.sowingDateFact) return fail('no_sowing_date');
    // A perennial's season runs from this spring's regrowth, an annual's from its sowing.
    const sowing = seasonStart(preset, plan.sowingDateFact, now);
    const dayNow = diffDays(sowing, now);
    if (dayNow < 0) return fail('not_sown_yet');
    advice.stage = growthStage(preset, dayNow);
    advice.kc = cropCoefficient(preset, dayNow);
    if (advice.kc === null) return fail('season_over');
    if (farm?.lat == null || farm.elevationM == null) return fail('no_weather');

    const start = sowing < from ? from : sowing;
    const kcOn = (date: string) => cropCoefficient(preset, diffDays(sowing, date));
    const et0On = (w: WeatherSnapshot | null) => (w ? et0Of(w, farm.lat!, farm.elevationM!) : null);
    const days = calendar(start, now, weather);
    const ahead = calendar(addDays(now, 1), addDays(now, 7), weather);
    const etcOf = (d: { date: string; weather: WeatherSnapshot | null }) => {
      const et0 = et0On(d.weather);
      const kc = kcOn(d.date);
      return et0 === null || kc === null ? null : round(et0 * kc, 2);
    };
    const todayWeather = days.at(-1)?.weather ?? null;
    advice.et0TodayMm = et0On(todayWeather) === null ? null : round(et0On(todayWeather)!, 1);
    advice.etcLast7Mm = sum(days.slice(-7).map(etcOf));
    advice.etcNext7Mm = sum(ahead.map(etcOf));

    if (preset.flooded) return fail('flooded');
    if (!field.soilTexture) return fail('no_soil_texture');
    const taw = totalAvailableWaterMm(field.soilTexture as SoilTexture, preset.rootDepthM);
    const raw = readilyAvailableWaterMm(taw, preset.depletionFraction);
    if (taw === null || raw === null) return fail('no_soil_texture');
    advice.tawMm = round(taw, 0);
    advice.rawMm = round(raw, 0);

    const applied = new Map(
      irrigations.filter((i) => i.fieldId === field.id).map((i) => [i.date, irrigationDepthMm(i.m3, field.areaHa) ?? 0]),
    );
    const balance = soilWaterBalance({
      days: days.map((d) => ({ date: d.date, et0Mm: et0On(d.weather), kc: kcOn(d.date), rainMm: d.weather?.precipitationMm ?? null, irrigationMm: applied.get(d.date) ?? 0 })),
      tawMm: taw,
      rawMm: raw,
      initialDepletionMm: 0,
      irrigationEfficiency: DEFAULT_IRRIGATION_EFFICIENCY,
    });
    const depletion = balance.at(-1)?.depletionMm ?? null;
    if (depletion === null) return fail('no_weather');
    advice.depletionMm = round(depletion, 1);
    advice.rawUsedPct = raw > 0 ? round((depletion * 100) / raw, 0) : null;
    advice.refillM3 = (() => {
      const m3 = refillVolumeM3(depletion, field.areaHa, DEFAULT_IRRIGATION_EFFICIENCY);
      return m3 === null ? null : Math.round(m3);
    })();
    advice.dueDate =
      depletion >= raw
        ? now
        : projectDueDate({ depletionMm: depletion, rawMm: raw, forecast: ahead.map((d) => ({ date: d.date, etcMm: etcOf(d) })) });
    return advice;
  });
}
