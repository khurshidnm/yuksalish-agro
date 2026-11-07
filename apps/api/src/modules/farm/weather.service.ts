/**
 * Weather for the farm (spec 7.3, 19). Forecasts come from MET Norway's Locationforecast and past
 * days from NASA POWER. Both are free and allow use in a paid product (CC BY 4.0, and NASA's open
 * data policy); Open-Meteo's free tier does not. Weather is a nicety: nothing here may fail or delay
 * the operation that asked for it, so every network problem ends as "no data" and a short backoff,
 * never as an error.
 *
 * A forecast day stays as forecast until NASA POWER publishes the observed day, 3 to 5 days later.
 */
import { and, asc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PRODUCT_NAME, addDays, diffDays, round, todayIso } from '@yap/shared';
import { windSpeedAt2m } from '@yap/shared/formulas/agro-weather';
import { config } from '../../config';
import { ctx, today, tx, withTenant, type Identity } from '../../core/context';
import { schema } from '../../db/client';

const { farms, weatherDaily: t, weatherHourly: h } = schema;

export const FORECAST_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
export const HISTORY_URL = 'https://power.larc.nasa.gov/api/temporal/daily/point';
export const WEATHER_SOURCE = { forecast: 'met-norway', history: 'nasa-power' } as const;

/** MET Norway forecasts about 9 days ahead. */
const FORECAST_DAYS_AHEAD = 9;
/** NASA POWER publishes a day 3 to 5 days late; two weeks back covers the lag with room to spare. */
const HISTORY_DAYS_BACK = 14;
/** Crop water use needs the whole season: past days are filled back to the earliest sowing, this far at most. */
const BACKFILL_DAYS = 300;
/** Past forecast hours kept for "what was it like this morning". */
const HOURLY_KEEP_DAYS = 2;
/** A forecast day counts as whole when its periods cover this many of its hours. */
const WHOLE_DAY_HOURS = 20;
const HISTORY_PARAMETERS = 'T2M_MAX,T2M_MIN,PRECTOTCORR,WS10M_MAX,WS2M,RH2M,T2MDEW,ALLSKY_SFC_SW_DWN';
const JOB_TIMEOUT_MS = 10_000;
/** A save must not wait long for weather. */
const INLINE_TIMEOUT_MS = 2_500;
const BACKOFF_MS = 5 * 60_000;

const unavailableUntil = { forecast: 0, history: 0 };

/** Clear the backoff. For tests. */
export function resetWeatherBackoff(): void {
  unavailableUntil.forecast = 0;
  unavailableUntil.history = 0;
}

/** MET Norway blocks anonymous clients: it asks for the product's name and a way to reach it. */
function userAgent(): string {
  return `${PRODUCT_NAME}/1.0 (+${config.WEB_ORIGIN})`;
}

interface DayWeather {
  date: string;
  tempMin: number | null;
  tempMax: number | null;
  precipitationMm: number | null;
  windMaxKmh: number | null;
  weatherCode: number | null;
  rhMeanPct: number | null;
  dewPointC: number | null;
  windMeanMs: number | null;
  solarMj: number | null;
}

export interface WeatherSnapshot extends DayWeather {
  /** Forecast rather than observed. */
  isForecast: boolean;
  /** At or below freezing (spec 7.3: sovuq). Null when the temperature is unknown. */
  frost: boolean | null;
  source: string;
}

export interface HourlyPoint {
  time: string;
  periodHours: number;
  tempC: number | null;
  rhPct: number | null;
  /** Wind at 10 m. */
  windMs: number | null;
  precipMm: number | null;
  weatherCode: number | null;
}

interface ForecastDay extends DayWeather {
  /** False for today, whose earlier hours are past, and for the forecast's last, cut-off day. */
  whole: boolean;
}

interface ForecastDownload {
  hours: (HourlyPoint & { at: Date; dewPointC: number | null })[];
  days: ForecastDay[];
  altitudeM: number | null;
}

// ─── MET Norway ──────────────────────────────────────────────────────────────

const optionalNumber = z.number().nullish();
const period = z
  .object({
    summary: z.object({ symbol_code: z.string().optional() }).optional(),
    details: z
      .object({ precipitation_amount: optionalNumber, air_temperature_max: optionalNumber, air_temperature_min: optionalNumber })
      .optional(),
  })
  .optional();
const forecastSchema = z.object({
  geometry: z.object({ coordinates: z.array(z.number()) }).optional(),
  properties: z.object({
    timeseries: z.array(
      z.object({
        time: z.string(),
        data: z.object({
          instant: z.object({
            details: z.object({
              air_temperature: optionalNumber,
              relative_humidity: optionalNumber,
              dew_point_temperature: optionalNumber,
              wind_speed: optionalNumber,
            }),
          }),
          next_1_hours: period,
          next_6_hours: period,
        }),
      }),
    ),
  }),
});

const SYMBOL_TO_WMO: Record<string, number> = {
  clearsky: 0,
  fair: 1,
  partlycloudy: 2,
  cloudy: 3,
  fog: 45,
  lightrain: 61,
  rain: 63,
  heavyrain: 65,
  lightsleet: 66,
  sleet: 67,
  heavysleet: 67,
  lightsnow: 71,
  snow: 73,
  heavysnow: 75,
  lightrainshowers: 80,
  rainshowers: 81,
  heavyrainshowers: 82,
  lightsleetshowers: 66,
  sleetshowers: 67,
  heavysleetshowers: 67,
  lightsnowshowers: 85,
  snowshowers: 85,
  heavysnowshowers: 86,
};

/**
 * MET Norway's symbol as the WMO code the app already draws. The codes rise with severity, so a
 * day's code is the highest of its periods, as Open-Meteo and most weather apps show it.
 */
export function wmoCodeOf(symbol: string | undefined): number | null {
  if (!symbol) return null;
  const base = symbol.replace(/_(day|night|polartwilight)$/, '');
  if (base.includes('thunder')) return 95;
  return SYMBOL_TO_WMO[base] ?? null;
}

const HOUR_MS = 3_600_000;

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function maybe(value: number | null, digits = 2): number | null {
  return value === null ? null : round(value, digits);
}

/** Hourly and 6-hourly points, then days in the farm's time zone. */
export function parseForecast(body: unknown, timeZone: string): ForecastDownload {
  const parsed = forecastSchema.parse(body);
  const series = parsed.properties.timeseries
    .map((entry) => ({ ...entry, at: new Date(entry.time) }))
    .filter((entry) => !Number.isNaN(entry.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const hours: ForecastDownload['hours'] = [];
  const blockLimits: { date: string; min: number | null; max: number | null }[] = [];
  for (const [i, entry] of series.entries()) {
    const next = series[i + 1];
    const gap = next ? (next.at.getTime() - entry.at.getTime()) / HOUR_MS : null;
    const { next_1_hours: one, next_6_hours: six } = entry.data;
    // Each point's period runs to the next point, so the hourly part and the 6-hourly part do not overlap.
    const useSix = six !== undefined && (gap === null ? one === undefined : gap >= 6);
    const block = useSix ? six : one;
    if (!block) continue;
    const periodHours = useSix ? 6 : 1;
    const d = entry.data.instant.details;
    hours.push({
      at: entry.at,
      time: entry.at.toISOString(),
      periodHours,
      tempC: d.air_temperature ?? null,
      rhPct: d.relative_humidity ?? null,
      windMs: d.wind_speed ?? null,
      dewPointC: d.dew_point_temperature ?? null,
      precipMm: block.details?.precipitation_amount ?? null,
      weatherCode: wmoCodeOf(block.summary?.symbol_code),
    });
    if (useSix) {
      const middle = new Date(entry.at.getTime() + 3 * HOUR_MS);
      blockLimits.push({
        date: todayIso(timeZone, middle),
        min: block.details?.air_temperature_min ?? null,
        max: block.details?.air_temperature_max ?? null,
      });
    }
  }

  interface Acc {
    hours: number;
    rainKnown: boolean;
    rain: number;
    temps: number[];
    rh: number[];
    dew: number[];
    wind: number[];
    codes: number[];
  }
  const byDate = new Map<string, Acc>();
  const acc = (date: string): Acc => {
    let a = byDate.get(date);
    if (!a) {
      a = { hours: 0, rainKnown: true, rain: 0, temps: [], rh: [], dew: [], wind: [], codes: [] };
      byDate.set(date, a);
    }
    return a;
  };

  for (const point of hours) {
    // Spread a period's rain over its hours, so a night block counts on both of its dates.
    for (let k = 0; k < point.periodHours; k++) {
      const a = acc(todayIso(timeZone, new Date(point.at.getTime() + k * HOUR_MS)));
      a.hours++;
      if (point.precipMm === null) a.rainKnown = false;
      else a.rain += point.precipMm / point.periodHours;
    }
    const a = acc(todayIso(timeZone, point.at));
    if (point.tempC !== null) a.temps.push(point.tempC);
    if (point.rhPct !== null) a.rh.push(point.rhPct);
    if (point.dewPointC !== null) a.dew.push(point.dewPointC);
    if (point.windMs !== null) a.wind.push(point.windMs);
    if (point.weatherCode !== null) a.codes.push(point.weatherCode);
  }
  for (const limit of blockLimits) {
    const a = byDate.get(limit.date);
    if (!a) continue;
    if (limit.min !== null) a.temps.push(limit.min);
    if (limit.max !== null) a.temps.push(limit.max);
  }

  const days: ForecastDay[] = [...byDate.entries()]
    .filter(([, a]) => a.temps.length > 0)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([date, a]) => {
      const windMean = mean(a.wind);
      return {
        date,
        tempMin: Math.min(...a.temps),
        tempMax: Math.max(...a.temps),
        precipitationMm: a.rainKnown ? round(a.rain, 2) : null,
        windMaxKmh: a.wind.length ? round(Math.max(...a.wind) * 3.6, 2) : null,
        weatherCode: a.codes.length ? Math.max(...a.codes) : null,
        rhMeanPct: maybe(mean(a.rh)),
        dewPointC: maybe(mean(a.dew)),
        windMeanMs: windMean === null ? null : round(windSpeedAt2m(windMean, 10), 2),
        solarMj: null,
        whole: a.hours >= WHOLE_DAY_HOURS,
      };
    });

  const altitude = parsed.geometry?.coordinates[2];
  return { hours, days, altitudeM: typeof altitude === 'number' ? altitude : null };
}

// ─── NASA POWER ──────────────────────────────────────────────────────────────

const historySchema = z.object({
  header: z.object({ fill_value: z.number().optional() }).optional(),
  properties: z.object({ parameter: z.record(z.string(), z.record(z.string(), z.number())) }),
});

const compact = (isoDate: string) => isoDate.replaceAll('-', '');

/** Observed days. A day NASA has not published yet (the fill value) is left out. */
export function parseHistory(body: unknown): DayWeather[] {
  const parsed = historySchema.parse(body);
  const fill = parsed.header?.fill_value ?? -999;
  const p = parsed.properties.parameter;
  const value = (name: string, key: string): number | null => {
    const v = p[name]?.[key];
    return v === undefined || v === fill ? null : v;
  };
  const keys = Object.keys(p.T2M_MAX ?? p.T2M_MIN ?? {}).sort();
  return keys
    .map((key) => {
      const windMax = value('WS10M_MAX', key);
      return {
        date: `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`,
        tempMin: value('T2M_MIN', key),
        tempMax: value('T2M_MAX', key),
        precipitationMm: value('PRECTOTCORR', key),
        windMaxKmh: windMax === null ? null : round(windMax * 3.6, 2),
        weatherCode: null,
        rhMeanPct: value('RH2M', key),
        dewPointC: value('T2MDEW', key),
        windMeanMs: value('WS2M', key),
        solarMj: value('ALLSKY_SFC_SW_DWN', key),
      };
    })
    .filter((d) => d.tempMin !== null || d.tempMax !== null);
}

// ─── Network ─────────────────────────────────────────────────────────────────

interface Location {
  lat: number;
  lng: number;
  elevationM: number | null;
  timeZone: string;
  /** First day the past-weather download starts from. */
  historyFrom: string;
}

async function getJson(source: keyof typeof unavailableUntil, url: URL, timeoutMs: number): Promise<unknown | null> {
  if (Date.now() < unavailableUntil[source]) return null;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    unavailableUntil[source] = Date.now() + BACKOFF_MS;
    // Logged once per backoff, so an outage leaves a trace without flooding the log.
    console.warn(`[weather] ${source} unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function parsedOrBackoff<T>(source: keyof typeof unavailableUntil, parse: () => T): T | null {
  try {
    return parse();
  } catch (err) {
    unavailableUntil[source] = Date.now() + BACKOFF_MS;
    console.warn(`[weather] ${source} sent an unexpected body: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** MET Norway refuses coordinates with more than 4 decimals. */
const coordinate = (value: number) => String(Number(value.toFixed(4)));

async function downloadForecast(loc: Location, timeoutMs: number): Promise<ForecastDownload | null> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set('lat', coordinate(loc.lat));
  url.searchParams.set('lon', coordinate(loc.lng));
  if (loc.elevationM !== null) url.searchParams.set('altitude', String(Math.round(loc.elevationM)));
  const body = await getJson('forecast', url, timeoutMs);
  if (body === null) return null;
  return parsedOrBackoff('forecast', () => parseForecast(body, loc.timeZone));
}

async function downloadHistory(loc: Location, from: string, to: string, timeoutMs: number): Promise<DayWeather[] | null> {
  const url = new URL(HISTORY_URL);
  url.searchParams.set('parameters', HISTORY_PARAMETERS);
  url.searchParams.set('community', 'AG');
  url.searchParams.set('latitude', coordinate(loc.lat));
  url.searchParams.set('longitude', coordinate(loc.lng));
  url.searchParams.set('start', compact(from));
  url.searchParams.set('end', compact(to));
  url.searchParams.set('format', 'JSON');
  url.searchParams.set('time-standard', 'LST');
  const body = await getJson('history', url, timeoutMs);
  if (body === null) return null;
  return parsedOrBackoff('history', () => parseHistory(body));
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/**
 * Where the past-weather download starts: two weeks back, or earlier when a crop in the field was
 * sown before the farm's stored weather begins, so its water use can be counted from sowing.
 */
async function historyStart(on: string): Promise<string> {
  const usual = addDays(on, -HISTORY_DAYS_BACK);
  const result = await tx().execute(sql`
    select min(sowing_date_fact)::text as sowing from crop_plans
    where farm_id = ${ctx().farmId} and status in ('sown', 'growing') and sowing_date_fact is not null`);
  const sowing = (result.rows[0] as { sowing: string | null } | undefined)?.sowing ?? null;
  if (!sowing || sowing >= usual) return usual;
  const from = sowing < addDays(on, -BACKFILL_DAYS) ? addDays(on, -BACKFILL_DAYS) : sowing;
  const gap = await tx().execute(sql`
    select d::date::text as date
    from generate_series(${from}::date, ${usual}::date, interval '1 day') d
    where not exists (
      select 1 from weather_daily w where w.farm_id = ${ctx().farmId} and w.date = d::date and not w.is_forecast
    )
    order by d limit 1`);
  return (gap.rows[0] as { date: string } | undefined)?.date ?? usual;
}

async function location(): Promise<Location | null> {
  const c = ctx();
  const [farm] = await tx()
    .select({ lat: farms.lat, lng: farms.lng, elevationM: farms.elevationM })
    .from(farms)
    .where(eq(farms.id, c.farmId));
  if (farm?.lat == null || farm.lng == null) return null;
  return { lat: farm.lat, lng: farm.lng, elevationM: farm.elevationM, timeZone: c.timezone, historyFrom: await historyStart(today()) };
}

const DAY_COLUMNS = ['tempMin', 'tempMax', 'precipitationMm', 'windMaxKmh', 'weatherCode', 'rhMeanPct', 'dewPointC', 'windMeanMs', 'solarMj'] as const;
const DAY_SQL_NAMES: Record<(typeof DAY_COLUMNS)[number], string> = {
  tempMin: 'temp_min',
  tempMax: 'temp_max',
  precipitationMm: 'precipitation_mm',
  windMaxKmh: 'wind_max_kmh',
  weatherCode: 'weather_code',
  rhMeanPct: 'rh_mean_pct',
  dewPointC: 'dew_point_c',
  windMeanMs: 'wind_mean_ms',
  solarMj: 'solar_mj',
};

/**
 * Upsert days. `newWins` replaces stored values where the new value is known; otherwise stored
 * values win and the new ones only fill gaps (a part-day forecast must not overwrite a whole one).
 * A forecast never replaces an observed day.
 */
async function upsertDays(days: DayWeather[], kind: 'forecast' | 'history', newWins: boolean): Promise<number> {
  if (days.length === 0) return 0;
  const c = ctx();
  const isForecast = kind === 'forecast';
  const set: Record<string, unknown> = {
    isForecast: sql`excluded.is_forecast`,
    source: sql`excluded.source`,
    fetchedAt: sql`excluded.fetched_at`,
    updatedAt: sql`now()`,
  };
  for (const column of DAY_COLUMNS) {
    const name = sql.raw(DAY_SQL_NAMES[column]);
    set[column] = newWins
      ? sql`coalesce(excluded.${name}, ${t[column]})`
      : sql`coalesce(${t[column]}, excluded.${name})`;
  }
  await tx()
    .insert(t)
    .values(
      days.map((day) => ({
        ...pick(day),
        tenantId: c.tenantId,
        farmId: c.farmId,
        isForecast,
        source: isForecast ? WEATHER_SOURCE.forecast : WEATHER_SOURCE.history,
        fetchedAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [t.farmId, t.date],
      set,
      ...(isForecast ? { setWhere: sql`${t.isForecast} = true` } : {}),
    });
  return days.length;
}

function pick(day: DayWeather): DayWeather {
  return {
    date: day.date,
    tempMin: day.tempMin,
    tempMax: day.tempMax,
    precipitationMm: day.precipitationMm,
    windMaxKmh: day.windMaxKmh,
    weatherCode: day.weatherCode,
    rhMeanPct: day.rhMeanPct,
    dewPointC: day.dewPointC,
    windMeanMs: day.windMeanMs,
    solarMj: day.solarMj,
  };
}

async function storeForecast(forecast: ForecastDownload, loc: Location): Promise<number> {
  const c = ctx();
  if (forecast.hours.length > 0) {
    // The new run replaces every point from its first hour on; older points stay for a short while.
    await tx().delete(h).where(and(eq(h.farmId, c.farmId), gte(h.time, forecast.hours[0].at)));
    await tx()
      .insert(h)
      .values(
        forecast.hours.map((p) => ({
          tenantId: c.tenantId,
          farmId: c.farmId,
          time: p.at,
          periodHours: p.periodHours,
          tempC: p.tempC,
          rhPct: p.rhPct,
          windMs: p.windMs,
          precipMm: p.precipMm,
          weatherCode: p.weatherCode,
        })),
      );
  }
  await tx()
    .delete(h)
    .where(and(eq(h.farmId, c.farmId), lt(h.time, new Date(Date.now() - HOURLY_KEEP_DAYS * 24 * HOUR_MS))));

  if (loc.elevationM === null && forecast.altitudeM !== null) {
    await tx().update(farms).set({ elevationM: forecast.altitudeM }).where(and(eq(farms.id, c.farmId), sql`${farms.elevationM} is null`));
  }

  const whole = forecast.days.filter((d) => d.whole);
  const partial = forecast.days.filter((d) => !d.whole);
  return (await upsertDays(whole, 'forecast', true)) + (await upsertDays(partial, 'forecast', false));
}

export interface RefreshResult {
  updated: number;
  /** The forecast could not be fetched. Past days may still have been updated. */
  unavailable: boolean;
}

interface Downloads {
  forecast: ForecastDownload | null;
  history: DayWeather[] | null;
}

async function downloadAll(loc: Location, on: string): Promise<Downloads> {
  const [forecast, history] = await Promise.all([
    downloadForecast(loc, JOB_TIMEOUT_MS),
    downloadHistory(loc, loc.historyFrom, addDays(on, -1), JOB_TIMEOUT_MS),
  ]);
  return { forecast, history };
}

async function storeAll(loc: Location, downloads: Downloads): Promise<number> {
  let updated = 0;
  if (downloads.forecast) updated += await storeForecast(downloads.forecast, loc);
  if (downloads.history) updated += await upsertDays(downloads.history, 'history', true);
  return updated;
}

/** Fetch and store the forecast and the recent past for the current farm. Never throws on network failure. */
export async function refreshWeather(): Promise<RefreshResult> {
  const loc = await location();
  if (!loc) return { updated: 0, unavailable: true };
  const downloads = await downloadAll(loc, today());
  return { updated: await storeAll(loc, downloads), unavailable: downloads.forecast === null };
}

/** The same refresh, without holding a database connection across the network calls. */
export async function refreshWeatherDetached(identity: Identity): Promise<RefreshResult> {
  const found = await withTenant(identity, async () => ({ loc: await location(), on: today() }));
  if (!found.loc) return { updated: 0, unavailable: true };
  const loc = found.loc;
  const downloads = await downloadAll(loc, found.on);
  return { updated: await withTenant(identity, () => storeAll(loc, downloads)), unavailable: downloads.forecast === null };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

function toSnapshot(row: typeof t.$inferSelect): WeatherSnapshot {
  return {
    date: row.date,
    tempMin: row.tempMin,
    tempMax: row.tempMax,
    precipitationMm: row.precipitationMm,
    windMaxKmh: row.windMaxKmh,
    weatherCode: row.weatherCode,
    rhMeanPct: row.rhMeanPct,
    dewPointC: row.dewPointC,
    windMeanMs: row.windMeanMs,
    solarMj: row.solarMj,
    isForecast: row.isForecast,
    frost: row.tempMin === null ? null : row.tempMin <= 0,
    source: row.source,
  };
}

/** Stored days in a range, oldest first. Reads the database only. */
export async function weatherRange(from: string, to: string): Promise<WeatherSnapshot[]> {
  const rows = await tx()
    .select()
    .from(t)
    .where(and(eq(t.farmId, ctx().farmId), gte(t.date, from), lte(t.date, to)))
    .orderBy(asc(t.date));
  return rows.map(toSnapshot);
}

/** Today and the following days. Reads the database only. */
export async function forecast(days = 7): Promise<WeatherSnapshot[]> {
  const from = today();
  return weatherRange(from, addDays(from, Math.min(Math.max(days, 1), 16) - 1));
}

/** Stored forecast points from `from` for `hours` hours, oldest first. Reads the database only. */
export async function hourlyForecast(from: Date, hours: number): Promise<HourlyPoint[]> {
  const rows = await tx()
    .select()
    .from(h)
    .where(and(eq(h.farmId, ctx().farmId), gte(h.time, from), lt(h.time, new Date(from.getTime() + hours * HOUR_MS))))
    .orderBy(asc(h.time));
  return rows.map((row) => ({
    time: row.time.toISOString(),
    periodHours: row.periodHours,
    tempC: row.tempC,
    rhPct: row.rhPct,
    windMs: row.windMs,
    precipMm: row.precipMm,
    weatherCode: row.weatherCode,
  }));
}

/** The farm's height above sea level, once the weather service has reported it. */
export async function farmElevationM(): Promise<number | null> {
  const [farm] = await tx().select({ elevationM: farms.elevationM }).from(farms).where(eq(farms.id, ctx().farmId));
  return farm?.elevationM ?? null;
}

/**
 * The weather on one date, for attaching to a journal entry (spec 7.3). Uses stored data, and
 * tries the network for a date outside the stored window, for example a back-dated operation.
 * Returns null when nothing is known.
 */
export async function getWeatherFor(
  date: string,
  options: { fetchMissing?: boolean } = {},
): Promise<WeatherSnapshot | null> {
  const stored = async () => {
    const [row] = await tx()
      .select()
      .from(t)
      .where(and(eq(t.farmId, ctx().farmId), eq(t.date, date)));
    return row ? toSnapshot(row) : null;
  };

  const known = await stored();
  if (known || options.fetchMissing === false) return known;

  const age = diffDays(date, today());
  if (age < -FORECAST_DAYS_AHEAD) return null;
  const loc = await location();
  if (!loc) return null;
  if (age > 0) {
    const days = await downloadHistory(loc, date, date, INLINE_TIMEOUT_MS);
    if (!days?.length) return null;
    await upsertDays(days, 'history', true);
  } else {
    const download = await downloadForecast(loc, INLINE_TIMEOUT_MS);
    if (!download) return null;
    await storeForecast(download, loc);
  }
  return stored();
}
