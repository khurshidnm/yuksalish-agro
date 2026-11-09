/**
 * Weather turned into farm decisions: reference evapotranspiration, heat stress in sheep,
 * spraying windows and frost.
 *
 * Equation numbers refer to FAO Irrigation and Drainage Paper 56 (Allen, Pereira, Raes and Smith,
 * 1998, "Crop evapotranspiration"). Same convention as index.ts: a missing reading is `null`,
 * and a result that would need a guess is `null` too.
 */
import { diffDays } from '../dates';

function known(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

/** Relative humidity above 100 % (sensor overshoot) is read as 100, below 0 as 0. */
function clampRh(rhPct: number): number {
  return Math.min(100, Math.max(0, rhPct));
}

// ─── FAO-56 building blocks ─────────────────────────────────────────────────

/** Solar constant, MJ/m²/min (FAO-56 eq. 21). */
const SOLAR_CONSTANT = 0.082;
/** Stefan-Boltzmann constant, MJ/K⁴/m²/day (FAO-56 eq. 39). */
const STEFAN_BOLTZMANN = 4.903e-9;
/** Albedo of the hypothetical grass reference crop (FAO-56 eq. 38). */
const REFERENCE_ALBEDO = 0.23;

/** Saturation vapour pressure at air temperature `tC`, kPa (FAO-56 eq. 11). */
export function saturationVapourPressure(tC: number): number {
  return 0.6108 * Math.exp((17.27 * tC) / (tC + 237.3));
}

/** Slope of the saturation vapour pressure curve at `tC`, kPa/°C (FAO-56 eq. 13). */
function vapourPressureSlope(tC: number): number {
  return (4098 * saturationVapourPressure(tC)) / (tC + 237.3) ** 2;
}

/** Atmospheric pressure at elevation `elevationM`, kPa (FAO-56 eq. 7). */
function atmosphericPressure(elevationM: number): number {
  return 101.3 * ((293 - 0.0065 * elevationM) / 293) ** 5.26;
}

/** Psychrometric constant, kPa/°C (FAO-56 eq. 8). */
function psychrometricConstant(pressureKpa: number): number {
  return 0.665e-3 * pressureKpa;
}

/**
 * Wind speed measured at `heightM` above the ground converted to the standard 2 m, m/s
 * (FAO-56 eq. 47, logarithmic wind profile over short grass). Weather services usually report 10 m.
 */
export function windSpeedAt2m(speedMs: number, heightM: number): number {
  return (speedMs * 4.87) / Math.log(67.8 * heightM - 5.42);
}

/** Day number in the year, 1 on 1 January (the J of FAO-56 eqs. 23-24). */
export function dayOfYear(date: string): number {
  return diffDays(`${date.slice(0, 4)}-01-01`, date) + 1;
}

/** Solar declination, rad (FAO-56 eq. 24). */
function solarDeclination(dayOfYear: number): number {
  return 0.409 * Math.sin((2 * Math.PI * dayOfYear) / 365 - 1.39);
}

/**
 * Sunset hour angle ωs, rad (FAO-56 eq. 25). In polar night or day it is held at its limit:
 * 0 when the sun does not rise, π when it does not set.
 */
function sunsetHourAngle(latitudeDeg: number, dayOfYear: number): number {
  const phi = (latitudeDeg * Math.PI) / 180;
  return Math.acos(Math.min(1, Math.max(-1, -Math.tan(phi) * Math.tan(solarDeclination(dayOfYear)))));
}

/**
 * Extraterrestrial radiation for a day, MJ/m²/day (FAO-56 eqs. 21-25): the solar energy reaching
 * the top of the atmosphere at this latitude. South latitudes are negative. In polar night or day
 * the sunset hour angle is held at its limit, so the result is 0 or a full day of sun.
 */
export function extraterrestrialRadiation(latitudeDeg: number, dayOfYear: number): number {
  const phi = (latitudeDeg * Math.PI) / 180;
  const inverseDistance = 1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365); // eq. 23
  const declination = solarDeclination(dayOfYear); // eq. 24
  const sunsetAngle = sunsetHourAngle(latitudeDeg, dayOfYear); // eq. 25
  const ra =
    ((24 * 60) / Math.PI) *
    SOLAR_CONSTANT *
    inverseDistance *
    (sunsetAngle * Math.sin(phi) * Math.sin(declination) +
      Math.cos(phi) * Math.cos(declination) * Math.sin(sunsetAngle)); // eq. 21
  return Math.max(0, ra);
}

/**
 * Solar radiation estimated from the daily temperature range, MJ/m²/day (FAO-56 eq. 50, Hargreaves).
 * `kRs` is 0.16 for interior locations and 0.19 for coastal ones. This is the estimate FAO-56
 * sanctions when radiation is not measured, which is always the case for a forecast.
 */
export function hargreavesRadiation(tMinC: number, tMaxC: number, raMj: number, kRs = 0.16): number {
  return kRs * Math.sqrt(Math.max(0, tMaxC - tMinC)) * raMj;
}

// ─── Daylight ───────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;

/** A place on the ground, in degrees: north and east positive. */
export interface GeoSite {
  latitudeDeg: number;
  longitudeDeg: number;
}

/** Daylight hours N from sunrise to sunset: 0 in polar night, 24 in polar day (FAO-56 eq. 34). */
export function daylightHours(latitudeDeg: number, dayOfYear: number): number {
  return (24 / Math.PI) * sunsetHourAngle(latitudeDeg, dayOfYear);
}

/** Seasonal correction for solar time Sc, hours (FAO-56 eqs. 32-33): how far the sun runs ahead of the clock. */
function solarTimeCorrection(dayOfYear: number): number {
  const b = (2 * Math.PI * (dayOfYear - 81)) / 364;
  return 0.1645 * Math.sin(2 * b) - 0.1255 * Math.cos(b) - 0.025 * Math.sin(b);
}

function sunTimesMs(date: string, site: GeoSite): { sunrise: number; sunset: number } {
  const j = dayOfYear(date);
  // Solar time is UTC + longitude/15 + Sc (FAO-56 eq. 31 with the clock read as UTC), so noon falls here.
  const noon = Date.parse(`${date}T12:00:00Z`) - (site.longitudeDeg / 15 + solarTimeCorrection(j)) * HOUR_MS;
  const half = (daylightHours(site.latitudeDeg, j) / 2) * HOUR_MS;
  return { sunrise: noon - half, sunset: noon + half };
}

/**
 * Sunrise and sunset on a date at `site`, as UTC ISO instants: the daylight hours of eq. 34 either
 * side of solar noon (FAO-56 eqs. 24-25 and 31-34). These are the moments the centre of the sun
 * crosses a level horizon; refraction shows the sun a few minutes earlier and later. In polar night
 * both are solar noon, in polar day they are 12 hours either side of it.
 */
export function sunTimes(date: string, site: GeoSite): { sunrise: string; sunset: string } {
  const { sunrise, sunset } = sunTimesMs(date, site);
  return { sunrise: new Date(sunrise).toISOString(), sunset: new Date(sunset).toISOString() };
}

// ─── Reference evapotranspiration ───────────────────────────────────────────

export interface Et0DayInput {
  /** YYYY-MM-DD */
  date: string;
  /** North positive, south negative. */
  latitudeDeg: number;
  /** Metres above sea level. */
  elevationM: number;
  tMinC: number | null;
  tMaxC: number | null;
  /** Mean dew point of the day: the best humidity reading when present (eq. 14). */
  dewPointC?: number | null;
  rhMaxPct?: number | null;
  rhMinPct?: number | null;
  rhMeanPct?: number | null;
  /** Mean wind speed at 2 m. Convert a 10 m reading with `windSpeedAt2m`. */
  windSpeed2mMs: number | null;
  /** Measured or forecast solar radiation. Missing: estimated with Hargreaves (eq. 50). */
  solarRadiationMj?: number | null;
}

/**
 * Actual vapour pressure, kPa. Dew point first (eq. 14), then RHmax with RHmin (eq. 17),
 * then RHmean (eq. 19). Null when the day has no humidity reading at all.
 */
function actualVapourPressure(i: Et0DayInput, tMinC: number, tMaxC: number): number | null {
  if (known(i.dewPointC)) return saturationVapourPressure(i.dewPointC);
  if (known(i.rhMaxPct) && known(i.rhMinPct)) {
    return (
      (saturationVapourPressure(tMinC) * clampRh(i.rhMaxPct)) / 100 +
      (saturationVapourPressure(tMaxC) * clampRh(i.rhMinPct)) / 100
    ) / 2;
  }
  if (known(i.rhMeanPct)) {
    return (
      (clampRh(i.rhMeanPct) / 100) * ((saturationVapourPressure(tMaxC) + saturationVapourPressure(tMinC)) / 2)
    );
  }
  return null;
}

/**
 * Daily grass reference evapotranspiration ET0, mm/day, by FAO-56 Penman-Monteith (eq. 6),
 * with soil heat flux G = 0 as FAO-56 allows for a day (eq. 42).
 *
 * Net radiation follows eqs. 37-40: albedo 0.23, clear-sky radiation from elevation (eq. 37),
 * Rs/Rso held at 1 or below. Missing solar radiation is estimated from the temperature range
 * (eq. 50). Missing temperature, wind or humidity gives null: FAO-56 does have fallbacks for
 * humidity and wind, but they are guesses about this farm's air, so the caller must supply them.
 * Null as well in polar night, where Rs/Rso has no value. A negative result is returned as 0.
 */
export function et0PenmanMonteith(i: Et0DayInput): number | null {
  const { tMinC, tMaxC, windSpeed2mMs } = i;
  if (!known(tMinC) || !known(tMaxC) || !known(windSpeed2mMs)) return null;
  if (tMaxC < tMinC || windSpeed2mMs < 0) return null;

  const ea = actualVapourPressure(i, tMinC, tMaxC);
  if (ea == null) return null;

  const tMean = (tMaxC + tMinC) / 2; // eq. 9
  const es = (saturationVapourPressure(tMaxC) + saturationVapourPressure(tMinC)) / 2; // eq. 12
  const slope = vapourPressureSlope(tMean);
  const gamma = psychrometricConstant(atmosphericPressure(i.elevationM));

  const ra = extraterrestrialRadiation(i.latitudeDeg, dayOfYear(i.date));
  const rs = known(i.solarRadiationMj) ? i.solarRadiationMj : hargreavesRadiation(tMinC, tMaxC, ra);
  const rso = (0.75 + 2e-5 * i.elevationM) * ra; // eq. 37
  if (rso <= 0) return null;
  const relativeShortwave = Math.min(1, rs / rso);

  const rns = (1 - REFERENCE_ALBEDO) * rs; // eq. 38
  const tMaxK4 = (tMaxC + 273.16) ** 4;
  const tMinK4 = (tMinC + 273.16) ** 4;
  const rnl =
    STEFAN_BOLTZMANN *
    ((tMaxK4 + tMinK4) / 2) *
    (0.34 - 0.14 * Math.sqrt(Math.max(0, ea))) *
    (1.35 * relativeShortwave - 0.35); // eq. 39
  const rn = rns - rnl; // eq. 40
  const g = 0;

  const et0 =
    (0.408 * slope * (rn - g) + gamma * (900 / (tMean + 273)) * windSpeed2mMs * (es - ea)) /
    (slope + gamma * (1 + 0.34 * windSpeed2mMs)); // eq. 6
  return Math.max(0, et0);
}

// ─── Heat stress in sheep ───────────────────────────────────────────────────

/**
 * Temperature-humidity index for sheep, Marai et al. 2007 (Small Ruminant Research 71:1-12):
 * THI = T − (0.31 − 0.31·RH/100)·(T − 14.4), with T the dry-bulb temperature in °C.
 */
export function sheepThi(tempC: number | null, rhPct: number | null): number | null {
  if (!known(tempC) || !known(rhPct)) return null;
  return tempC - (0.31 - (0.31 * clampRh(rhPct)) / 100) * (tempC - 14.4);
}

/** Lower bounds of the heat stress classes for sheep THI (Marai et al. 2007). */
export const SHEEP_THI_THRESHOLDS = {
  moderate: 22.2,
  severe: 23.3,
  extreme: 25.6,
} as const;

export type SheepHeatStress = 'none' | 'moderate' | 'severe' | 'extreme';

/**
 * Heat stress class for a sheep THI: below 22.2 none, 22.2 to below 23.3 moderate,
 * 23.3 to below 25.6 severe, 25.6 and above extreme (Marai et al. 2007).
 */
export function sheepHeatStress(thi: number | null): SheepHeatStress | null {
  if (!known(thi)) return null;
  if (thi >= SHEEP_THI_THRESHOLDS.extreme) return 'extreme';
  if (thi >= SHEEP_THI_THRESHOLDS.severe) return 'severe';
  if (thi >= SHEEP_THI_THRESHOLDS.moderate) return 'moderate';
  return 'none';
}

// ─── Spraying ───────────────────────────────────────────────────────────────

/**
 * Wet-bulb temperature from air temperature and relative humidity, °C (Stull 2011, J. Appl.
 * Meteor. Climatol. 50:2267-2269). Fitted at sea-level pressure for RH 5-99 % and −20 to 50 °C.
 */
export function wetBulbStull(tempC: number, rhPct: number): number {
  const rh = clampRh(rhPct);
  return (
    tempC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(tempC + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * rh ** 1.5 * Math.atan(0.023101 * rh) -
    4.686035
  );
}

/**
 * Delta T, °C: dry-bulb less wet-bulb temperature. The spraying measure of how fast droplets
 * evaporate: above 10 they shrink and drift before they reach the leaf.
 */
export function deltaT(tempC: number, rhPct: number): number {
  return tempC - wetBulbStull(tempC, rhPct);
}

/**
 * Limits for an hour of spraying. Wind 3 to 15 km/h: calmer air risks a temperature inversion
 * that carries fine droplets away, stronger wind drifts them. Rain from 0.1 mm washes the product
 * off. Above 28 °C or with Delta T above 10 the droplets evaporate. Below 8 °C crops and weeds take
 * up little of the product and pests are hardly active, so the work is wasted.
 */
export const SPRAY_LIMITS = {
  /** 3 km/h. */
  windMinMs: 3 / 3.6,
  /** 15 km/h. */
  windMaxMs: 15 / 3.6,
  rainMm: 0.1,
  maxTempC: 28,
  minTempC: 8,
  maxDeltaT: 10,
} as const;

/** Every reason an hour is unfit for spraying, in the order they are reported. */
export const SPRAY_ISSUES = ['wind_strong', 'wind_calm', 'rain', 'hot', 'cold', 'dry_air'] as const;

export type SprayIssue = (typeof SPRAY_ISSUES)[number];

export interface SprayHourWeather {
  tempC: number | null;
  rhPct: number | null;
  /** Wind at spraying height; weather services report it at 10 m, which reads slightly high. */
  windMs: number | null;
  precipMm: number | null;
}

export interface SprayAssessment {
  /** Null when any reading is missing: the hour may be fine, but nobody can say. */
  suitable: boolean | null;
  /** Problems found in the readings that are known, in a fixed order. */
  issues: SprayIssue[];
}

/** Whether an hour suits spraying, against `SPRAY_LIMITS`. */
export function assessSprayHour(h: SprayHourWeather): SprayAssessment {
  const issues: SprayIssue[] = [];
  if (known(h.windMs) && h.windMs > SPRAY_LIMITS.windMaxMs) issues.push('wind_strong');
  if (known(h.windMs) && h.windMs < SPRAY_LIMITS.windMinMs) issues.push('wind_calm');
  if (known(h.precipMm) && h.precipMm >= SPRAY_LIMITS.rainMm) issues.push('rain');
  if (known(h.tempC) && h.tempC > SPRAY_LIMITS.maxTempC) issues.push('hot');
  if (known(h.tempC) && h.tempC < SPRAY_LIMITS.minTempC) issues.push('cold');
  if (known(h.tempC) && known(h.rhPct) && deltaT(h.tempC, h.rhPct) > SPRAY_LIMITS.maxDeltaT) {
    issues.push('dry_air');
  }
  const complete = known(h.tempC) && known(h.rhPct) && known(h.windMs) && known(h.precipMm);
  return { suitable: complete ? issues.length === 0 : null, issues };
}

export type SprayHour = { /** ISO instant with an offset or Z, on the hour. */ time: string } & SprayHourWeather;

export interface SprayWindow {
  /** First hour of the window, as a UTC ISO instant. */
  start: string;
  /** End of the last hour (exclusive), as a UTC ISO instant. */
  end: string;
  hours: number;
}

/** Milliseconds of an ISO instant, or null when the string carries no offset (its zone would be a guess). */
function instantMs(time: string): number | null {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(time)) return null;
  const ms = Date.parse(time);
  return Number.isFinite(ms) ? ms : null;
}

/** Hours by their instant; an hour whose time has no offset is left out. */
function hoursByTime(hours: readonly SprayHour[]): Map<number, SprayHour> {
  const byTime = new Map<number, SprayHour>();
  for (const h of hours) {
    const ms = instantMs(h.time);
    if (ms != null) byTime.set(ms, h);
  }
  return byTime;
}

/**
 * Spraying is advised in daylight only, from an hour after sunrise to an hour before sunset: the
 * leaves are wet with dew after dawn, and the still air around sunrise and sunset holds the
 * inversion that carries fine droplets off the field.
 */
export const SPRAY_DAYLIGHT = { marginHours: 1 } as const;

function inSprayDaylightMs(startMs: number, site: GeoSite): boolean {
  // The hour's date in local solar time, whatever clock the farm's zone keeps.
  const date = new Date(startMs + (site.longitudeDeg / 15) * HOUR_MS).toISOString().slice(0, 10);
  const { sunrise, sunset } = sunTimesMs(date, site);
  const margin = SPRAY_DAYLIGHT.marginHours * HOUR_MS;
  return startMs >= sunrise + margin && startMs + HOUR_MS <= sunset - margin;
}

/** Whether the hour starting at `time` lies wholly in the spraying part of its day at `site` (`SPRAY_DAYLIGHT`). */
export function inSprayDaylight(time: string, site: GeoSite): boolean {
  const ms = instantMs(time);
  return ms != null && inSprayDaylightMs(ms, site);
}

/**
 * Spraying windows in an hourly forecast. An hour qualifies when it is suitable and neither it nor
 * any of the next `rainFreeHoursAfter` hours brings rain; a following hour that is missing or has
 * no precipitation reading does not count as dry. With `site`, an hour must also lie in the
 * spraying part of the day there (`SPRAY_DAYLIGHT`), so no window starts before dawn or runs into
 * the dusk. A window is a run of qualifying hours exactly one hour apart, at least `minHours` long.
 * Hours may come in any order; an hour whose time has no offset is ignored.
 */
export function sprayWindows(
  hours: readonly SprayHour[],
  opts: { minHours?: number; rainFreeHoursAfter?: number; site?: GeoSite } = {},
): SprayWindow[] {
  const minHours = opts.minHours ?? 2;
  const rainFreeHoursAfter = opts.rainFreeHoursAfter ?? 2;
  const { site } = opts;

  const byTime = hoursByTime(hours);
  const times = [...byTime.keys()].sort((a, b) => a - b);

  const dryAt = (ms: number) => {
    const h = byTime.get(ms);
    return h != null && known(h.precipMm) && h.precipMm < SPRAY_LIMITS.rainMm;
  };
  const qualifies = (ms: number) => {
    if (site && !inSprayDaylightMs(ms, site)) return false;
    if (assessSprayHour(byTime.get(ms)!).suitable !== true) return false;
    for (let k = 1; k <= rainFreeHoursAfter; k++) if (!dryAt(ms + k * HOUR_MS)) return false;
    return true;
  };

  const windows: SprayWindow[] = [];
  let runStart: number | null = null;
  let runLast = 0;
  const close = () => {
    if (runStart == null) return;
    const count = (runLast - runStart) / HOUR_MS + 1;
    if (count >= minHours) {
      windows.push({
        start: new Date(runStart).toISOString(),
        end: new Date(runLast + HOUR_MS).toISOString(),
        hours: count,
      });
    }
    runStart = null;
  };

  for (const ms of times) {
    if (!qualifies(ms)) {
      close();
      continue;
    }
    if (runStart != null && ms - runLast !== HOUR_MS) close();
    if (runStart == null) runStart = ms;
    runLast = ms;
  }
  close();
  return windows;
}

/**
 * What spoils spraying in the daylight hours of a forecast: every issue `assessSprayHour` finds in
 * an hour of the spraying part of the day at `site`, and rain in the `rainFreeHoursAfter` hours
 * after one, each once, in `SPRAY_ISSUES` order. Empty when those hours show no problem, for
 * example when their readings are missing.
 */
export function sprayIssuesInDaylight(
  hours: readonly SprayHour[],
  site: GeoSite,
  opts: { rainFreeHoursAfter?: number } = {},
): SprayIssue[] {
  const rainFreeHoursAfter = opts.rainFreeHoursAfter ?? 2;
  const byTime = hoursByTime(hours);
  const found = new Set<SprayIssue>();
  for (const [ms, hour] of byTime) {
    if (!inSprayDaylightMs(ms, site)) continue;
    for (const issue of assessSprayHour(hour).issues) found.add(issue);
    for (let k = 1; k <= rainFreeHoursAfter; k++) {
      const next = byTime.get(ms + k * HOUR_MS);
      if (next != null && known(next.precipMm) && next.precipMm >= SPRAY_LIMITS.rainMm) found.add('rain');
    }
  }
  return SPRAY_ISSUES.filter((issue) => found.has(issue));
}

// ─── Frost ──────────────────────────────────────────────────────────────────

/** Local hour, 0 to 23, of an instant in a time zone. */
export function localHourOf(iso: string, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
}

/**
 * Clock hours for spraying: windows start at 05:00 or later and end by 20:00, and last at least two hours.
 * @deprecated The same clock hours all year advise spraying before a November sunrise. Pass the farm's
 * `site` to `sprayWindows` instead, which follows the sun (`SPRAY_DAYLIGHT`).
 */
export const SPRAY_DAYTIME = { fromHour: 5, toHour: 20, minHours: 2 } as const;

/**
 * Suitable runs cut to the daytime hours of each local day. A calm night between two calm days gives
 * two windows, one each morning, rather than one that starts at midnight. Pieces shorter than
 * `minHours` are dropped.
 * @deprecated Clock hours ignore the season; pass the farm's `site` to `sprayWindows` instead.
 */
export function daytimeWindows(
  windows: readonly SprayWindow[],
  timeZone: string,
  daytime: { fromHour: number; toHour: number; minHours: number } = SPRAY_DAYTIME,
): SprayWindow[] {
  const out: SprayWindow[] = [];
  for (const w of windows) {
    const end = Date.parse(w.end);
    let from: number | null = null;
    const close = (to: number) => {
      const hours = from === null ? 0 : Math.round((to - from) / HOUR_MS);
      if (from !== null && hours >= daytime.minHours) out.push({ start: new Date(from).toISOString(), end: new Date(to).toISOString(), hours });
      from = null;
    };
    for (let t = Date.parse(w.start); t < end; t += HOUR_MS) {
      const hour = localHourOf(new Date(t).toISOString(), timeZone);
      const day = hour >= daytime.fromHour && hour < daytime.toHour;
      if (day && from === null) from = t;
      if (!day) close(t);
    }
    close(end);
  }
  return out;
}

export type FrostSeverity = 'none' | 'light' | 'hard';

/** Night frost from the minimum air temperature: above 0 °C none, from 0 down to above −2 light, −2 and below hard. */
export function frostSeverity(tMinC: number | null): FrostSeverity | null {
  if (!known(tMinC)) return null;
  if (tMinC > 0) return 'none';
  return tMinC > -2 ? 'light' : 'hard';
}
