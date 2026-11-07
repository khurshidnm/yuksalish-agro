import { describe, expect, it } from 'vitest';
import {
  SHEEP_THI_THRESHOLDS,
  daytimeWindows,
  localHourOf,
  SPRAY_LIMITS,
  assessSprayHour,
  dayOfYear,
  deltaT,
  et0PenmanMonteith,
  extraterrestrialRadiation,
  frostSeverity,
  hargreavesRadiation,
  saturationVapourPressure,
  sheepHeatStress,
  sheepThi,
  sprayWindows,
  wetBulbStull,
  windSpeedAt2m,
  type Et0DayInput,
  type SprayHour,
} from './agro-weather';

describe('FAO-56 building blocks', () => {
  it('saturationVapourPressure matches FAO-56 Annex 2 (eq. 11)', () => {
    expect(saturationVapourPressure(24.5)).toBeCloseTo(3.075, 3);
    expect(saturationVapourPressure(15)).toBeCloseTo(1.705, 3);
  });

  it('windSpeedAt2m: 3.2 m/s at 10 m is 2.4 m/s at 2 m (FAO-56 Example 14)', () => {
    expect(windSpeedAt2m(3.2, 10)).toBeCloseTo(2.4, 1);
    expect(windSpeedAt2m(3, 2)).toBeCloseTo(3, 2);
  });

  it('dayOfYear', () => {
    expect(dayOfYear('2026-01-01')).toBe(1);
    expect(dayOfYear('2026-07-06')).toBe(187);
    expect(dayOfYear('2026-09-03')).toBe(246);
    expect(dayOfYear('2024-12-31')).toBe(366);
  });

  it('extraterrestrialRadiation: 20°S on 3 September is 32.2 MJ/m²/day (FAO-56 Example 8)', () => {
    expect(extraterrestrialRadiation(-20, dayOfYear('2026-09-03'))).toBeCloseTo(32.2, 1);
    // Brussels, 6 July: FAO-56 Example 18 gives 41.09.
    expect(extraterrestrialRadiation(50 + 48 / 60, 187)).toBeCloseTo(41.09, 2);
    // Polar night: the sun does not rise.
    expect(extraterrestrialRadiation(75, dayOfYear('2026-12-21'))).toBe(0);
  });

  it('hargreavesRadiation: Lyon, 45°43\'N, 15 July (FAO-56 Example 15): Ra 40.6, Rs 22.3', () => {
    const ra = extraterrestrialRadiation(45 + 43 / 60, dayOfYear('2026-07-15'));
    expect(ra).toBeCloseTo(40.6, 1);
    expect(hargreavesRadiation(14.8, 26.6, ra)).toBeCloseTo(22.3, 1);
    // Coastal coefficient: 0.19 / 0.16 of the interior estimate.
    expect(hargreavesRadiation(14.8, 26.6, ra, 0.19)).toBeCloseTo((hargreavesRadiation(14.8, 26.6, ra) * 0.19) / 0.16, 10);
  });
});

describe('et0PenmanMonteith', () => {
  // FAO-56 Example 18: Brussels, 6 July, 50°48'N, 100 m, wind 10 km/h at 10 m.
  const brussels: Et0DayInput = {
    date: '2026-07-06',
    latitudeDeg: 50 + 48 / 60,
    elevationM: 100,
    tMaxC: 21.5,
    tMinC: 12.3,
    rhMaxPct: 84,
    rhMinPct: 63,
    windSpeed2mMs: windSpeedAt2m(10 / 3.6, 10),
    solarRadiationMj: 22.07,
  };

  it('Brussels, FAO-56 Example 18: 3.9 mm/day', () => {
    expect(brussels.windSpeed2mMs).toBeCloseTo(2.078, 3);
    const et0 = et0PenmanMonteith(brussels)!;
    expect(Math.abs(et0 - 3.9)).toBeLessThan(0.05);
  });

  it('missing temperature, wind or humidity gives null instead of a guess', () => {
    expect(et0PenmanMonteith({ ...brussels, rhMaxPct: null, rhMinPct: null })).toBeNull();
    expect(et0PenmanMonteith({ ...brussels, rhMaxPct: undefined, rhMinPct: 63 })).toBeNull();
    expect(et0PenmanMonteith({ ...brussels, windSpeed2mMs: null })).toBeNull();
    expect(et0PenmanMonteith({ ...brussels, tMinC: null })).toBeNull();
    expect(et0PenmanMonteith({ ...brussels, tMaxC: null })).toBeNull();
    // Tmax below Tmin is a broken record.
    expect(et0PenmanMonteith({ ...brussels, tMaxC: 10 })).toBeNull();
  });

  it('dew point outranks RH, and RH mean is the last resort', () => {
    const withDew = et0PenmanMonteith({ ...brussels, dewPointC: 12 });
    expect(withDew).toBe(et0PenmanMonteith({ ...brussels, rhMaxPct: null, rhMinPct: null, dewPointC: 12 }));
    expect(withDew).not.toBe(et0PenmanMonteith(brussels));

    const withMean = et0PenmanMonteith({ ...brussels, rhMaxPct: null, rhMinPct: null, rhMeanPct: 73.5 });
    expect(withMean).not.toBeNull();
    // RH max and min win over RH mean when both are present.
    expect(et0PenmanMonteith({ ...brussels, rhMeanPct: 40 })).toBe(et0PenmanMonteith(brussels));
  });

  it('missing solar radiation is estimated with Hargreaves from Ra', () => {
    const ra = extraterrestrialRadiation(brussels.latitudeDeg, 187);
    const estimated = hargreavesRadiation(12.3, 21.5, ra);
    expect(et0PenmanMonteith({ ...brussels, solarRadiationMj: null })).toBe(
      et0PenmanMonteith({ ...brussels, solarRadiationMj: estimated }),
    );
  });

  it('a negative result is 0, and polar night is null', () => {
    // Air wetter than saturation (dew point above Tmax) on a dark winter day: the formula goes below 0.
    const winter: Et0DayInput = {
      date: '2026-01-15',
      latitudeDeg: 60,
      elevationM: 0,
      tMinC: -5,
      tMaxC: -4,
      dewPointC: -3,
      windSpeed2mMs: 6,
      solarRadiationMj: 1,
    };
    expect(et0PenmanMonteith(winter)).toBe(0);
    expect(
      et0PenmanMonteith({ ...winter, date: '2026-12-21', latitudeDeg: 75, solarRadiationMj: null }),
    ).toBeNull();
  });
});

describe('sheep heat stress (Marai et al. 2007)', () => {
  it('sheepThi, hand-computed', () => {
    // 35 − (0.31 − 0.093)(20.6) = 35 − 4.4702
    expect(sheepThi(35, 30)).toBeCloseTo(30.5298, 10);
    // 25 − 0.155 × 10.6 = 25 − 1.643
    expect(sheepThi(25, 50)).toBeCloseTo(23.357, 10);
    // 20 − 0.155 × 5.6 = 20 − 0.868
    expect(sheepThi(20, 50)).toBeCloseTo(19.132, 10);
    expect(sheepThi(null, 50)).toBeNull();
    expect(sheepThi(30, null)).toBeNull();
  });

  it('sheepHeatStress classes and their boundaries', () => {
    expect(sheepHeatStress(sheepThi(35, 30))).toBe('extreme');
    expect(sheepHeatStress(sheepThi(25, 50))).toBe('severe');
    expect(sheepHeatStress(sheepThi(20, 50))).toBe('none');
    expect(sheepHeatStress(22.19)).toBe('none');
    expect(sheepHeatStress(SHEEP_THI_THRESHOLDS.moderate)).toBe('moderate');
    expect(sheepHeatStress(23.29)).toBe('moderate');
    expect(sheepHeatStress(SHEEP_THI_THRESHOLDS.severe)).toBe('severe');
    expect(sheepHeatStress(25.59)).toBe('severe');
    expect(sheepHeatStress(SHEEP_THI_THRESHOLDS.extreme)).toBe('extreme');
    expect(sheepHeatStress(null)).toBeNull();
  });
});

describe('spraying', () => {
  it('wetBulbStull: 20 °C at 50 % is 13.7 °C (Stull 2011)', () => {
    expect(wetBulbStull(20, 50)).toBeCloseTo(13.7, 1);
    expect(deltaT(20, 50)).toBeCloseTo(6.3, 1);
  });

  it('SPRAY_LIMITS: wind 3 to 15 km/h', () => {
    expect(SPRAY_LIMITS.windMinMs).toBeCloseTo(0.83, 2);
    expect(SPRAY_LIMITS.windMaxMs).toBeCloseTo(4.17, 2);
  });

  it('assessSprayHour names each problem', () => {
    const good = { tempC: 20, rhPct: 60, windMs: 2, precipMm: 0 };
    expect(assessSprayHour(good)).toEqual({ suitable: true, issues: [] });
    expect(assessSprayHour({ ...good, windMs: 5 })).toEqual({ suitable: false, issues: ['wind_strong'] });
    expect(assessSprayHour({ ...good, windMs: 0.5 })).toEqual({ suitable: false, issues: ['wind_calm'] });
    expect(assessSprayHour({ ...good, precipMm: 0.1 })).toEqual({ suitable: false, issues: ['rain'] });
    expect(assessSprayHour({ ...good, precipMm: 0.09 }).suitable).toBe(true);
    // 30 °C at 60 %: Delta T 6.0, so only the heat.
    expect(assessSprayHour({ ...good, tempC: 30 })).toEqual({ suitable: false, issues: ['hot'] });
    // 25 °C at 30 %: Delta T 10.4.
    expect(deltaT(25, 30)).toBeCloseTo(10.4, 1);
    expect(assessSprayHour({ ...good, tempC: 25, rhPct: 30 })).toEqual({ suitable: false, issues: ['dry_air'] });
    expect(assessSprayHour({ tempC: 32, rhPct: 15, windMs: 6, precipMm: 1 }).issues).toEqual([
      'wind_strong',
      'rain',
      'hot',
      'dry_air',
    ]);
  });

  it('assessSprayHour: a missing reading leaves the verdict unknown', () => {
    const good = { tempC: 20, rhPct: 60, windMs: 2, precipMm: 0 };
    expect(assessSprayHour({ ...good, windMs: null })).toEqual({ suitable: null, issues: [] });
    expect(assessSprayHour({ ...good, precipMm: null }).suitable).toBeNull();
    expect(assessSprayHour({ ...good, rhPct: null }).suitable).toBeNull();
    // Problems in the known readings are still reported.
    expect(assessSprayHour({ ...good, tempC: null, windMs: 6 })).toEqual({ suitable: null, issues: ['wind_strong'] });
  });

  const base = Date.parse('2026-05-01T00:00:00Z');
  const hour = (n: number, over: Partial<SprayHour> = {}): SprayHour => ({
    time: new Date(base + n * 3_600_000).toISOString(),
    tempC: 20,
    rhPct: 60,
    windMs: 2,
    precipMm: 0,
    ...over,
  });
  const at = (n: number) => new Date(base + n * 3_600_000).toISOString();

  it('sprayWindows: rain in the next two hours, and an unknown tail, disqualify an hour', () => {
    // Hours 0-7, rain at 05:00. Hours 3 and 4 have rain within two hours, hour 5 is raining,
    // hours 6 and 7 need hours 8 and 9, which are not in the forecast.
    const hours = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => hour(n, n === 5 ? { precipMm: 0.5 } : {}));
    expect(sprayWindows(hours)).toEqual([{ start: at(0), end: at(3), hours: 3 }]);
    // Without the look-ahead: 00-05 and 06-08.
    expect(sprayWindows(hours, { rainFreeHoursAfter: 0 })).toEqual([
      { start: at(0), end: at(5), hours: 5 },
      { start: at(6), end: at(8), hours: 2 },
    ]);
  });

  it('sprayWindows: a gap in the hours splits a window, and the following hour must be known', () => {
    // Hour 4 is missing.
    const hours = [0, 1, 2, 3, 5, 6, 7, 8, 9].map((n) => hour(n));
    expect(sprayWindows(hours, { rainFreeHoursAfter: 0 })).toEqual([
      { start: at(0), end: at(4), hours: 4 },
      { start: at(5), end: at(10), hours: 5 },
    ]);
    // Hours 2 and 3 look ahead into the gap; hours 8 and 9 past the end of the forecast.
    expect(sprayWindows(hours)).toEqual([
      { start: at(0), end: at(2), hours: 2 },
      { start: at(5), end: at(8), hours: 3 },
    ]);
    // A following hour with no precipitation reading is not dry.
    const unknownRain = [0, 1, 2, 3, 4, 5].map((n) => hour(n, n === 3 ? { precipMm: null } : {}));
    expect(sprayWindows(unknownRain, { rainFreeHoursAfter: 1 })).toEqual([{ start: at(0), end: at(2), hours: 2 }]);
  });

  it('sprayWindows: the minimum length, unsorted input and times without an offset', () => {
    // Only hour 2 qualifies: wind too strong on either side.
    const hours = [0, 1, 2, 3, 4, 5].map((n) => hour(n, n === 2 ? {} : { windMs: 8 }));
    expect(sprayWindows(hours)).toEqual([]);
    expect(sprayWindows(hours, { minHours: 1 })).toEqual([{ start: at(2), end: at(3), hours: 1 }]);

    const ordered = [0, 1, 2, 3, 4, 5].map((n) => hour(n));
    expect(sprayWindows([...ordered].reverse())).toEqual(sprayWindows(ordered));
    expect(sprayWindows(ordered)).toEqual([{ start: at(0), end: at(4), hours: 4 }]);

    // Same instants written in Tashkent time give the same windows.
    const local = ordered.map((h, n) => ({ ...h, time: `2026-05-01T${String(5 + n).padStart(2, '0')}:00:00+05:00` }));
    expect(sprayWindows(local)).toEqual(sprayWindows(ordered));
    // No offset: the zone would be a guess, so the hour is ignored.
    expect(sprayWindows(ordered.map((h) => ({ ...h, time: h.time.replace('Z', '') })))).toEqual([]);
  });
});

describe('frostSeverity', () => {
  it('above 0 none, (−2, 0] light, −2 and below hard', () => {
    expect(frostSeverity(0.5)).toBe('none');
    expect(frostSeverity(0)).toBe('light');
    expect(frostSeverity(-1.9)).toBe('light');
    expect(frostSeverity(-2)).toBe('hard');
    expect(frostSeverity(-6)).toBe('hard');
    expect(frostSeverity(null)).toBeNull();
  });
});

describe('daytime spraying windows', () => {
  const tz = 'Asia/Tashkent';
  const at = (local: string) => new Date(`${local}+05:00`).toISOString();

  it('reads the local hour', () => {
    expect(localHourOf('2026-11-07T00:30:00Z', tz)).toBe(5);
    expect(localHourOf('2026-11-07T19:00:00Z', tz)).toBe(0);
  });

  it('cuts a run that spans a night into one window each morning', () => {
    const run = { start: at('2026-11-07T14:00:00'), end: at('2026-11-08T09:00:00'), hours: 19 };
    expect(daytimeWindows([run], tz)).toEqual([
      { start: at('2026-11-07T14:00:00'), end: at('2026-11-07T20:00:00'), hours: 6 },
      { start: at('2026-11-08T05:00:00'), end: at('2026-11-08T09:00:00'), hours: 4 },
    ]);
  });

  it('drops daytime pieces too short to do the work', () => {
    const evening = { start: at('2026-11-07T19:00:00'), end: at('2026-11-08T06:00:00'), hours: 11 };
    expect(daytimeWindows([evening], tz)).toEqual([]);
    expect(daytimeWindows([evening], tz, { fromHour: 5, toHour: 20, minHours: 1 })).toHaveLength(2);
  });
});
