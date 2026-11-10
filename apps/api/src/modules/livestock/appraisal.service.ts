/**
 * What a person finds when handling an animal: body condition score, fat-tail measurements and
 * grading (bonitirovka). No money here, and no opinion either: these are records of what was seen.
 *
 * Body condition is scored 1 to 5 in half steps (Russel, Doney and Gunn 1969, J. Agric. Sci.
 * 72:451-454; see formulas/body-condition.ts). A fat-tailed breed carries much of its fat in the
 * tail, so no target score is stated anywhere.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { round } from '@yap/shared';
import { BODY_CONDITION_RULES, herdCondition, isBodyConditionScore, isThin } from '@yap/shared/formulas/body-condition';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate } from '../../core/query';
import { openCullMarks } from './cull-marks.service';
import { assertNotFuture, assertOnFarm, getAnimalOrThrow, getHerdOrThrow, onFarm } from './refs';

const { animals, animalGradings: g, bodyConditionScores: s, fatTailMeasurements: ft, herds, species } = schema;

const note = z.string().trim().max(500).nullish();
const score = z.number().refine(isBodyConditionScore, { message: 'A body condition score runs from 1 to 5 in half steps' });

function stamp() {
  const c = ctx();
  return { tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId };
}

/** The animal a record is about: on this farm, still here, and not dated before it was born or ahead of today. */
async function animalFor(animalId: string, date: string) {
  assertNotFuture(date);
  const animal = await getAnimalOrThrow(animalId);
  assertOnFarm(animal);
  return animal;
}

// ─── Body condition ─────────────────────────────────────────────────────────

export const conditionInput = z.object({ id: clientId, animalId: z.uuid(), date: isoDate.optional(), score, notes: note });

/** A scoring day: one score per animal, found by tag or by id. */
export const bulkConditionInput = z.object({
  /** When set, only animals of this herd are accepted: a tag from another herd is a slip. */
  herdId: z.uuid().nullish(),
  date: isoDate.optional(),
  entries: z
    .array(
      z
        .object({ animalId: z.uuid().optional(), tag: z.string().trim().min(1).max(60).optional(), score, notes: note })
        .refine((v) => !!v.animalId !== !!v.tag, { message: 'Give the animal by id or by tag', path: ['tag'] }),
    )
    .min(1)
    .max(2000),
});

export const herdConditionQuery = z.object({ herdId: z.uuid().optional() });

/** One score a day per animal: scoring her again the same day corrects the first entry. */
async function writeScore(animalId: string, i: { id?: string; date: string; score: number; notes?: string | null }) {
  const [row] = await tx()
    .insert(s)
    .values({ ...(i.id ? { id: i.id } : {}), ...stamp(), animalId, date: i.date, score: i.score, notes: i.notes || null })
    .onConflictDoUpdate({ target: [s.animalId, s.date], set: { score: i.score, notes: i.notes || null, updatedAt: new Date() } })
    .returning();
  await recordEvent({
    type: 'animal.condition_scored',
    entityType: 'animal',
    entityId: animalId,
    occurredAt: i.date,
    severity: isThin(i.score) ? 'attention' : 'info',
    data: { scoreId: row.id, score: i.score },
  });
  return row;
}

export async function recordCondition(i: z.infer<typeof conditionInput>) {
  const date = i.date ?? today();
  const animal = await animalFor(i.animalId, date);
  return writeScore(animal.id, { ...i, date });
}

type SkipReason = 'UNKNOWN_TAG' | 'NOT_IN_HERD' | 'DUPLICATE';

/** A scoring day. What cannot be recorded is listed, and the rest is saved. */
export async function bulkCondition(i: z.infer<typeof bulkConditionInput>) {
  const date = i.date ?? today();
  assertNotFuture(date);
  if (i.herdId) await getHerdOrThrow(i.herdId);

  const ids = i.entries.flatMap((e) => (e.animalId ? [e.animalId] : []));
  const tags = i.entries.flatMap((e) => (e.tag ? [e.tag.toLowerCase()] : []));
  const found = await tx()
    .select({ id: animals.id, tag: animals.tag, herdId: animals.herdId })
    .from(animals)
    .where(
      and(
        eq(animals.farmId, ctx().farmId),
        onFarm(),
        sql`(${ids.length ? inArray(animals.id, ids) : sql`false`} or ${tags.length ? inArray(sql`lower(${animals.tag})`, tags) : sql`false`})`,
      ),
    );
  const byId = new Map(found.map((a) => [a.id, a]));
  const byTag = new Map(found.map((a) => [a.tag.toLowerCase(), a]));

  const skipped: { tag: string | null; animalId: string | null; reason: SkipReason }[] = [];
  const seen = new Set<string>();
  let recorded = 0;
  for (const entry of i.entries) {
    const animal = entry.animalId ? byId.get(entry.animalId) : byTag.get(entry.tag!.toLowerCase());
    const skip = (reason: SkipReason) => skipped.push({ tag: animal?.tag ?? entry.tag ?? null, animalId: animal?.id ?? entry.animalId ?? null, reason });
    if (!animal) {
      skip('UNKNOWN_TAG');
      continue;
    }
    if (i.herdId && animal.herdId !== i.herdId) {
      skip('NOT_IN_HERD');
      continue;
    }
    if (seen.has(animal.id)) {
      skip('DUPLICATE');
      continue;
    }
    seen.add(animal.id);
    await writeScore(animal.id, { date, score: entry.score, notes: entry.notes });
    recorded += 1;
  }
  return { date, recorded, skipped };
}

export async function deleteCondition(id: string) {
  const [row] = await tx()
    .delete(s)
    .where(and(eq(s.id, id), eq(s.farmId, ctx().farmId)))
    .returning();
  if (!row) throw notFound('Body condition score');
  await recordEvent({ type: 'animal.condition_score_deleted', entityType: 'animal', entityId: row.animalId, data: { scoreId: id, date: row.date, score: row.score } });
  return { id };
}

export interface ConditionEntry {
  score: number;
  date: string;
}

/** Each animal's body condition scores, newest first. */
export async function conditionHistory(animalIds: string[]): Promise<Map<string, ConditionEntry[]>> {
  const rows = animalIds.length
    ? await tx()
        .select({ animalId: s.animalId, score: s.score, date: s.date })
        .from(s)
        .where(and(eq(s.farmId, ctx().farmId), inArray(s.animalId, animalIds)))
        .orderBy(desc(s.date))
    : [];
  const history = new Map<string, ConditionEntry[]>();
  for (const row of rows) {
    const list = history.get(row.animalId);
    if (list) list.push({ score: row.score, date: row.date });
    else history.set(row.animalId, [{ score: row.score, date: row.date }]);
  }
  return history;
}

/**
 * The work list of a scoring day: the animals of a herd with their latest score, and the herd's
 * average over scores no older than BODY_CONDITION_RULES.recentDays (null when there is none).
 */
export async function herdConditionList(q: z.infer<typeof herdConditionQuery>) {
  if (q.herdId) await getHerdOrThrow(q.herdId);
  const rows = await tx()
    .select({ animalId: animals.id, tag: animals.tag, category: animals.category, speciesKey: species.key, herdId: animals.herdId, herdName: herds.name })
    .from(animals)
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .leftJoin(species, eq(species.id, animals.speciesId))
    .where(and(eq(animals.farmId, ctx().farmId), onFarm(), q.herdId ? eq(animals.herdId, q.herdId) : undefined))
    .orderBy(asc(animals.tag));
  const history = await conditionHistory(rows.map((row) => row.animalId));
  const list = rows.map((row) => {
    const latest = history.get(row.animalId)?.[0] ?? null;
    return { ...row, score: latest?.score ?? null, scoredOn: latest?.date ?? null };
  });
  const condition = herdCondition(
    list.flatMap((row) => (row.score !== null && row.scoredOn ? [{ score: row.score, date: row.scoredOn }] : [])),
    today(),
  );
  return {
    summary: {
      head: list.length,
      scored: condition.scored,
      average: condition.average === null ? null : round(condition.average, 2),
      thin: condition.thin,
      thinPercent: condition.thinShare === null ? null : round(condition.thinShare * 100, 1),
      recentDays: BODY_CONDITION_RULES.recentDays,
      thinAtOrBelow: BODY_CONDITION_RULES.thinAtOrBelow,
    },
    animals: list,
  };
}

/** Body condition of every herd with on-farm animals, for the alert rule. */
export async function herdConditions() {
  const farmId = ctx().farmId;
  const rows = await tx()
    .select({ animalId: animals.id, herdId: animals.herdId, herdName: herds.name })
    .from(animals)
    .innerJoin(herds, eq(herds.id, animals.herdId))
    .where(and(eq(animals.farmId, farmId), eq(herds.farmId, farmId), onFarm()));
  const history = await conditionHistory(rows.map((row) => row.animalId));
  const byHerd = new Map<string, { herdId: string; herdName: string; latest: ConditionEntry[] }>();
  for (const row of rows) {
    const herd = byHerd.get(row.herdId!) ?? { herdId: row.herdId!, herdName: row.herdName, latest: [] };
    const latest = history.get(row.animalId)?.[0];
    if (latest) herd.latest.push(latest);
    byHerd.set(row.herdId!, herd);
  }
  const now = today();
  return [...byHerd.values()].map((herd) => ({ herdId: herd.herdId, herdName: herd.herdName, ...herdCondition(herd.latest, now) }));
}

// ─── Fat tail ───────────────────────────────────────────────────────────────

const cm = (max: number) => z.number().positive().max(max).nullish();

export const fatTailInput = z
  .object({ id: clientId, animalId: z.uuid(), date: isoDate.optional(), widthCm: cm(100), lengthCm: cm(100), circumferenceCm: cm(200), notes: note })
  .refine((v) => v.widthCm != null || v.lengthCm != null || v.circumferenceCm != null, {
    message: 'Give at least one measurement',
    path: ['widthCm'],
  });

export async function recordFatTail(i: z.infer<typeof fatTailInput>) {
  const date = i.date ?? today();
  const animal = await animalFor(i.animalId, date);
  const [row] = await tx()
    .insert(ft)
    .values({
      ...(i.id ? { id: i.id } : {}),
      ...stamp(),
      animalId: animal.id,
      date,
      widthCm: i.widthCm ?? null,
      lengthCm: i.lengthCm ?? null,
      circumferenceCm: i.circumferenceCm ?? null,
      notes: i.notes || null,
    })
    .returning();
  await recordEvent({
    type: 'animal.fat_tail_measured',
    entityType: 'animal',
    entityId: animal.id,
    occurredAt: date,
    data: { measurementId: row.id, widthCm: row.widthCm, lengthCm: row.lengthCm, circumferenceCm: row.circumferenceCm },
  });
  return row;
}

export async function deleteFatTail(id: string) {
  const [row] = await tx()
    .delete(ft)
    .where(and(eq(ft.id, id), eq(ft.farmId, ctx().farmId)))
    .returning();
  if (!row) throw notFound('Fat-tail measurement');
  await recordEvent({ type: 'animal.fat_tail_measurement_deleted', entityType: 'animal', entityId: row.animalId, data: { measurementId: id, date: row.date } });
  return { id };
}

// ─── Grading ────────────────────────────────────────────────────────────────

export const gradingInput = z.object({
  id: clientId,
  animalId: z.uuid(),
  date: isoDate.optional(),
  classKey: z.string().trim().min(1).max(40),
  /** Who graded: often a visiting specialist, so a name, not an employee. Personal data. */
  gradedBy: z.string().trim().max(120).nullish(),
  notes: note,
});

/** The classes this farm grades into, best first: its own list from settings, not an official standard. */
export function gradingClasses(): string[] {
  return ctx().settings.livestock.gradingClasses;
}

export async function recordGrading(i: z.infer<typeof gradingInput>) {
  const date = i.date ?? today();
  const classes = gradingClasses();
  if (!classes.includes(i.classKey)) {
    throw badRequest('UNKNOWN_GRADING_CLASS', 'This class is not on the farm\'s grading list', { classKey: i.classKey, classes });
  }
  const animal = await animalFor(i.animalId, date);
  const [row] = await tx()
    .insert(g)
    .values({ ...(i.id ? { id: i.id } : {}), ...stamp(), animalId: animal.id, date, classKey: i.classKey, gradedBy: i.gradedBy || null, notes: i.notes || null })
    .returning();
  // The grader's name stays out of the journal: it is personal data, and the journal is read widely.
  await recordEvent({ type: 'animal.graded', entityType: 'animal', entityId: animal.id, occurredAt: date, data: { gradingId: row.id, classKey: row.classKey } });
  return hasPermission('pii.view') ? row : { ...row, gradedBy: null };
}

export async function deleteGrading(id: string) {
  const [row] = await tx()
    .delete(g)
    .where(and(eq(g.id, id), eq(g.farmId, ctx().farmId)))
    .returning();
  if (!row) throw notFound('Grading');
  await recordEvent({ type: 'animal.grading_deleted', entityType: 'animal', entityId: row.animalId, data: { gradingId: id, date: row.date, classKey: row.classKey } });
  return { id };
}

/** Each animal's latest grading. */
export async function latestGradings(animalIds: string[]): Promise<Map<string, { classKey: string; date: string }>> {
  const rows = animalIds.length
    ? await tx()
        .selectDistinctOn([g.animalId], { animalId: g.animalId, classKey: g.classKey, date: g.date })
        .from(g)
        .where(and(eq(g.farmId, ctx().farmId), inArray(g.animalId, animalIds)))
        .orderBy(g.animalId, desc(g.date), desc(g.createdAt))
    : [];
  return new Map(rows.map((row) => [row.animalId, { classKey: row.classKey, date: row.date }]));
}

// ─── The animal card ────────────────────────────────────────────────────────

const HISTORY = 20;

/** Everything of this kind on one animal's card: histories, the latest of each, and an open cull mark. */
export async function animalAppraisal(animalId: string) {
  const animal = await getAnimalOrThrow(animalId);
  const farmId = ctx().farmId;
  const conditionScores = await tx()
    .select({ id: s.id, date: s.date, score: s.score, notes: s.notes })
    .from(s)
    .where(and(eq(s.animalId, animal.id), eq(s.farmId, farmId)))
    .orderBy(desc(s.date))
    .limit(HISTORY);
  const fatTail = await tx()
    .select({ id: ft.id, date: ft.date, widthCm: ft.widthCm, lengthCm: ft.lengthCm, circumferenceCm: ft.circumferenceCm, notes: ft.notes })
    .from(ft)
    .where(and(eq(ft.animalId, animal.id), eq(ft.farmId, farmId)))
    .orderBy(desc(ft.date), desc(ft.createdAt))
    .limit(HISTORY);
  const graded = await tx()
    .select({ id: g.id, date: g.date, classKey: g.classKey, gradedBy: g.gradedBy, notes: g.notes })
    .from(g)
    .where(and(eq(g.animalId, animal.id), eq(g.farmId, farmId)))
    .orderBy(desc(g.date), desc(g.createdAt))
    .limit(HISTORY);
  // A visiting specialist's name is personal data (rule 8).
  const gradings = hasPermission('pii.view') ? graded : graded.map((row) => ({ ...row, gradedBy: null }));
  const marks = await openCullMarks([animal.id]);
  return {
    animalId: animal.id,
    bodyCondition: conditionScores[0] ?? null,
    gradingClass: gradings[0]?.classKey ?? null,
    gradedOn: gradings[0]?.date ?? null,
    conditionScores,
    fatTail,
    gradings,
    gradingClasses: gradingClasses(),
    cullMark: marks.get(animal.id) ?? null,
  };
}
