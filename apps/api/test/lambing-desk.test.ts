import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays, todayIso } from '@yap/shared';
import { LAMBING_DESK } from '@yap/shared/formulas/lambing';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { lambingForecast } from '../src/modules/ai/analyzers/livestock';
import { evaluateRules } from '../src/modules/alerts/rules';
import { markExited } from '../src/modules/livestock/animals.service';
import { createPregnancy } from '../src/modules/livestock/breeding.service';
import { createFixture, type Fixture } from './helpers';

const { alerts, animals, breeds, breedingRecords, events, facilities, herds, lambCare, lambingRecords, penStays, pregnancyScans, species } = schema;

const T = todayIso();
const daysAgo = (n: number) => addDays(T, -n);
let tagCounter = 0;

async function makeEwe(f: Fixture, o: { tag?: string; herdId?: string | null; sex?: string } = {}) {
  return f.run(async () => {
    const [kind] = await tx().select().from(species).where(and(eq(species.tenantId, f.tenantId), eq(species.key, 'sheep')));
    const [breed] = await tx().select().from(breeds).where(and(eq(breeds.tenantId, f.tenantId), eq(breeds.key, 'hisori')));
    const [row] = await tx()
      .insert(animals)
      .values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        tag: o.tag ?? `LD${++tagCounter}`,
        speciesId: kind.id,
        breedId: breed.id,
        sex: o.sex ?? 'female',
        category: o.sex === 'male' ? 'ram' : 'ewe',
        origin: 'purchased',
        herdId: o.herdId ?? null,
      })
      .returning();
    return row;
  });
}

const makeHerd = (f: Fixture, name: string, facilityId: string | null = null) =>
  f.run(async () => (await tx().insert(herds).values({ tenantId: f.tenantId, farmId: f.farmId, name, facilityId }).returning())[0]);

/** A pregnant ewe mated `matedDaysAgo` days ago; a sheep carries 150 days. */
async function pregnantEwe(f: Fixture, matedDaysAgo: number, o: { tag?: string; herdId?: string | null } = {}) {
  const ewe = await makeEwe(f, o);
  const record = await f.run(() => createPregnancy({ eweId: ewe.id, matingDate: daysAgo(matedDaysAgo) }));
  return { ewe, record };
}

const animalOf = (f: Fixture, id: string) => f.run(async () => (await tx().select().from(animals).where(eq(animals.id, id)))[0]);
const pregnancyOf = (f: Fixture, id: string) => f.run(async () => (await tx().select().from(breedingRecords).where(eq(breedingRecords.id, id)))[0]);
const eventsOf = (f: Fixture, entityId: string) =>
  f.run(async () => (await tx().select({ type: events.type }).from(events).where(eq(events.entityId, entityId))).map((e) => e.type));
const alertsOf = (f: Fixture, ruleKey: string) =>
  f.run(() =>
    tx()
      .select()
      .from(alerts)
      .where(and(eq(alerts.farmId, f.farmId), eq(alerts.ruleKey, ruleKey), sql`status <> 'resolved'`)),
  );

/** A barn with sections, some of them marked as lambing pens. */
async function makeBarn(f: Fixture, pens: number, plain = 1) {
  return f.run(async () => {
    const base = { tenantId: f.tenantId, farmId: f.farmId, type: 'barn' };
    const [barn] = await tx().insert(facilities).values({ ...base, name: 'Qo\'zixona' }).returning();
    const sections = await tx()
      .insert(facilities)
      .values([
        ...Array.from({ length: pens }, (_, i) => ({ ...base, name: `Katak ${i + 1}`, parentId: barn.id, lambingPen: true })),
        ...Array.from({ length: plain }, (_, i) => ({ ...base, name: `Bo'lim ${i + 1}`, parentId: barn.id })),
      ])
      .returning();
    return { barn, pens: sections.filter((s) => s.lambingPen), plain: sections.filter((s) => !s.lambingPen) };
  });
}

describe('pregnancy scanning', () => {
  it('a count of 0 closes the pregnancy as not pregnant and the ewe is open again', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    const { ewe, record } = await pregnantEwe(f, 40);
    expect((await animalOf(f, ewe.id)).status).toBe('pregnant');

    const res = await shepherd.post(`/livestock/breeding/${record.id}/scans`, { fetusCount: 0, scannedBy: 'Dr. Karimov', notes: 'bo\'sh' });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ fetusCount: 0, closed: true, date: T });
    expect(await pregnancyOf(f, record.id)).toMatchObject({ status: 'failed', fetusCount: 0, scanDate: T });
    expect((await animalOf(f, ewe.id)).status).toBe('active');
    expect(await eventsOf(f, ewe.id)).toEqual(expect.arrayContaining(['animal.scanned', 'animal.pregnancy_failed']));

    // Closed is closed: a second scan has nothing to attach to.
    const again = await shepherd.post(`/livestock/breeding/${record.id}/scans`, { fetusCount: 1 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PREGNANCY_NOT_OPEN');
    // And she can be mated again.
    const zoo = await f.as('zootechnician');
    expect((await zoo.post('/livestock/breeding', { eweId: ewe.id, matingDate: T })).status).toBe(201);
  });

  it('keeps the latest scan on the pregnancy and the whole history beside it', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    const { ewe, record } = await pregnantEwe(f, 60);

    expect((await zoo.post(`/livestock/breeding/${record.id}/scans`, { fetusCount: 1, date: daysAgo(10), scannedBy: 'Dr. Karimov' })).status).toBe(201);
    expect((await zoo.post(`/livestock/breeding/${record.id}/scans`, { fetusCount: 2, date: daysAgo(2) })).status).toBe(201);
    // An older scan entered late does not replace the newer count.
    expect((await zoo.post(`/livestock/breeding/${record.id}/scans`, { fetusCount: 3, date: daysAgo(20) })).status).toBe(201);
    expect(await pregnancyOf(f, record.id)).toMatchObject({ status: 'pregnant', fetusCount: 2, scanDate: daysAgo(2) });
    expect((await animalOf(f, ewe.id)).status).toBe('pregnant');

    const history = await zoo.get(`/livestock/breeding/${record.id}/scans`);
    expect(history.data.map((s: any) => s.fetusCount)).toEqual([2, 1, 3]);

    // An older "empty" entered late is history too: the newer scan found lambs, so she stays pregnant.
    const lateEmpty = await zoo.post(`/livestock/breeding/${record.id}/scans`, { fetusCount: 0, date: daysAgo(15) });
    expect(lateEmpty.status).toBe(201);
    expect(lateEmpty.data.closed).toBe(false);
    expect(await pregnancyOf(f, record.id)).toMatchObject({ status: 'pregnant', fetusCount: 2 });

    const early = await zoo.post(`/livestock/breeding/${record.id}/scans`, { fetusCount: 1, date: daysAgo(61) });
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe('SCAN_BEFORE_MATING');
    expect((await zoo.post(`/livestock/breeding/${record.id}/scans`, { fetusCount: 4 })).status).toBe(400);
    expect((await zoo.post(`/livestock/breeding/${record.id}/scans`, { fetusCount: 1, date: addDays(T, 1) })).body.error.code).toBe('FUTURE_DATE');

    // The name of the person who scanned is personal data.
    expect(history.data.find((s: any) => s.fetusCount === 1).scannedBy).toBeNull();
    const owner = await f.as('owner');
    const seen = (await owner.get(`/livestock/breeding/${record.id}/scans`)).data;
    expect(seen.find((s: any) => s.fetusCount === 1).scannedBy).toBe('Dr. Karimov');
  });

  it('takes a scanning day by tag, saves what it can and lists what it cannot', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    const herd = await makeHerd(f, 'Bo\'g\'oz sovliqlar');
    const other = await makeHerd(f, 'Boshqa');
    const a = await pregnantEwe(f, 50, { tag: 'S-001', herdId: herd.id });
    const b = await pregnantEwe(f, 50, { tag: 'S-002', herdId: herd.id });
    const c = await pregnantEwe(f, 50, { tag: 'S-003', herdId: herd.id });
    await pregnantEwe(f, 50, { tag: 'S-004', herdId: other.id });
    await makeEwe(f, { tag: 'S-005', herdId: herd.id });

    const res = await shepherd.post('/livestock/scans/bulk', {
      herdId: herd.id,
      scannedBy: 'Dr. Karimov',
      entries: [
        { tag: 's-001', fetusCount: 2 },
        { tag: 'S-002', fetusCount: 0 },
        { eweId: c.ewe.id, fetusCount: 3 },
        { tag: 'S-001', fetusCount: 1 },
        { tag: 'S-004', fetusCount: 1 },
        { tag: 'S-005', fetusCount: 1 },
        { tag: 'YOQ-1', fetusCount: 1 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ date: T, recorded: 3, closed: 1 });
    expect(res.data.skipped.map((s: any) => [s.tag, s.reason])).toEqual([
      ['S-001', 'DUPLICATE'],
      ['S-004', 'NOT_IN_HERD'],
      ['S-005', 'NOT_PREGNANT'],
      ['YOQ-1', 'UNKNOWN_TAG'],
    ]);
    expect((await pregnancyOf(f, a.record.id)).fetusCount).toBe(2);
    expect((await pregnancyOf(f, b.record.id)).status).toBe('failed');
    expect((await animalOf(f, b.ewe.id)).status).toBe('active');

    // Ewes by foetus count: the list twin and triplet bearers are moved from.
    const all = (await shepherd.get('/livestock/scans/ewes')).data;
    expect(all.summary).toEqual({ total: 3, notScanned: 1, single: 0, twin: 1, triplet: 1, fetuses: 5 });
    const twins = (await shepherd.get('/livestock/scans/ewes', { fetusCount: '2' })).data.ewes;
    expect(twins.map((e: any) => e.tag)).toEqual(['S-001']);
    expect(twins[0]).toMatchObject({ herdId: herd.id, herdName: 'Bo\'g\'oz sovliqlar', fetusCount: 2, scanDate: T });
    expect((await shepherd.get('/livestock/scans/ewes', { fetusCount: 'none' })).data.ewes.map((e: any) => e.tag)).toEqual(['S-004']);

    // The existing transfer moves them to their own herd.
    const zoo = await f.as('zootechnician');
    const moved = await zoo.post('/livestock/transfers', { toHerdId: other.id, date: T, animalIds: [a.ewe.id, c.ewe.id] });
    expect(moved.status).toBe(200);
    expect((await shepherd.get('/livestock/scans/ewes', { herdId: other.id })).data.ewes.map((e: any) => e.tag)).toEqual(['S-001', 'S-003', 'S-004']);
  });

  it('expected lambs use the scanned count for scanned ewes and the rate for the rest (hand-worked)', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    const owner = await f.as('owner');
    const ewes: Awaited<ReturnType<typeof pregnantEwe>>[] = [];
    for (let i = 0; i < 11; i++) ewes.push(await pregnantEwe(f, 10));

    // Nothing scanned: 11 ewes × 1.1 assumed = 12.1, shown as 12. No own history, so no measured figure.
    const before = (await zoo.get('/livestock/breeding/calendar')).data;
    expect(before).toMatchObject({ totalEwes: 11, expectedLambs: null, assumedLambs: 12, scannedEwes: 0, scannedFetuses: 0 });
    expect((await owner.get('/dashboard/outlook')).data.herd.lambsBorn).toBe(12);

    // The scanning day: 4 twins, 3 singles, 1 triplet, 1 empty, 2 not presented.
    const counts = [2, 2, 2, 2, 1, 1, 1, 3, 0];
    const day = await zoo.post('/livestock/scans/bulk', { entries: counts.map((fetusCount, i) => ({ eweId: ewes[i].ewe.id, fetusCount })) });
    expect(day.data).toMatchObject({ recorded: 9, closed: 1, skipped: [] });

    // 10 ewes still pregnant. 8 scanned carry 8 + 3 + 3 = 14. 2 unscanned × 1.1 = 2.2. Total 16.2, shown as 16.
    // The old method would give 10 × 1.1 = 11.
    const after = (await zoo.get('/livestock/breeding/calendar')).data;
    expect(after).toMatchObject({ totalEwes: 10, scannedEwes: 8, scannedFetuses: 14, assumedLambs: 16 });
    // Two ewes are unscanned and the farm has no rate of its own to give them.
    expect(after.expectedLambs).toBeNull();
    expect(after.days).toEqual([{ date: addDays(T, 140), expected: 10 }]);

    const outlook = (await owner.get('/dashboard/outlook')).data.herd;
    expect(outlook.pregnant).toBe(10);
    expect(outlook.lambsBorn).toBe(16);

    const forecast = await f.run(() => lambingForecast());
    expect(forecast.findings[0].params).toMatchObject({ ewes: 10, lambs: 16 });
    const week = (forecast.findings[0].data as any).weeks.find((w: any) => w.ewes === 10);
    expect(week.lambs).toBe(16.2);

    // The last two scanned with one each: every ewe is counted, and no rate is needed at all.
    await zoo.post('/livestock/scans/bulk', { entries: [9, 10].map((i) => ({ eweId: ewes[i].ewe.id, fetusCount: 1 })) });
    const full = (await zoo.get('/livestock/breeding/calendar')).data;
    expect(full).toMatchObject({ totalEwes: 10, scannedEwes: 10, scannedFetuses: 16, expectedLambs: 16, assumedLambs: 16 });
    expect((await owner.get('/dashboard')).status).toBe(200);
  });

  it('refuses people without the right, and another farm', async () => {
    const f = await createFixture();
    const { ewe, record } = await pregnantEwe(f, 30, { tag: 'P-1' });

    for (const role of ['agronomist', 'storekeeper', 'mechanic'] as const) {
      const client = await f.as(role);
      expect((await client.post(`/livestock/breeding/${record.id}/scans`, { fetusCount: 1 })).status).toBe(403);
      expect((await client.post('/livestock/scans/bulk', { entries: [{ tag: 'P-1', fetusCount: 1 }] })).status).toBe(403);
      expect((await client.get('/livestock/scans/ewes')).status).toBe(403);
      expect((await client.get('/livestock/lambing-desk')).status).toBe(403);
    }
    // An auditor reads and writes nothing.
    const auditor = await f.as('auditor');
    expect((await auditor.get('/livestock/scans/ewes')).status).toBe(200);
    expect((await auditor.post(`/livestock/breeding/${record.id}/scans`, { fetusCount: 1 })).status).toBe(403);

    const g = await createFixture();
    const stranger = await g.as('owner');
    expect((await stranger.post(`/livestock/breeding/${record.id}/scans`, { fetusCount: 0 })).status).toBe(404);
    expect((await stranger.get(`/livestock/breeding/${record.id}/scans`)).data).toEqual([]);
    const bulk = await stranger.post('/livestock/scans/bulk', { entries: [{ tag: 'P-1', fetusCount: 0 }, { eweId: ewe.id, fetusCount: 0 }] });
    expect(bulk.data.recorded).toBe(0);
    expect(bulk.data.skipped.map((s: any) => s.reason)).toEqual(['UNKNOWN_TAG', 'UNKNOWN_TAG']);
    expect((await stranger.get('/livestock/scans/ewes')).data.ewes).toEqual([]);
    expect(await pregnancyOf(f, record.id)).toMatchObject({ status: 'pregnant', fetusCount: null });
    expect(await f.run(() => tx().select().from(pregnancyScans).where(eq(pregnancyScans.farmId, f.farmId)))).toEqual([]);
  });
});

/** A lambing entered through the API, as the shepherd does it. Returns the live lambs' ids. */
async function lamb(f: Fixture, eweId: string, o: { date?: string; lambs?: number; bornAt?: string; complications?: string } = {}) {
  const shepherd = await f.as('shepherd');
  const res = await shepherd.post('/livestock/lambings', {
    eweId,
    date: o.date ?? T,
    lambs: Array.from({ length: o.lambs ?? 1 }, () => ({ sex: 'female' })),
    bornAt: o.bornAt,
    complications: o.complications,
  });
  expect(res.status).toBe(201);
  return { record: res.data, lambIds: res.data.lambs.map((l: any) => l.animalId as string) };
}

describe('newborn care', () => {
  it('records colostrum, navel and mothering, and corrects them later', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    const ewe = await makeEwe(f, { tag: 'N-1' });
    const { lambIds } = await lamb(f, ewe.id);
    const [lambId] = lambIds;

    // Nothing recorded yet: the card says so instead of inventing a state.
    expect((await shepherd.get(`/livestock/lambs/${lambId}/care`)).data).toMatchObject({
      recorded: false,
      colostrumAt: null,
      navelTreated: false,
      mothering: null,
      damId: ewe.id,
      damTag: 'N-1',
    });

    const at = new Date(Date.now() - 60_000).toISOString();
    const saved = await shepherd.post(`/livestock/lambs/${lambId}/care`, { colostrumAt: at, navelTreated: true });
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ recorded: true, navelTreated: true, mothering: 'with_dam', fosterEweId: null });
    expect(new Date(saved.data.colostrumAt).toISOString()).toBe(at);

    // A later entry changes only what it names.
    const note = await shepherd.post(`/livestock/lambs/${lambId}/care`, { notes: 'zaif' });
    expect(note.data).toMatchObject({ navelTreated: true, notes: 'zaif', mothering: 'with_dam' });
    expect(new Date(note.data.colostrumAt).toISOString()).toBe(at);
    expect(await f.run(() => tx().select().from(lambCare).where(eq(lambCare.lambId, lambId)))).toHaveLength(1);
    expect(await eventsOf(f, lambId)).toContain('animal.care_recorded');

    // Colostrum before she was born is a slip.
    const early = await shepherd.post(`/livestock/lambs/${lambId}/care`, { colostrumAt: `${daysAgo(3)}T10:00:00+05:00` });
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe('COLOSTRUM_BEFORE_BIRTH');
    // A bought animal has no newborn record.
    const refused = await shepherd.post(`/livestock/lambs/${ewe.id}/care`, { navelTreated: true });
    expect(refused.body.error.code).toBe('NOT_BORN_HERE');
  });

  it('fostering stores the foster ewe apart and keeps the genetic dam', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    const zoo = await f.as('zootechnician');
    const dam = await makeEwe(f, { tag: 'D-1' });
    const fosterEwe = await makeEwe(f, { tag: 'F-1' });
    const ram = await makeEwe(f, { tag: 'R-1', sex: 'male' });
    const { lambIds } = await lamb(f, dam.id, { lambs: 2 });
    const [kept, given] = lambIds;

    const noEwe = await shepherd.post(`/livestock/lambs/${given}/care`, { mothering: 'fostered' });
    expect(noEwe.status).toBe(400);
    expect(noEwe.body.error.code).toBe('FOSTER_EWE_REQUIRED');
    expect((await shepherd.post(`/livestock/lambs/${given}/care`, { mothering: 'fostered', fosterEweId: dam.id })).body.error.code).toBe('FOSTER_IS_DAM');
    expect((await shepherd.post(`/livestock/lambs/${given}/care`, { mothering: 'fostered', fosterEweId: ram.id })).body.error.code).toBe('ANIMAL_NOT_FEMALE');

    const res = await shepherd.post(`/livestock/lambs/${given}/care`, { mothering: 'fostered', fosterEweId: fosterEwe.id });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ mothering: 'fostered', fosterEweId: fosterEwe.id, fosterEweTag: 'F-1', damId: dam.id, damTag: 'D-1' });
    expect(await eventsOf(f, given)).toContain('animal.fostered');

    // The genetic dam is untouched, and so are her figures: two lambs born to her, none to the foster ewe.
    expect((await animalOf(f, given)).damId).toBe(dam.id);
    expect((await animalOf(f, kept)).damId).toBe(dam.id);
    const ewesList = (await zoo.get('/livestock/breeding/ewes')).data;
    expect(ewesList.map((e: any) => e.tag)).toEqual(['D-1']);
    expect(ewesList[0]).toMatchObject({ lambings: 1, lambsBorn: 2, lambsAlive: 2 });
    const pedigree = (await zoo.get(`/livestock/pedigree/${given}`)).data;
    expect(JSON.stringify(pedigree)).toContain(dam.id);
    expect(JSON.stringify(pedigree)).not.toContain(fosterEwe.id);

    // Back to the bottle: the foster ewe is dropped from the record.
    const bottle = await shepherd.post(`/livestock/lambs/${given}/care`, { mothering: 'bottle' });
    expect(bottle.data).toMatchObject({ mothering: 'bottle', fosterEweId: null, fosterEweTag: null });
    expect(await eventsOf(f, given)).toContain('animal.bottle_fed');
  });

  it('lists lambs needing attention and raises the two alerts, then clears them', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    const [e1, e2, e3, e4] = [await makeEwe(f), await makeEwe(f), await makeEwe(f), await makeEwe(f)];

    // Born two days ago, entered now: at least a whole day old, with no colostrum on record.
    const old = await lamb(f, e1.id, { date: daysAgo(2), lambs: 2 });
    // Saved on the phone seven hours ago: past the threshold of LAMBING_DESK.colostrumHours.
    const sevenHoursAgo = new Date(Date.now() - 7 * 3_600_000);
    const late = await lamb(f, e2.id, { date: todayIso(undefined, sevenHoursAgo), bornAt: sevenHoursAgo.toISOString() });
    // Saved an hour ago: too early to worry.
    const hourAgo = new Date(Date.now() - 3_600_000);
    const fresh = await lamb(f, e3.id, { date: todayIso(undefined, hourAgo), bornAt: hourAgo.toISOString() });
    // An orphan on the bottle, three weeks old, colostrum long done.
    const orphan = await lamb(f, e4.id, { date: daysAgo(21) });
    await shepherd.post(`/livestock/lambs/${orphan.lambIds[0]}/care`, { mothering: 'bottle', colostrumAt: `${daysAgo(21)}T12:00:00+05:00` });

    expect(LAMBING_DESK.colostrumHours).toBe(6);
    const list = (await shepherd.get('/livestock/lambs/attention')).data;
    expect(list.colostrumHours).toBe(6);
    const reasons = new Map(list.lambs.map((l: any) => [l.lambId, l.reasons]));
    expect(reasons.get(old.lambIds[0])).toEqual(['no_colostrum']);
    expect(reasons.get(old.lambIds[1])).toEqual(['no_colostrum']);
    expect(reasons.get(late.lambIds[0])).toEqual(['no_colostrum']);
    expect(reasons.has(fresh.lambIds[0])).toBe(false);
    expect(reasons.get(orphan.lambIds[0])).toEqual(['bottle']);
    expect(list.lambs).toHaveLength(4);
    // Missing colostrum comes first; the orphan is last.
    expect(list.lambs.at(-1).lambId).toBe(orphan.lambIds[0]);
    expect(list.lambs.find((l: any) => l.lambId === late.lambIds[0]).hoursOld).toBeCloseTo(7, 0);

    await f.run(() => evaluateRules());
    const [colostrum] = await alertsOf(f, 'lambing_no_colostrum');
    expect(colostrum).toMatchObject({ severity: 'attention', link: '/livestock/breeding?tab=desk' });
    expect(colostrum.title).toContain('3');
    const [bottle] = await alertsOf(f, 'lambing_bottle_lambs');
    expect(bottle).toMatchObject({ severity: 'info' });
    expect(bottle.title).toContain('1');

    // Care entered, and the orphan taken by a ewe: both alerts go.
    const now = new Date().toISOString();
    for (const id of [...old.lambIds, ...late.lambIds]) {
      expect((await shepherd.post(`/livestock/lambs/${id}/care`, { colostrumAt: now })).status).toBe(200);
    }
    await shepherd.post(`/livestock/lambs/${orphan.lambIds[0]}/care`, { mothering: 'fostered', fosterEweId: e3.id });
    expect((await shepherd.get('/livestock/lambs/attention')).data.lambs).toEqual([]);
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'lambing_no_colostrum')).toEqual([]);
    expect(await alertsOf(f, 'lambing_bottle_lambs')).toEqual([]);
  });

  it('a lamb that died is not on the list, and care is closed to other roles and farms', async () => {
    const f = await createFixture();
    const ewe = await makeEwe(f);
    const { lambIds } = await lamb(f, ewe.id, { date: daysAgo(2), lambs: 2 });
    await f.run(() => markExited(lambIds[0], 'dead', T));
    const shepherd = await f.as('shepherd');
    expect((await shepherd.get('/livestock/lambs/attention')).data.lambs.map((l: any) => l.lambId)).toEqual([lambIds[1]]);

    for (const role of ['agronomist', 'storekeeper'] as const) {
      const client = await f.as(role);
      expect((await client.post(`/livestock/lambs/${lambIds[1]}/care`, { navelTreated: true })).status).toBe(403);
      expect((await client.get('/livestock/lambs/attention')).status).toBe(403);
    }
    expect((await (await f.as('auditor')).post(`/livestock/lambs/${lambIds[1]}/care`, { navelTreated: true })).status).toBe(403);

    const g = await createFixture();
    const stranger = await g.as('owner');
    expect((await stranger.post(`/livestock/lambs/${lambIds[1]}/care`, { navelTreated: true })).status).toBe(404);
    expect((await stranger.get(`/livestock/lambs/${lambIds[1]}/care`)).status).toBe(404);
    expect((await stranger.get('/livestock/lambs/attention')).data.lambs).toEqual([]);
    // Nor can a foster ewe be borrowed from another farm.
    const theirs = await makeEwe(g);
    const { lambIds: own } = await lamb(g, theirs.id);
    expect((await stranger.post(`/livestock/lambs/${own[0]}/care`, { mothering: 'fostered', fosterEweId: ewe.id })).status).toBe(404);
  });
});

describe('lambing pens', () => {
  it('marks a barn section as a pen: the zootechnician may, the shepherd may not', async () => {
    const f = await createFixture();
    const { barn, plain } = await makeBarn(f, 0, 2);
    const zoo = await f.as('zootechnician');
    const shepherd = await f.as('shepherd');

    expect((await shepherd.post(`/livestock/pens/sections/${plain[0].id}`, { lambingPen: true })).status).toBe(403);
    const marked = await zoo.post(`/livestock/pens/sections/${plain[0].id}`, { lambingPen: true });
    expect(marked.status).toBe(200);
    expect(marked.data).toMatchObject({ id: plain[0].id, lambingPen: true });
    expect(await eventsOf(f, plain[0].id)).toContain('facility.pen_marked');

    const whole = await zoo.post(`/livestock/pens/sections/${barn.id}`, { lambingPen: true });
    expect(whole.status).toBe(400);
    expect(whole.body.error.code).toBe('NOT_A_SECTION');

    const sections = (await shepherd.get('/livestock/pens/sections')).data;
    expect(sections.map((s: any) => [s.name, s.lambingPen, s.parentName])).toEqual([
      ['Bo\'lim 1', true, 'Qo\'zixona'],
      ['Bo\'lim 2', false, 'Qo\'zixona'],
    ]);
    expect((await shepherd.get('/livestock/pens')).data.map((p: any) => [p.name, p.free])).toEqual([['Bo\'lim 1', true]]);
  });

  it('puts a ewe and her lambs in, shows who is where, and lets them out again', async () => {
    const f = await createFixture();
    const { pens, plain } = await makeBarn(f, 2, 1);
    const shepherd = await f.as('shepherd');
    const herd = await makeHerd(f, 'Sovliqlar', plain[0].id);
    const ewe = await makeEwe(f, { tag: 'K-1', herdId: herd.id });
    const second = await makeEwe(f, { tag: 'K-2', herdId: herd.id });
    await f.run(() => tx().update(animals).set({ facilityId: plain[0].id }).where(eq(animals.id, ewe.id)));
    const { record, lambIds } = await lamb(f, ewe.id, { lambs: 2 });

    const notPen = await shepherd.post('/livestock/pens/stays', { facilityId: plain[0].id, eweId: ewe.id });
    expect(notPen.status).toBe(400);
    expect(notPen.body.error.code).toBe('NOT_A_LAMBING_PEN');

    const stay = await shepherd.post('/livestock/pens/stays', { facilityId: pens[0].id, eweId: ewe.id, lambingId: record.id });
    expect(stay.status).toBe(201);
    // In today, out after LAMBING_DESK.penDays = 3 days.
    expect(stay.data).toMatchObject({ sinceDate: T, plannedReleaseDate: addDays(T, 3), previousFacilityId: plain[0].id, lambingId: record.id });
    expect(stay.data.lambs).toHaveLength(2);
    for (const id of [ewe.id, ...lambIds]) expect((await animalOf(f, id)).facilityId).toBe(pens[0].id);
    expect(await eventsOf(f, ewe.id)).toContain('animal.penned');

    // One ewe to a pen, one pen to a ewe.
    const full = await shepherd.post('/livestock/pens/stays', { facilityId: pens[0].id, eweId: second.id });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('PEN_OCCUPIED');
    const twice = await shepherd.post('/livestock/pens/stays', { facilityId: pens[1].id, eweId: ewe.id });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('EWE_ALREADY_IN_PEN');

    const list = (await shepherd.get('/livestock/pens')).data;
    expect(list.map((p: any) => [p.name, p.free])).toEqual([['Katak 1', false], ['Katak 2', true]]);
    expect(list[0]).toMatchObject({ parentName: 'Qo\'zixona', stay: { id: stay.data.id, eweId: ewe.id, eweTag: 'K-1', sinceDate: T, plannedReleaseDate: addDays(T, 3), releaseDue: false } });
    expect(list[0].stay.lambs.map((l: any) => l.id).sort()).toEqual([...lambIds].sort());
    const desk = (await shepherd.get('/livestock/lambing-desk')).data;
    expect(desk.counts).toMatchObject({ pensTotal: 2, pensFree: 1, lambedToday: 1, lambsToday: 2 });

    // An occupied pen cannot lose its mark.
    const zoo = await f.as('zootechnician');
    expect((await zoo.post(`/livestock/pens/sections/${pens[0].id}`, { lambingPen: false })).body.error.code).toBe('PEN_OCCUPIED');

    const out = await shepherd.post(`/livestock/pens/stays/${stay.data.id}/release`, {});
    expect(out.status).toBe(200);
    expect(out.data.releasedDate).toBe(T);
    // Back where she was kept before, lambs with her.
    for (const id of [ewe.id, ...lambIds]) expect((await animalOf(f, id)).facilityId).toBe(plain[0].id);
    expect(await eventsOf(f, ewe.id)).toContain('animal.pen_released');
    expect((await shepherd.post(`/livestock/pens/stays/${stay.data.id}/release`, {})).body.error.code).toBe('PEN_STAY_CLOSED');
    expect((await shepherd.get('/livestock/pens')).data.every((p: any) => p.free)).toBe(true);
    // And the pen takes the next ewe.
    expect((await shepherd.post('/livestock/pens/stays', { facilityId: pens[0].id, eweId: second.id, days: 5 })).data.plannedReleaseDate).toBe(addDays(T, 5));
  });

  it('a ewe that died in the pen no longer holds it; a fostered lamb goes with its foster ewe', async () => {
    const f = await createFixture();
    const { pens } = await makeBarn(f, 2, 0);
    const shepherd = await f.as('shepherd');
    const [dam, fosterEwe, next] = [await makeEwe(f), await makeEwe(f), await makeEwe(f)];
    const { lambIds } = await lamb(f, dam.id, { lambs: 2 });
    await shepherd.post(`/livestock/lambs/${lambIds[1]}/care`, { mothering: 'fostered', fosterEweId: fosterEwe.id });

    const own = await shepherd.post('/livestock/pens/stays', { facilityId: pens[0].id, eweId: dam.id });
    expect(own.data.lambs.map((l: any) => l.id)).toEqual([lambIds[0]]);
    const fostered = await shepherd.post('/livestock/pens/stays', { facilityId: pens[1].id, eweId: fosterEwe.id });
    expect(fostered.data.lambs.map((l: any) => l.id)).toEqual([lambIds[1]]);
    expect((await animalOf(f, lambIds[1])).facilityId).toBe(pens[1].id);

    await f.run(() => markExited(dam.id, 'dead', T));
    expect((await shepherd.get('/livestock/pens')).data.map((p: any) => p.free)).toEqual([true, false]);
    expect((await shepherd.post('/livestock/pens/stays', { facilityId: pens[0].id, eweId: next.id })).status).toBe(201);
    const open = await f.run(() => tx().select().from(penStays).where(and(eq(penStays.facilityId, pens[0].id), sql`released_date is null`)));
    expect(open.map((s) => s.eweId)).toEqual([next.id]);
  });

  it('is closed to other roles and other farms', async () => {
    const f = await createFixture();
    const { pens } = await makeBarn(f, 1, 0);
    const ewe = await makeEwe(f);
    for (const role of ['agronomist', 'storekeeper', 'auditor'] as const) {
      const client = await f.as(role);
      expect((await client.post('/livestock/pens/stays', { facilityId: pens[0].id, eweId: ewe.id })).status).toBe(403);
      expect((await client.post(`/livestock/pens/sections/${pens[0].id}`, { lambingPen: false })).status).toBe(403);
    }
    const shepherd = await f.as('shepherd');
    const stay = await shepherd.post('/livestock/pens/stays', { facilityId: pens[0].id, eweId: ewe.id });

    const g = await createFixture();
    const stranger = await g.as('owner');
    const theirs = await makeEwe(g);
    expect((await stranger.get('/livestock/pens')).data).toEqual([]);
    expect((await stranger.post('/livestock/pens/stays', { facilityId: pens[0].id, eweId: theirs.id })).status).toBe(404);
    expect((await stranger.post(`/livestock/pens/stays/${stay.data.id}/release`, {})).status).toBe(404);
    expect((await stranger.post(`/livestock/pens/sections/${pens[0].id}`, { lambingPen: false })).status).toBe(404);
    expect((await shepherd.get('/livestock/pens')).data[0].free).toBe(false);
  });
});

describe('night watch and the desk', () => {
  it('lists ewes due soon and overdue, soonest first, with what the shepherd needs', async () => {
    const f = await createFixture();
    const { pens, plain } = await makeBarn(f, 1, 1);
    const herd = await makeHerd(f, 'Bo\'g\'oz', plain[0].id);
    const shepherd = await f.as('shepherd');

    // Sheep carry 150 days: mated 147 days ago is due in 3 days, 160 days ago is past the window.
    const soon = await pregnantEwe(f, 147, { tag: 'W-2', herdId: herd.id });
    const overdue = await pregnantEwe(f, 160, { tag: 'W-1', herdId: herd.id });
    const far = await pregnantEwe(f, 100, { tag: 'W-3', herdId: herd.id });
    const gone = await pregnantEwe(f, 147, { tag: 'W-4', herdId: herd.id });
    await f.run(() => markExited(gone.ewe.id, 'sold', T));
    // W-2 lambed here before, with trouble, and lost one lamb.
    await f.run(() =>
      tx().insert(lambingRecords).values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        eweId: soon.ewe.id,
        date: daysAgo(400),
        lambsBorn: 2,
        lambsAlive: 1,
        lambs: [],
        complications: 'Og\'ir tug\'ruq',
      }),
    );
    await shepherd.post(`/livestock/breeding/${soon.record.id}/scans`, { fetusCount: 2 });

    const watch = (await shepherd.get('/livestock/lambing-desk/watch')).data;
    expect(watch).toMatchObject({ today: T, days: LAMBING_DESK.watchDays });
    expect(watch.ewes.map((e: any) => e.tag)).toEqual(['W-1', 'W-2']);
    expect(watch.ewes[0]).toMatchObject({
      eweId: overdue.ewe.id,
      breedingId: overdue.record.id,
      expectedDate: daysAgo(10),
      daysLeft: -10,
      overdue: true,
      fetusCount: null,
      firstLambing: true,
      complications: [],
      herdName: 'Bo\'g\'oz',
      facilityName: 'Bo\'lim 1',
      barnName: 'Qo\'zixona',
      inPen: false,
    });
    expect(watch.ewes[1]).toMatchObject({
      expectedDate: addDays(T, 3),
      daysLeft: 3,
      overdue: false,
      fetusCount: 2,
      firstLambing: false,
      complications: [{ date: daysAgo(400), text: 'Og\'ir tug\'ruq' }],
      stillborn: 1,
    });
    expect(watch.freePens).toEqual([{ id: pens[0].id, name: 'Katak 1', parentName: 'Qo\'zixona' }]);

    // A wider window takes in the third ewe: due in 50 days.
    const wide = (await shepherd.get('/livestock/lambing-desk/watch', { days: 60 })).data;
    expect(wide.ewes.map((e: any) => e.tag)).toEqual(['W-1', 'W-2', 'W-3']);
    expect(wide.ewes[2].eweId).toBe(far.ewe.id);

    // Moved into the pen, she is shown there.
    await shepherd.post('/livestock/pens/stays', { facilityId: pens[0].id, eweId: soon.ewe.id });
    const after = (await shepherd.get('/livestock/lambing-desk/watch')).data;
    expect(after.ewes[1]).toMatchObject({ facilityName: 'Katak 1', inPen: true });
    expect(after.freePens).toEqual([]);
  });

  it('brings the counts together', async () => {
    const f = await createFixture();
    await makeBarn(f, 3, 0);
    const zoo = await f.as('zootechnician');
    await pregnantEwe(f, 147); // due in 3 days
    await pregnantEwe(f, 151); // a day past the expected date, still inside the window
    await pregnantEwe(f, 141); // due in 9 days: on the watch list, not this week
    await pregnantEwe(f, 160); // overdue
    await pregnantEwe(f, 20);
    const mother = await makeEwe(f);
    await lamb(f, mother.id, { lambs: 2 });
    const earlier = await makeEwe(f);
    await lamb(f, earlier.id, { date: daysAgo(2) });

    const desk = (await zoo.get('/livestock/lambing-desk')).data;
    expect(desk.counts).toEqual({
      dueThisWeek: 2,
      overdue: 1,
      lambedToday: 1,
      lambsToday: 2,
      lambsNeedingAttention: 1,
      pensTotal: 3,
      pensFree: 3,
    });
    expect(desk.limits).toEqual({ watchDays: 14, colostrumHours: 6, penDays: 3 });
    expect(desk.watch).toHaveLength(4);
    expect(desk.attention).toHaveLength(1);
    expect(desk.pens).toHaveLength(3);

    // An empty farm has an empty desk, not an error.
    const g = await createFixture();
    const empty = (await (await g.as('shepherd')).get('/livestock/lambing-desk')).data;
    expect(empty.counts).toEqual({ dueThisWeek: 0, overdue: 0, lambedToday: 0, lambsToday: 0, lambsNeedingAttention: 0, pensTotal: 0, pensFree: 0 });
    expect(empty.watch).toEqual([]);
  });
});

describe('records the phone sends from its queue', () => {
  it('a lambing, its care and its pen arrive once, however often they are resent', async () => {
    const f = await createFixture();
    const { pens } = await makeBarn(f, 2, 0);
    const shepherd = await f.as('shepherd');
    const { ewe } = await pregnantEwe(f, 148);
    // Everything gets its id on the phone, before there is a connection.
    const [lambingId, lambId, careKey, stayId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const at = new Date().toISOString();

    const lambing = { id: lambingId, eweId: ewe.id, date: T, lambs: [{ id: lambId, sex: 'female' }], bornAt: at };
    for (let n = 0; n < 2; n++) {
      const res = await shepherd.post('/livestock/lambings', lambing, { 'idempotency-key': lambingId });
      expect(res.status).toBe(201);
      expect(res.data.lambs.map((l: any) => l.animalId)).toEqual([lambId]);
    }

    const care = { colostrumAt: at, navelTreated: true };
    for (let n = 0; n < 2; n++) expect((await shepherd.post(`/livestock/lambs/${lambId}/care`, care, { 'idempotency-key': careKey })).status).toBe(200);
    expect(await f.run(() => tx().select().from(lambCare).where(eq(lambCare.lambId, lambId)))).toHaveLength(1);

    const stay = { id: stayId, facilityId: pens[0].id, eweId: ewe.id, lambingId, sinceDate: T };
    const first = await shepherd.post('/livestock/pens/stays', stay, { 'idempotency-key': stayId });
    expect(first.status).toBe(201);
    // The stored answer is replayed for the same key...
    expect((await shepherd.post('/livestock/pens/stays', stay, { 'idempotency-key': stayId })).data.id).toBe(stayId);
    // ...and without it the stay is still known by its own id, not refused as a second stay.
    const again = await shepherd.post('/livestock/pens/stays', stay);
    expect(again.body.error).toBeUndefined();
    expect(again.data).toMatchObject({ id: stayId, facilityId: pens[0].id });
    expect(again.data.lambs.map((l: any) => l.id)).toEqual([lambId]);
    // The same id for another pen is a different request and is refused as before.
    expect((await shepherd.post('/livestock/pens/stays', { ...stay, facilityId: pens[1].id })).body.error.code).toBe('EWE_ALREADY_IN_PEN');

    expect(await f.run(() => tx().select().from(penStays).where(eq(penStays.eweId, ewe.id)))).toHaveLength(1);
    expect(await f.run(() => tx().select().from(lambingRecords).where(eq(lambingRecords.eweId, ewe.id)))).toHaveLength(1);
    expect((await eventsOf(f, ewe.id)).filter((type) => type === 'animal.penned')).toHaveLength(1);
  });

  it('offers the night watch on the Today page to people who record livestock', async () => {
    const f = await createFixture();
    expect((await (await f.as('shepherd')).get('/today')).data.actions).toContain('night_watch');
    expect((await (await f.as('storekeeper')).get('/today')).data.actions).not.toContain('night_watch');
  });
});
