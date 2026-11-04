/**
 * Daily weather for the farm from the free Open-Meteo API (spec 7.3, 19). Weather is a nicety:
 * nothing here may fail or delay the operation that asked for it, so every network problem ends
 * as "no data" and a short backoff, never as an error.
 */
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { addDays, diffDays } from '@yap/shared';
import { ctx, today, tx, withTenant, type Identity } from '../../core/context';
import { schema } from '../../db/client';

const { farms, weatherDaily: t } = schema;

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const DAILY = 'temperature_2m_min,temperature_2m_max,precipitation_sum,wind_speed_10m_max,weather_code';

/** Open-Meteo's forecast endpoint covers about 3 months back and 16 days ahead. */
const FORECAST_API_PAST_DAYS = 85;
const FORECAST_API_FUTURE_DAYS = 15;
const JOB_TIMEOUT_MS = 8_000;
/** A save must not wait long for weather. */
const INLINE_TIMEOUT_MS = 2_500;
const BACKOFF_MS = 5 * 60_000;

let unavailableUntil = 0;

/** Clear the backoff. For tests. */
export function resetWeatherBackoff(): void {
  unavailableUntil = 0;
}

const nullableNumbers = z.array(z.number().nullable());
const responseSchema = z.object({
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_min: nullableNumbers,
    temperature_2m_max: nullableNumbers,
    precipitation_sum: nullableNumbers,
    wind_speed_10m_max: nullableNumbers,
    weather_code: nullableNumbers,
  }),
});

interface DayWeather {
  date: string;
  tempMin: number | null;
  tempMax: number | null;
  precipitationMm: number | null;
  windMaxKmh: number | null;
  weatherCode: number | null;
}

export interface WeatherSnapshot extends DayWeather {
  /** Forecast rather than observed. */
  isForecast: boolean;
  /** At or below freezing (spec 7.3: sovuq). Null when the temperature is unknown. */
  frost: boolean | null;
  source: string;
}

async function download(url: URL, timeoutMs: number): Promise<DayWeather[] | null> {
  if (Date.now() < unavailableUntil) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { daily } = responseSchema.parse(await response.json());
    return daily.time.map((date, i) => ({
      date,
      tempMin: daily.temperature_2m_min[i] ?? null,
      tempMax: daily.temperature_2m_max[i] ?? null,
      precipitationMm: daily.precipitation_sum[i] ?? null,
      windMaxKmh: daily.wind_speed_10m_max[i] ?? null,
      weatherCode: daily.weather_code[i] ?? null,
    }));
  } catch (err) {
    unavailableUntil = Date.now() + BACKOFF_MS;
    // Logged once per backoff, so an outage leaves a trace without flooding the log.
    console.warn(`[weather] unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function baseUrl(endpoint: string): Promise<URL | null> {
  const c = ctx();
  const [farm] = await tx().select({ lat: farms.lat, lng: farms.lng }).from(farms).where(eq(farms.id, c.farmId));
  if (farm?.lat == null || farm.lng == null) return null;
  const url = new URL(endpoint);
  url.searchParams.set('latitude', String(farm.lat));
  url.searchParams.set('longitude', String(farm.lng));
  url.searchParams.set('daily', DAILY);
  url.searchParams.set('timezone', c.timezone);
  return url;
}

/** Last week and the coming week: yesterday's forecast becomes today's observation. */
async function rollingWindowUrl(): Promise<URL | null> {
  const url = await baseUrl(FORECAST_URL);
  url?.searchParams.set('past_days', '7');
  url?.searchParams.set('forecast_days', '8');
  return url;
}

async function storeDays(days: DayWeather[]): Promise<number> {
  if (days.length === 0) return 0;
  const c = ctx();
  const now = today();
  await tx()
    .insert(t)
    .values(
      days.map((day) => ({
        ...day,
        tenantId: c.tenantId,
        farmId: c.farmId,
        isForecast: day.date > now,
        source: 'open-meteo',
        fetchedAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [t.farmId, t.date],
      set: {
        // A gap in a newer response must not erase a value we already have.
        tempMin: sql`coalesce(excluded.temp_min, ${t.tempMin})`,
        tempMax: sql`coalesce(excluded.temp_max, ${t.tempMax})`,
        precipitationMm: sql`coalesce(excluded.precipitation_mm, ${t.precipitationMm})`,
        windMaxKmh: sql`coalesce(excluded.wind_max_kmh, ${t.windMaxKmh})`,
        weatherCode: sql`coalesce(excluded.weather_code, ${t.weatherCode})`,
        isForecast: sql`excluded.is_forecast`,
        fetchedAt: sql`excluded.fetched_at`,
        updatedAt: sql`now()`,
      },
    });
  return days.length;
}

export interface RefreshResult {
  updated: number;
  unavailable: boolean;
}

/** Fetch and store the rolling window for the current farm. Never throws on network failure. */
export async function refreshWeather(): Promise<RefreshResult> {
  const url = await rollingWindowUrl();
  const days = url ? await download(url, JOB_TIMEOUT_MS) : null;
  if (!days) return { updated: 0, unavailable: true };
  return { updated: await storeDays(days), unavailable: false };
}

/** The same refresh, without holding a database connection across the network call. */
export async function refreshWeatherDetached(identity: Identity): Promise<RefreshResult> {
  const url = await withTenant(identity, rollingWindowUrl);
  const days = url ? await download(url, JOB_TIMEOUT_MS) : null;
  if (!days) return { updated: 0, unavailable: true };
  return { updated: await withTenant(identity, () => storeDays(days)), unavailable: false };
}

function toSnapshot(row: typeof t.$inferSelect): WeatherSnapshot {
  return {
    date: row.date,
    tempMin: row.tempMin,
    tempMax: row.tempMax,
    precipitationMm: row.precipitationMm,
    windMaxKmh: row.windMaxKmh,
    weatherCode: row.weatherCode,
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
  if (age < -FORECAST_API_FUTURE_DAYS) return null;
  const url = await baseUrl(age > FORECAST_API_PAST_DAYS ? ARCHIVE_URL : FORECAST_URL);
  if (!url) return null;
  url.searchParams.set('start_date', date);
  url.searchParams.set('end_date', date);
  const days = await download(url, INLINE_TIMEOUT_MS);
  if (!days?.length) return null;
  await storeDays(days);
  return stored();
}
