/**
 * What the scenario planner's screen needs to know about each assumption: which group it sits in,
 * what the API accepts, and how far its slider reaches. The arithmetic itself is
 * `@yap/shared/formulas/scenario`; nothing here calculates a plan.
 */
import {
  SCENARIO_NUMBER_KEYS,
  type ScenarioAssumptionKey,
  type ScenarioAssumptions,
  type ScenarioNumberKey,
  type ScenarioOneOff,
  type ScenarioResult,
} from '@yap/shared/formulas/scenario';

export const SCENARIOS_PATH = '/finance/scenarios';
export const BASELINE_PATH = '/finance/scenarios/baseline';

/** Plans shown side by side. More columns than this cannot be read on a phone. */
export const COMPARE_LIMIT = 3;
/** The API stores at most this many one-off outlays in a plan. */
export const ONE_OFF_LIMIT = 50;

export type BaselineSource = 'animals' | 'lambings' | 'scans' | 'pregnancies' | 'sales' | 'costs' | 'rations' | 'accounts';

export interface Baseline {
  asOf: string;
  startMonth: string;
  assumptions: ScenarioAssumptions;
  sources: Partial<Record<ScenarioAssumptionKey, { source: BaselineSource; basis: Record<string, unknown> }>>;
  /** The app's own starting values, given only where the farm has no figure. Never the farm's. */
  suggestions: Partial<Record<ScenarioAssumptionKey, { value: number | number[]; source: 'default' }>>;
  costGroups: { from: string; to: string; months: number; perMonth: Record<string, number>; total: number } | null;
}

export interface SavedScenario {
  id: string;
  name: string;
  assumptions: Record<string, unknown>;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FieldKind = 'head' | 'share' | 'ratio' | 'months' | 'kg' | 'money' | 'calendarMonth';
export type FieldGroup = 'herd' | 'lambing' | 'sales' | 'costs' | 'cash';

export interface SliderRange {
  min: number;
  max: number;
  step: number;
}

export interface FieldSpec {
  key: ScenarioNumberKey;
  group: FieldGroup;
  kind: FieldKind;
  /** What the API accepts (finance/scenarios.service `assumptionsInput`). A test holds the two together. */
  min: number;
  max: number;
  /**
   * How far the slider reaches, in the stored unit. A convenience of the screen, not a limit: a figure
   * beyond it can still be typed. Left out for head and money, whose scale depends on the farm.
   */
  slider?: SliderRange;
}

const MAX_HEAD = 1e7;
const MAX_MONEY = 1e13;
const head = (key: ScenarioNumberKey): FieldSpec => ({ key, group: 'herd', kind: 'head', min: 0, max: MAX_HEAD });
const share = (key: ScenarioNumberKey, slider: SliderRange = { min: 0, max: 1, step: 0.01 }): FieldSpec => ({ key, group: 'lambing', kind: 'share', min: 0, max: 1, slider });
const money = (key: ScenarioNumberKey, group: FieldGroup): FieldSpec => ({ key, group, kind: 'money', min: 0, max: MAX_MONEY });

/** In the order the screen lists them. */
export const FIELDS: FieldSpec[] = [
  head('openingEwes'),
  head('openingRams'),
  head('openingReplacements'),
  head('openingLambs'),
  { key: 'lambingMonth', group: 'lambing', kind: 'calendarMonth', min: 1, max: 12 },
  share('lambingShare'),
  { key: 'lambsPerEweLambing', group: 'lambing', kind: 'ratio', min: 0, max: 5, slider: { min: 0, max: 3, step: 0.05 } },
  share('lambSurvival'),
  share('replacementShare'),
  { key: 'firstLambingAgeMonths', group: 'lambing', kind: 'months', min: 1, max: 60, slider: { min: 6, max: 36, step: 1 } },
  share('eweDeathsPerYear', { min: 0, max: 0.3, step: 0.005 }),
  share('eweCullsPerYear', { min: 0, max: 0.5, step: 0.01 }),
  { key: 'saleAgeMonths', group: 'sales', kind: 'months', min: 1, max: 36, slider: { min: 1, max: 24, step: 1 } },
  { key: 'saleWeightKg', group: 'sales', kind: 'kg', min: 0, max: 500, slider: { min: 0, max: 100, step: 0.5 } },
  money('pricePerKg', 'sales'),
  money('cullEwePrice', 'sales'),
  money('feedAdultStallPerMonth', 'costs'),
  money('feedAdultGrazingPerMonth', 'costs'),
  money('feedLambPerMonth', 'costs'),
  money('otherCostPerHeadPerMonth', 'costs'),
  money('fixedCostPerMonth', 'costs'),
  { key: 'openingCash', group: 'cash', kind: 'money', min: -MAX_MONEY, max: MAX_MONEY },
];

export const FIELD_GROUPS: FieldGroup[] = ['herd', 'lambing', 'sales', 'costs', 'cash'];

export const fieldSpec = (key: ScenarioNumberKey): FieldSpec => FIELDS.find((f) => f.key === key) as FieldSpec;

/** 1, 2 or 5 times a power of ten, at or above the value: a scale a slider can be read on. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 0;
  const power = 10 ** Math.floor(Math.log10(value));
  const lead = value / power;
  return (lead <= 1 ? 1 : lead <= 2 ? 2 : lead <= 5 ? 5 : 10) * power;
}

const SLIDER_STEPS = 200;

/**
 * The slider of a field. Head and money reach to about twice the figure the field started from
 * (`anchor`), so a farm of 700 ewes and one of 70 000 both get a slider they can use. Without such a
 * figure there is no scale to offer, and the answer is null: the number is typed first.
 */
export function sliderRange(spec: FieldSpec, anchor: number | null | undefined): SliderRange | null {
  if (spec.slider) return spec.slider;
  if (spec.kind === 'calendarMonth') return null;
  const max = niceCeil(2 * Math.abs(anchor ?? 0));
  if (max === 0) return null;
  const step = spec.kind === 'head' ? Math.max(1, max / SLIDER_STEPS) : max / SLIDER_STEPS;
  return { min: spec.min < 0 ? -max : 0, max: Math.min(max, spec.max), step };
}

export type FieldProblem = 'min' | 'max' | 'whole';

/** Why the API would refuse this figure, or null. An empty field is not a problem: it is missing data. */
export function fieldProblem(spec: FieldSpec, value: number | null): FieldProblem | null {
  if (value === null) return null;
  if (value < spec.min) return 'min';
  if (value > spec.max) return 'max';
  if ((spec.kind === 'months' || spec.kind === 'calendarMonth') && !Number.isInteger(value)) return 'whole';
  return null;
}

export const invalidFields = (a: ScenarioAssumptions): ScenarioNumberKey[] => FIELDS.filter((f) => fieldProblem(f, a[f.key]) !== null).map((f) => f.key);

export function emptyAssumptions(startMonth: string): ScenarioAssumptions {
  const numbers = Object.fromEntries(SCENARIO_NUMBER_KEYS.map((key) => [key, null])) as Record<ScenarioNumberKey, number | null>;
  return { ...numbers, startMonth, stallMonths: null, oneOffs: [] };
}

const isMonth = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * A stored plan as the model takes it. The API checked it when it was saved; a plan saved before an
 * assumption existed simply has that one empty, and the screen says so.
 */
export function readAssumptions(raw: Record<string, unknown>, fallbackStartMonth: string): ScenarioAssumptions {
  const a = emptyAssumptions(isMonth(raw.startMonth) ? raw.startMonth : fallbackStartMonth);
  for (const key of SCENARIO_NUMBER_KEYS) if (isNumber(raw[key])) a[key] = raw[key];
  if (Array.isArray(raw.stallMonths)) a.stallMonths = raw.stallMonths.filter(isNumber);
  if (Array.isArray(raw.oneOffs)) {
    a.oneOffs = raw.oneOffs.filter((o): o is ScenarioOneOff => o !== null && typeof o === 'object' && isNumber((o as ScenarioOneOff).month) && isNumber((o as ScenarioOneOff).amount));
  }
  return a;
}

/** The app's starting values put into the empty fields only. A figure the farm or the person gave stays. */
export function withSuggestions(a: ScenarioAssumptions, suggestions: Baseline['suggestions']): ScenarioAssumptions {
  const next = { ...a };
  for (const key of SCENARIO_NUMBER_KEYS) {
    const value = suggestions[key]?.value;
    if (next[key] === null && typeof value === 'number') next[key] = value;
  }
  const stall = suggestions.stallMonths?.value;
  if (next.stallMonths === null && Array.isArray(stall)) next.stallMonths = [...stall];
  return next;
}

/** Empty fields the app has a starting value for. */
export function openSuggestions(a: ScenarioAssumptions, suggestions: Baseline['suggestions']): ScenarioAssumptionKey[] {
  return (Object.keys(suggestions) as ScenarioAssumptionKey[]).filter((key) => a[key] === null);
}

/** The figure each slider is scaled by: the plan's own, else the farm's, else the app's starting value. */
export function sliderAnchors(a: ScenarioAssumptions, baseline: Baseline | undefined): Partial<Record<ScenarioNumberKey, number>> {
  const anchors: Partial<Record<ScenarioNumberKey, number>> = {};
  for (const key of SCENARIO_NUMBER_KEYS) {
    const suggested = baseline?.suggestions[key]?.value;
    const value = a[key] || baseline?.assumptions[key] || (typeof suggested === 'number' ? suggested : null);
    if (value) anchors[key] = Math.abs(value);
  }
  return anchors;
}

/** Order does not matter to a plan, so two plans are compared key by key. */
export function sameAssumptions(a: ScenarioAssumptions, b: ScenarioAssumptions): boolean {
  const stall = (months: number[] | null) => (months === null ? null : [...months].sort((x, y) => x - y).join());
  const oneOffs = (list: ScenarioOneOff[]) => list.map((o) => `${o.month}:${o.amount}`).sort().join();
  return (
    a.startMonth === b.startMonth &&
    SCENARIO_NUMBER_KEYS.every((key) => a[key] === b[key]) &&
    stall(a.stallMonths) === stall(b.stallMonths) &&
    oneOffs(a.oneOffs) === oneOffs(b.oneOffs)
  );
}

/** The month-by-month rows the two charts draw. Head is rounded here, where it is shown, and nowhere earlier. */
export function chartRows(result: ScenarioResult): { month: string; cash: number | null; ewes: number | null; total: number | null; negative: boolean }[] {
  const whole = (n: number | null) => (n === null ? null : Math.round(n));
  return result.months.map((m) => ({
    month: m.month,
    cash: m.closingCash,
    ewes: whole(m.herd.ewes),
    total: whole(m.herd.total),
    negative: m.closingCash !== null && m.closingCash < 0,
  }));
}
