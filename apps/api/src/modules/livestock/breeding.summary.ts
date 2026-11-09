/**
 * Calendar and reproduction KPIs (spec 8.2, 8.6). Re-export these two from modules/livestock/
 * summary.ts: reproductionKpis() and lambingCalendar(days).
 */
import { and, count, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { addDays, lambingPercent, round, survivalPercent } from '@yap/shared';
import { OUTLOOK_ASSUMPTIONS, expectedLambs } from '@yap/shared/formulas/outlook';
import {
  MIN_PROGENY_FOR_RATING,
  WEANING_DAYS,
  adjustedWeight100,
  averageOf,
  gainFromBirthGrams,
  lambsPerEwe,
  progenyIndex,
} from '@yap/shared/formulas/reproduction';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { weekStart } from './breeding.shared';
import { onFarm } from './refs';

const { animals, breedingRecords: b, lambingRecords: l } = schema;

function onFarmEwes() {
  return tx().select({ id: animals.id }).from(animals).where(and(eq(animals.farmId, ctx().farmId), onFarm()));
}

/** Expected lambings per day from today, for ewes still on the farm. */
export async function lambingCalendar(days: number): Promise<{ date: string; expected: number }[]> {
  const from = today();
  return expectedByDay(from, addDays(from, days));
}

async function expectedByDay(from: string, to: string, herdId?: string) {
  const rows = await tx()
    .select({ date: b.expectedDate, expected: count() })
    .from(b)
    .where(
      and(
        eq(b.farmId, ctx().farmId),
        eq(b.status, 'pregnant'),
        gte(b.expectedDate, from),
        lte(b.expectedDate, to),
        inArray(b.eweId, herdId ? tx().select({ id: animals.id }).from(animals).where(and(eq(animals.herdId, herdId), onFarm())) : onFarmEwes()),
      ),
    )
    .groupBy(b.expectedDate)
    .orderBy(b.expectedDate);
  return rows;
}

/** Lambing plan: expected ewes by day and week, and how many are already past their date. */
export async function calendar(q: { from?: string; to?: string; herdId?: string }) {
  const now = today();
  const from = q.from ?? now;
  const to = q.to ?? addDays(from, 180);
  const days = await expectedByDay(from, to, q.herdId);

  const byWeek = new Map<string, number>();
  for (const day of days) {
    const week = weekStart(day.date);
    byWeek.set(week, (byWeek.get(week) ?? 0) + day.expected);
  }
  const [{ overdue }] = await tx()
    .select({ overdue: count() })
    .from(b)
    .where(and(eq(b.farmId, ctx().farmId), eq(b.status, 'pregnant'), lte(b.expectedLatest, addDays(now, -1)), inArray(b.eweId, onFarmEwes())));

  const totalEwes = days.reduce((sum, d) => sum + d.expected, 0);
  const history = await lambingTotals();
  const perEwe = lambsPerEwe(history.born, history.lambings);
  return {
    from,
    to,
    days,
    weeks: [...byWeek].map(([week, expected]) => ({ week, expected })),
    totalEwes,
    /** Past their latest plausible date and still not recorded. */
    overdue,
    /** Only from this farm's own history: null until the first lambing is recorded. */
    expectedLambs: perEwe === null ? null : Math.round(totalEwes * perEwe),
    /** The outlook's estimate for these ewes, from its stated assumption. Null with no ewes due. */
    assumedLambs: totalEwes > 0 ? expectedLambs(totalEwes) : null,
    assumedLambsPerEwe: OUTLOOK_ASSUMPTIONS.lambsPerEwe,
  };
}

async function lambingTotals(from?: string, to?: string) {
  const [row] = await tx()
    .select({
      lambings: count(),
      born: sql<number>`coalesce(sum(${l.lambsBorn}), 0)`.mapWith(Number),
      alive: sql<number>`coalesce(sum(${l.lambsAlive}), 0)`.mapWith(Number),
      unlinked: sql<number>`count(*) filter (where ${l.breedingId} is null)`.mapWith(Number),
    })
    .from(l)
    .where(and(eq(l.farmId, ctx().farmId), from ? gte(l.date, from) : undefined, to ? lte(l.date, to) : undefined));
  return row;
}

interface LambRow {
  id: string;
  damId: string | null;
  sireId: string | null;
  birthDate: string | null;
  birthWeightKg: number | null;
  status: string;
  exitDate: string | null;
}

async function bornAnimals(from?: string, to?: string): Promise<LambRow[]> {
  return tx()
    .select({
      id: animals.id,
      damId: animals.damId,
      sireId: animals.sireId,
      birthDate: animals.birthDate,
      birthWeightKg: animals.birthWeightKg,
      status: animals.status,
      exitDate: animals.exitDate,
    })
    .from(animals)
    .where(
      and(
        eq(animals.farmId, ctx().farmId),
        eq(animals.origin, 'born'),
        from ? gte(animals.birthDate, from) : undefined,
        to ? lte(animals.birthDate, to) : undefined,
      ),
    );
}

/** A lamb that died or vanished before weaning. A sale is not a loss: it was alive when it left. */
function lostBeforeWeaning(lamb: LambRow): boolean {
  if (lamb.status !== 'dead' && lamb.status !== 'lost') return false;
  if (!lamb.exitDate || !lamb.birthDate) return true;
  return lamb.exitDate <= addDays(lamb.birthDate, WEANING_DAYS);
}

interface Growth {
  weight100: number | null;
  gainGrams: number | null;
}

/** Each lamb's weighing closest to 100 days, standardised to exactly 100 days. */
async function lambGrowth(): Promise<Map<string, Growth>> {
  const result = await tx().execute<{ id: string; age: number; weight_kg: string; birth_weight_kg: string }>(sql`
    select distinct on (a.id) a.id, (w.date - a.birth_date) as age, w.weight_kg, a.birth_weight_kg
    from animals a
    join weight_records w on w.animal_id = a.id
    where a.farm_id = ${ctx().farmId}
      and a.origin = 'born'
      and a.birth_date is not null
      and a.birth_weight_kg is not null
      and (w.date - a.birth_date) between 70 and 130
    order by a.id, abs((w.date - a.birth_date) - 100), w.date`);
  const growth = new Map<string, Growth>();
  for (const row of result.rows) {
    const birth = Number(row.birth_weight_kg);
    const weight = Number(row.weight_kg);
    const age = Number(row.age);
    growth.set(row.id, { weight100: adjustedWeight100(birth, weight, age), gainGrams: gainFromBirthGrams(birth, weight, age) });
  }
  return growth;
}

const rounded = (value: number | null, digits = 2) => (value === null ? null : round(value, digits));

/** Farm reproduction KPIs (spec 8.6, 14.3), optionally limited to one period. */
export async function reproductionKpis(from?: string, to?: string) {
  const c = ctx();
  const inPeriod = and(eq(b.farmId, c.farmId), from ? gte(b.matingDate, from) : undefined, to ? lte(b.matingDate, to) : undefined);
  const [counts] = await tx()
    .select({
      open: sql<number>`count(*) filter (where ${b.status} = 'pregnant')`.mapWith(Number),
      lambed: sql<number>`count(*) filter (where ${b.status} = 'lambed')`.mapWith(Number),
      // markExited closes a pregnancy as failed; a ewe sold while carrying is not a breeding loss.
      lost: sql<number>`count(*) filter (where ${b.status} in ('aborted', 'failed') and ${animals.status} not in ('sold', 'slaughtered'))`.mapWith(Number),
    })
    .from(b)
    .innerJoin(animals, eq(animals.id, b.eweId))
    .where(inPeriod);
  const totals = await lambingTotals(from, to);

  // Only ewes with a known outcome count: mid-season, an ewe still carrying is not a failure, and
  // counting her would show 500 mated and 50 lambed as a 10 % lambing rate.
  const ewesWithOutcome = counts.lambed + counts.lost + totals.unlinked;

  const cutoff = addDays(today(), -WEANING_DAYS);
  const lambs = await bornAnimals(from, to);
  const reachedWeaning = lambs.filter((a) => a.birthDate && a.birthDate <= cutoff);
  const cohort = await lambingTotals(from, to && to < cutoff ? to : cutoff);
  const aliveAtWeaning = reachedWeaning.filter((a) => !lostBeforeWeaning(a)).length;

  const growth = await lambGrowth();
  const weights = lambs.map((a) => growth.get(a.id)?.weight100);

  return {
    ewesPregnant: counts.open,
    ewesMated: counts.open + counts.lambed + counts.lost,
    ewesWithOutcome,
    lambings: totals.lambings,
    lambsBorn: totals.born,
    lambsBornAlive: totals.alive,
    lambingPercent: rounded(lambingPercent(totals.born, ewesWithOutcome), 1),
    survivalPercent: rounded(survivalPercent(aliveAtWeaning, cohort.born), 1),
    lambsPerEwe: rounded(lambsPerEwe(totals.born, totals.lambings)),
    avgWeight100Kg: rounded(averageOf(weights), 1),
  };
}

/** Per-ewe figures (spec 8.2): lambs born, survival, 100-day weight. */
export async function ewePerformance(eweIds: string[]) {
  const records = eweIds.length
    ? await tx()
        .select({ eweId: l.eweId, date: l.date, born: l.lambsBorn, alive: l.lambsAlive })
        .from(l)
        .where(and(eq(l.farmId, ctx().farmId), inArray(l.eweId, eweIds)))
    : [];
  const lambs = await bornAnimals();
  const growth = await lambGrowth();
  const cutoff = addDays(today(), -WEANING_DAYS);

  return new Map(
    eweIds.map((eweId) => {
      const own = records.filter((r) => r.eweId === eweId);
      const offspring = lambs.filter((a) => a.damId === eweId);
      const bornInCohort = own.filter((r) => r.date <= cutoff).reduce((sum, r) => sum + r.born, 0);
      const weaned = offspring.filter((a) => a.birthDate && a.birthDate <= cutoff && !lostBeforeWeaning(a)).length;
      return [
        eweId,
        {
          lambings: own.length,
          lambsBorn: own.reduce((sum, r) => sum + r.born, 0),
          lambsAlive: own.reduce((sum, r) => sum + r.alive, 0),
          survivalPercent: rounded(survivalPercent(weaned, bornInCohort), 1),
          avgWeight100Kg: rounded(averageOf(offspring.map((a) => growth.get(a.id)?.weight100)), 1),
        },
      ];
    }),
  );
}

/**
 * Ram rating (spec 8.2): how each ram's lambs grow compared with the farm's lambs. An index of 110
 * means 10 % faster than average. A few lambs prove little, so low samples are flagged.
 */
export async function ramRating() {
  const c = ctx();
  const lambs = await bornAnimals();
  const growth = await lambGrowth();
  const sireIds = new Set(lambs.map((a) => a.sireId).filter((id): id is string => !!id));

  const rams = await tx()
    .select({ id: animals.id, tag: animals.tag, status: animals.status })
    .from(animals)
    .where(
      and(
        eq(animals.farmId, c.farmId),
        sireIds.size
          ? sql`(${animals.category} = 'ram' or ${inArray(animals.id, [...sireIds])})`
          : eq(animals.category, 'ram'),
      ),
    );

  const allGains = lambs.map((a) => growth.get(a.id)?.gainGrams);
  const farmGain = averageOf(allGains);
  const rows = rams.map((ram) => {
    const progeny = lambs.filter((a) => a.sireId === ram.id);
    const gains = progeny.map((a) => growth.get(a.id)?.gainGrams);
    const weighed = gains.filter((g) => typeof g === 'number').length;
    const gain = averageOf(gains);
    return {
      ramId: ram.id,
      tag: ram.tag,
      status: ram.status,
      progeny: progeny.length,
      weighed,
      avgWeight100Kg: rounded(averageOf(progeny.map((a) => growth.get(a.id)?.weight100)), 1),
      avgGainGrams: rounded(gain, 0),
      index: rounded(progenyIndex(gain, farmGain), 1),
      lowConfidence: weighed < MIN_PROGENY_FOR_RATING,
    };
  });
  rows.sort((x, y) => (y.index ?? -1) - (x.index ?? -1) || y.progeny - x.progeny || x.tag.localeCompare(y.tag));
  return { farmAvgGainGrams: rounded(farmGain, 0), rams: rows.map((row, i) => ({ rank: row.index === null ? null : i + 1, ...row })) };
}
