/**
 * The culling list. Two things meet here and stay apart: suggestions, worked out from the records
 * every time the list is read and never stored (formulas/ewe-score.ts), and cull marks, which are
 * a person's own decision (cull-marks.service.ts). A suggestion puts nobody out of the flock; only
 * a mark says "cull her".
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { BODY_CONDITION_RULES } from '@yap/shared/formulas/body-condition';
import { CULLING, cullReasons, emptySeasonsRunning, lowScoreCutoff, type BreedingOutcome, type ComputedCullReason } from '@yap/shared/formulas/ewe-score';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { flockScores } from './ewe-score.service';
import { getHerdOrThrow, onFarm } from './refs';

const { animals, breedingRecords: b, cullMarks: m, herds, lambingRecords: l } = schema;

export const cullingQuery = z.object({ herdId: z.uuid().optional() });

/**
 * What became of each mating, per ewe, for "empty two seasons running". A pregnancy closed as
 * `failed` is a ewe that was mated and found empty: a scan that counted 0 closes it that way, and
 * so does a person saying she turned out not to be pregnant. A lambing entered with no pregnancy
 * record still shows she conceived.
 */
async function breedingOutcomes(eweIds: string[]): Promise<Map<string, BreedingOutcome[]>> {
  const outcomes = new Map<string, BreedingOutcome[]>();
  if (eweIds.length === 0) return outcomes;
  const farmId = ctx().farmId;
  const add = (eweId: string, outcome: BreedingOutcome) => {
    const list = outcomes.get(eweId);
    if (list) list.push(outcome);
    else outcomes.set(eweId, [outcome]);
  };
  const pregnancies = await tx()
    .select({ eweId: b.eweId, matingDate: b.matingDate, status: b.status })
    .from(b)
    .where(and(eq(b.farmId, farmId), inArray(b.eweId, eweIds)));
  for (const p of pregnancies) add(p.eweId, { date: p.matingDate, outcome: p.status === 'failed' ? 'empty' : (p.status as BreedingOutcome['outcome']) });
  const unlinked = await tx()
    .select({ eweId: l.eweId, date: l.date })
    .from(l)
    .where(and(eq(l.farmId, farmId), isNull(l.breedingId), inArray(l.eweId, eweIds)));
  for (const record of unlinked) add(record.eweId, { date: record.date, outcome: 'lambed' });
  return outcomes;
}

/**
 * The culling list: ewes the records speak against, each with its reasons, and the animals a
 * person has marked. A marked animal is listed once, under the marks, with any reasons beside it.
 */
export async function cullingList(q: z.infer<typeof cullingQuery>) {
  if (q.herdId) await getHerdOrThrow(q.herdId);
  const farmId = ctx().farmId;
  // The whole flock is scored whatever the herd filter says: "the lowest tenth" is of the flock.
  const flock = await flockScores();
  const cutoff = lowScoreCutoff(flock.map((ewe) => ewe.score));
  const outcomes = await breedingOutcomes(flock.map((ewe) => ewe.eweId));

  const reasonsOf = new Map<string, ComputedCullReason[]>();
  for (const ewe of flock) {
    reasonsOf.set(
      ewe.eweId,
      cullReasons({
        ageYears: ewe.ageYears,
        emptySeasons: emptySeasonsRunning(outcomes.get(ewe.eweId) ?? []),
        rearedByLambing: ewe.facts.rearedByLambing,
        score: ewe.score,
        lowScoreCutoff: cutoff,
        conditionScores: ewe.conditionScores.map((entry) => entry.score),
        complicatedLambings: ewe.facts.complicatedLambings,
      }),
    );
  }

  const marks = await tx()
    .select({
      id: m.id,
      animalId: m.animalId,
      tag: animals.tag,
      category: animals.category,
      herdId: animals.herdId,
      herdName: herds.name,
      reason: m.reason,
      note: m.note,
      markedOn: m.markedOn,
    })
    .from(m)
    .innerJoin(animals, eq(animals.id, m.animalId))
    .leftJoin(herds, eq(herds.id, animals.herdId))
    // A mark on an animal that has since left the farm has done its work: it is history, not a task.
    .where(and(eq(m.farmId, farmId), eq(animals.farmId, farmId), isNull(m.clearedOn), onFarm(), q.herdId ? eq(animals.herdId, q.herdId) : undefined))
    .orderBy(asc(animals.tag));
  const markedIds = new Set(marks.map((mark) => mark.animalId));
  const scoreOf = new Map(flock.map((ewe) => [ewe.eweId, ewe]));

  const suggested = flock
    .filter((ewe) => !markedIds.has(ewe.eweId) && (!q.herdId || ewe.herdId === q.herdId) && reasonsOf.get(ewe.eweId)!.length > 0)
    .map((ewe) => ({
      animalId: ewe.eweId,
      tag: ewe.tag,
      herdId: ewe.herdId,
      herdName: ewe.herdName,
      ageYears: ewe.ageYears,
      lambings: ewe.facts.lambings,
      score: ewe.score,
      bodyCondition: ewe.conditionScores[0]?.score ?? null,
      reasons: reasonsOf.get(ewe.eweId)!,
    }))
    // Most reasons first, then the lowest score, then by tag.
    .sort((x, y) => y.reasons.length - x.reasons.length || (x.score ?? Infinity) - (y.score ?? Infinity) || x.tag.localeCompare(y.tag));

  return {
    suggested,
    marked: marks.map((mark) => ({
      ...mark,
      ageYears: scoreOf.get(mark.animalId)?.ageYears ?? null,
      score: scoreOf.get(mark.animalId)?.score ?? null,
      suggestedReasons: reasonsOf.get(mark.animalId) ?? [],
    })),
    /** How many ewes were looked at, and the line under which a score counts as low (null: no line). */
    flock: { ewes: flock.length, scored: flock.filter((ewe) => ewe.score !== null).length, lowScoreCutoff: cutoff },
    /** The starting values behind the reasons, so the screen can say them in words. */
    thresholds: { ...CULLING, thinAtOrBelow: BODY_CONDITION_RULES.thinAtOrBelow },
  };
}
