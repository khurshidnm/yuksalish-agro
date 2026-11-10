import { describe, expect, it } from 'vitest';
import * as ai from './ai';

describe('basic statistics', () => {
  it('mean and sample standard deviation match a hand calculation', () => {
    expect(ai.mean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5);
    // Sum of squared deviations is 32, n − 1 = 7.
    expect(ai.sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 10);
    expect(ai.mean([])).toBeNull();
    expect(ai.sampleStdDev([1])).toBeNull();
  });

  it('movingAverage leaves the first window empty', () => {
    expect(ai.movingAverage([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });

  it('zScore floors the spread so a flat baseline still works', () => {
    // Flat at 100: the spread is the 2% floor, so 120 is (120 − 100) / 2 = 10.
    expect(ai.zScore(120, [100, 100, 100])).toBeCloseTo(10, 8);
    expect(ai.zScore(1, [5])).toBeNull();
    expect(ai.zScore(1, [0, 0, 0])).toBeNull();
  });

  it('confidence rises with effect and sample and stays within bounds', () => {
    expect(ai.findingConfidence(2, 0, 7)).toBe(0.5);
    expect(ai.findingConfidence(50, 100, 7)).toBe(0.95);
    expect(ai.findingConfidence(4, 21, 7)).toBeGreaterThan(ai.findingConfidence(3, 7, 7));
  });
});

describe('detectAnomalies', () => {
  const flat = Array.from({ length: 13 }, () => 100);

  it('flags a 20% spike on the newest day', () => {
    const [found] = ai.detectAnomalies([...flat, 120], { window: 14, minBaseline: 7, lookback: 3 });
    expect(found).toMatchObject({ index: 13, value: 120, baselineSize: 13, deviationPercent: 20, z: 10 });
    expect(found.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('claims nothing below the minimum baseline', () => {
    expect(ai.detectAnomalies([100, 100, 100, 200], { window: 14, minBaseline: 7, lookback: 3 })).toEqual([]);
    expect(ai.hasEnoughBaseline(4, 7)).toBe(false);
    expect(ai.hasEnoughBaseline(8, 7)).toBe(true);
  });

  it('ignores ordinary noise and small relative changes', () => {
    const noisy = [100, 104, 96, 101, 99, 103, 97, 100, 102, 98, 101];
    expect(ai.detectAnomalies([...noisy, 103], { window: 14, minBaseline: 7, lookback: 3 })).toEqual([]);
    // Statistically odd but under 10%: not worth anyone's attention.
    expect(ai.detectAnomalies([...flat, 107], { window: 14, minBaseline: 7, lookback: 1 })).toEqual([]);
  });

  it('respects the direction', () => {
    const series = [...flat, 70];
    expect(ai.detectAnomalies(series, { window: 14, minBaseline: 7, lookback: 1, direction: 'up' })).toEqual([]);
    expect(ai.detectAnomalies(series, { window: 14, minBaseline: 7, lookback: 1, direction: 'down' })).toHaveLength(1);
  });

  it('only judges the lookback window', () => {
    const series = [...flat, 150, ...Array.from({ length: 5 }, () => 100)];
    expect(ai.detectAnomalies(series, { window: 14, minBaseline: 7, lookback: 3 })).toEqual([]);
    expect(ai.detectAnomalies(series, { window: 14, minBaseline: 7, lookback: 6 }).map((a) => a.value)).toEqual([150]);
  });
});

describe('countSpike', () => {
  it('flags a week well above a quiet baseline', () => {
    // Expected 0.5 a week; (6 − 0.5) / sqrt(0.5) = 7.78.
    const spike = ai.countSpike(6, [0, 1, 0, 1, 0, 1], { minBaseline: 6 });
    expect(spike).toMatchObject({ expected: 0.5, z: 7.78 });
  });

  it('stays silent on a single loss, on normal weeks, and with too little history', () => {
    expect(ai.countSpike(1, [0, 0, 0, 0, 0, 0], { minBaseline: 6 })).toBeNull();
    expect(ai.countSpike(3, [3, 2, 3, 4, 3, 3], { minBaseline: 6 })).toBeNull();
    expect(ai.countSpike(6, [0, 1], { minBaseline: 6 })).toBeNull();
  });
});

describe('gainSlowdown', () => {
  it('reports when the latest interval falls below 70% of the earlier mean', () => {
    const r = ai.gainSlowdown([0.2, 0.2, 0.12]);
    expect(r).toMatchObject({ latest: 0.12, previousMean: 0.2, ratio: 0.6 });
  });

  it('needs enough intervals and a real earlier gain', () => {
    expect(ai.gainSlowdown([0.2, 0.1])).toBeNull();
    expect(ai.gainSlowdown([0.2, 0.2, 0.18])).toBeNull();
    expect(ai.gainSlowdown([-0.1, -0.1, -0.2])).toBeNull();
  });
});

describe('forecasts', () => {
  it('weekStartOf returns the Monday', () => {
    expect(ai.weekStartOf('2026-11-04')).toBe('2026-11-02'); // Wednesday
    expect(ai.weekStartOf('2026-11-02')).toBe('2026-11-02'); // Monday
    expect(ai.weekStartOf('2026-11-08')).toBe('2026-11-02'); // Sunday
  });

  it('lambingWorkload matches the hand-computed weeks', () => {
    const rows = ai.lambingWorkload(
      [
        { weekStart: '2027-02-15', ewes: 10 },
        { weekStart: '2027-02-22', ewes: 20 },
        { weekStart: '2027-03-01', ewes: 30 },
      ],
      { lambsPerEwe: 1.2, lactationWeeks: 2, extraKgPerEweDay: 0.5, laborHoursPerLambing: 1, shiftHours: 10 },
    );
    expect(rows).toEqual([
      { weekStart: '2027-02-15', ewes: 10, lambs: 12, lactatingEwes: 10, extraFeedKg: 35, laborHours: 10, workersNeeded: 1 },
      { weekStart: '2027-02-22', ewes: 20, lambs: 24, lactatingEwes: 30, extraFeedKg: 105, laborHours: 20, workersNeeded: 1 },
      { weekStart: '2027-03-01', ewes: 30, lambs: 36, lactatingEwes: 50, extraFeedKg: 175, laborHours: 30, workersNeeded: 1 },
      // No lambing, but the last 30 ewes are in their second lactation week.
      { weekStart: '2027-03-08', ewes: 0, lambs: 0, lactatingEwes: 30, extraFeedKg: 105, laborHours: 0, workersNeeded: 0 },
    ]);
    // 60 ewes × 2 weeks × 7 days × 0.5 kg.
    expect(rows.reduce((sum, r) => sum + r.extraFeedKg!, 0)).toBe(420);
  });

  it('lambingWorkload feeds every ewe for her whole lactation, past the last lambing (control numbers)', () => {
    // 700 ewes lambing over four weeks, 8 weeks on the lactating ration at 1.206 kg a day more.
    const rows = ai.lambingWorkload(
      [
        { weekStart: '2027-02-01', ewes: 100 },
        { weekStart: '2027-02-08', ewes: 300 },
        { weekStart: '2027-02-15', ewes: 200 },
        { weekStart: '2027-02-22', ewes: 100 },
      ],
      { lambsPerEwe: 1.1, lactationWeeks: 8, extraKgPerEweDay: 1.206, laborHoursPerLambing: 1, shiftHours: 10 },
    );
    // Seven weeks after the last lambing, until the ewes that lambed in its week are weaned.
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.lactatingEwes)).toEqual([100, 400, 600, 700, 700, 700, 700, 700, 600, 300, 100]);
    expect(rows.at(-1)).toEqual({ weekStart: '2027-04-12', ewes: 0, lambs: 0, lactatingEwes: 100, extraFeedKg: 844.2, laborHours: 0, workersNeeded: 0 });
    // 700 ewes × 8 weeks × 7 days × 1.206 kg = 47 275.2 kg. Stopping at the last lambing gave 15 195.6.
    expect(rows.reduce((sum, r) => sum + r.extraFeedKg!, 0)).toBeCloseTo(47_275.2, 6);
    expect(rows.reduce((sum, r) => sum + r.lambs, 0)).toBe(770);
  });

  it('lambingWorkload of no lambing is an empty table', () => {
    expect(ai.lambingWorkload([], { lambsPerEwe: 1.1, lactationWeeks: 8, extraKgPerEweDay: 1, laborHoursPerLambing: 1, shiftHours: 10 })).toEqual([]);
  });

  it('lambingWorkload keeps extra feed null when a ration is missing', () => {
    const [row] = ai.lambingWorkload([{ weekStart: '2027-02-15', ewes: 100 }], {
      lambsPerEwe: 1,
      lactationWeeks: 8,
      extraKgPerEweDay: null,
      laborHoursPerLambing: 2,
      shiftHours: 10,
    });
    expect(row.extraFeedKg).toBeNull();
    expect(row.workersNeeded).toBe(3); // 200 h / 70 h a week
  });

  it('seasonForecast matches a hand calculation and skips incomplete lines', () => {
    const forecast = ai.seasonForecast([
      { areaHa: 10, expectedYieldTHa: 4, pricePerT: 1000, plannedCost: 20_000, actualCost: 25_000, harvestedT: null },
      { areaHa: 10, expectedYieldTHa: 4, pricePerT: 2000, plannedCost: 10_000, actualCost: 8000, harvestedT: 30 },
      { areaHa: 5, expectedYieldTHa: 4, pricePerT: null, plannedCost: 1000, actualCost: null, harvestedT: null },
    ]);
    expect(forecast).toEqual({
      revenue: 100_000,
      cost: 35_000,
      profit: 65_000,
      profitabilityPercent: 185.71,
      linesUsed: 2,
      linesSkipped: 1,
      areaCoveredPercent: 80,
    });
  });

  it('seasonForecast with nothing usable reports no profitability', () => {
    expect(ai.seasonForecast([]).profitabilityPercent).toBeNull();
    const none = ai.seasonForecast([
      { areaHa: 5, expectedYieldTHa: null, pricePerT: 10, plannedCost: 1, actualCost: null, harvestedT: null },
    ]);
    expect(none).toMatchObject({ linesUsed: 0, linesSkipped: 1, areaCoveredPercent: 0 });
  });

  it('feedRunOutDate counts whole days', () => {
    expect(ai.feedRunOutDate(3000, 600, '2026-11-04')).toBe('2026-11-09');
    expect(ai.feedRunOutDate(3100, 600, '2026-11-04')).toBe('2026-11-09');
    expect(ai.feedRunOutDate(3000, 0, '2026-11-04')).toBeNull();
  });

  it('costPerKgDryMatter', () => {
    expect(ai.costPerKgDryMatter(900, 90)).toBeCloseTo(1000, 8);
    expect(ai.costPerKgDryMatter(900, 0)).toBeNull();
  });

  it('rationSavingOption moves dry matter from the dearest to the cheapest feed of one group', () => {
    const saving = ai.rationSavingOption(
      [
        { itemId: 'a', name: 'Beda pichani', kgPerHeadDay: 1, unitCostPerKg: 3000, dryMatterPct: 90 },
        { itemId: 'b', name: 'Somon', kgPerHeadDay: 1, unitCostPerKg: 1000, dryMatterPct: 88 },
      ],
      500,
    );
    // 0.09 kg DM × (3333.33 − 1136.36) = 197.73 per head per day, 4.9% of the 4000 the ration costs.
    expect(saving).toEqual({
      fromItemId: 'a',
      fromName: 'Beda pichani',
      toItemId: 'b',
      toName: 'Somon',
      feedClass: 'roughage',
      shiftKgDmPerHeadDay: 0.09,
      savingPerHeadDay: 197.73,
      savingPerDay: 98_863.64,
      rationCostPerHeadDay: 4000,
      savingPercent: 4.9,
    });
  });

  it('rationSavingOption needs two priced components', () => {
    const line = { itemId: 'a', name: 'Pichan', kgPerHeadDay: 1, unitCostPerKg: 100, dryMatterPct: 90 };
    expect(ai.rationSavingOption([line], 10)).toBeNull();
    expect(ai.rationSavingOption([line, { ...line, itemId: 'b', name: 'Somon', unitCostPerKg: null }], 10)).toBeNull();
    expect(ai.rationSavingOption([line, { ...line, itemId: 'b', name: 'Somon' }], 10)).toBeNull();
    expect(ai.rationSavingOption([line, { ...line, itemId: 'b', name: 'Somon', unitCostPerKg: 50 }], 0)).toBeNull();
  });

  it('rankCropOptions orders by margin and applies rotation and feed adjustments', () => {
    const base = { isFeed: false, feedShortage: false };
    const ranked = ai.rankCropOptions(
      [
        { ...base, key: 'wheat', yieldTHa: 5, pricePerT: 3_000_000, costPerHa: 9_000_000 },
        { ...base, key: 'barley', yieldTHa: 4, pricePerT: 2_500_000, costPerHa: 5_000_000, isFeed: true, feedShortage: true },
        { ...base, key: 'rice', yieldTHa: null, pricePerT: 1, costPerHa: 1 },
      ],
      [{ key: 'wheat', family: null }],
    );
    // wheat margin 6 mln, less 25% = 4.5 mln. barley margin 5 mln, plus 15% = 5.75 mln.
    expect(ranked).toEqual([
      { key: 'barley', marginPerHa: 5_000_000, score: 5_750_000, reasons: ['feed_shortage_bonus'] },
      { key: 'wheat', marginPerHa: 6_000_000, score: 4_500_000, reasons: ['rotation_penalty'] },
    ]);
  });

  it('a perennial crop carries no rotation penalty', () => {
    const [ranked] = ai.rankCropOptions(
      [{ key: 'alfalfa', yieldTHa: 8, pricePerT: 1, costPerHa: 1, isFeed: true, family: 'perennial_grass', feedShortage: false }],
      [{ key: 'alfalfa', family: 'perennial_grass' }],
    );
    expect(ranked.reasons).toEqual([]);
  });

  it('the penalty follows the rotation rules: a cereal after another cereal is penalised too', () => {
    const wheat = { key: 'wheat', yieldTHa: 5, pricePerT: 2, costPerHa: 2, isFeed: false, family: 'cereal' as const, feedShortage: false };
    expect(ai.rankCropOptions([wheat], [{ key: 'barley', family: 'cereal' }])[0].reasons).toEqual(['rotation_penalty']);
    expect(ai.rankCropOptions([wheat], [{ key: 'alfalfa', family: 'perennial_grass' }])[0].reasons).toEqual([]);
  });

  it('two cereals on two equal fields swap places, though every choice carries the penalty', () => {
    const crop = (key: string, pricePerT: number) => ({ key, yieldTHa: 4, pricePerT, costPerHa: 0, isFeed: false, family: 'cereal' as const, feedShortage: false });
    const { assignments } = ai.allocateCrops(
      [
        { id: 'a', areaHa: 10, lastCropKey: 'wheat' },
        { id: 'b', areaHa: 10, lastCropKey: 'barley' },
      ],
      [crop('wheat', 3), crop('barley', 2)],
    );
    // Wheat scores 12 less 25 % = 9 on both fields. Field b takes it, because on field a it would follow itself.
    expect(assignments.map((x) => [x.fieldId, x.key])).toEqual([['a', 'barley'], ['b', 'wheat']]);
    expect(assignments.every((x) => x.reasons.includes('rotation_penalty'))).toBe(true);
  });
});

describe('feed groups', () => {
  it.each([
    // Uzbek Latin
    ["Bug'doy somoni", 'roughage'],
    ['Beda (pichan)', 'roughage'],
    ["Makkajo'xori silosi", 'succulent'],
    ["Mineral qo'shimcha", 'mineral'],
    ['Tuz', 'mineral'],
    ['Arpa', 'concentrate'],
    ['Omuxta yem', 'concentrate'],
    ['Kunjara', 'protein'],
    // Uzbek Cyrillic
    ['Буғдой сомони', 'roughage'],
    ['Маккажўхори силоси', 'succulent'],
    ['Минерал қўшимча', 'mineral'],
    ['Арпа', 'concentrate'],
    ['Кунжара', 'protein'],
    // Russian
    ['Солома пшеничная', 'roughage'],
    ['Сено люцерновое', 'roughage'],
    ['Силос кукурузный', 'succulent'],
    ['Соль-лизунец', 'mineral'],
    ['Премикс', 'mineral'],
    ['Ячмень', 'concentrate'],
    ['Жмых подсолнечный', 'protein'],
    // English
    ['Wheat straw', 'roughage'],
    ['Alfalfa hay', 'roughage'],
    ['Corn silage', 'succulent'],
    ['Mineral premix', 'mineral'],
    ['Barley', 'concentrate'],
    ['Soybean meal', 'protein'],
  ])('%s is %s', (name, group) => {
    expect(ai.feedClassOf(name)).toBe(group);
  });

  it('reads a wet feed as succulent and does not guess an unknown name', () => {
    expect(ai.feedClassOf("Ko'k massa", 22)).toBe('succulent');
    expect(ai.feedClassOf('Ozuqa №3', 88)).toBeNull();
    expect(ai.feedClassOf('Ozuqa №3')).toBeNull();
    // A name that says supplement stays one, however dry or wet.
    expect(ai.feedClassOf('Vitamin eritmasi', 5)).toBe('mineral');
  });
});

describe('rationSavingOption on a real ration', () => {
  /** The pilot farm's ration for pregnant ewes, with its stock costs, per head per day. */
  const pregnant = [
    { itemId: 'hay', name: 'Beda (pichan)', kgPerHeadDay: 1.1, unitCostPerKg: 2000, dryMatterPct: 86 },
    { itemId: 'silage', name: 'Silos', kgPerHeadDay: 1, unitCostPerKg: 650, dryMatterPct: 30 },
    { itemId: 'straw', name: 'Somon', kgPerHeadDay: 0.4, unitCostPerKg: 800, dryMatterPct: 88 },
    { itemId: 'barley', name: 'Arpa', kgPerHeadDay: 0.3, unitCostPerKg: 3500, dryMatterPct: 87 },
    { itemId: 'bran', name: 'Kepak', kgPerHeadDay: 0.1, unitCostPerKg: 2400, dryMatterPct: 88 },
    { itemId: 'cake', name: 'Kunjara', kgPerHeadDay: 0.1, unitCostPerKg: 3000, dryMatterPct: 90 },
    { itemId: 'salt', name: 'Tuz', kgPerHeadDay: 0.012, unitCostPerKg: 1500, dryMatterPct: 98 },
    { itemId: 'premix', name: "Mineral qo'shimcha", kgPerHeadDay: 0.012, unitCostPerKg: 18_000, dryMatterPct: 95 },
  ];

  it('never replaces the premix and swaps roughage for roughage (control numbers)', () => {
    const saving = ai.rationSavingOption(pregnant, 700)!;
    // The premix costs most per kg of dry matter, 18 947 so'm, but is a supplement and only 0.6% of the dry matter.
    // Roughage: hay 2000 / 0.86 = 2325.58, straw 800 / 0.88 = 909.09. 10% of the hay's 0.946 kg DM moves:
    // 0.0946 × 1416.49 = 134.00 a head a day. Concentrates would save 0.0261 × (4022.99 − 2727.27) = 33.82.
    expect(saving).toMatchObject({ fromItemId: 'hay', toItemId: 'straw', feedClass: 'roughage', shiftKgDmPerHeadDay: 0.095 });
    expect(saving.savingPerHeadDay).toBeCloseTo(134, 1);
    expect(saving.savingPerDay).toBeCloseTo(93_800, -1);
    // 2200 + 650 + 320 + 1050 + 240 + 300 + 18 + 216 = 4994 a head a day.
    expect(saving.rationCostPerHeadDay).toBe(4994);
    expect(saving.savingPercent).toBe(2.7);
  });

  it('compares concentrates only with concentrates', () => {
    const grain = pregnant.filter((l) => ['straw', 'barley', 'bran', 'silage'].includes(l.itemId));
    // Straw is far cheaper than barley per kg of dry matter, but it is roughage: barley gives way to bran.
    const saving = ai.rationSavingOption(grain, 100)!;
    expect(saving).toMatchObject({ fromItemId: 'barley', toItemId: 'bran', feedClass: 'concentrate' });
    expect(saving.savingPerHeadDay).toBeCloseTo(0.0261 * (3500 / 0.87 - 2400 / 0.88), 2);
  });

  it('offers nothing when the only swap saves under 1% of the ration', () => {
    const concentratesOnly = pregnant.filter((l) => l.itemId !== 'straw');
    // Without straw the best swap is barley to bran, 33.82 of 4674 so'm: 0.7%.
    expect(ai.rationSavingOption(concentratesOnly, 700)).toBeNull();
  });

  it('leaves out a minor line and an unknown feed', () => {
    const ration = [
      { itemId: 'hay', name: 'Pichan', kgPerHeadDay: 2, unitCostPerKg: 1500, dryMatterPct: 86 },
      // Protein feeds: the dear one is under 2% of the dry matter, so the group has nothing to swap.
      { itemId: 'fish', name: 'Kunjara', kgPerHeadDay: 0.03, unitCostPerKg: 20_000, dryMatterPct: 90 },
      { itemId: 'soy', name: 'Soya shroti', kgPerHeadDay: 0.3, unitCostPerKg: 6000, dryMatterPct: 90 },
      // Cheap per kg of dry matter, but nothing says what it is.
      { itemId: 'mystery', name: 'Ozuqa №3', kgPerHeadDay: 0.5, unitCostPerKg: 100, dryMatterPct: 88 },
    ];
    expect(ai.rationSavingOption(ration, 50)).toBeNull();
    // Told what the feed is, the swap is made.
    const told = ration.map((l) => (l.itemId === 'mystery' ? { ...l, feedClass: 'roughage' as const } : l));
    expect(ai.rationSavingOption(told, 50)).toMatchObject({ fromItemId: 'hay', toItemId: 'mystery' });
  });

  it('needs the whole ration priced', () => {
    const unpriced = pregnant.map((l) => (l.itemId === 'salt' ? { ...l, unitCostPerKg: null } : l));
    expect(ai.rationSavingOption(unpriced, 700)).toBeNull();
    const noDryMatter = pregnant.map((l) => (l.itemId === 'cake' ? { ...l, dryMatterPct: null } : l));
    expect(ai.rationSavingOption(noDryMatter, 700)).toBeNull();
  });
});

describe('allocateCrops', () => {
  const option = (key: string, yieldTHa: number, pricePerT: number, costPerHa: number, extra: Partial<ai.CropOption> = {}): ai.CropOption => ({
    key,
    yieldTHa,
    pricePerT,
    costPerHa,
    isFeed: false,
    feedShortage: false,
    ...extra,
  });

  it('rotates two fields rather than giving both the best crop', () => {
    // Wheat 5 t × 3 mln − 3 mln = 12 mln/ha, barley 4 t × 2.5 mln − 2 mln = 8 mln/ha.
    const plan = ai.allocateCrops(
      [
        { id: '1', areaHa: 10, lastCropKey: 'wheat' },
        { id: '2', areaHa: 10, lastCropKey: 'barley' },
      ],
      [option('wheat', 5, 3_000_000, 3_000_000), option('barley', 4, 2_500_000, 2_000_000), option('rice', 6, 1, null as never)],
    );
    // Two priced crops may take half the land each. Field 2 takes wheat at 12 mln, field 1 is left barley.
    expect(plan.capHa).toBe(10);
    expect(plan.assignments.map((a) => [a.fieldId, a.key, a.marginPerHa])).toEqual([
      ['1', 'barley', 8_000_000],
      ['2', 'wheat', 12_000_000],
    ]);
    expect(plan.assignments[0].reasons).toEqual(['share_limit']);
    expect(plan.areaHa).toEqual({ wheat: 10, barley: 10 });
  });

  it('plans the pilot farm within each crop share and keeps the winter feed (control numbers)', () => {
    const crops = [
      option('alfalfa', 10, 2_100_000, 2_500_000, { isFeed: true, family: 'perennial_grass' }), // 18.5 mln/ha
      option('corn', 35, 650_000, 5_400_000, { isFeed: true }), // 17.35 mln/ha
      option('barley', 4.2, 3_500_000, 62_000_000 / 15, { isFeed: true }), // 10.57 mln/ha
      option('wheat', 5.5, 800_000, 4_200_000), // 0.2 mln/ha
    ];
    const plan = ai.allocateCrops(
      [
        { id: '1', areaHa: 10, lastCropKey: 'wheat' },
        { id: '2', areaHa: 9, lastCropKey: 'wheat' },
        { id: '3', areaHa: 15, lastCropKey: 'barley' },
        { id: '6', areaHa: 18, lastCropKey: 'wheat' },
      ],
      crops,
      // Field 4 is a second-year alfalfa stand and field 5 is planned for silage corn already.
      { committedHa: { alfalfa: 28, corn: 10 }, feedNeedHa: { alfalfa: 9.24, corn: 2.4, barley: 6, wheat: 6.11 } },
    );
    // 40% of 90 ha is 36 ha: alfalfa, at 28 ha, has no room for another field.
    expect(plan.totalHa).toBe(90);
    expect(plan.capHa).toBe(36);
    // Straw (wheat) and barley are the gaps. Wheat gives up least on field 3, barley least on the smallest field.
    // Then corn, the best that still fits, takes the largest field, and field 1 is left barley.
    expect(plan.assignments.map((a) => [a.fieldId, a.key])).toEqual([
      ['1', 'barley'],
      ['2', 'barley'],
      ['3', 'wheat'],
      ['6', 'corn'],
    ]);
    expect(plan.assignments.find((a) => a.fieldId === '2')!.reasons).toEqual(['feed_need']);
    expect(plan.areaHa).toEqual({ alfalfa: 28, corn: 28, barley: 19, wheat: 15 });
    expect(Math.max(...Object.values(plan.areaHa))).toBeLessThanOrEqual(plan.capHa);
    expect(plan.feedShort).toEqual([]);
  });

  it('says which feed need the land cannot cover', () => {
    const plan = ai.allocateCrops(
      [{ id: '1', areaHa: 10, lastCropKey: null }],
      [option('wheat', 5, 3_000_000, 3_000_000), option('barley', 4, 2_500_000, 2_000_000, { isFeed: true })],
      // Corn has no price, so it cannot be suggested, and barley needs more than the one field.
      { feedNeedHa: { barley: 25, corn: 3 } },
    );
    expect(plan.assignments.map((a) => a.key)).toEqual(['barley']);
    expect(plan.feedShort).toEqual(['barley', 'corn']);
  });

  it('gives a field to the smallest crop when every crop is at its share', () => {
    const plan = ai.allocateCrops(
      [{ id: 'big', areaHa: 30, lastCropKey: null }],
      [option('a', 1, 3, 0), option('b', 1, 2, 0), option('c', 1, 1, 0)],
      { committedHa: { a: 12, b: 11, c: 11 } },
    );
    // 40% of 64 ha is 25.6 ha, and each crop would pass it. b and c hold least; b pays more.
    expect(plan.assignments).toMatchObject([{ fieldId: 'big', key: 'b', reasons: ['share_limit'] }]);
  });

  it('suggests nothing without a priced crop', () => {
    const plan = ai.allocateCrops([{ id: '1', areaHa: 10, lastCropKey: null }], [option('wheat', 5, 3_000_000, null as never)]);
    expect(plan.assignments).toEqual([]);
  });
});
