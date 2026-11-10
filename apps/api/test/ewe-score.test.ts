import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays, todayIso } from '@yap/shared';
import { BODY_CONDITION_RULES } from '@yap/shared/formulas/body-condition';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { evaluateRules } from '../src/modules/alerts/rules';
import { createPregnancy } from '../src/modules/livestock/breeding.service';
import { openCullMarks } from '../src/modules/livestock/cull-marks.service';
import { createFixture, type Fixture } from './helpers';

const { alerts, animals, bodyConditionScores, breeds, events, herds, lambCare, lambingRecords, species, weightRecords } = schema;

const T = todayIso();
const daysAgo = (n: number) => addDays(T, -n);
/** The same day of the year, `n` years back. */
const yearsAgo = (n: number) => `${Number(T.slice(0, 4)) - n}${T.slice(4) === '-02-29' ? '-02-28' : T.slice(4)}`;
let tagCounter = 0;

async function makeEwe(f: Fixture, o: { tag?: string; herdId?: string | null; birthDate?: string | null; sex?: string; status?: string } = {}) {
  return f.run(async () => {
    const [kind] = await tx().select().from(species).where(and(eq(species.tenantId, f.tenantId), eq(species.key, 'sheep')));
    const [breed] = await tx().select().from(breeds).where(and(eq(breeds.tenantId, f.tenantId), eq(breeds.key, 'hisori')));
    const [row] = await tx()
      .insert(animals)
      .values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        tag: o.tag ?? `ES${++tagCounter}`,
        speciesId: kind.id,
        breedId: breed.id,
        sex: o.sex ?? 'female',
        category: o.sex === 'male' ? 'ram' : 'ewe',
        origin: 'purchased',
        herdId: o.herdId ?? null,
        birthDate: o.birthDate ?? null,
        status: o.status ?? 'active',
      })
      .returning();
    return row;
  });
}

const makeHerd = (f: Fixture, name: string) =>
  f.run(async () => (await tx().insert(herds).values({ tenantId: f.tenantId, farmId: f.farmId, name }).returning())[0]);

const eventsOf = (f: Fixture, entityId: string) =>
  f.run(async () => (await tx().select({ type: events.type }).from(events).where(eq(events.entityId, entityId))).map((e) => e.type));

const alertsOf = (f: Fixture, ruleKey: string) =>
  f.run(() =>
    tx()
      .select()
      .from(alerts)
      .where(and(eq(alerts.farmId, f.farmId), eq(alerts.ruleKey, ruleKey), sql`status <> 'resolved'`)),
  );

/** A lambing through the API, as the shepherd records it. Returns the ids of the lambs born alive. */
async function lambing(f: Fixture, eweId: string, date: string, lambs: { alive?: boolean; birthWeightKg?: number }[], complications?: string) {
  const shepherd = await f.as('shepherd');
  const res = await shepherd.post('/livestock/lambings', {
    eweId,
    date,
    lambs: lambs.map((l) => ({ sex: 'female', alive: l.alive ?? true, birthWeightKg: l.birthWeightKg })),
    complications,
  });
  expect(res.status).toBe(201);
  return (res.data.lambs as { animalId: string | null }[]).flatMap((l) => (l.animalId ? [l.animalId] : []));
}

const weigh = (f: Fixture, animalId: string, date: string, weightKg: number) =>
  f.run(() => tx().insert(weightRecords).values({ tenantId: f.tenantId, farmId: f.farmId, animalId, date, weightKg }));

describe('body condition score', () => {
  it('records one score a day per animal, refuses a score off the scale or a day not yet come, and keeps other roles and tenants out', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    const ewe = await makeEwe(f, { tag: 'BC-1' });

    const first = await shepherd.post('/livestock/condition-scores', { animalId: ewe.id, score: 2.5 });
    expect(first.status).toBe(201);
    expect(first.data).toMatchObject({ animalId: ewe.id, date: T, score: 2.5 });
    expect(await eventsOf(f, ewe.id)).toContain('animal.condition_scored');

    // The same day again corrects the entry: still one row.
    const again = await shepherd.post('/livestock/condition-scores', { animalId: ewe.id, score: 3, notes: 'second look' });
    expect(again.status).toBe(201);
    expect(again.data.id).toBe(first.data.id);
    const rows = await f.run(() => tx().select().from(bodyConditionScores).where(eq(bodyConditionScores.animalId, ewe.id)));
    expect(rows.map((row) => row.score)).toEqual([3]);

    // Off the scale: below 1, above 5, not a half step.
    for (const score of [0.5, 5.5, 2.3, 0]) {
      expect((await shepherd.post('/livestock/condition-scores', { animalId: ewe.id, score })).status).toBe(400);
    }
    const future = await shepherd.post('/livestock/condition-scores', { animalId: ewe.id, score: 3, date: addDays(T, 1) });
    expect(future.status).toBe(400);
    expect(future.body.error.code).toBe('FUTURE_DATE');

    // An animal that has left the farm is not scored.
    const sold = await makeEwe(f, { status: 'sold' });
    const gone = await shepherd.post('/livestock/condition-scores', { animalId: sold.id, score: 3 });
    expect(gone.status).toBe(409);
    expect(gone.body.error.code).toBe('ANIMAL_NOT_ON_FARM');

    // The card shows the latest score and the history.
    const older = await shepherd.post('/livestock/condition-scores', { animalId: ewe.id, score: 2, date: daysAgo(40) });
    expect(older.status).toBe(201);
    const card = (await shepherd.get(`/livestock/animals/${ewe.id}/appraisal`)).data;
    expect(card.bodyCondition).toMatchObject({ score: 3, date: T });
    expect(card.conditionScores.map((row: any) => row.score)).toEqual([3, 2]);
    expect(card.cullMark).toBeNull();

    // Roles: an agronomist has no livestock access at all; an auditor reads and cannot write.
    const agronomist = await f.as('agronomist');
    expect((await agronomist.get(`/livestock/animals/${ewe.id}/appraisal`)).status).toBe(403);
    expect((await agronomist.post('/livestock/condition-scores', { animalId: ewe.id, score: 3 })).status).toBe(403);
    expect((await agronomist.get('/livestock/condition-scores/herd')).status).toBe(403);
    const auditor = await f.as('auditor');
    expect((await auditor.get(`/livestock/animals/${ewe.id}/appraisal`)).status).toBe(200);
    expect((await auditor.post('/livestock/condition-scores', { animalId: ewe.id, score: 3 })).status).toBe(403);
    // A shepherd records but does not delete.
    expect((await shepherd.delete(`/livestock/condition-scores/${first.data.id}`)).status).toBe(403);

    // Another tenant can neither read nor score this animal, by id or by tag.
    const g = await createFixture();
    const stranger = await g.as('zootechnician');
    expect((await stranger.get(`/livestock/animals/${ewe.id}/appraisal`)).status).toBe(404);
    expect((await stranger.post('/livestock/condition-scores', { animalId: ewe.id, score: 3 })).status).toBe(404);
    const bulk = await stranger.post('/livestock/condition-scores/bulk', { entries: [{ tag: 'BC-1', score: 3 }, { animalId: ewe.id, score: 3 }] });
    expect(bulk.status).toBe(201);
    expect(bulk.data.recorded).toBe(0);
    expect(bulk.data.skipped.map((s: any) => s.reason)).toEqual(['UNKNOWN_TAG', 'UNKNOWN_TAG']);
    expect((await stranger.delete(`/livestock/condition-scores/${first.data.id}`)).status).toBe(404);
    expect(await f.run(() => tx().select().from(bodyConditionScores).where(eq(bodyConditionScores.animalId, ewe.id)))).toHaveLength(2);
  });

  it('scores a herd in one go, averages the recent scores and raises the thin-herd alert', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    const herd = await makeHerd(f, 'Sovliqlar');
    const other = await makeHerd(f, 'Boshqa');
    const ewes = [];
    for (let i = 1; i <= 12; i++) ewes.push(await makeEwe(f, { tag: `H-${String(i).padStart(2, '0')}`, herdId: herd.id }));
    const outsider = await makeEwe(f, { tag: 'OUT-1', herdId: other.id });

    // Ten scored: three at 2 (thin), seven at 3. Two are left unscored.
    const res = await shepherd.post('/livestock/condition-scores/bulk', {
      herdId: herd.id,
      entries: [
        ...ewes.slice(0, 3).map((e) => ({ tag: e.tag.toLowerCase(), score: 2 })),
        ...ewes.slice(3, 10).map((e) => ({ animalId: e.id, score: 3 })),
        { tag: 'NO-SUCH', score: 3 },
        { tag: 'H-01', score: 4 },
        { tag: outsider.tag, score: 3 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.data.recorded).toBe(10);
    expect(res.data.skipped).toEqual([
      { tag: 'NO-SUCH', animalId: null, reason: 'UNKNOWN_TAG' },
      { tag: 'H-01', animalId: ewes[0].id, reason: 'DUPLICATE' },
      { tag: 'OUT-1', animalId: outsider.id, reason: 'NOT_IN_HERD' },
    ]);

    // (3 x 2 + 7 x 3) / 10 = 2.7; three thin of ten = 30 %.
    const list = (await shepherd.get('/livestock/condition-scores/herd', { herdId: herd.id })).data;
    expect(list.summary).toMatchObject({ head: 12, scored: 10, average: 2.7, thin: 3, thinPercent: 30, recentDays: BODY_CONDITION_RULES.recentDays });
    expect(list.animals).toHaveLength(12);
    expect(list.animals[0]).toMatchObject({ tag: 'H-01', score: 2, scoredOn: T });
    expect(list.animals[11]).toMatchObject({ tag: 'H-12', score: null, scoredOn: null });

    // 30 % of ten scored animals is over the starting line of 25 % of at least ten.
    await f.run(() => evaluateRules());
    const raised = await alertsOf(f, 'herd_thin');
    expect(raised).toHaveLength(1);
    expect(raised[0].dedupKey).toBe(`herd_thin:${herd.id}`);

    // Two of the thin ones are scored again the same day, now at 3: one thin of ten, and the alert clears.
    await shepherd.post('/livestock/condition-scores/bulk', { herdId: herd.id, entries: ewes.slice(0, 2).map((e) => ({ animalId: e.id, score: 3 })) });
    const after = (await shepherd.get('/livestock/condition-scores/herd', { herdId: herd.id })).data;
    expect(after.summary).toMatchObject({ scored: 10, average: 2.9, thin: 1, thinPercent: 10 });
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'herd_thin')).toHaveLength(0);

    // A score older than the window says nothing about today: the average is missing, not zero.
    await shepherd.post('/livestock/condition-scores', { animalId: outsider.id, score: 1.5, date: daysAgo(BODY_CONDITION_RULES.recentDays + 1) });
    const stale = (await shepherd.get('/livestock/condition-scores/herd', { herdId: other.id })).data;
    expect(stale.summary).toMatchObject({ head: 1, scored: 0, average: null, thin: 0, thinPercent: null });
    expect(stale.animals[0]).toMatchObject({ score: 1.5 });
  });
});

describe('fat-tail measurements and grading', () => {
  it('records fat-tail measurements with at least one figure', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    const ewe = await makeEwe(f);

    expect((await shepherd.post('/livestock/fat-tail', { animalId: ewe.id })).status).toBe(400);
    expect((await shepherd.post('/livestock/fat-tail', { animalId: ewe.id, widthCm: -3 })).status).toBe(400);
    const future = await shepherd.post('/livestock/fat-tail', { animalId: ewe.id, widthCm: 24, date: addDays(T, 2) });
    expect(future.body.error.code).toBe('FUTURE_DATE');

    const res = await shepherd.post('/livestock/fat-tail', { animalId: ewe.id, widthCm: 24.5, date: daysAgo(3) });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ widthCm: 24.5, lengthCm: null, circumferenceCm: null, date: daysAgo(3) });
    await shepherd.post('/livestock/fat-tail', { animalId: ewe.id, widthCm: 25, lengthCm: 21, circumferenceCm: 68 });
    expect(await eventsOf(f, ewe.id)).toContain('animal.fat_tail_measured');

    const card = (await shepherd.get(`/livestock/animals/${ewe.id}/appraisal`)).data;
    expect(card.fatTail.map((row: any) => [row.date, row.widthCm, row.lengthCm, row.circumferenceCm])).toEqual([
      [T, 25, 21, 68],
      [daysAgo(3), 24.5, null, null],
    ]);

    expect((await (await f.as('agronomist')).post('/livestock/fat-tail', { animalId: ewe.id, widthCm: 20 })).status).toBe(403);
    const g = await createFixture();
    expect((await (await g.as('zootechnician')).post('/livestock/fat-tail', { animalId: ewe.id, widthCm: 20 })).status).toBe(404);
  });

  it('grades into the farm\'s own classes and hides the grader\'s name without pii.view', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    const ewe = await makeEwe(f, { tag: 'GR-1' });
    const plain = await makeEwe(f, { tag: 'GR-2' });

    expect((await zoo.get('/livestock/gradings/classes')).data.classes).toEqual(['elite', 'class_1', 'class_2', 'unclassed']);
    const unknown = await zoo.post('/livestock/gradings', { animalId: ewe.id, classKey: 'super' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('UNKNOWN_GRADING_CLASS');
    // A shepherd records what a hand finds; the class is the zootechnician's call.
    expect((await (await f.as('shepherd')).post('/livestock/gradings', { animalId: ewe.id, classKey: 'elite' })).status).toBe(403);

    await zoo.post('/livestock/gradings', { animalId: ewe.id, classKey: 'class_1', date: daysAgo(200) });
    const res = await zoo.post('/livestock/gradings', { animalId: ewe.id, classKey: 'elite', gradedBy: 'Karimov A.' });
    expect(res.status).toBe(201);
    // The zootechnician holds no pii.view: the name is stored and not shown.
    expect(res.data).toMatchObject({ classKey: 'elite', gradedBy: null });
    expect(await eventsOf(f, ewe.id)).toContain('animal.graded');
    const seenByZoo = (await zoo.get(`/livestock/animals/${ewe.id}/appraisal`)).data;
    expect(seenByZoo).toMatchObject({ gradingClass: 'elite', gradedOn: T });
    expect(seenByZoo.gradings.map((row: any) => [row.classKey, row.gradedBy])).toEqual([['elite', null], ['class_1', null]]);
    const seenByOwner = (await (await f.as('owner')).get(`/livestock/animals/${ewe.id}/appraisal`)).data;
    expect(seenByOwner.gradings[0].gradedBy).toBe('Karimov A.');
    // Nor does the name leak into the journal.
    const journal = await f.run(() => tx().select({ data: events.data }).from(events).where(eq(events.entityId, ewe.id)));
    expect(JSON.stringify(journal)).not.toContain('Karimov');

    // The ewe list shows the class and filters by it.
    const elite = (await zoo.get('/livestock/ewes/scores', { gradingClass: 'elite' })).data;
    expect(elite.map((row: any) => [row.tag, row.gradingClass])).toEqual([['GR-1', 'elite']]);
    const ungraded = (await zoo.get('/livestock/ewes/scores', { gradingClass: 'none' })).data;
    expect(ungraded.map((row: any) => row.tag)).toEqual([plain.tag]);

    // A farm with its own list grades into that list, not the default one.
    const own = await createFixture({ settings: { livestock: { gradingClasses: ['a_plus', 'b'] } } });
    const ownZoo = await own.as('zootechnician');
    const theirs = await makeEwe(own);
    expect((await ownZoo.get('/livestock/gradings/classes')).data.classes).toEqual(['a_plus', 'b']);
    expect((await ownZoo.post('/livestock/gradings', { animalId: theirs.id, classKey: 'elite' })).status).toBe(400);
    expect((await ownZoo.post('/livestock/gradings', { animalId: theirs.id, classKey: 'a_plus' })).status).toBe(201);
    // And cannot grade another tenant's animal.
    expect((await ownZoo.post('/livestock/gradings', { animalId: ewe.id, classKey: 'a_plus' })).status).toBe(404);
  });
});

describe('ewe score', () => {
  it('matches the hand-worked score, sorts and pages on the server', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    const shepherd = await f.as('shepherd');

    // E1: five years old, twins 500 days ago and a single 135 days ago (365 days apart).
    const e1 = await makeEwe(f, { tag: 'S-1', birthDate: yearsAgo(5) });
    const [twinA, twinB] = await lambing(f, e1.id, daysAgo(500), [{}, {}]);
    const [single] = await lambing(f, e1.id, daysAgo(135), [{ birthWeightKg: 4 }]);
    // One twin died at ten days; the other went on the bottle: born to her, weaned, not reared by her.
    await f.run(() => tx().update(animals).set({ status: 'dead', exitDate: daysAgo(490) }).where(eq(animals.id, twinA)));
    await f.run(() => tx().insert(lambCare).values({ tenantId: f.tenantId, farmId: f.farmId, lambId: twinB, mothering: 'bottle' }));
    // Her single weighed 34 kg at exactly 100 days.
    await weigh(f, single, daysAgo(35), 34);
    expect((await shepherd.post('/livestock/condition-scores', { animalId: e1.id, score: 2.5 })).status).toBe(201);

    // E2: age unknown, one single 135 days ago that weighed 26 kg at 100 days. Never scored for condition.
    const e2 = await makeEwe(f, { tag: 'S-2' });
    const [lamb2] = await lambing(f, e2.id, daysAgo(135), [{ birthWeightKg: 4 }]);
    await weigh(f, lamb2, daysAgo(35), 26);

    // E3: a ewe with no lambing on record has no score.
    await makeEwe(f, { tag: 'S-3', birthDate: yearsAgo(2) });

    // Farm average 100-day weight: (34 + 26) / 2 = 30 kg.
    //
    // E1  prolificacy       3 born / 2 lambings = 1.5 -> 75 points      x 0.25 = 18.75
    //     rearing           1 reared / 3 due = 0.3333 -> 33.333         x 0.25 =  8.3333
    //     lamb_growth       34 / 30 = index 113.33 -> 33.33 / 40 = 83.333  x 0.20 = 16.6667
    //     lambing_interval  365 days -> 100                            x 0.10 = 10
    //     age               5 years -> 100                             x 0.10 = 10
    //     condition         2.5 -> 75                                  x 0.10 =  7.5
    //                                                                   total = 71.25
    // E2  prolificacy 1 / 1 -> 50 (weight 25), rearing 1 / 1 -> 100 (25), lamb_growth 26 / 30 = 86.667 ->
    //     6.667 / 40 = 16.667 (20); the other three are missing, so the weights add up to 70:
    //     (50 x 25 + 100 x 25 + 16.667 x 20) / 70 = 4083.33 / 70 = 58.33
    const res = await zoo.get('/livestock/ewes/scores');
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, total: 3 });
    expect(res.data.map((row: any) => row.tag)).toEqual(['S-1', 'S-2', 'S-3']);
    const [r1, r2, r3] = res.data;

    expect(Math.abs(r1.score - 71.25)).toBeLessThanOrEqual(0.05);
    expect(r1.missing).toEqual([]);
    const points = Object.fromEntries(r1.parts.map((p: any) => [p.key, p.points]));
    expect(points).toEqual({ prolificacy: 75, rearing: 33.3, lamb_growth: 83.3, lambing_interval: 100, age: 100, condition: 75 });
    expect(r1.parts.map((p: any) => p.weight)).toEqual([0.25, 0.25, 0.2, 0.1, 0.1, 0.1]);
    // The figures beside the score are the same ones the per-ewe table always showed.
    expect(r1).toMatchObject({ lambings: 2, lambsBorn: 3, lambsAlive: 3, survivalPercent: 66.7, avgWeight100Kg: 34, ageYears: 5, bodyCondition: 2.5, bodyConditionDate: T, cullMarked: false });
    const old = (await zoo.get('/livestock/breeding/ewes', { search: 'S-1' })).data[0];
    expect(old).toMatchObject({ lambings: 2, lambsBorn: 3, survivalPercent: 66.7, avgWeight100Kg: 34 });

    expect(r2.score).toBe(58.3);
    expect(r2.missing).toEqual(['lambing_interval', 'age', 'condition']);
    expect(r2.parts.map((p: any) => [p.key, p.points])).toEqual([['prolificacy', 50], ['rearing', 100], ['lamb_growth', 16.7]]);
    expect(r3).toMatchObject({ score: null, parts: [], lambings: 0, bodyCondition: null, avgWeight100Kg: null, survivalPercent: null });

    // One ewe's score for her card is the same number.
    expect((await zoo.get(`/livestock/ewes/${e2.id}/score`)).data).toMatchObject({ score: 58.3, lambings: 1 });

    // Lowest first: a ewe with no score still comes last. Paging happens after sorting.
    expect((await zoo.get('/livestock/ewes/scores', { sort: 'score' })).data.map((row: any) => row.tag)).toEqual(['S-2', 'S-1', 'S-3']);
    const second = await zoo.get('/livestock/ewes/scores', { pageSize: 1, page: 2 });
    expect(second.data.map((row: any) => row.tag)).toEqual(['S-2']);
    expect(second.body.meta).toMatchObject({ page: 2, pageSize: 1, total: 3 });
    expect((await zoo.get('/livestock/ewes/scores', { sort: '-tag' })).data.map((row: any) => row.tag)).toEqual(['S-3', 'S-2', 'S-1']);
    expect((await zoo.get('/livestock/ewes/scores', { search: 's-2' })).data.map((row: any) => row.tag)).toEqual(['S-2']);
    expect((await zoo.get('/livestock/ewes/scores', { sort: 'price' })).status).toBe(400);

    // No money anywhere in this feature.
    expect(JSON.stringify(res.body)).not.toMatch(/price|cost|amount/i);

    // The shepherd reads it; an agronomist does not; another tenant sees none of these ewes.
    expect((await shepherd.get('/livestock/ewes/scores')).status).toBe(200);
    expect((await (await f.as('agronomist')).get('/livestock/ewes/scores')).status).toBe(403);
    const g = await createFixture();
    const stranger = await g.as('zootechnician');
    expect((await stranger.get('/livestock/ewes/scores')).data).toEqual([]);
    expect((await stranger.get(`/livestock/ewes/${e1.id}/score`)).data).toBeNull();
  });
});

describe('culling list', () => {
  it('suggests ewes from their records, each with its own reasons', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    const shepherd = await f.as('shepherd');

    // Eight years old, over the starting line of seven.
    const old = await makeEwe(f, { tag: 'C-OLD', birthDate: yearsAgo(8) });
    // Mated and scanned empty in two seasons, 340 days apart.
    const empty = await makeEwe(f, { tag: 'C-EMPTY' });
    for (const [mated, scanned] of [[400, 350], [60, 10]] as const) {
      const record = await f.run(() => createPregnancy({ eweId: empty.id, matingDate: daysAgo(mated) }));
      const scan = await zoo.post(`/livestock/breeding/${record.id}/scans`, { fetusCount: 0, date: daysAgo(scanned) });
      expect(scan.status).toBe(201);
      expect(scan.data.closed).toBe(true);
    }
    // Empty once, then in lamb again: the run is broken.
    const carrying = await makeEwe(f, { tag: 'C-CARRY' });
    const first = await f.run(() => createPregnancy({ eweId: carrying.id, matingDate: daysAgo(400) }));
    await zoo.post(`/livestock/breeding/${first.id}/scans`, { fetusCount: 0, date: daysAgo(350) });
    await f.run(() => createPregnancy({ eweId: carrying.id, matingDate: daysAgo(60) }));
    // Two lambings, both stillborn: no lamb reared in her last two.
    const barren = await makeEwe(f, { tag: 'C-NOLAMB' });
    await lambing(f, barren.id, daysAgo(500), [{ alive: false }]);
    await lambing(f, barren.id, daysAgo(135), [{ alive: false }]);
    // Two lambings with a complication written down, lambs alive and with her.
    const hard = await makeEwe(f, { tag: 'C-HARD' });
    await lambing(f, hard.id, daysAgo(500), [{}], 'Qiyin tug\'ruq');
    await lambing(f, hard.id, daysAgo(135), [{}], 'Bachadon tushishi');
    // Thin at her last two scorings.
    const thin = await makeEwe(f, { tag: 'C-THIN' });
    await shepherd.post('/livestock/condition-scores', { animalId: thin.id, score: 2, date: daysAgo(30) });
    await shepherd.post('/livestock/condition-scores', { animalId: thin.id, score: 1.5 });
    // Thin once, then better: nothing against her. And a sound ewe with one lambing.
    const better = await makeEwe(f, { tag: 'C-BETTER' });
    await shepherd.post('/livestock/condition-scores', { animalId: better.id, score: 1.5, date: daysAgo(30) });
    await shepherd.post('/livestock/condition-scores', { animalId: better.id, score: 3 });
    const sound = await makeEwe(f, { tag: 'C-SOUND', birthDate: yearsAgo(3) });
    await lambing(f, sound.id, daysAgo(135), [{}]);

    const res = await zoo.get('/livestock/culling');
    expect(res.status).toBe(200);
    const reasons = Object.fromEntries(res.data.suggested.map((row: any) => [row.tag, row.reasons]));
    expect(reasons).toEqual({
      'C-OLD': ['old_age'],
      'C-EMPTY': ['empty_twice'],
      'C-NOLAMB': ['no_lamb_reared'],
      'C-HARD': ['lambing_complications'],
      'C-THIN': ['thin_twice'],
    });
    expect(res.data.marked).toEqual([]);
    // Eight ewes are too few for "the lowest tenth" to mean anything: no line is drawn.
    expect(res.data.flock).toMatchObject({ ewes: 8, lowScoreCutoff: null });
    expect(res.data.thresholds).toMatchObject({ oldAgeYears: 7, emptySeasons: 2, thinAtOrBelow: 2 });
    expect(JSON.stringify(res.body)).not.toMatch(/price|cost|amount/i);

    expect((await (await f.as('agronomist')).get('/livestock/culling')).status).toBe(403);
    const g = await createFixture();
    expect((await (await g.as('zootechnician')).get('/livestock/culling')).data.suggested).toEqual([]);
  });

  it('flags the lowest tenth of a flock of twenty by score', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    // Twenty ewes that lambed ten days ago: two had a single (50 points), eighteen had twins (100).
    // With nothing else on record the score is the prolificacy part alone. A tenth of twenty is
    // two ewes, so the line is the second-lowest score: 50.
    for (let i = 1; i <= 20; i++) {
      const ewe = await makeEwe(f, { tag: `L-${String(i).padStart(2, '0')}` });
      const born = i <= 2 ? 1 : 2;
      await f.run(() =>
        tx().insert(lambingRecords).values({ tenantId: f.tenantId, farmId: f.farmId, eweId: ewe.id, date: daysAgo(10), lambsBorn: born, lambsAlive: born }),
      );
    }
    const res = (await zoo.get('/livestock/culling')).data;
    expect(res.flock).toEqual({ ewes: 20, scored: 20, lowScoreCutoff: 50 });
    expect(res.suggested.map((row: any) => [row.tag, row.score, row.reasons])).toEqual([
      ['L-01', 50, ['low_score']],
      ['L-02', 50, ['low_score']],
    ]);
  });

  it('keeps one open cull mark per animal, a person\'s decision apart from the suggestions', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    const old = await makeEwe(f, { tag: 'M-OLD', birthDate: yearsAgo(9) });
    const ram = await makeEwe(f, { tag: 'M-RAM', sex: 'male' });

    // Failure paths first: a reason off the list, a day not yet come, a role that may not decide.
    expect((await zoo.post('/livestock/culling/marks', { animalId: old.id, reason: 'ugly' })).status).toBe(400);
    const future = await zoo.post('/livestock/culling/marks', { animalId: old.id, reason: 'old_age', date: addDays(T, 1) });
    expect(future.status).toBe(400);
    expect(future.body.error.code).toBe('FUTURE_DATE');
    expect((await (await f.as('shepherd')).post('/livestock/culling/marks', { animalId: old.id, reason: 'old_age' })).status).toBe(403);
    expect((await (await f.as('auditor')).post('/livestock/culling/marks', { animalId: old.id, reason: 'old_age' })).status).toBe(403);

    const mark = await zoo.post('/livestock/culling/marks', { animalId: old.id, reason: 'teeth', note: 'Old tishlari tushgan' });
    expect(mark.status).toBe(201);
    expect(mark.data).toMatchObject({ animalId: old.id, reason: 'teeth', markedOn: T, clearedOn: null });
    expect(await eventsOf(f, old.id)).toContain('animal.cull_marked');

    // A second open mark on the same animal is refused.
    const second = await zoo.post('/livestock/culling/marks', { animalId: old.id, reason: 'old_age' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CULL_MARK_EXISTS');
    // Any animal can be marked, not only a ewe.
    expect((await zoo.post('/livestock/culling/marks', { animalId: ram.id, reason: 'feet' })).status).toBe(201);

    // She moves from the suggestions to the marks, with what the records say beside the person's reason.
    const list = (await zoo.get('/livestock/culling')).data;
    expect(list.suggested).toEqual([]);
    expect(list.marked.map((row: any) => [row.tag, row.reason, row.suggestedReasons])).toEqual([
      ['M-OLD', 'teeth', ['old_age']],
      ['M-RAM', 'feet', []],
    ]);
    // Her card and the ewe list carry the badge; the function sale readiness will call finds the mark.
    expect((await zoo.get(`/livestock/animals/${old.id}/appraisal`)).data.cullMark).toMatchObject({ id: mark.data.id, reason: 'teeth', markedOn: T });
    expect((await zoo.get('/livestock/ewes/scores')).data[0]).toMatchObject({ tag: 'M-OLD', cullMarked: true });
    const open = await f.run(() => openCullMarks([old.id, ram.id, mark.data.id]));
    expect([...open.keys()].sort()).toEqual([old.id, ram.id].sort());

    // Another tenant can neither mark this animal nor clear its mark, and its function finds nothing.
    const g = await createFixture();
    const stranger = await g.as('zootechnician');
    expect((await stranger.post('/livestock/culling/marks', { animalId: old.id, reason: 'other' })).status).toBe(404);
    expect((await stranger.post(`/livestock/culling/marks/${mark.data.id}/clear`, {})).status).toBe(404);
    expect((await g.run(() => openCullMarks([old.id]))).size).toBe(0);

    // Clearing keeps the mark as history, and she is a suggestion again.
    expect((await (await f.as('shepherd')).post(`/livestock/culling/marks/${mark.data.id}/clear`, {})).status).toBe(403);
    const cleared = await zoo.post(`/livestock/culling/marks/${mark.data.id}/clear`, { note: 'Yana bir mavsum qoladi' });
    expect(cleared.status).toBe(200);
    expect(cleared.data).toMatchObject({ clearedOn: T, reason: 'teeth' });
    expect(await eventsOf(f, old.id)).toContain('animal.cull_mark_cleared');
    const again = await zoo.post(`/livestock/culling/marks/${mark.data.id}/clear`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CULL_MARK_NOT_OPEN');
    const after = (await zoo.get('/livestock/culling')).data;
    expect(after.suggested.map((row: any) => [row.tag, row.reasons])).toEqual([['M-OLD', ['old_age']]]);
    expect(after.marked.map((row: any) => row.tag)).toEqual(['M-RAM']);
    expect((await zoo.get(`/livestock/animals/${old.id}/appraisal`)).data.cullMark).toBeNull();

    // With the old mark closed, a new one may be opened.
    expect((await zoo.post('/livestock/culling/marks', { animalId: old.id, reason: 'old_age' })).status).toBe(201);
  });
});
