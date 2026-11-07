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

/**
 * Extraterrestrial radiation for a day, MJ/m²/day (FAO-56 eqs. 21-25): the solar energy reaching
 * the top of the atmosphere at this latitude. South latitudes are negative. In polar night or day
 * the sunset hour angle is held at its limit, so the result is 0 or a full day of sun.
 */
export function extraterrestrialRadiation(latitudeDeg: number, dayOfYear: number): number {
  const phi = (latitudeDeg * Math.PI) / 180;
  const inverseDistance = 1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365); // eq. 23
  const declination = 0.409 * Math.sin((2 * Math.PI * dayOfYear) / 365 - 1.39); // eq. 24
  const cosSunset = Math.min(1, Math.max(-1, -Math.tan(phi) * Math.tan(declination)));
  const sunsetAngle = Math.acos(cosSunset); // eq. 25
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
 * off. Above 28 °C or with Delta T above 10 the droplets evaporate.
 */
export const SPRAY_LIMITS = {
  /** 3 km/h. */
  windMinMs: 3 / 3.6,
  /** 15 km/h. */
  windMaxMs: 15 / 3.6,
  rainMm: 0.1,
  maxTempC: 28,
  maxDeltaT: 10,
} as const;

export type SprayIssue = 'wind_strong' | 'wind_calm' | 'rain' | 'hot' | 'dry_air';

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

const HOUR_MS = 3_600_000;

/** Milliseconds of an ISO instant, or null when the string carries no offset (its zone would be a guess). */
function instantMs(time: string): number | null {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(time)) return null;
  const ms = Date.parse(time);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Spraying windows in an hourly forecast. An hour qualifies when it is suitable and neither it nor
 * any of the next `rainFreeHoursAfter` hours brings rain; a following hour that is missing or has
 * no precipitation reading does not count as dry. A window is a run of qualifying hours exactly
 * one hour apart, at least `minHours` long. Hours may come in any order; an hour whose time has no
 * offset is ignored.
 */
export function sprayWindows(
  hours: SprayHour[],
  opts: { minHours?: number; rainFreeHoursAfter?: number } = {},
): SprayWindow[] {
  const minHours = opts.minHours ?? 2;
  const rainFreeHoursAfter = opts.rainFreeHoursAfter ?? 2;

  const byTime = new Map<number, SprayHour>();
  for (const h of hours) {
    const ms = instantMs(h.time);
    if (ms != null) byTime.set(ms, h);
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);

  const dryAt = (ms: number) => {
    const h = byTime.get(ms);
    return h != null && known(h.precipMm) && h.precipMm < SPRAY_LIMITS.rainMm;
  };
  const qualifies = (ms: number) => {
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

// ─── Frost ──────────────────────────────────────────────────────────────────

/** Local hour, 0 to 23, of an instant in a time zone. */
export function localHourOf(iso: string, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
}

/** Spraying is advised by day: windows start at 05:00 or later and end by 20:00, and last at least two hours. */
export const SPRAY_DAYTIME = { fromHour: 5, toHour: 20, minHours: 2 } as const;

/**
 * Suitable runs cut to the daytime hours of each local day. A calm night between two calm days gives
 * two windows, one each morning, rather than one that starts at midnight. Pieces shorter than
 * `minHours` are dropped.
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
