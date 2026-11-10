import { addDays, todayIso } from '@yap/shared';
import { GRAZING_RULES } from '@yap/shared/formulas/grazing';
import { NIGHT_RULES, ZONE_RULES } from '@yap/shared/formulas/tracking';
import { and, eq, like } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { summarizeGrazing, summarizeGrazingDay } from '../src/modules/tracking/grazing.service';
import { evaluateHealth } from '../src/modules/tracking/health.service';
import { createFixture, type Client, type Fixture } from './helpers';

const { alerts, animals, animalTracking, events, grazingCellDays, species } = schema;

/**
 * Near the farm. One thousandth of a degree of latitude is 111.195 m everywhere; of longitude at
 * 39.5° N it is 111.195 x cos 39.5° = 85.80 m.
 */
const LAT = 39.5;
const LNG = 64.8;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A square 0.004° on a side around the flock: 444.8 m north to south, 343.2 m east to west. */
const SQUARE = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [64.798, 39.498],
      [64.802, 39.498],
      [64.802, 39.502],
      [64.798, 39.502],
      [64.798, 39.498],
    ],
  ],
};
/** A smaller square inside it, north of the flock: 39.5010 to 39.5018. */
const POND = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [64.799, 39.501],
      [64.801, 39.501],
      [64.801, 39.5018],
      [64.799, 39.5018],
      [64.799, 39.501],
    ],
  ],
};

const eui = (i: number) => `A840410000${i.toString(16).padStart(6, '0')}`.toUpperCase();

interface Farm {
  f: Fixture;
  owner: Client;
  key: string;
  herdId: string;
  sheep: { id: string; tag: string }[];
}

async function farm(n = 6): Promise<Farm> {
  const f = await createFixture();
  const owner = await f.as('owner');
  const key = (await owner.post('/settings/api-keys', { name: 'ChirpStack', scopes: ['events:write'] })).data.key as string;
  const herdId = (await owner.post('/livestock/herds', { name: 'Sovliqlar' })).data.id as string;
  const sheep = await f.run(async () => {
    const [sp] = await tx().select().from(species).where(eq(species.key, 'sheep'));
    return tx()
      .insert(animals)
      .values(
        Array.from({ length: n }, (_, i) => ({
          tenantId: f.tenantId,
          farmId: f.farmId,
          tag: `YA-${String(i + 1).padStart(4, '0')}`,
          speciesId: sp!.id,
          sex: 'female',
          category: 'ewe',
          origin: 'purchased',
          herdId,
        })),
      )
      .returning({ id: animals.id, tag: animals.tag });
  });
  const res = await owner.post('/tracking/trackers/import', { rows: sheep.map((s, i) => ({ externalId: eui(i), kind: 'collar', animal: s.tag })) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { f, owner, key, herdId, sheep };
}

/** One position per sheep at `at`; `place(i)` is its offset north of the farm in degrees, or `null` to stay silent. */
async function fixes(x: Farm, at: number, place: (i: number) => number | null) {
  const readings = x.sheep.flatMap((_, i) => {
    const offset = place(i);
    return offset === null ? [] : [{ externalId: eui(i), recordedAt: new Date(at).toISOString(), lat: LAT + offset, lng: LNG }];
  });
  const res = await x.f.app.inject({
    method: 'POST',
    url: '/api/v1/tracking/readings',
    headers: { 'content-type': 'application/json', 'x-api-key': x.key },
    payload: JSON.stringify({ readings }),
  });
  expect(res.statusCode, res.body).toBe(200);
}

const openAlerts = (f: Fixture, ruleKey: string) =>
  f.run(() =>
    tx()
      .select()
      .from(alerts)
      .where(and(eq(alerts.ruleKey, ruleKey), eq(alerts.status, 'open'))),
  );

const flagsOf = (x: Farm, i: number) =>
  x.f.run(async () => (await tx().select().from(animalTracking).where(eq(animalTracking.animalId, x.sheep[i]!.id)))[0]?.flags ?? {});

const check = (x: Farm, now = new Date()) => x.f.run(() => evaluateHealth(now, false));

/** The flock grazing together, a metre or two apart. */
const together = (i: number) => i * 0.00001;

describe('zones: who may change them, and what a zone must be', () => {
  it('a zootechnician draws, renames and switches a zone; a shepherd only reads; a mechanic sees nothing', async () => {
    const x = await farm(1);
    const zoo = await x.f.as('zootechnician');
    const shepherd = await x.f.as('shepherd');
    const mechanic = await x.f.as('mechanic');

    const made = await zoo.post('/tracking/zones', { name: 'Yaylov', kind: 'allowed', geometry: SQUARE, herdId: x.herdId });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.data).toMatchObject({ name: 'Yaylov', kind: 'allowed', active: true, herdId: x.herdId, herdName: 'Sovliqlar', fieldId: null, geometry: SQUARE });
    const id = made.data.id as string;

    const seen = await shepherd.get('/tracking/zones');
    expect(seen.status).toBe(200);
    expect(seen.data.map((z: { name: string }) => z.name)).toEqual(['Yaylov']);
    expect((await shepherd.post('/tracking/zones', { name: 'X', kind: 'allowed', geometry: SQUARE })).status).toBe(403);
    expect((await shepherd.patch(`/tracking/zones/${id}`, { active: false })).status).toBe(403);
    expect((await shepherd.delete(`/tracking/zones/${id}`)).status).toBe(403);
    expect((await mechanic.get('/tracking/zones')).status).toBe(403);
    expect((await mechanic.get('/tracking/lost')).status).toBe(403);
    expect((await mechanic.get('/tracking/grazing')).status).toBe(403);
    // A vet may change herds, so also zones, but may not remove either.
    const vet = await x.f.as('veterinarian');
    expect((await vet.delete(`/tracking/zones/${id}`)).status).toBe(403);

    const renamed = await zoo.patch(`/tracking/zones/${id}`, { name: 'Shimoliy yaylov', herdId: null });
    expect(renamed.data).toMatchObject({ name: 'Shimoliy yaylov', herdId: null, herdName: null, geometry: SQUARE });
    expect((await zoo.patch(`/tracking/zones/${id}`, { active: false })).data.active).toBe(false);
    expect((await zoo.patch(`/tracking/zones/${id}`, { active: true })).data.active).toBe(true);
    expect((await zoo.delete(`/tracking/zones/${id}`)).status).toBe(200);
    expect((await zoo.get('/tracking/zones')).data).toEqual([]);

    // Every change is in the journal.
    const journal = await x.f.run(() => tx().select({ type: events.type }).from(events).where(like(events.type, 'tracking.zone_%')));
    expect(journal.map((e) => e.type).sort()).toEqual(
      ['tracking.zone_created', 'tracking.zone_removed', 'tracking.zone_switched_off', 'tracking.zone_switched_on', 'tracking.zone_updated'].sort(),
    );
  });

  it('refuses an open outline, one that crosses itself, and a zone with no outline or two', async () => {
    const x = await farm(1);
    const post = (body: Record<string, unknown>) => x.owner.post('/tracking/zones', { name: 'Zona', kind: 'allowed', ...body });

    // The last corner is not the first.
    const open = await post({ geometry: { type: 'Polygon', coordinates: [SQUARE.coordinates[0]!.slice(0, 4)] } });
    expect(open.status).toBe(400);
    expect(open.body.error?.code).toBe('VALIDATION_ERROR');

    // A bow tie: the second side runs corner to corner, so two sides cross in the middle.
    const bowTie = [
      [64.798, 39.498],
      [64.802, 39.502],
      [64.802, 39.498],
      [64.798, 39.502],
      [64.798, 39.498],
    ];
    const crossing = await post({ geometry: { type: 'Polygon', coordinates: [bowTie] } });
    expect(crossing.status).toBe(400);
    expect(crossing.body.error).toMatchObject({ code: 'INVALID_GEOMETRY', details: { problem: 'crossing' } });

    // Three corners on one line enclose nothing.
    const line = [
      [64.798, 39.498],
      [64.8, 39.498],
      [64.802, 39.498],
      [64.798, 39.498],
    ];
    expect((await post({ geometry: { type: 'Polygon', coordinates: [line] } })).body.error).toMatchObject({ code: 'INVALID_GEOMETRY', details: { problem: 'flat' } });

    expect((await post({})).body.error?.code).toBe('ZONE_OUTLINE_REQUIRED');
    const field = await x.owner.post('/farm/fields', { number: 'Y-1', landUse: 'pasture', boundary: SQUARE });
    expect(field.status, JSON.stringify(field.body)).toBe(201);
    expect((await post({ fieldId: field.data.id, geometry: SQUARE })).body.error?.code).toBe('ZONE_OUTLINE_REQUIRED');

    // A field that is only a number and an area has no line to cross.
    const bare = await x.owner.post('/farm/fields', { number: 'Y-2', landUse: 'pasture', areaHa: 40 });
    expect((await post({ fieldId: bare.data.id })).body.error?.code).toBe('ZONE_FIELD_NO_BOUNDARY');
    expect((await post({ kind: 'sometimes', geometry: SQUARE })).status).toBe(400);
    expect((await x.owner.get('/tracking/zones')).data).toEqual([]);
  });

  it("keeps workspaces apart: another farm's zone, field and herd do not exist here", async () => {
    const a = await farm(1);
    const b = await farm(1);
    const zone = (await a.owner.post('/tracking/zones', { name: 'Yaylov', kind: 'allowed', geometry: SQUARE })).data;
    const fieldOfB = (await b.owner.post('/farm/fields', { number: 'B-1', landUse: 'pasture', boundary: SQUARE })).data;

    expect((await b.owner.get('/tracking/zones')).data).toEqual([]);
    expect((await b.owner.patch(`/tracking/zones/${zone.id}`, { name: 'Meniki' })).status).toBe(404);
    expect((await b.owner.delete(`/tracking/zones/${zone.id}`)).status).toBe(404);

    const foreignField = await a.owner.post('/tracking/zones', { name: 'Begona dala', kind: 'allowed', fieldId: fieldOfB.id });
    expect(foreignField.status).toBe(404);
    const foreignHerd = await a.owner.post('/tracking/zones', { name: 'Begona poda', kind: 'allowed', geometry: SQUARE, herdId: b.herdId });
    expect(foreignHerd.status).toBe(404);
    expect((await a.owner.get('/tracking/zones')).data).toHaveLength(1);
    expect((await a.owner.get('/tracking/zones')).data[0].name).toBe('Yaylov');
  });
});

describe('out of zone', () => {
  it('two fixes in a row 111 m past the line flag the sheep; 22 m past, or one fix, do not; the herd gets one alert', async () => {
    const x = await farm(6);
    const field = (await x.owner.post('/farm/fields', { number: 'Y-1', landUse: 'pasture', boundary: SQUARE })).data;
    const zone = (await x.owner.post('/tracking/zones', { name: 'Yaylov', kind: 'allowed', fieldId: field.id, herdId: x.herdId })).data;
    expect(zone).toMatchObject({ fieldId: field.id, fieldNumber: 'Y-1' });
    expect(zone.geometry.type).toBe('Polygon');

    // The north edge is at +0.002°. Sheep 5 stands at +0.003°: 0.001° = 111 m past it, twice.
    // Sheep 4 stands at +0.0022°: 22 m past it, inside the 30 m allowed for GPS error.
    // Sheep 3 was inside 20 minutes ago and is 111 m out now: one fix is not yet a fact.
    expect(ZONE_RULES).toMatchObject({ bufferM: 30, exitFixes: 2 });
    const now = Date.now();
    await fixes(x, now - 20 * MIN, (i) => (i === 5 ? 0.003 : i === 4 ? 0.0022 : together(i)));
    await fixes(x, now - 5 * MIN, (i) => (i === 5 || i === 3 ? 0.003 : i === 4 ? 0.0022 : together(i)));
    const run = await check(x);
    expect(run.outOfZone).toBe(1);

    expect((await flagsOf(x, 5)).out_of_zone).toBeTruthy();
    expect((await flagsOf(x, 4)).out_of_zone).toBeUndefined();
    expect((await flagsOf(x, 3)).out_of_zone).toBeUndefined();
    const raised = await openAlerts(x.f, 'geofence_exit');
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ entityType: 'herd', entityId: x.herdId, severity: 'attention' });
    expect(raised[0]!.data).toEqual({ herd: 'Sovliqlar', count: 1, tracked: 6, zone: 'Yaylov', fixes: 2 });
    expect(raised[0]!.notifyRoles).toEqual(expect.arrayContaining(['shepherd', 'zootechnician', 'director']));

    // Sheep 3 is still out at the next fix: now two are, in the same alert.
    await fixes(x, now - 1 * MIN, (i) => (i === 5 || i === 3 ? 0.003 : i === 4 ? 0.0022 : together(i)));
    expect((await check(x)).outOfZone).toBe(2);
    const again = await openAlerts(x.f, 'geofence_exit');
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(raised[0]!.id);
    expect(again[0]!.data).toMatchObject({ count: 2, tracked: 6 });
    // The map shows the flag.
    const live = (await x.owner.get('/tracking/live')).data;
    expect(live.animals.filter((a: { flags: Record<string, string> }) => a.flags.out_of_zone).map((a: { tag: string }) => a.tag).sort()).toEqual(['YA-0004', 'YA-0006']);

    // Switched off, the zone binds nobody: flags and alert go.
    await x.owner.patch(`/tracking/zones/${zone.id}`, { active: false });
    const off = await check(x);
    expect(off.outOfZone).toBe(0);
    expect((await flagsOf(x, 5)).out_of_zone).toBeUndefined();
    expect(await openAlerts(x.f, 'geofence_exit')).toHaveLength(0);
  });

  it('one fix back inside clears the flag and closes the alert', async () => {
    const x = await farm(6);
    await x.owner.post('/tracking/zones', { name: 'Yaylov', kind: 'allowed', geometry: SQUARE });
    const now = Date.now();
    await fixes(x, now - 20 * MIN, (i) => (i === 0 ? -0.004 : together(i)));
    await fixes(x, now - 10 * MIN, (i) => (i === 0 ? -0.004 : together(i)));
    expect((await check(x)).outOfZone).toBe(1);
    expect(await openAlerts(x.f, 'geofence_exit')).toHaveLength(1);

    await fixes(x, now - 1 * MIN, together);
    expect((await check(x)).outOfZone).toBe(0);
    expect((await flagsOf(x, 0)).out_of_zone).toBeUndefined();
    expect(await openAlerts(x.f, 'geofence_exit')).toHaveLength(0);
  });

  it("a closed zone flags sheep 39 m inside it, and another herd's zone binds nobody here", async () => {
    const x = await farm(6);
    const other = (await x.owner.post('/livestock/herds', { name: "Qo'chqorlar" })).data.id as string;
    // An allowed zone far away, for the other herd only: this herd is not held to it.
    const far = SQUARE.coordinates[0]!.map(([lng, lat]) => [lng! + 1, lat!]);
    await x.owner.post('/tracking/zones', { name: 'Uzoq yaylov', kind: 'allowed', geometry: { type: 'Polygon', coordinates: [far] }, herdId: other });
    await x.owner.post('/tracking/zones', { name: 'Hovuz', kind: 'forbidden', geometry: POND });

    // The pond runs from +0.0010° to +0.0018°. Sheep 0 and 1 stand at +0.00135°: 0.00035° = 38.9 m
    // from the south edge, the nearest. Sheep 2 stands at +0.0011°: 11 m inside, within GPS error.
    const now = Date.now();
    const place = (i: number) => (i < 2 ? 0.00135 : i === 2 ? 0.0011 : together(i));
    await fixes(x, now - 20 * MIN, place);
    await fixes(x, now - 5 * MIN, place);
    expect((await check(x)).outOfZone).toBe(2);
    expect((await flagsOf(x, 2)).out_of_zone).toBeUndefined();
    const raised = await openAlerts(x.f, 'geofence_exit');
    expect(raised).toHaveLength(1);
    expect(raised[0]!.data).toEqual({ herd: 'Sovliqlar', count: 2, tracked: 6, zone: 'Hovuz', fixes: 2, textKey: 'geofence_exit_forbidden' });
  });
});

describe('movement at night', () => {
  /** The latest 01:00 in Tashkent (20:00 UTC) that is at least 12 hours behind us. */
  const lastNight = () => {
    const d = new Date(Date.now() - 12 * HOUR);
    d.setUTCMinutes(0, 0, 0);
    while (d.getUTCHours() !== 20) d.setTime(d.getTime() - HOUR);
    return d;
  };

  it('a herd whose centre went 556 m in the dark raises one urgent alert; by day the same walk raises none', async () => {
    const x = await farm(6);
    const night = lastNight();
    const at = night.getTime();
    expect(NIGHT_RULES).toMatchObject({ fromHour: 22, toHour: 5, maxMoveM: 400, maxSpeedKmh: 1 });

    // Penned, shuffling a metre: nothing.
    await fixes(x, at - 100 * MIN, together);
    await fixes(x, at - 70 * MIN, (i) => together(i) + 0.00001);
    expect((await check(x, new Date(at - 65 * MIN))).nightMoves).toBe(0);
    expect(await openAlerts(x.f, 'night_movement')).toHaveLength(0);

    // Then the whole flock is 0.005° north: 0.005 x 111 195 = 556 m, over 40 minutes, so 0.83 km/h.
    // Far (over 400 m) but not fast (under 1 km/h).
    await fixes(x, at - 45 * MIN, together);
    await fixes(x, at - 5 * MIN, (i) => together(i) + 0.005);
    const run = await check(x, night);
    expect(run.nightMoves).toBe(1);
    const raised = await openAlerts(x.f, 'night_movement');
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ severity: 'urgent', entityType: 'herd', entityId: x.herdId });
    expect(raised[0]!.data).toMatchObject({ herd: 'Sovliqlar', distance: 556, minutes: 120, tracked: 6, speedKmh: 0.8, reason: 'far' });

    // A second run that night adds no second alert.
    await check(x, new Date(at + 2 * MIN));
    expect(await openAlerts(x.f, 'night_movement')).toHaveLength(1);

    // Noon in Tashkent: the first run by day closes it.
    const noon = new Date(at + 11 * HOUR);
    expect((await check(x, noon)).nightMoves).toBe(0);
    expect(await openAlerts(x.f, 'night_movement')).toHaveLength(0);

    // The same walk at noon is grazing.
    const y = await farm(6);
    await fixes(y, noon.getTime() - 45 * MIN, together);
    await fixes(y, noon.getTime() - 5 * MIN, (i) => together(i) + 0.005);
    expect((await check(y, noon)).nightMoves).toBe(0);
    expect(await openAlerts(y.f, 'night_movement')).toHaveLength(0);
  });

  it('a short dash counts too: 222 m in 10 minutes is 1.3 km/h', async () => {
    const x = await farm(6);
    const at = lastNight().getTime();
    await fixes(x, at - 15 * MIN, together);
    await fixes(x, at - 5 * MIN, (i) => together(i) + 0.002);
    expect((await check(x, new Date(at))).nightMoves).toBe(1);
    const [alert] = await openAlerts(x.f, 'night_movement');
    expect(alert!.data).toMatchObject({ distance: 222, speedKmh: 1.3, reason: 'fast' });
  });

  it('a farm that grazes at night switches the watch off: nothing is raised, and an open alert is closed', async () => {
    const x = await farm(6);
    const owner = await x.f.as('owner');
    const shepherd = await x.f.as('shepherd');
    const at = lastNight().getTime();
    expect((await shepherd.get('/tracking/night-watch')).data).toEqual({ enabled: true });

    await fixes(x, at - 45 * MIN, together);
    await fixes(x, at - 5 * MIN, (i) => together(i) + 0.005);
    expect((await check(x, new Date(at))).nightMoves).toBe(1);
    expect(await openAlerts(x.f, 'night_movement')).toHaveLength(1);

    // The switch silences an urgent alert, so it belongs to whoever sets the workspace policy.
    const refused = await shepherd.patch('/settings/policy', { tracking: { nightWatch: false } });
    expect(refused.status).toBe(403);
    const off = await owner.patch('/settings/policy', { tracking: { nightWatch: false } });
    expect(off.status).toBe(200);
    expect(off.data.tracking).toEqual({ nightWatch: false });
    expect((await shepherd.get('/tracking/night-watch')).data).toEqual({ enabled: false });

    // The same night, still moving: the next run closes what was open and raises nothing.
    // (`f.run` keeps the settings the fixture began with, so the run is given what is stored now.)
    const stored = { ...DEFAULT_SETTINGS, tracking: off.data.tracking };
    expect((await x.f.run(() => evaluateHealth(new Date(at + 2 * MIN), false), { settings: stored })).nightMoves).toBe(0);
    expect(await openAlerts(x.f, 'night_movement')).toHaveLength(0);

    // Switched back on, the same movement is told again.
    expect((await owner.patch('/settings/policy', { tracking: { nightWatch: true } })).status).toBe(200);
    expect((await check(x, new Date(at + 4 * MIN))).nightMoves).toBe(1);
    expect(await openAlerts(x.f, 'night_movement')).toHaveLength(1);
  });
});

describe('last seen', () => {
  it('lists the silent sheep with where she was, how long ago and how far from the flock', async () => {
    const x = await farm(6);
    const now = Date.now();
    // Sheep 5 was last heard five hours ago, 0.002° north of where the flock is now.
    await fixes(x, now - 300 * MIN, (i) => (i === 5 ? 0.002 : null));
    await fixes(x, now - 5 * MIN, (i) => (i === 5 ? null : i * 0.0001));

    const shepherd = await x.f.as('shepherd');
    const res = await shepherd.get('/tracking/lost');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ tracked: 6, total: 1, allSilent: false });
    const [row] = res.data.animals;
    expect(row).toMatchObject({ tag: 'YA-0006', reason: 'silent', herdName: 'Sovliqlar', lat: LAT + 0.002, lng: LNG });
    expect(row.minutesSinceContact).toBeGreaterThanOrEqual(300);
    expect(row.minutesSinceContact).toBeLessThanOrEqual(301);
    expect(row.minutesSincePosition).toBe(row.minutesSinceContact);
    // The flock's centre is its median sheep, at +0.0002°: 0.0018° x 111 195 = 200 m.
    expect(row.distanceFromHerdM).toBe(200);

    // Another workspace sees none of it.
    const other = await farm(1);
    expect((await other.owner.get('/tracking/lost')).data).toMatchObject({ total: 0, animals: [] });
  });

  it('nobody to look for is an empty list, not an error', async () => {
    const x = await farm(6);
    await fixes(x, Date.now() - 5 * MIN, together);
    expect((await x.owner.get('/tracking/lost')).data).toMatchObject({ tracked: 6, total: 0, animals: [] });
  });
});

describe('grazing map', () => {
  it('counts a day of fixes into cells and fields, and the totals are the fixes sent', async () => {
    const x = await farm(6);
    const field = (await x.owner.post('/farm/fields', { number: 'Y-1', landUse: 'pasture', boundary: SQUARE })).data;
    const empty = await x.owner.get('/tracking/grazing', { days: '7' });
    expect(empty.status).toBe(200);
    expect(empty.data).toMatchObject({ days: 7, daysWithData: 0, totalFixes: null, cells: null, fields: null });

    // Yesterday from 10:00 Tashkent time, four fixes 15 minutes apart. Sheep 0 to 3 are on the
    // field, sheep 4 and 5 are 0.01° north of it. A fix is worth the time to the next one and the
    // last one 30 minutes, so each sheep was seen for 15 + 15 + 15 + 30 = 75 minutes.
    const yesterday = addDays(todayIso(), -1);
    const ten = Date.parse(`${yesterday}T05:00:00Z`);
    for (let k = 0; k < 4; k += 1) await fixes(x, ten + k * 15 * MIN, (i) => (i < 4 ? i * 0.0001 : 0.01));
    expect(await x.f.run(() => summarizeGrazingDay(yesterday))).toBe(24);
    // Counting the same day again replaces it.
    expect(await x.f.run(() => summarizeGrazing())).toBe(24);

    const shepherd = await x.f.as('shepherd');
    const res = await shepherd.get('/tracking/grazing', { days: '7' });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ days: 7, to: yesterday, from: addDays(todayIso(), -7), daysWithData: 1, totalFixes: 24, truncated: false });
    // Cells are 0.0005°: 39.5000 to 39.5003 share one, 39.51 is twenty cells north.
    const cells = res.data.cells as { south: number; west: number; north: number; east: number; fixes: number; share: number; level: number }[];
    expect(cells.map((c) => [c.south, c.west, c.fixes])).toEqual([
      [39.5, 64.8, 16],
      [39.51, 64.8, 8],
    ]);
    expect(cells[0]).toMatchObject({ north: 39.5005, east: 64.8005 });
    expect(cells.reduce((sum, c) => sum + c.fixes, 0)).toBe(24);
    expect(cells[0]!.share).toBeCloseTo(16 / 24, 4);
    expect(cells[0]!.level).toBe(GRAZING_RULES.heatLevels);
    expect(cells[1]!.level).toBe(3);

    // The field: 4 sheep x 4 fixes, 4 sheep x 1.25 h, and each of the four was there over an hour.
    expect(res.data.fields).toHaveLength(1);
    const used = res.data.fields[0];
    expect(used).toMatchObject({ fieldId: field.id, number: 'Y-1', fixes: 16, animalDays: 4, animalHours: 5, daysUsed: 1 });
    expect(used.share).toBeCloseTo(16 / 24, 3);
    expect(used.animalDaysPerHa).toBe(Math.round((4 / used.areaHa) * 10) / 10);

    // Another herd has no positions: nothing, not zero.
    const other = (await x.owner.post('/livestock/herds', { name: "Qo'chqorlar" })).data.id as string;
    expect((await x.owner.get('/tracking/grazing', { days: '7', herdId: other })).data).toMatchObject({ totalFixes: null, cells: null, fields: null });
    expect((await x.owner.get('/tracking/grazing', { days: '14' })).status).toBe(400);

    // Another workspace sees none of it.
    const b = await farm(1);
    expect((await b.owner.get('/tracking/grazing', { days: '90' })).data.totalFixes).toBeNull();
  });

  it('ninety days of a whole farm is one read of the daily grid', async () => {
    const x = await farm(1);
    // 210 ha is about 880 cells of 0.0005°. Every one of them used on each of 90 days: 79 200 rows.
    const CELLS = 880;
    const DAYS = 90;
    await x.f.run(async () => {
      for (let d = 1; d <= DAYS; d += 1) {
        await tx()
          .insert(grazingCellDays)
          .values(
            Array.from({ length: CELLS }, (_, c) => ({
              tenantId: x.f.tenantId,
              farmId: x.f.farmId,
              date: addDays(todayIso(), -d),
              herdId: x.herdId,
              cellX: 129600 + (c % 40),
              cellY: 79000 + Math.floor(c / 40),
              fixes: 1 + (c % 7),
            })),
          );
      }
    });
    const perDay = Array.from({ length: CELLS }, (_, c) => 1 + (c % 7)).reduce((a, b) => a + b, 0);
    const started = performance.now();
    const res = await x.owner.get('/tracking/grazing', { days: '90' });
    const tookMs = performance.now() - started;
    expect(res.status).toBe(200);
    expect(res.data.daysWithData).toBe(DAYS);
    expect(res.data.totalFixes).toBe(perDay * DAYS);
    expect(res.data.cells).toHaveLength(CELLS);
    expect(res.data.truncated).toBe(false);
    console.info(`grazing: ${CELLS * DAYS} rows of grazing_cell_days read for 90 days in ${Math.round(tookMs)} ms`);
    expect(tookMs).toBeLessThan(5000);
    // A week reads a week of them.
    expect((await x.owner.get('/tracking/grazing', { days: '7' })).data.totalFixes).toBe(perDay * 7);
  });
});
