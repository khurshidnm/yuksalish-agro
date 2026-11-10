import { and, asc, count, eq, gte, min, sql } from 'drizzle-orm';
import { countSpike, gainSlowdown, lambingWorkload, weekStartOf, type LambingWeek } from '@yap/shared/formulas/ai';
import { expectedLambCrop } from '@yap/shared/formulas/lambing';
import { OUTLOOK_ASSUMPTIONS } from '@yap/shared/formulas/outlook';
import { ANIMAL_ON_FARM_STATUSES, addDays, diffDays, monthOf, round } from '@yap/shared';
import { ctx, today, tx } from '../../../core/context';
import { schema } from '../../../db/client';
import { dayText } from '../render';
import { coverage, type AnalyzerResult, type Finding } from './types';

const { animalExits, animals, breedingRecords, herds, lambingRecords, rationLines, rations, weightRecords } = schema;

const ON_FARM = sql.join(ANIMAL_ON_FARM_STATUSES.map((s) => sql`${s}`), sql`, `);

const MIN_MORTALITY_BASELINE_WEEKS = 6;
const MIN_WEIGHED_ANIMALS = 10;
const MIN_WEIGHT_INTERVALS = 3;
const WEIGHT_LOSS_RATIO = 0.08;
const MIN_PREGNANT_EWES = 10;

// Assumptions used while the farm has no history of its own. Shown with the forecast. Lambs per
// ewe is the outlook's, so the assistant expects as many lambs as the dashboard does.
const MIN_OWN_LAMBINGS = 30;
const ASSUMED_LAMBS_PER_EWE = OUTLOOK_ASSUMPTIONS.lambsPerEwe;
const LACTATION_WEEKS = 8;
const LABOR_HOURS_PER_LAMBING = 1;
const SHIFT_HOURS = 10;

/** Deaths in the last 7 days against earlier weeks (spec 15.1.2). */
export async function mortalitySpike(): Promise<AnalyzerResult> {
  const farmId = ctx().farmId;
  const [{ firstAnimal, firstPurchase }] = await tx()
    .select({ firstAnimal: min(animals.createdAt), firstPurchase: min(animals.purchaseDate) })
    .from(animals)
    .where(eq(animals.farmId, farmId));

  const start =
    firstPurchase ?? (firstAnimal ? firstAnimal.toISOString().slice(0, 10) : null);
  const weeksKnown = start ? Math.floor(diffDays(start, today()) / 7) : 0;
  const baselineWeeks = Math.max(0, weeksKnown - 1);
  const cover = coverage('mortality_spike', baselineWeeks, MIN_MORTALITY_BASELINE_WEEKS, 'weeks');
  if (!cover.enough) return { coverage: cover, findings: [] };

  const considered = Math.min(baselineWeeks, 26);
  const from = addDays(today(), -(considered + 1) * 7 + 1);
  const deaths = await tx()
    .select({ date: animalExits.date, dead: count() })
    .from(animalExits)
    .where(and(eq(animalExits.farmId, farmId), eq(animalExits.type, 'death'), gte(animalExits.date, from)))
    .groupBy(animalExits.date);

  const buckets = Array.from({ length: considered + 1 }, () => 0);
  for (const row of deaths) buckets[Math.floor(diffDays(row.date, today()) / 7)] += row.dead;
  const [recent, ...baseline] = buckets;

  const spike = countSpike(recent, baseline, { minBaseline: MIN_MORTALITY_BASELINE_WEEKS });
  if (!spike) return { coverage: cover, findings: [] };

  const periodFrom = addDays(today(), -6);
  return {
    coverage: cover,
    findings: [
      {
        type: 'mortality_spike',
        dedupKey: `mortality_spike:${weekStartOf(today())}`,
        severity: 'urgent',
        confidence: spike.confidence,
        params: { dead: recent, expected: spike.expected },
        sources: {
          tables: ['animal_exits', 'animals'],
          from,
          to: today(),
          baselineWeeks: baseline.length,
          expectedPerWeek: spike.expected,
          z: spike.z,
        },
        data: { recent, weeklyCounts: baseline },
        periodFrom,
        periodTo: today(),
        link: '/livestock/exits',
      },
    ],
  };
}

interface IntervalRow extends Record<string, unknown> {
  herd_id: string;
  herd: string;
  date: string;
  animals: number;
  adg: number;
}

/** Daily gain per weighing interval by herd, and animals that lost weight (15.1.2, 15.1.7). */
export async function weightGain(): Promise<AnalyzerResult> {
  const farmId = ctx().farmId;
  const from = addDays(today(), -365);
  const paired = sql`
    select animal.herd_id, record.animal_id, animal.tag, record.date, record.weight_kg,
      lag(record.date) over w as prev_date,
      lag(record.weight_kg) over w as prev_kg,
      row_number() over (partition by record.animal_id order by record.date desc) as recency
    from ${weightRecords} record
    join ${animals} animal on animal.id = record.animal_id
    where record.farm_id = ${farmId} and record.date >= ${from} and animal.status in (${ON_FARM})
    window w as (partition by record.animal_id order by record.date)`;

  const intervals = await tx().execute(sql`
    with paired as (${paired})
    select paired.herd_id, herd.name as herd, paired.date::text as date, count(*)::int as animals,
      avg((paired.weight_kg - paired.prev_kg) / (paired.date - paired.prev_date))::float8 as adg
    from paired
    join ${herds} herd on herd.id = paired.herd_id
    where paired.prev_date is not null and paired.date > paired.prev_date
    group by paired.herd_id, herd.name, paired.date
    having count(*) >= ${MIN_WEIGHED_ANIMALS}
    order by paired.herd_id, paired.date`);

  const byHerd = new Map<string, IntervalRow[]>();
  for (const row of intervals.rows as IntervalRow[]) {
    byHerd.set(row.herd_id, [...(byHerd.get(row.herd_id) ?? []), row]);
  }
  const longest = Math.max(0, ...[...byHerd.values()].map((rows) => rows.length));
  const cover = coverage('weight_slowdown', longest, MIN_WEIGHT_INTERVALS, 'intervals');

  const findings: Finding[] = [];
  for (const rows of byHerd.values()) {
    const slowdown = gainSlowdown(rows.map((r) => r.adg), { minIntervals: MIN_WEIGHT_INTERVALS });
    if (!slowdown) continue;
    const last = rows[rows.length - 1];
    findings.push({
      type: 'weight_slowdown',
      dedupKey: `weight_slowdown:${last.herd_id}:${last.date}`,
      severity: 'attention',
      confidence: slowdown.confidence,
      params: {
        herd: last.herd,
        latestG: round(slowdown.latest * 1000, 0),
        previousG: round(slowdown.previousMean * 1000, 0),
      },
      sources: {
        tables: ['weight_records', 'animals'],
        intervals: rows.length,
        animalsWeighed: last.animals,
        from: rows[0].date,
        to: last.date,
      },
      data: { series: rows.map((r) => ({ date: r.date, gramsPerDay: round(r.adg * 1000, 0) })) },
      entityType: 'herd',
      entityId: last.herd_id,
      periodTo: last.date,
      link: `/livestock/herds/${last.herd_id}`,
    });
  }

  // Two weighings are enough to see an individual losing weight, a health signal (15.1.7).
  const losing = await tx().execute(sql`
    with paired as (${paired})
    select tag, date::text as date, prev_kg::float8 as prev_kg, weight_kg::float8 as weight_kg
    from paired
    where recency = 1 and prev_kg is not null and prev_kg > 0
      and (prev_kg - weight_kg) / prev_kg >= ${WEIGHT_LOSS_RATIO}
    order by (prev_kg - weight_kg) / prev_kg desc
    limit 50`);
  const rows = losing.rows as { tag: string; date: string; prev_kg: number; weight_kg: number }[];
  if (rows.length > 0) {
    const latestDate = rows.map((r) => r.date).sort().at(-1)!;
    findings.push({
      type: 'weight_loss',
      dedupKey: `weight_loss:${latestDate}`,
      severity: 'attention',
      confidence: 0.6,
      params: { count: rows.length, tags: rows.slice(0, 10).map((r) => r.tag).join(', ') },
      sources: { tables: ['weight_records', 'animals'], thresholdPercent: WEIGHT_LOSS_RATIO * 100, weighings: 2 },
      data: { animals: rows.map((r) => ({ tag: r.tag, fromKg: r.prev_kg, toKg: r.weight_kg, date: r.date })) },
      periodTo: latestDate,
      link: '/livestock/animals',
      alertable: false,
    });
  }
  return { coverage: cover, findings };
}

/**
 * Tonnes as the text gives them. From 10 t in whole tonnes: an estimate resting on an eight-week
 * lactation is no finer than that, and a whole number reads the same in every language, where a
 * fraction would be written 25.8 in English but 25,8 in Uzbek and Russian.
 */
function tonsText(kg: number): number {
  return kg >= 10_000 ? round(kg / 1000, 0) : round(kg / 1000, 1);
}

async function rationTotals(): Promise<Record<string, number>> {
  const rows = await tx()
    .select({ state: rations.state, kg: sql<number>`sum(${rationLines.kgPerHeadDay})`.mapWith(Number) })
    .from(rations)
    .innerJoin(rationLines, eq(rationLines.rationId, rations.id))
    .where(and(eq(rations.farmId, ctx().farmId), eq(rations.active, true)))
    .groupBy(rations.id);
  const totals: Record<string, number> = {};
  for (const row of rows) totals[row.state] = Math.max(totals[row.state] ?? 0, row.kg);
  return totals;
}

/** Weekly lambing load for feed and labour (spec 15.3 scenario 1). */
export async function lambingForecast(): Promise<AnalyzerResult> {
  const farmId = ctx().farmId;
  const rows = await tx()
    .select({
      date: breedingRecords.expectedDate,
      ewes: count(),
      scannedEwes: sql<number>`count(${breedingRecords.fetusCount})`.mapWith(Number),
      scannedFetuses: sql<number>`coalesce(sum(${breedingRecords.fetusCount}), 0)`.mapWith(Number),
    })
    .from(breedingRecords)
    .where(
      and(
        eq(breedingRecords.farmId, farmId),
        eq(breedingRecords.status, 'pregnant'),
        gte(breedingRecords.expectedDate, today()),
      ),
    )
    .groupBy(breedingRecords.expectedDate)
    .orderBy(asc(breedingRecords.expectedDate));

  const pregnant = rows.reduce((sum, r) => sum + r.ewes, 0);
  const cover = coverage('lambing_workload', pregnant, MIN_PREGNANT_EWES, 'ewes');
  if (!cover.enough) return { coverage: cover, findings: [] };

  const perWeek = new Map<string, number>();
  // Ewes a pregnancy scan has counted, and the foetuses it found, by week.
  const scannedPerWeek = new Map<string, { scannedEwes: number; scannedFetuses: number }>();
  for (const row of rows) {
    const week = weekStartOf(row.date);
    perWeek.set(week, (perWeek.get(week) ?? 0) + row.ewes);
    if (row.scannedEwes > 0) {
      const scanned = scannedPerWeek.get(week) ?? { scannedEwes: 0, scannedFetuses: 0 };
      scannedPerWeek.set(week, { scannedEwes: scanned.scannedEwes + row.scannedEwes, scannedFetuses: scanned.scannedFetuses + row.scannedFetuses });
    }
  }
  // Consecutive weeks, gaps included, so the lactation window counts real weeks.
  const first = weekStartOf(rows[0].date);
  const last = weekStartOf(rows[rows.length - 1].date);
  const weeks: LambingWeek[] = [];
  for (let week = first; week <= last; week = addDays(week, 7)) {
    weeks.push({ weekStart: week, ewes: perWeek.get(week) ?? 0, ...scannedPerWeek.get(week) });
  }

  const [history] = await tx()
    .select({ lambings: count(), lambs: sql<number>`coalesce(sum(${lambingRecords.lambsBorn}), 0)`.mapWith(Number) })
    .from(lambingRecords)
    .where(eq(lambingRecords.farmId, farmId));
  const ownHistory = history.lambings >= MIN_OWN_LAMBINGS;
  const lambsPerEwe = ownHistory ? round(history.lambs / history.lambings, 2) : ASSUMED_LAMBS_PER_EWE;

  const rationKg = await rationTotals();
  const extraKgPerEweDay =
    rationKg.lactating !== undefined && rationKg.pregnant !== undefined
      ? round(rationKg.lactating - rationKg.pregnant, 3)
      : null;

  const workload = lambingWorkload(weeks, {
    lambsPerEwe,
    lactationWeeks: LACTATION_WEEKS,
    extraKgPerEweDay,
    laborHoursPerLambing: LABOR_HOURS_PER_LAMBING,
    shiftHours: SHIFT_HOURS,
  });
  const peak = workload.reduce((a, b) => (b.ewes > a.ewes ? b : a));
  // The same count the dashboard and the outlook show for these ewes: scanned ewes by their scan.
  const scannedEwes = rows.reduce((sum, r) => sum + r.scannedEwes, 0);
  const scannedFetuses = rows.reduce((sum, r) => sum + r.scannedFetuses, 0);
  const lambs = expectedLambCrop({ ewes: pregnant, scannedEwes, scannedFetuses }, lambsPerEwe) ?? 0;
  const extraFeedKg =
    extraKgPerEweDay === null ? null : workload.reduce((sum, w) => sum + (w.extraFeedKg ?? 0), 0);

  return {
    coverage: cover,
    findings: [
      {
        type: 'lambing_workload',
        dedupKey: `lambing_workload:${monthOf(today())}`,
        severity: 'info',
        confidence: ownHistory ? 0.8 : 0.6,
        // Without both rations the feed effect is unknown, so the text does not mention it.
        textKey: extraFeedKg === null ? 'lambing_workload_no_feed' : undefined,
        params: {
          ewes: pregnant,
          lambs,
          peakWeek: dayText(peak.weekStart),
          peakEwes: peak.ewes,
          workers: Math.max(...workload.map((w) => w.workersNeeded)),
          extraFeedT: extraFeedKg === null ? 0 : tonsText(extraFeedKg),
        },
        sources: {
          tables: ['breeding_records', 'lambing_records', 'rations', 'ration_lines'],
          pregnantEwes: pregnant,
          ownLambings: history.lambings,
          assumptions: {
            lambsPerEwe,
            lambsPerEweSource: ownHistory ? 'farm_history' : 'assumed_default',
            lactationWeeks: LACTATION_WEEKS,
            laborHoursPerLambing: LABOR_HOURS_PER_LAMBING,
            shiftHours: SHIFT_HOURS,
          },
        },
        data: { weeks: workload, extraKgPerEweDay },
        periodFrom: first,
        periodTo: addDays(last, 6),
        link: '/livestock/breeding',
        alertable: false,
      },
    ],
  };
}
