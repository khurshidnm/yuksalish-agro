/**
 * Live tracking of animals: distances from GPS fixes, and the health rules that read collars and
 * rumen boluses (docs/tracking.md).
 *
 * Every rule compares a sheep with its own herd at the same time, never with a fixed number alone.
 * A flock grazes, rests and heats up together, so the herd cancels out the weather, the time of day
 * and the scale of a vendor's activity counter. Same convention as index.ts: a result that would
 * need a guess is `null`, and the caller raises nothing.
 *
 * The thresholds are starting values, chosen to stay quiet rather than cry wolf. Tune them against
 * the pilot flock's own data before trusting them.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** One GPS position. `at` is milliseconds since the epoch. */
export interface Fix extends LatLng {
  at: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const TRACKING_RULES = {
  /** A herd needs this many sheep with fresh data before anyone in it can be compared with it. */
  minHerdTracked: 5,
  /** A fix older than this does not place the sheep now. */
  fixFreshMs: 30 * MINUTE,
  /** A sheep is apart from its flock beyond the larger of this distance... */
  isolationMinM: 300,
  /** ...and this many times the flock's median distance from its centre. */
  isolationSpreadFactor: 4,
  /** More than this share of the herd apart at once is a split flock, not stray sheep. */
  splitShare: 0.1,
  /** Inactivity is judged over this window, in daylight only. */
  inactiveWindowMs: 3 * HOUR,
  daytimeFromHour: 7,
  daytimeToHour: 20,
  /** Fixes needed in the window to judge movement. */
  inactiveMinFixes: 3,
  /** A sheep whose fixes stay this close to their own centre has not moved... */
  inactiveMaxRangeM: 25,
  /** ...while the herd's median sheep ranged at least this far. */
  inactiveHerdMinRangeM: 100,
  /** Activity readings needed in the window to judge the counter. */
  inactiveMinActivityReadings: 3,
  /** Below this share of the herd's median activity a sheep is idle. */
  inactiveActivityShare: 0.25,
  /**
   * A fever is judged over this window. A bolus speaks every 30 minutes and about one message in
   * fifty is lost, so two hours holds four readings and one lost message does not hide a fever.
   */
  feverWindowMs: 2 * HOUR,
  /** Temperature readings in the window needed to judge a fever. */
  feverMinReadings: 2,
  /** Days of a sheep's own readings needed before its normal is known. */
  feverMinBaselineDays: 3,
  /** A fever is this much above the herd now... */
  feverOverHerdC: 1.0,
  /** ...and this much above the sheep's own normal. */
  feverOverBaselineC: 0.8,
  /** This far above the herd the alert is urgent. */
  feverUrgentOverHerdC: 2.0,
  /** A walk faster than this between two fixes is GPS noise, not a sheep. */
  maxSpeedKmh: 10,
  /** Steps shorter than this are GPS jitter of a sheep standing still. */
  jitterM: 5,
  /** A collar silent this long needs someone to look. */
  silentAfterMs: 2 * HOUR,
  /**
   * A bolus speaks from inside the rumen and is heard only near a gateway, so it is quiet all the
   * while the flock grazes. One silent through a whole night in the barn needs someone to look.
   */
  bolusSilentAfterMs: 14 * HOUR,
  /** Battery below this needs replacing soon. */
  lowBatteryPct: 20,
} as const;

/** Mean Earth radius (IUGG), metres. */
export const EARTH_RADIUS_M = 6_371_008.8;

const RAD = Math.PI / 180;

/** Great-circle distance between two points, metres (haversine formula). */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Middle value; the mean of the two middle values for an even count. `null` for none. */
export function median(values: readonly number[]): number | null {
  const known = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (known.length === 0) return null;
  const mid = known.length >> 1;
  return known.length % 2 ? known[mid]! : (known[mid - 1]! + known[mid]!) / 2;
}

/** The value below which a share `q` (0 to 1) of the values fall, interpolated (type 7). `null` for none. */
export function quantile(values: readonly number[], q: number): number | null {
  const known = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (known.length === 0) return null;
  const pos = (known.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return known[lo]! + (known[hi]! - known[lo]!) * (pos - lo);
}

/**
 * Centre of a group of points: the median latitude and the median longitude. Unlike the mean,
 * one sheep far away does not drag the centre of the flock towards it.
 */
export function medianPoint(points: readonly LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  return { lat: median(points.map((p) => p.lat))!, lng: median(points.map((p) => p.lng))! };
}

/**
 * Distance walked along a track, metres. A step faster than `maxSpeedKmh` is a bad fix and is left
 * out, and so is a step shorter than `jitterM`. `null` with fewer than two fixes.
 */
export function trackDistanceM(fixes: readonly Fix[]): number | null {
  if (fixes.length < 2) return null;
  const sorted = [...fixes].sort((a, b) => a.at - b.at);
  const maxMps = (TRACKING_RULES.maxSpeedKmh * 1000) / 3600;
  let total = 0;
  let from = sorted[0]!;
  for (const to of sorted.slice(1)) {
    const seconds = (to.at - from.at) / 1000;
    if (seconds <= 0) continue;
    const step = haversineM(from, to);
    if (step / seconds > maxMps) continue; // the jump is the bad fix: keep walking from the last good one
    // Stay put until the sheep is clearly elsewhere, so a slow walk still adds up and jitter does not.
    if (step < TRACKING_RULES.jitterM) continue;
    total += step;
    from = to;
  }
  return total;
}

/** How far a sheep's fixes reach from their own centre, metres. `null` for no fixes. */
export function rangeM(fixes: readonly LatLng[]): number | null {
  const centre = medianPoint(fixes);
  if (!centre) return null;
  return Math.max(...fixes.map((f) => haversineM(centre, f)));
}

/** How long a tracker of this kind may stay silent before it counts as silent. */
export function silentAfterMsFor(kind: string | null | undefined): number {
  return kind === 'bolus' ? TRACKING_RULES.bolusSilentAfterMs : TRACKING_RULES.silentAfterMs;
}

/** Whether a local hour (0-23) is daylight for the inactivity rule. */
export function isDaytime(localHour: number): boolean {
  return localHour >= TRACKING_RULES.daytimeFromHour && localHour < TRACKING_RULES.daytimeToHour;
}

// ─── Apart from the flock ───────────────────────────────────────────────────

export interface AnimalFixes {
  animalId: string;
  /** Recent fixes, any order. */
  fixes: readonly Fix[];
}

export type IsolationResult =
  | {
      kind: 'ok';
      tracked: number;
      centre: LatLng;
      thresholdM: number;
      isolated: { animalId: string; distanceM: number }[];
    }
  | { kind: 'split'; tracked: number; centre: LatLng; thresholdM: number; apart: number };

/**
 * Sheep that are apart from their herd now. A sheep counts only when its last two fixes are both
 * beyond the threshold, so one bad fix raises nothing. `null` when fewer than `minHerdTracked`
 * sheep have a fresh fix.
 */
export function herdIsolation(animals: readonly AnimalFixes[], now: number): IsolationResult | null {
  const r = TRACKING_RULES;
  const fresh = animals
    .map((a) => ({ animalId: a.animalId, fixes: [...a.fixes].sort((x, y) => y.at - x.at) }))
    .filter((a) => a.fixes.length > 0 && now - a.fixes[0]!.at <= r.fixFreshMs);
  if (fresh.length < r.minHerdTracked) return null;

  const centre = medianPoint(fresh.map((a) => a.fixes[0]!))!;
  const distances = fresh.map((a) => haversineM(centre, a.fixes[0]!));
  const thresholdM = Math.max(r.isolationMinM, r.isolationSpreadFactor * median(distances)!);

  const isolated = fresh
    .map((a, i) => ({ a, distanceM: distances[i]! }))
    .filter(({ a, distanceM }) => distanceM > thresholdM && a.fixes.length >= 2 && haversineM(centre, a.fixes[1]!) > thresholdM)
    .map(({ a, distanceM }) => ({ animalId: a.animalId, distanceM }));

  if (isolated.length > Math.max(1, Math.floor(r.splitShare * fresh.length))) {
    return { kind: 'split', tracked: fresh.length, centre, thresholdM, apart: isolated.length };
  }
  return { kind: 'ok', tracked: fresh.length, centre, thresholdM, isolated };
}

// ─── Not moving ─────────────────────────────────────────────────────────────

export interface AnimalWindow {
  animalId: string;
  /** Fixes inside the inactivity window. */
  fixes: readonly LatLng[];
  /** Activity counter readings inside the window, in the device's own units. */
  activity: readonly number[];
}

export interface InactivityResult {
  /** The median sheep's range, metres, or null when too few sheep had enough fixes. */
  herdRangeM: number | null;
  /** The median sheep's mean activity, or null when too few sheep had enough readings. */
  herdActivity: number | null;
  inactive: { animalId: string; rangeM: number | null; activity: number | null }[];
}

/**
 * Sheep that stood still while their herd moved. Two signs: GPS range and the activity counter.
 * When a sheep has both, both must say it is still, because a collar that lost its view of the sky
 * can look still while the sheep walks. Call it in daylight only (`isDaytime`). `null` when the
 * herd has too few sheep with data for either sign.
 */
export function herdInactivity(animals: readonly AnimalWindow[]): InactivityResult | null {
  const r = TRACKING_RULES;
  const ranges = new Map<string, number>();
  for (const a of animals) {
    if (a.fixes.length >= r.inactiveMinFixes) ranges.set(a.animalId, rangeM(a.fixes)!);
  }
  const activities = new Map<string, number>();
  for (const a of animals) {
    const known = a.activity.filter((v) => Number.isFinite(v) && v >= 0);
    if (known.length >= r.inactiveMinActivityReadings) activities.set(a.animalId, known.reduce((s, v) => s + v, 0) / known.length);
  }

  const herdRangeM = ranges.size >= r.minHerdTracked ? median([...ranges.values()]) : null;
  const herdActivity = activities.size >= r.minHerdTracked ? median([...activities.values()]) : null;
  if (herdRangeM === null && herdActivity === null) return null;

  const herdMoved = herdRangeM !== null && herdRangeM >= r.inactiveHerdMinRangeM;
  const herdActive = herdActivity !== null && herdActivity > 0;

  const inactive: InactivityResult['inactive'] = [];
  for (const a of animals) {
    const range = ranges.get(a.animalId) ?? null;
    const activity = activities.get(a.animalId) ?? null;
    const stillByGps = range !== null && herdMoved ? range < r.inactiveMaxRangeM : null;
    const stillByCounter = activity !== null && herdActive ? activity < r.inactiveActivityShare * herdActivity! : null;
    const signs = [stillByGps, stillByCounter].filter((s): s is boolean => s !== null);
    if (signs.length > 0 && signs.every(Boolean)) inactive.push({ animalId: a.animalId, rangeM: range, activity });
  }
  return { herdRangeM, herdActivity, inactive };
}

// ─── Fever ──────────────────────────────────────────────────────────────────

export interface AnimalTemperatures {
  animalId: string;
  /** Readings from the last `feverWindowMs`, °C. */
  recent: readonly number[];
  /** The sheep's daily median temperature on previous days, °C. Its normal is their lower quarter. */
  baselineDays: readonly number[];
}

export interface FeverResult {
  herdMedianC: number;
  fever: { animalId: string; medianC: number; overHerdC: number; overBaselineC: number; urgent: boolean }[];
}

/**
 * Sheep running a temperature: above the herd right now and above their own normal. A hot day lifts
 * the whole herd and so raises nothing; water drunk lowers a reading, and the median drops it.
 * A sheep needs `feverMinBaselineDays` of its own history first. `null` when too few sheep in the
 * herd have recent readings.
 */
export function herdFever(animals: readonly AnimalTemperatures[]): FeverResult | null {
  const r = TRACKING_RULES;
  const medians = animals
    .map((a) => ({ a, medianC: a.recent.length >= r.feverMinReadings ? median(a.recent) : null }))
    .filter((x): x is { a: AnimalTemperatures; medianC: number } => x.medianC !== null);
  if (medians.length < r.minHerdTracked) return null;

  const herdMedianC = median(medians.map((x) => x.medianC))!;
  const fever: FeverResult['fever'] = [];
  for (const { a, medianC } of medians) {
    if (a.baselineDays.length < r.feverMinBaselineDays) continue;
    // The lower quarter of its days, not the middle: a sheep ill for days would otherwise make
    // its fever its normal, and the fever would vanish.
    const baseline = quantile(a.baselineDays, 0.25)!;
    const overHerdC = medianC - herdMedianC;
    const overBaselineC = medianC - baseline;
    if (overHerdC >= r.feverOverHerdC && overBaselineC >= r.feverOverBaselineC) {
      fever.push({ animalId: a.animalId, medianC, overHerdC, overBaselineC, urgent: overHerdC >= r.feverUrgentOverHerdC });
    }
  }
  return { herdMedianC, fever };
}

// ─── One day of one sheep ───────────────────────────────────────────────────

export interface DayReading {
  at: number;
  lat: number | null;
  lng: number | null;
  activity: number | null;
  temperatureC: number | null;
}

export interface DaySummary {
  fixes: number;
  distanceM: number | null;
  activityMean: number | null;
  temperatureMedianC: number | null;
  temperatureMaxC: number | null;
}

/** The daily figures kept after the raw readings expire. */
export function daySummary(readings: readonly DayReading[]): DaySummary {
  const fixes = readings.filter((r): r is DayReading & LatLng => r.lat !== null && r.lng !== null);
  const activity = readings.map((r) => r.activity).filter((v): v is number => v !== null && Number.isFinite(v));
  const temps = readings.map((r) => r.temperatureC).filter((v): v is number => v !== null && Number.isFinite(v));
  return {
    fixes: fixes.length,
    distanceM: trackDistanceM(fixes),
    activityMean: activity.length ? activity.reduce((s, v) => s + v, 0) / activity.length : null,
    temperatureMedianC: median(temps),
    temperatureMaxC: temps.length ? Math.max(...temps) : null,
  };
}

// ─── Zones ──────────────────────────────────────────────────────────────────

/**
 * A GeoJSON Polygon or MultiPolygon, positions as [longitude, latitude]. The same shape a field's
 * boundary is stored in, so a zone can borrow a field's outline or carry its own.
 */
export interface AreaGeometry {
  type: string;
  coordinates: unknown;
}

type Position = readonly number[];
type Ring = readonly Position[];

/** Every polygon of a geometry as its rings: the outer ring first, then holes. */
function polygonsOf(geometry: AreaGeometry | null | undefined): Ring[][] {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return (polygons as unknown[]).flatMap((rings) =>
    Array.isArray(rings) && rings.every((ring) => Array.isArray(ring) && ring.every(isPosition)) ? [rings as Ring[]] : [],
  );
}

const isPosition = (p: unknown): p is Position =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

/** What is wrong with a drawn outline, in the order a person would fix it. */
export type AreaProblem = 'shape' | 'points' | 'open' | 'crossing' | 'flat';

const orient = (a: Position, b: Position, c: Position) => Math.sign((b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!));
const between = (a: Position, b: Position, p: Position) =>
  Math.min(a[0]!, b[0]!) <= p[0]! && p[0]! <= Math.max(a[0]!, b[0]!) && Math.min(a[1]!, b[1]!) <= p[1]! && p[1]! <= Math.max(a[1]!, b[1]!);

/** Whether two segments share any point. */
function segmentsMeet(a: Position, b: Position, c: Position, d: Position): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && between(a, b, c)) || (o2 === 0 && between(a, b, d)) || (o3 === 0 && between(c, d, a)) || (o4 === 0 && between(c, d, b));
}

/**
 * Why an outline cannot be a zone, or `null` when it can: it must be a Polygon or MultiPolygon
 * ('shape'), each ring needs at least three corners with coordinates on the globe ('points') and
 * must end where it began ('open'), no two of its sides may cross or touch ('crossing'), and it
 * must enclose some area ('flat'). A figure of eight has no inside to be in or out of.
 */
export function areaProblem(geometry: AreaGeometry | null | undefined): AreaProblem | null {
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') || !Array.isArray(geometry.coordinates)) return 'shape';
  const polygons = polygonsOf(geometry);
  const expected = geometry.type === 'Polygon' ? 1 : geometry.coordinates.length;
  if (expected === 0) return 'shape';
  if (polygons.length !== expected) return 'points';
  for (const rings of polygons) {
    if (rings.length === 0) return 'shape';
    for (const ring of rings) {
      if (ring.length < 4) return 'points';
      const first = ring[0]!;
      const last = ring[ring.length - 1]!;
      if (first[0] !== last[0] || first[1] !== last[1]) return 'open';
      const sides = ring.length - 1;
      for (let i = 0; i < sides; i += 1) {
        for (let j = i + 1; j < sides; j += 1) {
          const neighbours = j === i + 1 || (i === 0 && j === sides - 1);
          if (!neighbours && segmentsMeet(ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!)) return 'crossing';
        }
      }
      // Shoelace formula, in squared degrees, from the first corner. Only whether it is nothing
      // matters here, and nothing is measured against the outline's own length, because corners
      // on one line still leave a rounding error behind.
      let twiceArea = 0;
      let around = 0;
      for (let i = 0; i < sides; i += 1) {
        around += Math.hypot(ring[i + 1]![0]! - ring[i]![0]!, ring[i + 1]![1]! - ring[i]![1]!);
        twiceArea += (ring[i]![0]! - first[0]!) * (ring[i + 1]![1]! - first[1]!) - (ring[i + 1]![0]! - first[0]!) * (ring[i]![1]! - first[1]!);
      }
      if (Math.abs(twiceArea) <= 1e-9 * around * around) return 'flat';
    }
  }
  return null;
}

/**
 * How far a point is from the edge of an area, metres: negative inside, positive outside. Holes
 * are outside. The outline is laid flat around the point (one degree of longitude is cos φ of a
 * degree of latitude), which is exact to centimetres over a farm. `null` when the geometry has no
 * outline to measure against.
 */
export function signedDistanceM(point: LatLng, geometry: AreaGeometry | null | undefined): number | null {
  const kx = RAD * EARTH_RADIUS_M * Math.cos(point.lat * RAD);
  const ky = RAD * EARTH_RADIUS_M;
  let inside = false;
  let nearest = Infinity;
  for (const rings of polygonsOf(geometry)) {
    let within = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const ax = (ring[j]![0]! - point.lng) * kx;
        const ay = (ring[j]![1]! - point.lat) * ky;
        const bx = (ring[i]![0]! - point.lng) * kx;
        const by = (ring[i]![1]! - point.lat) * ky;
        // A ray east from the point crosses this side: an odd number of crossings is inside.
        if (ay > 0 !== by > 0 && ax + ((bx - ax) * -ay) / (by - ay) > 0) within = !within;
        const dx = bx - ax;
        const dy = by - ay;
        const length2 = dx * dx + dy * dy;
        const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / length2));
        nearest = Math.min(nearest, Math.hypot(ax + t * dx, ay + t * dy));
      }
    }
    if (within) inside = true;
  }
  if (nearest === Infinity) return null;
  return inside ? -nearest : nearest;
}

/** Whether a point is inside an area. `null` when the geometry has no outline. */
export function insideArea(point: LatLng, geometry: AreaGeometry | null | undefined): boolean | null {
  const d = signedDistanceM(point, geometry);
  return d === null ? null : d < 0;
}

/**
 * Starting values for the zone rule, to be tuned on the pilot flock. A collar's fix is good to
 * about 5 to 10 m under open sky and worse beside a wall, so the line is crossed only well past it.
 */
export const ZONE_RULES = {
  /** A fix counts as over the line only this far past it, metres: GPS jitter must not raise anything. */
  bufferM: 30,
  /** This many fixes in a row over the line before a sheep is out of its zone. */
  exitFixes: 2,
} as const;

export type ZoneKind = 'allowed' | 'forbidden';

export interface Zone {
  id: string;
  name: string;
  kind: ZoneKind;
  /** The herd the zone is for; `null` is every herd. */
  herdId: string | null;
  geometry: AreaGeometry | null;
}

export interface ZoneBreach {
  /** `outside`: beyond every allowed zone. `inside`: within a forbidden one. */
  kind: 'outside' | 'inside';
  /** The allowed zone it is nearest to, or the forbidden zone it is in. */
  zoneId: string;
  zoneName: string;
  /** How far past the line, metres. */
  distanceM: number;
}

/** The zones that bind a herd: its own and those for every herd. A sheep without a herd has only the latter. */
export function zonesFor<Z extends { herdId: string | null }>(zones: readonly Z[], herdId: string | null): Z[] {
  return zones.filter((z) => z.herdId === null || z.herdId === herdId);
}

/**
 * Whether one position breaks the zones given: inside a forbidden zone by more than the buffer, or,
 * when there is at least one allowed zone, outside all of them by more than the buffer. A forbidden
 * zone wins over an allowed one that contains it. Zones without an outline are left out. `null`
 * when nothing is broken.
 */
export function zoneBreach(point: LatLng, zones: readonly Zone[]): ZoneBreach | null {
  let nearestAllowed: ZoneBreach | null = null;
  let deepest: ZoneBreach | null = null;
  let insideAllowed = false;
  for (const zone of zones) {
    const d = signedDistanceM(point, zone.geometry);
    if (d === null) continue;
    if (zone.kind === 'forbidden') {
      if (d < -ZONE_RULES.bufferM && (!deepest || -d > deepest.distanceM)) deepest = { kind: 'inside', zoneId: zone.id, zoneName: zone.name, distanceM: -d };
    } else if (d <= ZONE_RULES.bufferM) {
      insideAllowed = true;
    } else if (!nearestAllowed || d < nearestAllowed.distanceM) {
      nearestAllowed = { kind: 'outside', zoneId: zone.id, zoneName: zone.name, distanceM: d };
    }
  }
  if (deepest) return deepest;
  return insideAllowed ? null : nearestAllowed;
}

export interface ZoneVerdict {
  out: boolean;
  /** The breach at the latest fix when `out`. */
  breach: ZoneBreach | null;
}

/**
 * Whether a sheep is out of its zone now: its last `exitFixes` fixes all break the zones, so one
 * bad fix raises nothing, and one good fix clears it. With no zone that has an outline nothing can
 * be broken and the answer is "no". `null` when the latest fix is stale, or when it is over the
 * line and there are not yet enough fixes to be sure.
 */
export function outOfZone(fixes: readonly Fix[], zones: readonly Zone[], now: number): ZoneVerdict | null {
  const bounded = zones.filter((z) => signedDistanceM({ lat: 0, lng: 0 }, z.geometry) !== null);
  if (bounded.length === 0) return { out: false, breach: null };
  const latest = [...fixes].sort((a, b) => b.at - a.at).slice(0, ZONE_RULES.exitFixes);
  if (latest.length === 0 || now - latest[0]!.at > TRACKING_RULES.fixFreshMs) return null;
  const breaches = latest.map((fix) => zoneBreach(fix, bounded));
  if (breaches.some((b) => b === null)) return { out: false, breach: null };
  if (latest.length < ZONE_RULES.exitFixes) return null;
  return { out: true, breach: breaches[0]! };
}

// ─── Movement at night ──────────────────────────────────────────────────────

/**
 * Starting values for the night rule, to be tuned on the pilot flock. A flock penned for the night
 * shuffles a few metres; its centre does not travel. A centre that does is a gate left open, a
 * predator, or theft.
 */
export const NIGHT_RULES = {
  /** Night begins at this local hour... */
  fromHour: 22,
  /** ...and ends at this one. */
  toHour: 5,
  /** Movement is judged over this long, or since night began when that is shorter. */
  windowMs: 2 * HOUR,
  /** The herd's centre moved farther than this over the window, metres... */
  maxMoveM: 400,
  /** ...or faster than this between its last two fixes, km/h. */
  maxSpeedKmh: 1,
  /** Two fixes closer in time than this give no speed: metres of jitter over seconds look like a gallop. */
  minStepMs: 10 * MINUTE,
} as const;

/** Whether a local hour (0-23) is night for the movement rule. The hours may wrap past midnight. */
export function isNight(localHour: number): boolean {
  const { fromHour, toHour } = NIGHT_RULES;
  return fromHour <= toHour ? localHour >= fromHour && localHour < toHour : localHour >= fromHour || localHour < toHour;
}

/** How long ago this night began, from the local clock; `null` by day. */
export function nightElapsedMs(localHour: number, localMinute: number): number | null {
  if (!isNight(localHour)) return null;
  const hours = (localHour - NIGHT_RULES.fromHour + 24) % 24;
  return hours * HOUR + localMinute * MINUTE;
}

export interface NightMovement {
  /** Sheep with a fresh fix and at least two fixes in the window. */
  tracked: number;
  /** How far the herd's centre is from where it was at the start of the window, metres. */
  movedM: number;
  /** The centre's speed between the last two fixes, km/h; `null` when they are too close in time. */
  speedKmh: number | null;
  moved: boolean;
  /** Which threshold was passed. */
  reason: 'far' | 'fast' | 'both' | null;
  from: LatLng;
  to: LatLng;
}

/**
 * Whether a herd is on the move at night. Only fixes since `nightStart` count, so the walk home at
 * dusk is not held against it. The centre is the median sheep, so a few strays do not move it.
 * `null` when fewer than `minHerdTracked` sheep have a fresh fix and an earlier one tonight.
 */
export function nightMovement(animals: readonly AnimalFixes[], now: number, nightStart: number): NightMovement | null {
  const n = NIGHT_RULES;
  const since = Math.max(nightStart, now - n.windowMs);
  const tracks = animals
    .map((a) => a.fixes.filter((f) => f.at >= since && f.at <= now).sort((x, y) => x.at - y.at))
    .filter((fixes) => fixes.length >= 2 && now - fixes[fixes.length - 1]!.at <= TRACKING_RULES.fixFreshMs);
  if (tracks.length < TRACKING_RULES.minHerdTracked) return null;

  const from = medianPoint(tracks.map((t) => t[0]!))!;
  const before = medianPoint(tracks.map((t) => t[t.length - 2]!))!;
  const to = medianPoint(tracks.map((t) => t[t.length - 1]!))!;
  const movedM = haversineM(from, to);
  const stepMs = median(tracks.map((t) => t[t.length - 1]!.at - t[t.length - 2]!.at))!;
  const speedKmh = stepMs >= n.minStepMs ? haversineM(before, to) / 1000 / (stepMs / HOUR) : null;
  const far = movedM > n.maxMoveM;
  const fast = speedKmh !== null && speedKmh > n.maxSpeedKmh;
  return { tracked: tracks.length, movedM, speedKmh, moved: far || fast, reason: far && fast ? 'both' : far ? 'far' : fast ? 'fast' : null, from, to };
}

// ─── Last seen ──────────────────────────────────────────────────────────────

export interface TrackedNow {
  animalId: string;
  herdId: string | null;
  lat: number | null;
  lng: number | null;
  /** When the position was taken, ms; `null` when it never had one. */
  positionAt: number | null;
  /** When any of its trackers last spoke, ms; `null` when none ever did. */
  lastReadingAt: number | null;
  /** Every tracker on it is silent past its threshold (`silentAfterMsFor`). */
  silent: boolean;
  /** Flagged apart from its herd. */
  isolated: boolean;
}

export interface LastSeen {
  animalId: string;
  reason: 'silent' | 'isolated' | 'both';
  /** Time since any tracker on it spoke, ms. */
  sinceContactMs: number | null;
  /** Age of the position, ms; `null` when it never had one. */
  sincePositionMs: number | null;
  /** From its last position to its herd's centre now, metres; `null` when either is unknown. */
  distanceFromHerdM: number | null;
}

/**
 * The animals to go and look for: silent past the threshold, or apart from the herd. A tracker
 * that never spoke is not here, because there is no last place to look. Those apart from the herd
 * come first (they can be walked to now), then the longest silent.
 */
export function lastSeenList(animals: readonly TrackedNow[], herdCentres: ReadonlyMap<string, LatLng>, now: number): LastSeen[] {
  return animals
    .filter((a) => a.isolated || (a.silent && a.lastReadingAt !== null))
    .map((a): LastSeen => {
      const centre = a.herdId ? herdCentres.get(a.herdId) : undefined;
      return {
        animalId: a.animalId,
        reason: a.isolated && a.silent ? 'both' : a.isolated ? 'isolated' : 'silent',
        sinceContactMs: a.lastReadingAt === null ? null : now - a.lastReadingAt,
        sincePositionMs: a.positionAt === null ? null : now - a.positionAt,
        distanceFromHerdM: centre && a.lat !== null && a.lng !== null ? haversineM(centre, { lat: a.lat, lng: a.lng }) : null,
      };
    })
    .sort((x, y) => Number(y.reason !== 'silent') - Number(x.reason !== 'silent') || (y.sinceContactMs ?? 0) - (x.sinceContactMs ?? 0));
}
