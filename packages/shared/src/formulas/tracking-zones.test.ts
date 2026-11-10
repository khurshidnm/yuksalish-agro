import { describe, expect, it } from 'vitest';
import {
  areaProblem,
  insideArea,
  isNight,
  lastSeenList,
  nightElapsedMs,
  nightMovement,
  outOfZone,
  signedDistanceM,
  zoneBreach,
  zonesFor,
  type AnimalFixes,
  type AreaGeometry,
  type Fix,
  type TrackedNow,
  type Zone,
} from './tracking';

/**
 * Control numbers by hand. One degree of latitude is R · π / 180 = 111 195.08 m, so 0.001° is
 * 111.195 m. At 39° N one degree of longitude is that times cos 39° = 0.777146: 86 414.8 m, so
 * 0.001° of longitude is 86.41 m.
 */
const PER_DEGREE = 111_195.08;
const LAT = 39.0;
const LNG = 64.8;
const MIN = 60_000;
const NOW = Date.UTC(2026, 5, 1, 19, 0); // midnight in Tashkent

/** A square from (dLat, dLng) with sides of `size` degrees: 0.002° is 222.39 m tall and 172.83 m wide. */
const square = (dLat = 0, dLng = 0, size = 0.002): number[][] => [
  [LNG + dLng, LAT + dLat],
  [LNG + dLng + size, LAT + dLat],
  [LNG + dLng + size, LAT + dLat + size],
  [LNG + dLng, LAT + dLat + size],
  [LNG + dLng, LAT + dLat],
];
const polygon = (...rings: number[][][]): AreaGeometry => ({ type: 'Polygon', coordinates: rings });
const FIELD = polygon(square());
const at = (dLat: number, dLng = 0) => ({ lat: LAT + dLat, lng: LNG + dLng });

describe('signedDistanceM', () => {
  it('is negative inside: the centre of the square is 86.41 m from its east and west sides', () => {
    expect(signedDistanceM(at(0.001, 0.001), FIELD)).toBeCloseTo(-86.41, 1);
  });

  it('is positive outside: 0.0005° north of the north side is 55.60 m', () => {
    expect(signedDistanceM(at(0.0025, 0.001), FIELD)).toBeCloseTo(0.0005 * PER_DEGREE, 1);
  });

  it('measures to a corner: 0.0003° north (33.36 m) and 0.0004° east (34.57 m) of it is 48.04 m', () => {
    expect(signedDistanceM(at(0.0023, 0.0024), FIELD)).toBeCloseTo(48.04, 1);
  });

  it('a hole is outside: its centre is 0.0002° of longitude (17.28 m) from the hole edge', () => {
    const holed = polygon(square(), square(0.0008, 0.0008, 0.0004));
    expect(signedDistanceM(at(0.001, 0.001), holed)).toBeCloseTo(17.28, 1);
    expect(insideArea(at(0.001, 0.001), holed)).toBe(false);
    expect(insideArea(at(0.0004, 0.0004), holed)).toBe(true);
  });

  it('a multipolygon is inside when any part holds the point', () => {
    const two: AreaGeometry = { type: 'MultiPolygon', coordinates: [[square()], [square(0.01, 0.01)]] };
    expect(insideArea(at(0.011, 0.011), two)).toBe(true);
    expect(insideArea(at(0.005, 0.005), two)).toBe(false);
  });

  it('has no answer without an outline', () => {
    expect(signedDistanceM(at(0, 0), null)).toBeNull();
    expect(signedDistanceM(at(0, 0), { type: 'Point', coordinates: [LNG, LAT] })).toBeNull();
    expect(insideArea(at(0, 0), { type: 'Polygon', coordinates: [] })).toBeNull();
  });
});

describe('areaProblem', () => {
  it('accepts a square, with a hole or as a multipolygon', () => {
    expect(areaProblem(FIELD)).toBeNull();
    expect(areaProblem(polygon(square(), square(0.0008, 0.0008, 0.0004)))).toBeNull();
    expect(areaProblem({ type: 'MultiPolygon', coordinates: [[square()], [square(0.01, 0.01)]] })).toBeNull();
  });

  it('names what is wrong', () => {
    expect(areaProblem(null)).toBe('shape');
    expect(areaProblem({ type: 'LineString', coordinates: square() })).toBe('shape');
    expect(areaProblem({ type: 'MultiPolygon', coordinates: [] })).toBe('shape');
    expect(areaProblem(polygon(square().slice(0, 3)))).toBe('points');
    expect(areaProblem(polygon([[LNG, 95], [LNG + 1, 95], [LNG + 1, 96], [LNG, 95]]))).toBe('points');
    expect(areaProblem(polygon(square().slice(0, 4)))).toBe('open');
  });

  it('refuses a figure of eight: the first and third sides cross in the middle', () => {
    const bowTie = [[LNG, LAT], [LNG + 0.002, LAT + 0.002], [LNG + 0.002, LAT], [LNG, LAT + 0.002], [LNG, LAT]];
    expect(areaProblem(polygon(bowTie))).toBe('crossing');
  });

  it('refuses three corners on one line', () => {
    expect(areaProblem(polygon([[LNG, LAT], [LNG + 0.001, LAT + 0.001], [LNG + 0.002, LAT + 0.002], [LNG, LAT]]))).toBe('flat');
  });
});

const zone = (id: string, kind: Zone['kind'], geometry: AreaGeometry | null, herdId: string | null = null): Zone => ({ id, name: id, kind, herdId, geometry });
const HOME = zone('home', 'allowed', FIELD);

describe('zoneBreach', () => {
  it('is quiet within the 30 m buffer: 0.00018° north of the line is 20.0 m out', () => {
    expect(zoneBreach(at(0.00218, 0.001), [HOME])).toBeNull();
  });

  it('is a breach 55.6 m past the line of the only allowed zone', () => {
    expect(zoneBreach(at(0.0025, 0.001), [HOME])).toMatchObject({ kind: 'outside', zoneId: 'home' });
    expect(zoneBreach(at(0.0025, 0.001), [HOME])!.distanceM).toBeCloseTo(55.6, 1);
  });

  it('is quiet in a second allowed zone, and names the nearest zone when out of both', () => {
    const far = zone('far', 'allowed', polygon(square(0.01, 0)));
    expect(zoneBreach(at(0.011, 0.001), [HOME, far])).toBeNull();
    // 0.0030° north of home's north side (333.6 m), 0.0050° south of far's south side (556.0 m)
    expect(zoneBreach(at(0.005, 0.001), [HOME, far])).toMatchObject({ kind: 'outside', zoneId: 'home' });
  });

  it('a forbidden zone inside an allowed one wins, once the sheep is more than 30 m into it', () => {
    const crop = zone('crop', 'forbidden', polygon(square(0, 0, 0.001))); // 111.2 m tall, 86.4 m wide
    // The centre is 43.2 m from its east and west sides.
    expect(zoneBreach(at(0.0005, 0.0005), [HOME, crop])).toMatchObject({ kind: 'inside', zoneId: 'crop' });
    expect(zoneBreach(at(0.0005, 0.0005), [HOME, crop])!.distanceM).toBeCloseTo(43.21, 1);
    // 0.0001° of latitude (11.1 m) inside its north side: still within the buffer.
    expect(zoneBreach(at(0.0009, 0.0005), [HOME, crop])).toBeNull();
  });

  it('with only a forbidden zone, anywhere outside it is fine', () => {
    expect(zoneBreach(at(0.5, 0.5), [zone('crop', 'forbidden', FIELD)])).toBeNull();
  });
});

describe('outOfZone', () => {
  const fix = (minutesAgo: number, out: boolean): Fix => ({ ...at(out ? 0.0025 : 0.001, 0.001), at: NOW - minutesAgo * MIN });

  it('needs two fixes in a row past the line', () => {
    expect(outOfZone([fix(15, true), fix(0, true)], [HOME], NOW)).toMatchObject({ out: true, breach: { kind: 'outside', zoneId: 'home' } });
    expect(outOfZone([fix(15, false), fix(0, true)], [HOME], NOW)).toEqual({ out: false, breach: null });
  });

  it('one fix inside clears it', () => {
    expect(outOfZone([fix(30, true), fix(15, true), fix(0, false)], [HOME], NOW)).toEqual({ out: false, breach: null });
  });

  it('cannot tell from one fix past the line, or from a stale one', () => {
    expect(outOfZone([fix(0, true)], [HOME], NOW)).toBeNull();
    expect(outOfZone([fix(60, true), fix(45, true)], [HOME], NOW)).toBeNull();
    expect(outOfZone([], [HOME], NOW)).toBeNull();
  });

  it('nothing can be broken without a zone that has an outline', () => {
    expect(outOfZone([fix(15, true), fix(0, true)], [], NOW)).toEqual({ out: false, breach: null });
    expect(outOfZone([fix(15, true), fix(0, true)], [zone('empty', 'allowed', null)], NOW)).toEqual({ out: false, breach: null });
  });

  it('zonesFor keeps a herd its own zones and those for every herd', () => {
    const zones = [zone('all', 'allowed', FIELD), zone('a', 'allowed', FIELD, 'herd-a'), zone('b', 'forbidden', FIELD, 'herd-b')];
    expect(zonesFor(zones, 'herd-a').map((z) => z.id)).toEqual(['all', 'a']);
    expect(zonesFor(zones, null).map((z) => z.id)).toEqual(['all']);
  });
});

describe('night', () => {
  it('runs from 22:00 to 05:00', () => {
    expect([21, 22, 23, 0, 4, 5, 12].map(isNight)).toEqual([false, true, true, true, true, false, false]);
    expect(nightElapsedMs(22, 30)).toBe(30 * MIN);
    expect(nightElapsedMs(1, 15)).toBe(195 * MIN);
    expect(nightElapsedMs(12, 0)).toBeNull();
  });

  /** Six sheep side by side with a fix every 15 minutes; `north[i]` is how far north the flock stood at fix i, degrees. */
  const herd = (north: number[], size = 6): AnimalFixes[] =>
    Array.from({ length: size }, (_, sheep) => ({
      animalId: `s${sheep}`,
      fixes: north.map((dLat, i) => ({ ...at(dLat, sheep * 0.00001), at: NOW - (north.length - 1 - i) * 15 * MIN })),
    }));
  const NIGHT_START = NOW - 120 * MIN;

  it('a penned flock has not moved', () => {
    expect(nightMovement(herd([0, 0, 0, 0]), NOW, NIGHT_START)).toMatchObject({ tracked: 6, movedM: 0, speedKmh: 0, moved: false, reason: null });
  });

  it('a slow drift of 333.6 m in 45 minutes at 0.44 km/h passes neither threshold', () => {
    const m = nightMovement(herd([0, 0.001, 0.002, 0.003]), NOW, NIGHT_START)!;
    expect(m.movedM).toBeCloseTo(0.003 * PER_DEGREE, 0); // 333.6 m
    expect(m.speedKmh).toBeCloseTo(0.4448, 3); // 111.195 m in a quarter of an hour
    expect(m.moved).toBe(false);
  });

  it('farther: 500.4 m in 45 minutes, at 0.67 km/h', () => {
    const m = nightMovement(herd([0, 0.0015, 0.003, 0.0045]), NOW, NIGHT_START)!;
    expect(m.movedM).toBeCloseTo(500.4, 0);
    expect(m.speedKmh).toBeCloseTo(0.667, 2);
    expect(m).toMatchObject({ moved: true, reason: 'far' });
  });

  it('faster: still, then 333.6 m in 15 minutes is 1.33 km/h', () => {
    const m = nightMovement(herd([0, 0, 0, 0.003]), NOW, NIGHT_START)!;
    expect(m.movedM).toBeCloseTo(333.6, 0);
    expect(m.speedKmh).toBeCloseTo(1.334, 2);
    expect(m).toMatchObject({ moved: true, reason: 'fast' });
  });

  it('both: 1000.8 m in 45 minutes at 1.33 km/h', () => {
    expect(nightMovement(herd([0, 0.003, 0.006, 0.009]), NOW, NIGHT_START)).toMatchObject({ moved: true, reason: 'both' });
  });

  it('the walk home before night began is not held against the flock', () => {
    // Night began 20 minutes ago: only the last two fixes count, and between them it stood still.
    expect(nightMovement(herd([0.02, 0.01, 0, 0]), NOW, NOW - 20 * MIN)).toMatchObject({ movedM: 0, moved: false });
  });

  it('two strays out of six do not move the centre', () => {
    const flock = herd([0, 0, 0, 0]);
    for (const stray of flock.slice(0, 2)) stray.fixes = stray.fixes.map((f, i) => ({ ...f, lat: f.lat + i * 0.01 }));
    expect(nightMovement(flock, NOW, NIGHT_START)).toMatchObject({ movedM: 0, moved: false });
  });

  it('has no answer for four sheep, for stale fixes, or for one fix each since night began', () => {
    expect(nightMovement(herd([0, 0.003, 0.006, 0.009], 4), NOW, NIGHT_START)).toBeNull();
    expect(nightMovement(herd([0, 0.003, 0.006, 0.009]), NOW + 45 * MIN, NIGHT_START)).toBeNull();
    expect(nightMovement(herd([0, 0.003, 0.006, 0.009]), NOW, NOW - 10 * MIN)).toBeNull();
  });
});

describe('lastSeenList', () => {
  const HOUR = 60 * MIN;
  const animal = (animalId: string, over: Partial<TrackedNow>): TrackedNow => ({
    animalId,
    herdId: 'h',
    lat: LAT,
    lng: LNG,
    positionAt: NOW - 5 * MIN,
    lastReadingAt: NOW - 5 * MIN,
    silent: false,
    isolated: false,
    ...over,
  });
  const centres = new Map([['h', { lat: LAT, lng: LNG }]]);

  it('lists the silent and the strays, strays first, with the distance from the herd centre', () => {
    const list = lastSeenList(
      [
        animal('fine', {}),
        animal('silent3h', { silent: true, lat: LAT + 0.002, positionAt: NOW - 3 * HOUR, lastReadingAt: NOW - 3 * HOUR }),
        animal('silent9h', { silent: true, herdId: null, positionAt: NOW - 9 * HOUR, lastReadingAt: NOW - 9 * HOUR }),
        animal('stray', { isolated: true, lat: LAT + 0.005 }),
        animal('never', { silent: true, lat: null, lng: null, positionAt: null, lastReadingAt: null }),
      ],
      centres,
      NOW,
    );
    expect(list.map((x) => x.animalId)).toEqual(['stray', 'silent9h', 'silent3h']);
    expect(list[0]).toMatchObject({ reason: 'isolated', sinceContactMs: 5 * MIN });
    expect(list[0]!.distanceFromHerdM).toBeCloseTo(0.005 * PER_DEGREE, 0); // 556.0 m
    expect(list[1]).toMatchObject({ reason: 'silent', sinceContactMs: 9 * HOUR, distanceFromHerdM: null }); // no herd, no centre
    expect(list[2]!.distanceFromHerdM).toBeCloseTo(222.39, 1);
    expect(list[2]).toMatchObject({ sincePositionMs: 3 * HOUR });
  });

  it('a stray whose collar then went silent is both', () => {
    expect(lastSeenList([animal('x', { isolated: true, silent: true })], centres, NOW)[0]!.reason).toBe('both');
  });
});
