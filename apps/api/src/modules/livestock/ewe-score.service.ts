/**
 * The ewe score: every ewe on the farm ranked by what her own records show. The formula, its
 * weights and its scales are in formulas/ewe-score.ts; survival, rearing and 100-day weight come
 * from breeding.summary.ts, the one place that computes them.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { diffDays, round, survivalPercent } from '@yap/shared';
import { eweScore, lambingIntervalDays, type EweScoreComponent, type EweScorePart } from '@yap/shared/formulas/ewe-score';
import { ageInMonths } from '@yap/shared/formulas/livestock';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { listQuery, type Page } from '../../core/query';
import { conditionHistory, latestGradings, type ConditionEntry } from './appraisal.service';
import { eweFacts, type EweFacts } from './breeding.summary';
import { openCullMarks } from './cull-marks.service';
import { getHerdOrThrow, onFarm } from './refs';

const { animals, herds, lambingRecords } = schema;

const SORTS = ['score', 'tag', 'condition', 'age', 'lambings'] as const;

export const eweScoreQuery = listQuery.extend({
  herdId: z.uuid().optional(),
  /** A class key, or `none` for ewes not graded yet. */
  gradingClass: z.string().trim().min(1).max(40).optional(),
  /** `score` (lowest first) or `-score` (highest first), and the same for tag, condition, age, lambings. */
  sort: z
    .string()
    .refine((v) => (SORTS as readonly string[]).includes(v.replace(/^-/, '')), { message: 'Unknown sort field' })
    .optional(),
});

export interface ScoredEwe {
  eweId: string;
  tag: string;
  status: string;
  herdId: string | null;
  herdName: string | null;
  birthDate: string | null;
  /** Null when her birth date is not on record. */
  ageYears: number | null;
  facts: EweFacts;
  /** 0 to 100, one decimal. Null with no lambing on record. */
  score: number | null;
  parts: EweScorePart[];
  missing: EweScoreComponent[];
  /** Newest first. */
  conditionScores: ConditionEntry[];
}

/**
 * Every ewe on the farm with her score: females kept as ewes, and any other female with a lambing
 * on record. One pass over the flock, because "the lowest tenth" needs every score.
 */
export async function flockScores(): Promise<ScoredEwe[]> {
  const farmId = ctx().farmId;
  const now = today();
  const rows = await tx()
    .select({ eweId: animals.id, tag: animals.tag, status: animals.status, herdId: animals.herdId, herdName: herds.name, birthDate: animals.birthDate })
    .from(animals)
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .where(
      and(
        eq(animals.farmId, farmId),
        eq(animals.sex, 'female'),
        onFarm(),
        sql`(${animals.category} = 'ewe' or exists (select 1 from ${lambingRecords} where ${lambingRecords.eweId} = ${animals.id}))`,
      ),
    )
    .orderBy(asc(animals.tag));
  const ids = rows.map((row) => row.eweId);
  const { farmWeight100Kg, byEwe } = await eweFacts(ids);
  const conditions = await conditionHistory(ids);

  return rows.map((row) => {
    const facts = byEwe.get(row.eweId)!;
    const conditionScores = conditions.get(row.eweId) ?? [];
    const months = ageInMonths(row.birthDate, now);
    const ageYears = months === null ? null : months / 12;
    const latest = conditionScores[0] ?? null;
    const result = eweScore({
      lambings: facts.lambings,
      lambsBorn: facts.lambsBorn,
      lambsDueAtWeaning: facts.lambsDueAtWeaning,
      lambsReared: facts.lambsReared,
      lambWeight100Kg: facts.avgWeight100Kg,
      farmWeight100Kg,
      lambingIntervalDays: lambingIntervalDays(facts.lambingDates),
      ageYears,
      bodyCondition: latest?.score ?? null,
      bodyConditionAgeDays: latest ? diffDays(latest.date, now) : null,
    });
    return {
      ...row,
      ageYears: ageYears === null ? null : round(ageYears, 1),
      facts,
      score: result.score === null ? null : round(result.score, 1),
      parts: result.parts.map((part) => ({ ...part, value: round(part.value, 2), points: round(part.points, 1), weight: round(part.weight, 4) })),
      missing: result.missing,
      conditionScores,
    };
  });
}

/** Sort by a number, with ewes that have none always last, whichever way the list runs. */
function byNumber<T>(value: (row: T) => number | null, descending: boolean) {
  return (x: T, y: T) => {
    const a = value(x);
    const b = value(y);
    if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1;
    return descending ? b - a : a - b;
  };
}

/** The ewe list with scores, sorted and paged on the server. The best ewes come first unless asked otherwise. */
export async function listEweScores(q: z.infer<typeof eweScoreQuery>): Promise<Page<Record<string, unknown>>> {
  if (q.herdId) await getHerdOrThrow(q.herdId);
  const flock = await flockScores();
  const gradings = await latestGradings(flock.map((ewe) => ewe.eweId));
  const search = q.search?.toLowerCase();
  const wanted = flock.filter((ewe) => {
    if (q.herdId && ewe.herdId !== q.herdId) return false;
    if (search && !ewe.tag.toLowerCase().includes(search)) return false;
    if (q.gradingClass) {
      const classKey = gradings.get(ewe.eweId)?.classKey ?? 'none';
      if (classKey !== q.gradingClass) return false;
    }
    return true;
  });

  const sort = q.sort ?? '-score';
  const descending = sort.startsWith('-');
  const field = sort.replace(/^-/, '') as (typeof SORTS)[number];
  const byTag = (x: ScoredEwe, y: ScoredEwe) => x.tag.localeCompare(y.tag) || x.eweId.localeCompare(y.eweId);
  const order =
    field === 'tag'
      ? (x: ScoredEwe, y: ScoredEwe) => (descending ? -byTag(x, y) : byTag(x, y))
      : byNumber<ScoredEwe>(
          {
            score: (ewe: ScoredEwe) => ewe.score,
            condition: (ewe: ScoredEwe) => ewe.conditionScores[0]?.score ?? null,
            age: (ewe: ScoredEwe) => ewe.ageYears,
            lambings: (ewe: ScoredEwe) => ewe.facts.lambings,
          }[field],
          descending,
        );
  wanted.sort((x, y) => order(x, y) || byTag(x, y));

  const offset = (q.page - 1) * q.pageSize;
  const slice = wanted.slice(offset, offset + q.pageSize);
  const marks = await openCullMarks(slice.map((ewe) => ewe.eweId));
  return {
    data: slice.map((ewe) => {
      const { facts, conditionScores, ...rest } = ewe;
      const grading = gradings.get(ewe.eweId) ?? null;
      return {
        ...rest,
        lambings: facts.lambings,
        lambsBorn: facts.lambsBorn,
        lambsAlive: facts.lambsAlive,
        survivalPercent: roundOrNull(survivalPercent(facts.lambsWeaned, facts.lambsDueAtWeaning), 1),
        avgWeight100Kg: roundOrNull(facts.avgWeight100Kg, 1),
        bodyCondition: conditionScores[0]?.score ?? null,
        bodyConditionDate: conditionScores[0]?.date ?? null,
        gradingClass: grading?.classKey ?? null,
        gradedOn: grading?.date ?? null,
        cullMarked: marks.has(ewe.eweId),
      };
    }),
    meta: { page: q.page, pageSize: q.pageSize, total: wanted.length },
  };
}

const roundOrNull = (value: number | null, digits: number) => (value === null ? null : round(value, digits));

/** One ewe's score for her card. Null for an animal that is not a ewe of this farm's flock today. */
export async function eweScoreOf(animalId: string) {
  const ewe = (await flockScores()).find((row) => row.eweId === animalId);
  if (!ewe) return null;
  return { score: ewe.score, parts: ewe.parts, missing: ewe.missing, lambings: ewe.facts.lambings };
}
