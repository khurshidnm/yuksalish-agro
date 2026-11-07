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
  /** Temperature readings in the last hour needed to judge a fever. */
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
  /** A tracker silent this long needs someone to look. */
  silentAfterMs: 2 * HOUR,
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
  /** Readings from the last hour, °C. */
  recent: readonly number[];
  /** The sheep's daily median temperature on previous days, °C. */
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
    const baseline = median(a.baselineDays)!;
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
