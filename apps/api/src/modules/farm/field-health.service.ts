/**
 * What the satellite says about one field: the latest map, the season's curve, events it saw
 * (green-up, harvest, bare soil), where it disagrees with the recorded work, and for a pasture how
 * many days it can feed the flock. Every figure comes from formulas/vegetation.ts.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ANIMAL_ON_FARM_STATUSES, addDays, diffDays, round } from '@yap/shared';
import {
  DEFAULT_PASTURE_MODEL,
  GRAZING_DEFAULTS,
  checkRecordedWork,
  detectEvents,
  fitBiomassModel,
  grazingDays,
  pastureBiomassKgHa,
  type SatelliteEvent,
  type WorkCheck,
} from '@yap/shared/formulas/vegetation';
import { ctx, today, tx } from '../../core/context';
import { notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { isoDate } from '../../core/query';
import { schema } from '../../db/client';
import { currentPlans, getField } from './fields.service';
import { lastSceneDate, vegetationOn, vegetationSeries, type VegetationPoint, type VegetationView } from './satellite.service';

const { animals, fieldVegetation: veg, harvests, pastureSamples: samples, species } = schema;

/** A year and a bit: enough for this season's curve and last year's for comparison. */
const SERIES_DAYS = 400;
/** A sample takes the NDVI of a clear scene this close to its date. */
const SAMPLE_MATCH_DAYS = 7;
/** Autumn-sown cereals stay short until spring, so "no green-up" waits until April. */
const WINTER_CEREALS = new Set(['wheat', 'barley']);

type Plan = NonNullable<ReturnType<Awaited<ReturnType<typeof currentPlans>>['get']>>;

function winterSown(plan: Plan, sowing: string): boolean {
  const month = Number(sowing.slice(5, 7));
  return WINTER_CEREALS.has(plan.cropKey) && month >= 8;
}

/** The checks for the current crop, from the season's own observations only. */
async function workChecks(plan: Plan, series: VegetationPoint[]): Promise<WorkCheck[]> {
  const sowing = plan.sowingDateFact;
  const seasonStart = sowing ?? plan.sowingDatePlan;
  if (!seasonStart) return [];
  const own = series.filter((p) => diffDays(addDays(seasonStart, -20), p.date) >= 0);
  const recorded = await tx()
    .select({ date: harvests.date })
    .from(harvests)
    .where(and(eq(harvests.farmId, ctx().farmId), eq(harvests.fieldId, plan.fieldId), gte(harvests.date, seasonStart)));
  const now = today();
  return checkRecordedWork(own, { sowingDate: sowing, harvestDates: recorded.map((r) => r.date) }, now).filter((check) => {
    if (check.kind !== 'no_green_up' || !sowing || !winterSown(plan, sowing)) return true;
    const april = `${Number(sowing.slice(0, 4)) + 1}-04-01`;
    return now >= april;
  });
}

export interface PastureEstimate {
  date: string | null;
  ndvi: number | null;
  biomassKgHa: number | null;
  /** Sheep and goats on the farm now. */
  head: number;
  intakeKgDmPerHeadDay: number;
  utilisation: number;
  grazingDays: number | null;
  model: { slope: number; intercept: number; r2: number | null; samples: number; calibrated: boolean };
  samples: { id: string; date: string; biomassKgHa: number; ndvi: number | null; notes: string | null }[];
}

async function smallRuminantsOnFarm(): Promise<number> {
  const [row] = await tx()
    .select({ n: sql<number>`count(*)::int` })
    .from(animals)
    .innerJoin(species, eq(species.id, animals.speciesId))
    .where(and(eq(animals.farmId, ctx().farmId), inArray(animals.status, [...ANIMAL_ON_FARM_STATUSES]), inArray(species.key, ['sheep', 'goat'])));
  return row?.n ?? 0;
}

async function pastureEstimate(fieldId: string, areaHa: number, latest: VegetationView | null): Promise<PastureEstimate> {
  const rows = await tx()
    .select()
    .from(samples)
    .where(and(eq(samples.farmId, ctx().farmId), eq(samples.fieldId, fieldId)))
    .orderBy(desc(samples.date));
  const fit = fitBiomassModel(rows.filter((r) => r.ndvi !== null).map((r) => ({ ndvi: r.ndvi!, biomassKgHa: r.biomassKgHa })));
  const model = fit ?? DEFAULT_PASTURE_MODEL;
  const ndvi = latest?.ndviMean ?? null;
  const biomass = pastureBiomassKgHa(ndvi, model);
  const head = await smallRuminantsOnFarm();
  const days = grazingDays({ biomassKgHa: biomass, areaHa, head });
  return {
    date: latest?.date ?? null,
    ndvi,
    biomassKgHa: biomass === null ? null : Math.round(biomass),
    head,
    intakeKgDmPerHeadDay: GRAZING_DEFAULTS.intakeKgDmPerHeadDay,
    utilisation: GRAZING_DEFAULTS.utilisation,
    grazingDays: days === null ? null : round(days, 1),
    model: { slope: model.slope, intercept: model.intercept, r2: fit ? round(fit.r2, 3) : null, samples: fit?.n ?? 0, calibrated: fit !== null },
    samples: rows.map((r) => ({ id: r.id, date: r.date, biomassKgHa: r.biomassKgHa, ndvi: r.ndvi, notes: r.notes })),
  };
}

export interface FieldHealth {
  fieldId: string;
  landUse: string;
  areaHa: number;
  crop: { cropKey: string; cropName: unknown; status: string; sowingDate: string | null } | null;
  latest: VegetationView | null;
  /** Mean NDVI of the clear reading before the latest one. */
  previousMean: number | null;
  series: VegetationPoint[];
  events: SatelliteEvent[];
  checks: WorkCheck[];
  /** The last scene looked at for the farm, clear over this field or not. */
  lastSceneDate: string | null;
  pasture: PastureEstimate | null;
}

export async function fieldHealth(fieldId: string): Promise<FieldHealth> {
  const field = await getField(fieldId);
  const plan = (await currentPlans([fieldId])).get(fieldId) ?? null;
  const series = await vegetationSeries(fieldId, addDays(today(), -SERIES_DAYS));
  const latest = await vegetationOn(fieldId);
  const points = series.map((p) => ({ date: p.date, mean: p.mean }));
  return {
    fieldId,
    landUse: field.landUse,
    areaHa: field.areaHa,
    crop: plan && { cropKey: plan.cropKey, cropName: plan.cropName, status: plan.status, sowingDate: plan.sowingDateFact ?? plan.sowingDatePlan },
    latest,
    previousMean: series.length >= 2 ? series[series.length - 2].mean : null,
    series,
    events: detectEvents(points),
    checks: plan ? await workChecks(plan, series) : [],
    lastSceneDate: await lastSceneDate(),
    pasture: field.landUse === 'pasture' ? await pastureEstimate(fieldId, field.areaHa, latest) : null,
  };
}

/** Work checks of every field with a current crop, for the alert rule. */
export async function farmWorkChecks(): Promise<{ fieldId: string; number: string; check: WorkCheck }[]> {
  const fieldRows = await tx()
    .select({ id: schema.fields.id, number: schema.fields.number })
    .from(schema.fields)
    .where(and(eq(schema.fields.farmId, ctx().farmId), eq(schema.fields.status, 'active')));
  const plans = await currentPlans(fieldRows.map((f) => f.id));
  const out: { fieldId: string; number: string; check: WorkCheck }[] = [];
  for (const field of fieldRows) {
    const plan = plans.get(field.id);
    if (!plan) continue;
    const series = await vegetationSeries(field.id, addDays(today(), -SERIES_DAYS));
    for (const check of await workChecks(plan, series)) out.push({ fieldId: field.id, number: field.number, check });
  }
  return out;
}

// ─── Pasture samples ─────────────────────────────────────────────────────────

export const pastureSampleInput = z.object({
  date: isoDate,
  /** Dry matter cut from a measured square, scaled to a hectare. */
  biomassKgHa: z.number().min(0).max(30_000),
  notes: z.string().trim().max(500).nullish(),
});

/** The NDVI of the clear reading nearest the sample's date, within a week, or null. */
async function ndviNear(fieldId: string, date: string): Promise<number | null> {
  const [row] = await tx()
    .select({ mean: veg.ndviMean })
    .from(veg)
    .where(
      and(
        eq(veg.farmId, ctx().farmId),
        eq(veg.fieldId, fieldId),
        gte(veg.date, addDays(date, -SAMPLE_MATCH_DAYS)),
        lte(veg.date, addDays(date, SAMPLE_MATCH_DAYS)),
        isNotNull(veg.ndviMean),
      ),
    )
    .orderBy(sql`abs(${veg.date} - ${date}::date)`, asc(veg.date))
    .limit(1);
  return row?.mean ?? null;
}

export async function addPastureSample(fieldId: string, input: z.infer<typeof pastureSampleInput>) {
  await getField(fieldId);
  const c = ctx();
  const ndvi = await ndviNear(fieldId, input.date);
  const [row] = await tx()
    .insert(samples)
    .values({ tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId, fieldId, date: input.date, biomassKgHa: input.biomassKgHa, ndvi, notes: input.notes ?? null })
    .returning();
  await recordEvent({ type: 'pasture.sample_recorded', entityType: 'field', entityId: fieldId, data: { date: input.date, biomassKgHa: input.biomassKgHa, ndvi } });
  return row;
}

export async function removePastureSample(fieldId: string, sampleId: string) {
  const [row] = await tx()
    .delete(samples)
    .where(and(eq(samples.farmId, ctx().farmId), eq(samples.fieldId, fieldId), eq(samples.id, sampleId)))
    .returning();
  if (!row) throw notFound('Pasture sample');
  await recordEvent({ type: 'pasture.sample_removed', entityType: 'field', entityId: fieldId, data: { date: row.date } });
  return { id: row.id };
}
