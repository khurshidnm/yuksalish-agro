import { PRODUCT_NAME, addDays, todayIso } from '@yap/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tx } from '../src/core/context';
import { schema } from '../src/db/client';
import { jobs } from '../src/modules/farm/jobs';
import type { FarmJob } from '../src/jobs/types';
import {
  forecast,
  getWeatherFor,
  hourlyForecast,
  parseForecast,
  refreshWeather,
  resetWeatherBackoff,
  wmoCodeOf,
} from '../src/modules/farm/weather.service';
import { createFixture } from './helpers';

const TZ = 'Asia/Tashkent';
const HOUR = 3_600_000;
const today = () => todayIso();
const day = (offset: number) => addDays(today(), offset);
/** Local midnight of a date, as an instant. */
const midnight = (date: string) => new Date(`${date}T00:00:00+05:00`);

interface MetOptions {
  start?: Date;
  hourly?: number;
  sixHourly?: number;
  temp?: (localHour: number, index: number) => number;
  rainPerHour?: number;
  symbol?: (index: number) => string;
  altitude?: number;
}

/** A Locationforecast body: hourly points, then 6-hourly points, as MET Norway sends them. */
function metBody(o: MetOptions = {}) {
  const start = o.start ?? midnight(today());
  const hourly = o.hourly ?? 48;
  const sixHourly = o.sixHourly ?? 4;
  const temp = o.temp ?? ((localHour) => (localHour < 6 ? -2 : 10));
  const rain = o.rainPerHour ?? 0.1;
  const timeseries = [];
  for (let i = 0; i < hourly + sixHourly; i++) {
    const six = i >= hourly;
    const at = new Date(start.getTime() + (six ? hourly + (i - hourly) * 6 : i) * HOUR);
    const localHour = (at.getUTCHours() + 5) % 24;
    const symbol = o.symbol?.(i) ?? 'cloudy';
    const block = { summary: { symbol_code: symbol }, details: { precipitation_amount: six ? rain * 6 : rain, ...(six ? { air_temperature_max: temp(localHour, i) + 1, air_temperature_min: temp(localHour, i) - 1 } : {}) } };
    timeseries.push({
      time: at.toISOString().replace('.000', ''),
      data: {
        instant: { details: { air_temperature: temp(localHour, i), relative_humidity: 50, dew_point_temperature: 1, wind_speed: 4 } },
        ...(six ? { next_6_hours: block } : { next_1_hours: block, next_6_hours: { summary: { symbol_code: symbol }, details: { precipitation_amount: 9 } } }),
      },
    });
  }
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [64.8, 39.5, o.altitude ?? 225] }, properties: { timeseries } };
}

/** A NASA POWER daily body for the given offsets; offsets listed in `missing` carry the fill value. */
function powerBody(offsets: number[], missing: number[] = []) {
  const series = (value: (o: number) => number) =>
    Object.fromEntries(offsets.map((o) => [day(o).replaceAll('-', ''), missing.includes(o) ? -999 : value(o)]));
  return {
    header: { fill_value: -999 },
    properties: {
      parameter: {
        T2M_MAX: series((o) => 20 + o),
        T2M_MIN: series(() => 5),
        PRECTOTCORR: series(() => 0.4),
        WS10M_MAX: series(() => 5),
        WS2M: series(() => 1.5),
        RH2M: series(() => 30),
        T2MDEW: series(() => -3),
        ALLSKY_SFC_SW_DWN: series(() => 12),
      },
    },
  };
}

type Route = unknown | (() => Response | Promise<Response>);

/** fetch that answers MET Norway and NASA POWER separately. */
function serve(met: Route, power: Route = powerBody([])) {
  const answer = async (route: Route) =>
    typeof route === 'function' ? (route as () => Response)() : new Response(JSON.stringify(route), { status: 200 });
  return vi.fn(async (url: URL | string, _init?: RequestInit) => {
    const host = new URL(String(url)).hostname;
    if (host === 'api.met.no') return answer(met);
    if (host === 'power.larc.nasa.gov') return answer(power);
    throw new Error(`unexpected host ${host}`);
  });
}

const down = () => {
  throw new Error('ECONNREFUSED');
};
const urlsOf = (mock: ReturnType<typeof serve>) => mock.mock.calls.map(([u]) => new URL(String(u)));

beforeEach(() => {
  resetWeatherBackoff();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MET Norway forecast parsing', () => {
  it('builds whole local days from hourly and 6-hourly points without double counting', () => {
    const { hours, days, altitudeM } = parseForecast(metBody(), TZ);
    expect(hours).toHaveLength(52);
    expect(hours[0].periodHours).toBe(1);
    expect(hours[48].periodHours).toBe(6);
    expect(altitudeM).toBe(225);

    expect(days.map((d) => d.date)).toEqual([day(0), day(1), day(2)]);
    // 24 hourly points of 0.1 mm; the 6-hour total of 9 mm on hourly points is not counted again.
    expect(days[0]).toMatchObject({ tempMin: -2, tempMax: 10, precipitationMm: 2.4, weatherCode: 3, rhMeanPct: 50, dewPointC: 1, whole: true });
    // Four 6-hour blocks of 0.6 mm; block limits widen the range beyond the instants.
    expect(days[2]).toMatchObject({ tempMin: -3, tempMax: 11, precipitationMm: 2.4, whole: true });
    // 4 m/s at 10 m is about 3 m/s at 2 m (FAO-56 eq. 47); the daily maximum stays at 10 m in km/h.
    expect(days[0].windMeanMs).toBeCloseTo(2.99, 2);
    expect(days[0].windMaxKmh).toBe(14.4);
  });

  it('marks a day the forecast only partly covers', () => {
    const start = new Date(midnight(today()).getTime() + 14 * HOUR);
    // 10 hours of today, 18 of tomorrow.
    const { days } = parseForecast(metBody({ start, hourly: 28, sixHourly: 0 }), TZ);
    expect(days[0]).toMatchObject({ date: day(0), whole: false });
    expect(days[1]).toMatchObject({ date: day(1), whole: false });
  });

  it('takes the most severe symbol of the day', () => {
    const { days } = parseForecast(metBody({ symbol: (i) => (i === 5 ? 'heavyrainshowersandthunder_day' : 'fair_night') }), TZ);
    expect(days[0].weatherCode).toBe(95);
    expect(days[1].weatherCode).toBe(1);
    expect(wmoCodeOf('lightsnowshowers_polartwilight')).toBe(85);
    expect(wmoCodeOf('unknown_symbol')).toBeNull();
    expect(wmoCodeOf(undefined)).toBeNull();
  });
});

describe('weather', () => {
  it('stores the forecast and the observed past, and asks politely', async () => {
    const f = await createFixture();
    const fetchMock = serve(metBody(), powerBody([-5, -4, -3, -2, -1], [-2, -1]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await f.run(() => refreshWeather());
    expect(result).toEqual({ updated: 6, unavailable: false });

    const [met, power] = urlsOf(fetchMock).sort((a, b) => a.hostname.localeCompare(b.hostname));
    expect(met.hostname).toBe('api.met.no');
    expect(met.searchParams.get('lat')).toBe('39.5');
    expect(met.searchParams.get('lon')).toBe('64.8');
    expect(power.searchParams.get('start')).toBe(day(-14).replaceAll('-', ''));
    expect(power.searchParams.get('end')).toBe(day(-1).replaceAll('-', ''));
    // MET Norway blocks clients that do not say who they are.
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Record<string, string>)['User-Agent']).toContain(PRODUCT_NAME);
    }

    const rows = await f.run(() => forecast(2));
    expect(rows.map((r) => r.date)).toEqual([day(0), day(1)]);
    expect(rows[0]).toMatchObject({ tempMin: -2, tempMax: 10, precipitationMm: 2.4, isForecast: true, frost: true, source: 'met-norway' });

    const past = await f.run(() => getWeatherFor(day(-4), { fetchMissing: false }));
    expect(past).toMatchObject({ tempMax: 16, tempMin: 5, solarMj: 12, windMeanMs: 1.5, isForecast: false, source: 'nasa-power' });
    // A day NASA has not published yet is not stored as zero.
    expect(await f.run(() => getWeatherFor(day(-1), { fetchMissing: false }))).toBeNull();
  });

  it('keeps forecast points by the hour for advice', async () => {
    const f = await createFixture();
    vi.stubGlobal('fetch', serve(metBody()));
    await f.run(() => refreshWeather());
    const from = midnight(today());
    const points = await f.run(() => hourlyForecast(from, 6));
    expect(points).toHaveLength(6);
    expect(points[0]).toMatchObject({ periodHours: 1, tempC: -2, rhPct: 50, windMs: 4, precipMm: 0.1, weatherCode: 3 });

    // A newer run replaces the points it covers.
    vi.stubGlobal('fetch', serve(metBody({ temp: () => 7 })));
    await f.run(() => refreshWeather());
    expect((await f.run(() => hourlyForecast(from, 1)))[0].tempC).toBe(7);
  });

  it('takes the farm altitude from the forecast once', async () => {
    const f = await createFixture();
    vi.stubGlobal('fetch', serve(metBody({ altitude: 231 })));
    await f.run(() => refreshWeather());
    const altitude = () => f.run(async () => (await tx().select().from(schema.farms).where(eq(schema.farms.id, f.farmId)))[0].elevationM);
    expect(await altitude()).toBe(231);

    const fetchMock = serve(metBody({ altitude: 900 }));
    vi.stubGlobal('fetch', fetchMock);
    await f.run(() => refreshWeather());
    expect(await altitude()).toBe(231);
    // The stored altitude now sharpens the forecast.
    expect(urlsOf(fetchMock).find((u) => u.hostname === 'api.met.no')!.searchParams.get('altitude')).toBe('231');
  });

  it('runs as a farm job', async () => {
    const f = await createFixture();
    vi.stubGlobal('fetch', serve(metBody()));
    const job = jobs.find((j) => j.name === 'farm.weather') as FarmJob;
    expect(job.cron).toBe('15 */6 * * *');
    await f.run(() => job.run());
    expect(await f.run(() => forecast(1))).toHaveLength(1);
  });

  it('a forecast never replaces an observed day, and a part day never replaces a whole one', async () => {
    const f = await createFixture();
    vi.stubGlobal('fetch', serve(metBody()));
    await f.run(() => refreshWeather());

    // Observed weather for tomorrow, as if the day had passed.
    await f.run(() =>
      tx().update(schema.weatherDaily).set({ isForecast: false, source: 'nasa-power', tempMax: 30 }).where(eq(schema.weatherDaily.date, day(1))),
    );
    // A run that starts this afternoon covers only part of today.
    const start = new Date(midnight(today()).getTime() + 14 * HOUR);
    vi.stubGlobal('fetch', serve(metBody({ start, temp: () => 25 })));
    await f.run(() => refreshWeather());

    const [todayRow, tomorrow] = await f.run(() => forecast(2));
    expect(todayRow).toMatchObject({ tempMax: 10, tempMin: -2 });
    expect(tomorrow).toMatchObject({ tempMax: 30, isForecast: false });
  });

  it.each([
    ['network down', () => down],
    ['server error', () => () => new Response('{}', { status: 500 })],
    ['unexpected body', () => ({ properties: { timeseries: 'nope' } })],
  ])('degrades quietly: %s', async (_label, makeRoute) => {
    const f = await createFixture();
    vi.stubGlobal('fetch', serve(makeRoute(), down));
    await expect(f.run(() => refreshWeather())).resolves.toEqual({ updated: 0, unavailable: true });
    expect(await f.run(() => forecast(7))).toEqual([]);
  });

  it('stores the past even when the forecast is down', async () => {
    const f = await createFixture();
    vi.stubGlobal('fetch', serve(down, powerBody([-6])));
    expect(await f.run(() => refreshWeather())).toEqual({ updated: 1, unavailable: true });
  });

  it('backs off after a failure so saves are not delayed', async () => {
    const f = await createFixture();
    const failing = serve(down, down);
    vi.stubGlobal('fetch', failing);
    await f.run(() => refreshWeather());
    await f.run(() => refreshWeather());
    await f.run(() => getWeatherFor(day(-3)));
    await f.run(() => getWeatherFor(day(2)));
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('skips a farm without coordinates', async () => {
    const f = await createFixture();
    await f.run(() => tx().update(schema.farms).set({ lat: null, lng: null }).where(eq(schema.farms.id, f.farmId)));
    const fetchMock = serve(metBody());
    vi.stubGlobal('fetch', fetchMock);
    expect(await f.run(() => refreshWeather())).toEqual({ updated: 0, unavailable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getWeatherFor uses stored data without touching the network', async () => {
    const f = await createFixture();
    vi.stubGlobal('fetch', serve(metBody()));
    await f.run(() => refreshWeather());
    const fetchMock = serve(metBody());
    vi.stubGlobal('fetch', fetchMock);
    expect(await f.run(() => getWeatherFor(day(0)))).toMatchObject({ date: day(0), tempMin: -2 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getWeatherFor asks NASA POWER for a past date and stores it', async () => {
    const f = await createFixture();
    const fetchMock = serve(metBody(), powerBody([-200]));
    vi.stubGlobal('fetch', fetchMock);
    const snapshot = await f.run(() => getWeatherFor(day(-200)));
    expect(snapshot).toMatchObject({ date: day(-200), isForecast: false, source: 'nasa-power' });
    const [url] = urlsOf(fetchMock);
    expect(url.hostname).toBe('power.larc.nasa.gov');
    expect(url.searchParams.get('start')).toBe(day(-200).replaceAll('-', ''));
    expect(url.searchParams.get('end')).toBe(day(-200).replaceAll('-', ''));
    await f.run(() => getWeatherFor(day(-200)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getWeatherFor asks MET Norway for a coming date', async () => {
    const f = await createFixture();
    const fetchMock = serve(metBody());
    vi.stubGlobal('fetch', fetchMock);
    expect(await f.run(() => getWeatherFor(day(1)))).toMatchObject({ date: day(1), isForecast: true });
    expect(urlsOf(fetchMock).map((u) => u.hostname)).toEqual(['api.met.no']);
  });

  it('getWeatherFor returns null rather than guessing', async () => {
    const f = await createFixture();
    const fetchMock = serve(metBody(), powerBody([-2], [-2]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await f.run(() => getWeatherFor(day(60)))).toBeNull();
    expect(await f.run(() => getWeatherFor(day(-1), { fetchMissing: false }))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // Not yet published by NASA.
    expect(await f.run(() => getWeatherFor(day(-2)))).toBeNull();
  });

  it('unknown temperature gives unknown frost, not "no frost"', async () => {
    const f = await createFixture();
    await f.run(() => tx().insert(schema.weatherDaily).values({ tenantId: f.tenantId, farmId: f.farmId, date: day(0), tempMin: null }));
    expect((await f.run(() => forecast(1)))[0]).toMatchObject({ tempMin: null, frost: null });
  });

  it('serves weather through the API, and reports an outage as a result', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    vi.stubGlobal('fetch', serve(down, down));
    const refreshed = await owner.post('/farm/weather/refresh');
    expect(refreshed.status).toBe(200);
    expect(refreshed.data).toEqual({ updated: 0, unavailable: true });

    resetWeatherBackoff();
    vi.stubGlobal('fetch', serve(metBody()));
    expect((await owner.post('/farm/weather/refresh')).data).toEqual({ updated: 3, unavailable: false });

    const res = await owner.get('/farm/weather/forecast', { days: 2 });
    expect(res.data.map((r: any) => r.date)).toEqual([day(0), day(1)]);
    expect((await owner.get('/farm/weather', { from: day(0), to: day(2) })).data).toHaveLength(3);

    // The dashboard shows the forecast to investors; a shepherd has no such screen.
    expect((await (await f.as('investor')).get('/farm/weather/forecast')).status).toBe(200);
    expect((await (await f.as('shepherd')).get('/farm/weather/forecast')).status).toBe(403);
    expect((await (await f.as('agronomist')).post('/farm/weather/refresh')).status).toBe(200);
    expect((await (await f.as('investor')).post('/farm/weather/refresh')).status).toBe(403);
  });
});
