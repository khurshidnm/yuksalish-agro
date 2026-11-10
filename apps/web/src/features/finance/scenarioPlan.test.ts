import { readFileSync } from 'node:fs';
import { SCENARIO_NUMBER_KEYS, type ScenarioAssumptions, runScenario } from '@yap/shared/formulas/scenario';
import { describe, expect, it } from 'vitest';
import {
  type Baseline,
  FIELDS,
  ONE_OFF_LIMIT,
  chartRows,
  emptyAssumptions,
  fieldProblem,
  fieldSpec,
  invalidFields,
  niceCeil,
  openSuggestions,
  readAssumptions,
  sameAssumptions,
  sliderAnchors,
  sliderRange,
  withSuggestions,
} from './scenarioPlan';

const api = readFileSync(new URL('../../../../api/src/modules/finance/scenarios.service.ts', import.meta.url), 'utf8');

/** `z.number().int().min(1).max(60)` as the limits it sets. Names stand for the constants of the API file. */
function limits(expression: string) {
  const number = (text: string) => Number(text.replace('MAX_MONEY', '1e13'));
  const min = /\.min\(([^)]+)\)/.exec(expression)?.[1];
  const max = /\.max\(([^)]+)\)/.exec(expression)?.[1];
  if (min === undefined || max === undefined) throw new Error(`no limits in: ${expression}`);
  return { min: number(min), max: number(max), whole: expression.includes('.int()') };
}

/** What the API accepts for one assumption, read from its own source. */
function apiLimits(key: string) {
  const field = new RegExp(`^  ${key}: (.+),$`, 'm').exec(api)?.[1];
  if (!field) throw new Error(`the API has no assumption called ${key}`);
  const name = /^[a-zA-Z]+/.exec(field)?.[0] ?? '';
  const named = new RegExp(`^const ${name} = (.+);$`, 'm').exec(api)?.[1];
  return limits(named ?? field);
}

const plan = (over: Partial<ScenarioAssumptions> = {}): ScenarioAssumptions => ({ ...emptyAssumptions('2026-11'), ...over });

const baseline = (assumptions: Partial<ScenarioAssumptions>, suggestions: Baseline['suggestions'] = {}): Baseline => ({
  asOf: '2026-11-10',
  startMonth: '2026-11',
  assumptions: plan(assumptions),
  sources: {},
  suggestions,
  costGroups: null,
});

describe('the limits of each field', () => {
  it('lists every number the model takes, once', () => {
    expect(FIELDS.map((f) => f.key).sort()).toEqual([...SCENARIO_NUMBER_KEYS].sort());
  });

  it('are the limits the API checks', () => {
    for (const spec of FIELDS) {
      const whole = spec.kind === 'months' || spec.kind === 'calendarMonth';
      expect({ key: spec.key, min: spec.min, max: spec.max, whole }).toEqual({ key: spec.key, ...apiLimits(spec.key) });
    }
  });

  it('holds as many one-off outlays as the API stores', () => {
    expect(api).toContain(`.max(${ONE_OFF_LIMIT}),`);
  });

  it('keeps every fixed slider inside what may be typed', () => {
    for (const spec of FIELDS) {
      if (!spec.slider) continue;
      expect(spec.slider.min, spec.key).toBeGreaterThanOrEqual(spec.min);
      expect(spec.slider.max, spec.key).toBeLessThanOrEqual(spec.max);
    }
  });
});

describe('fieldProblem', () => {
  it('lets an empty field through: that is missing data, not a mistake', () => {
    expect(fieldProblem(fieldSpec('openingEwes'), null)).toBeNull();
  });

  it('names what the API would refuse', () => {
    expect(fieldProblem(fieldSpec('lambSurvival'), 1.2)).toBe('max');
    expect(fieldProblem(fieldSpec('openingEwes'), -1)).toBe('min');
    expect(fieldProblem(fieldSpec('saleAgeMonths'), 6.5)).toBe('whole');
    expect(fieldProblem(fieldSpec('saleAgeMonths'), 6)).toBeNull();
    // Cash at the start may be below zero; nothing else may.
    expect(fieldProblem(fieldSpec('openingCash'), -5_000_000)).toBeNull();
    expect(fieldProblem(fieldSpec('pricePerKg'), -1)).toBe('min');
  });

  it('lists the fields that stop a plan from being worked out', () => {
    expect(invalidFields(plan({ openingEwes: 700 }))).toEqual([]);
    expect(invalidFields(plan({ lambingShare: 1.5, saleAgeMonths: 0 }))).toEqual(['lambingShare', 'saleAgeMonths']);
  });
});

describe('niceCeil', () => {
  it('rounds up to 1, 2 or 5 times a power of ten', () => {
    expect(niceCeil(1400)).toBe(2000);
    expect(niceCeil(2000)).toBe(2000);
    expect(niceCeil(2001)).toBe(5000);
    expect(niceCeil(90_000)).toBe(100_000);
    expect(niceCeil(0.3)).toBeCloseTo(0.5, 10);
  });

  it('has no scale for nothing', () => {
    expect(niceCeil(0)).toBe(0);
    expect(niceCeil(-5)).toBe(0);
    expect(niceCeil(Number.NaN)).toBe(0);
  });
});

describe('sliderRange', () => {
  it('reaches about twice the figure a head count started from, in whole head', () => {
    // 700 ewes: twice is 1 400, the next round figure 2 000, in 200 steps of 10.
    expect(sliderRange(fieldSpec('openingEwes'), 700)).toEqual({ min: 0, max: 2000, step: 10 });
    // 30 rams: twice is 60, rounded to 100. A 200th of that is half a ram, so the step is one.
    expect(sliderRange(fieldSpec('openingRams'), 30)).toEqual({ min: 0, max: 100, step: 1 });
  });

  it('scales money the same way', () => {
    // 60 000 a kg: twice is 120 000, rounded to 200 000, in steps of 1 000.
    expect(sliderRange(fieldSpec('pricePerKg'), 60_000)).toEqual({ min: 0, max: 200_000, step: 1000 });
  });

  it('gives cash at the start a side below zero', () => {
    expect(sliderRange(fieldSpec('openingCash'), 40_000_000)).toEqual({ min: -100_000_000, max: 100_000_000, step: 500_000 });
  });

  it('offers no slider without a figure to scale it by', () => {
    expect(sliderRange(fieldSpec('pricePerKg'), undefined)).toBeNull();
    expect(sliderRange(fieldSpec('pricePerKg'), 0)).toBeNull();
    expect(sliderRange(fieldSpec('lambingMonth'), 3)).toBeNull();
  });

  it('keeps the fixed scale of a share whatever the figure', () => {
    expect(sliderRange(fieldSpec('lambSurvival'), undefined)).toEqual({ min: 0, max: 1, step: 0.01 });
  });

  it('never reaches past what may be typed', () => {
    expect(sliderRange(fieldSpec('openingEwes'), 9_000_000)?.max).toBe(1e7);
  });
});

describe('readAssumptions', () => {
  it('reads a stored plan as it was saved', () => {
    const stored = plan({ openingEwes: 700, lambSurvival: 0.9, stallMonths: [12, 1, 2], oneOffs: [{ month: 0, amount: 5_000_000 }] });
    expect(readAssumptions(JSON.parse(JSON.stringify(stored)), '2030-01')).toEqual(stored);
  });

  it('leaves empty what a plan does not hold, and takes the given month when it has none', () => {
    const read = readAssumptions({ openingEwes: 700, saleWeightKg: '45', oneOffs: [{ month: 'x', amount: 1 }, null] }, '2027-03');
    expect(read.startMonth).toBe('2027-03');
    expect(read.openingEwes).toBe(700);
    expect(read.saleWeightKg).toBeNull();
    expect(read.firstLambingAgeMonths).toBeNull();
    expect(read.stallMonths).toBeNull();
    expect(read.oneOffs).toEqual([]);
  });
});

describe("the app's starting values", () => {
  const suggestions: Baseline['suggestions'] = {
    eweDeathsPerYear: { value: 0.03, source: 'default' },
    firstLambingAgeMonths: { value: 24, source: 'default' },
    stallMonths: { value: [11, 12, 1, 2, 3], source: 'default' },
  };

  it('fill empty fields only: a figure someone gave stays', () => {
    const filled = withSuggestions(plan({ eweDeathsPerYear: 0.05 }), suggestions);
    expect(filled.eweDeathsPerYear).toBe(0.05);
    expect(filled.firstLambingAgeMonths).toBe(24);
    expect(filled.stallMonths).toEqual([11, 12, 1, 2, 3]);
    expect(filled.openingEwes).toBeNull();
  });

  it('are offered only while the field is empty', () => {
    expect(openSuggestions(plan({ eweDeathsPerYear: 0.05 }), suggestions).sort()).toEqual(['firstLambingAgeMonths', 'stallMonths']);
    expect(openSuggestions(withSuggestions(plan(), suggestions), suggestions)).toEqual([]);
  });

  it("scale a slider when neither the plan nor the farm has a figure", () => {
    const farm = baseline({ openingEwes: 700, pricePerKg: 60_000 }, suggestions);
    const anchors = sliderAnchors(plan({ openingEwes: 900 }), farm);
    expect(anchors.openingEwes).toBe(900);
    expect(anchors.pricePerKg).toBe(60_000);
    expect(anchors.firstLambingAgeMonths).toBe(24);
    expect(anchors.cullEwePrice).toBeUndefined();
  });
});

describe('sameAssumptions', () => {
  const a = plan({ openingEwes: 700, stallMonths: [12, 1, 2], oneOffs: [{ month: 0, amount: 5 }, { month: 3, amount: 7 }] });

  it('does not mind the order of months or outlays', () => {
    expect(sameAssumptions(a, { ...a, stallMonths: [1, 2, 12], oneOffs: [{ month: 3, amount: 7 }, { month: 0, amount: 5 }] })).toBe(true);
  });

  it('sees a changed figure, month or outlay', () => {
    expect(sameAssumptions(a, { ...a, openingEwes: 701 })).toBe(false);
    expect(sameAssumptions(a, { ...a, startMonth: '2026-12' })).toBe(false);
    expect(sameAssumptions(a, { ...a, stallMonths: [12, 1] })).toBe(false);
    expect(sameAssumptions(a, { ...a, oneOffs: [{ month: 0, amount: 5 }] })).toBe(false);
  });

  it('tells no stall months from stall months not set', () => {
    expect(sameAssumptions({ ...a, stallMonths: [] }, { ...a, stallMonths: null })).toBe(false);
  });
});

describe('chartRows', () => {
  it('gives one row a month and leaves an unknown figure empty, not zero', () => {
    const rows = chartRows(runScenario(plan({ openingEwes: 700 })));
    expect(rows).toHaveLength(36);
    expect(rows[0].month).toBe('2026-11');
    expect(rows[0].cash).toBeNull();
    expect(rows[0].negative).toBe(false);
  });
});
