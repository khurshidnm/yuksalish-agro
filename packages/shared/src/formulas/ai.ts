/**
 * Statistics behind the AI layer (spec 15.2: simple moving averages and z-scores first, ML only
 * once data has accumulated). Pure functions, one implementation for API and UI.
 *
 * Every detector takes a minimum sample size and returns null below it. Too little data is
 * reported as such, never as "no problem found" (spec 15.2).
 */
import { addDays } from '../dates';
import { round } from './index';
import { APOSTROPHES, fold, wordSet } from './units';

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Sample standard deviation (n − 1). */
export function sampleStdDev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

/** Trailing moving average; null until the window is full. */
export function movingAverage(values: readonly number[], window: number): (number | null)[] {
  return values.map((_, i) => (i + 1 < window ? null : mean(values.slice(i + 1 - window, i + 1))));
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A perfectly flat baseline has std 0. Treat 2% of the mean as the smallest meaningful spread. */
const STD_FLOOR_RATIO = 0.02;

export function zScore(value: number, baseline: readonly number[]): number | null {
  const m = mean(baseline);
  const s = sampleStdDev(baseline);
  if (m === null || s === null) return null;
  const spread = Math.max(s, Math.abs(m) * STD_FLOOR_RATIO);
  if (spread === 0) return null;
  return (value - m) / spread;
}

/** Confidence in a statistical finding: 0.5 to 0.95, rising with effect size and sample size. */
export function findingConfidence(z: number, sampleSize: number, minSample: number): number {
  const strength = clamp((Math.abs(z) - 2) / 3, 0, 1);
  const sample = clamp(sampleSize / (minSample * 3), 0, 1);
  return round(0.5 + 0.3 * strength + 0.15 * sample, 2);
}

export interface AnomalyOptions {
  /** Trailing points forming each point's baseline. */
  window: number;
  /** Fewest baseline points that allow a claim. */
  minBaseline: number;
  /** Only the last `lookback` points are judged. */
  lookback: number;
  zThreshold?: number;
  minDeviationPercent?: number;
  direction?: 'both' | 'up' | 'down';
}

export interface Anomaly {
  index: number;
  value: number;
  baselineMean: number;
  baselineStd: number;
  baselineSize: number;
  z: number;
  deviationPercent: number;
  confidence: number;
}

/** Whether the series is long enough for at least its newest point to be judged. */
export function hasEnoughBaseline(length: number, minBaseline: number): boolean {
  return length >= minBaseline + 1;
}

/** Points that stand out from their trailing baseline by both z-score and relative size. */
export function detectAnomalies(series: readonly number[], o: AnomalyOptions): Anomaly[] {
  const zThreshold = o.zThreshold ?? 2.5;
  const minDeviation = o.minDeviationPercent ?? 10;
  const direction = o.direction ?? 'both';
  const found: Anomaly[] = [];

  for (let i = Math.max(0, series.length - o.lookback); i < series.length; i++) {
    const baseline = series.slice(Math.max(0, i - o.window), i);
    if (baseline.length < o.minBaseline) continue;
    const z = zScore(series[i], baseline);
    const baselineMean = mean(baseline)!;
    if (z === null || baselineMean === 0) continue;
    const deviationPercent = ((series[i] - baselineMean) / Math.abs(baselineMean)) * 100;
    const outside = Math.abs(z) >= zThreshold && Math.abs(deviationPercent) >= minDeviation;
    const wanted = direction === 'both' || (direction === 'up' ? z > 0 : z < 0);
    if (outside && wanted) {
      found.push({
        index: i,
        value: series[i],
        baselineMean,
        baselineStd: sampleStdDev(baseline)!,
        baselineSize: baseline.length,
        z: round(z, 2),
        deviationPercent: round(deviationPercent, 1),
        confidence: findingConfidence(z, baseline.length, o.minBaseline),
      });
    }
  }
  return found;
}

export interface CountSpike {
  expected: number;
  z: number;
  confidence: number;
}

/**
 * Rare events per period, such as deaths per week. Counts are close to Poisson, so the spread
 * comes from the expected count itself rather than from a noisy sample of near-zero weeks.
 */
export function countSpike(
  recent: number,
  baseline: readonly number[],
  o: { minBaseline: number; zThreshold?: number; minCount?: number },
): CountSpike | null {
  if (baseline.length < o.minBaseline) return null;
  const expected = mean(baseline)!;
  const z = (recent - expected) / Math.sqrt(Math.max(expected, 0.5));
  if (recent < (o.minCount ?? 2) || z < (o.zThreshold ?? 2.5)) return null;
  return {
    expected: round(expected, 2),
    z: round(z, 2),
    confidence: findingConfidence(z, baseline.length, o.minBaseline),
  };
}

export interface GainSlowdown {
  latest: number;
  previousMean: number;
  ratio: number;
  confidence: number;
}

/**
 * Compare the newest weight-gain interval with the ones before it. `series` is mean daily gain
 * per interval, oldest first. `dropRatio` 0.7 means "fell below 70% of the earlier average".
 */
export function gainSlowdown(
  series: readonly number[],
  o: { minIntervals?: number; dropRatio?: number } = {},
): GainSlowdown | null {
  const minIntervals = o.minIntervals ?? 3;
  if (series.length < minIntervals) return null;
  const latest = series[series.length - 1];
  const previous = series.slice(0, -1);
  const previousMean = mean(previous)!;
  if (previousMean <= 0) return null;
  const ratio = latest / previousMean;
  if (ratio >= (o.dropRatio ?? 0.7)) return null;
  const spread = sampleStdDev(previous) ?? 0;
  const z = (previousMean - latest) / Math.max(spread, previousMean * 0.1);
  return {
    latest: round(latest, 3),
    previousMean: round(previousMean, 3),
    ratio: round(ratio, 2),
    confidence: findingConfidence(z, previous.length, minIntervals - 1),
  };
}

// ─── Forecasts ──────────────────────────────────────────────────────────────

/** Monday of the week containing a date. */
export function weekStartOf(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return addDays(isoDate, day === 0 ? -6 : 1 - day);
}

export interface LambingWeek {
  weekStart: string;
  ewes: number;
}

export interface LambingWorkloadOptions {
  lambsPerEwe: number;
  /** How long a ewe stays on the lactating ration, in whole weeks. */
  lactationWeeks: number;
  /** Lactating ration minus current ration, kg per head per day. Null when a ration is missing. */
  extraKgPerEweDay: number | null;
  laborHoursPerLambing: number;
  shiftHours: number;
}

export interface LambingWorkloadRow extends LambingWeek {
  lambs: number;
  lactatingEwes: number;
  extraFeedKg: number | null;
  laborHours: number;
  workersNeeded: number;
}

/**
 * Spring feed and labour load per week (spec 15.3 scenario 1). `weeks` is oldest first, one per week. The
 * table runs on past the last lambing until the last ewe's lactation ends, with no new lambings, so the
 * extra feed covers every ewe's whole lactation: ewes × lactation weeks × 7 days × extra kg in all.
 */
export function lambingWorkload(lambingWeeks: readonly LambingWeek[], o: LambingWorkloadOptions): LambingWorkloadRow[] {
  const last = lambingWeeks.at(-1);
  const tail = last
    ? Array.from({ length: Math.max(0, o.lactationWeeks - 1) }, (_, i) => ({ weekStart: addDays(last.weekStart, 7 * (i + 1)), ewes: 0 }))
    : [];
  const weeks = [...lambingWeeks, ...tail];
  return weeks.map((week, i) => {
    const lactatingEwes = weeks
      .slice(Math.max(0, i + 1 - o.lactationWeeks), i + 1)
      .reduce((sum, w) => sum + w.ewes, 0);
    const laborHours = round(week.ewes * o.laborHoursPerLambing, 1);
    return {
      ...week,
      lambs: round(week.ewes * o.lambsPerEwe, 1),
      lactatingEwes,
      extraFeedKg: o.extraKgPerEweDay === null ? null : round(lactatingEwes * o.extraKgPerEweDay * 7, 1),
      laborHours,
      workersNeeded: Math.ceil(laborHours / (o.shiftHours * 7)),
    };
  });
}

export interface SeasonLine {
  areaHa: number;
  expectedYieldTHa: number | null;
  pricePerT: number | null;
  plannedCost: number | null;
  actualCost: number | null;
  harvestedT: number | null;
}

export interface SeasonForecast {
  revenue: number;
  cost: number;
  profit: number;
  profitabilityPercent: number | null;
  linesUsed: number;
  linesSkipped: number;
  /** Share of the planned area the forecast covers. */
  areaCoveredPercent: number | null;
}

/**
 * Season profit from plan, actual and expected yield (spec 15.3 scenario 3). Lines missing a
 * price, a yield or any cost are left out and counted, rather than filled in with a guess.
 * A harvest overrides expected yield. Cost is the larger of planned and actual: spending below
 * plan mid-season usually means the work has not happened yet.
 */
export function seasonForecast(lines: readonly SeasonLine[]): SeasonForecast {
  let revenue = 0;
  let cost = 0;
  let linesUsed = 0;
  let usedArea = 0;
  let totalArea = 0;

  for (const line of lines) {
    totalArea += line.areaHa;
    const tons =
      line.harvestedT ?? (line.expectedYieldTHa === null ? null : line.areaHa * line.expectedYieldTHa);
    const hasCost = line.plannedCost !== null || line.actualCost !== null;
    if (tons === null || line.pricePerT === null || !hasCost) continue;
    revenue += tons * line.pricePerT;
    cost += Math.max(line.plannedCost ?? 0, line.actualCost ?? 0);
    linesUsed += 1;
    usedArea += line.areaHa;
  }

  return {
    revenue: round(revenue, 2),
    cost: round(cost, 2),
    profit: round(revenue - cost, 2),
    profitabilityPercent: cost > 0 ? round(((revenue - cost) / cost) * 100, 2) : null,
    linesUsed,
    linesSkipped: lines.length - linesUsed,
    areaCoveredPercent: totalArea > 0 ? round((usedArea / totalArea) * 100, 1) : null,
  };
}

/** The date stock runs out at a daily rate, counting whole days covered from `today`. */
export function feedRunOutDate(stockKg: number, dailyKg: number, today: string): string | null {
  if (dailyKg <= 0) return null;
  return addDays(today, Math.floor(stockKg / dailyKg));
}

export function costPerKgDryMatter(unitCostPerKg: number, dryMatterPct: number): number | null {
  if (dryMatterPct <= 0) return null;
  return unitCostPerKg / (dryMatterPct / 100);
}

/**
 * The groups a zootechnician compares feeds within: roughage (dag'al), succulent (shirali), energy and
 * protein concentrates, and mineral supplements. Moving dry matter from one group to another changes what
 * the animal eats, not only what the ration costs, so a cost swap stays inside one group.
 */
export const FEED_CLASSES = ['roughage', 'succulent', 'concentrate', 'protein', 'mineral'] as const;
export type FeedClass = (typeof FEED_CLASSES)[number];

/** Wetter than this, a feed is succulent whatever it is called: silage, haylage, roots, green fodder. */
const SUCCULENT_MAX_DRY_MATTER_PCT = 45;

/** Words of feed names in Uzbek, Russian and English, folded so Latin and Cyrillic spellings meet. */
const FEED_WORDS: Record<FeedClass, Set<string>> = {
  mineral: wordSet(
    "tuz*, yalama*, premiks*, mineral*, vitamin*, bo'r, ohak*, fosfat*, suyak*, " +
      'соль, соли, лизунец, лизунца, премикс, премикса, премиксы, минералы, минеральная, минеральный, минеральные, ' +
      'минеральной, витамины, витаминный, витаминная, витаминов, мел, мела, фосфаты, монокальцийфосфат, ' +
      'дикальцийфосфат, трикальцийфосфат, костная, ' +
      'salt, salts, lick, licks, premix, premixes, minerals, vitamins, chalk, limestone, phosphate, phosphates, bone',
  ),
  succulent: wordSet(
    "silos*, senaj*, lavlagi*, sabzi*, ildizmeva*, kartoshka*, qovoq*, oshqovoq*, " +
      'силос, силоса, силосная, сенаж, сенажа, свекла, свёкла, свеклы, свёклы, морковь, моркови, корнеплод, ' +
      'корнеплоды, картофель, тыква, тыквы, ' +
      'silage, haylage, beet, beets, beetroot, carrot, carrots, root, roots, potato, potatoes, pumpkin, pumpkins',
  ),
  roughage: wordSet(
    "pichan*, somon*, xashak*, poxol*, to'pon*, poya*, beda*, qamish*, " +
      'сено, сена, сенная, солома, соломы, соломенная, мякина, мякины, стебли, люцерна, люцерны, люцерновое, ' +
      'люцерновая, ' +
      'hay, straw, chaff, stover, stalks, alfalfa, lucerne',
  ),
  protein: wordSet(
    "kunjara*, shrot*, soya*, no'xat*, mosh*, " +
      'жмых, жмыха, жмыхи, шрот, шрота, соя, сои, соевый, соевая, соевого, горох, гороха, ' +
      'cake, oilcake, meal, soybean, soybeans, peas, pea',
  ),
  concentrate: wordSet(
    "arpa*, bug'doy*, makkajo'xori*, jo'xori*, suli*, tariq*, sholi*, kepak*, yem*, omuxta*, don*, yorma*, " +
      'ячмень, ячменя, ячменная, пшеница, пшеницы, пшеничная, кукуруза, кукурузы, кукурузная, овёс, овес, овса, ' +
      'просо, проса, отруби, отрубей, комбикорм, комбикорма, зерно, зерна, дерть, дерти, ' +
      'barley, wheat, corn, maize, oats, oat, millet, sorghum, bran, grain, grains, concentrate, concentrates, pellets',
  ),
};

const NAME_WORD = new RegExp(`[\\p{L}\\p{M}${APOSTROPHES}]+`, 'gu');

/**
 * The group of a feed from its name and dry matter, or null when neither tells. Supplements are recognised
 * first, then wet feeds, then roughage, then protein, then grain: "Bug'doy somoni" is straw rather than wheat,
 * "Makkajo'xori silosi" is silage, and "Mineral qo'shimcha" is a supplement.
 */
export function feedClassOf(name: string, dryMatterPct: number | null = null): FeedClass | null {
  const keys = (name.match(NAME_WORD) ?? []).map(fold);
  const named = (feedClass: FeedClass) => keys.some((key) => FEED_WORDS[feedClass].has(key));
  if (named('mineral')) return 'mineral';
  if (named('succulent') || (dryMatterPct !== null && dryMatterPct > 0 && dryMatterPct < SUCCULENT_MAX_DRY_MATTER_PCT)) {
    return 'succulent';
  }
  return (['roughage', 'protein', 'concentrate'] as const).find(named) ?? null;
}

export interface RationCostLine {
  itemId: string;
  name: string;
  kgPerHeadDay: number;
  unitCostPerKg: number | null;
  dryMatterPct: number | null;
  /** Read from the name and dry matter when not given. Null: unknown, and the line is not compared. */
  feedClass?: FeedClass | null;
}

export interface RationSaving {
  fromItemId: string;
  fromName: string;
  toItemId: string;
  toName: string;
  /** Both feeds belong to it. */
  feedClass: FeedClass;
  shiftKgDmPerHeadDay: number;
  savingPerHeadDay: number;
  savingPerDay: number;
  /** What the whole ration costs per head per day before the swap. */
  rationCostPerHeadDay: number;
  /** The saving as a percent of that. */
  savingPercent: number;
}

/** A feed under this share of the ration's dry matter is a supplement, such as salt or premix: never swapped. */
export const MIN_SWAP_DRY_MATTER_SHARE = 0.02;
/** A swap that saves less than this share of the ration's daily cost is not worth changing a ration for. */
export const MIN_RATION_SAVING_SHARE = 0.01;

/**
 * Cheapening option for a ration (spec 15.1.5): within one feed group, move a share of the dry matter from
 * the component that costs most per kg of dry matter to the one that costs least, and keep the group whose
 * swap saves most. Supplements, unrecognised feeds and lines under 2% of the dry matter are left alone, and a
 * saving under 1% of the ration's cost is no option. The whole ration must be priced with its dry matter,
 * or neither its cost nor its shares are known. A cost figure only: whether the swap suits the animals is
 * the zootechnician's decision, which is why it stays a recommendation.
 */
export function rationSavingOption(
  lines: readonly RationCostLine[],
  head: number,
  shiftShare = 0.1,
): RationSaving | null {
  const fed = lines.filter((l) => l.kgPerHeadDay > 0);
  if (head <= 0 || fed.length < 2) return null;
  if (fed.some((l) => l.unitCostPerKg === null || l.dryMatterPct === null || l.dryMatterPct <= 0)) return null;

  const known = fed.map((l) => ({
    ...l,
    dmKg: l.kgPerHeadDay * (l.dryMatterPct! / 100),
    costDm: costPerKgDryMatter(l.unitCostPerKg!, l.dryMatterPct!)!,
    group: l.feedClass === undefined ? feedClassOf(l.name, l.dryMatterPct) : l.feedClass,
  }));
  const totalDm = known.reduce((sum, l) => sum + l.dmKg, 0);
  const rationCost = known.reduce((sum, l) => sum + l.kgPerHeadDay * l.unitCostPerKg!, 0);
  if (rationCost <= 0) return null;

  let best: { feedClass: FeedClass; from: (typeof known)[number]; to: (typeof known)[number]; shiftKgDm: number; saving: number } | null = null;
  for (const feedClass of FEED_CLASSES) {
    if (feedClass === 'mineral') continue;
    const group = known.filter((l) => l.group === feedClass && l.dmKg >= totalDm * MIN_SWAP_DRY_MATTER_SHARE);
    if (group.length < 2) continue;
    const from = group.reduce((a, b) => (b.costDm > a.costDm ? b : a));
    const to = group.reduce((a, b) => (b.costDm < a.costDm ? b : a));
    if (from.costDm <= to.costDm) continue;
    const shiftKgDm = from.dmKg * shiftShare;
    const saving = shiftKgDm * (from.costDm - to.costDm);
    if (!best || saving > best.saving) best = { feedClass, from, to, shiftKgDm, saving };
  }
  if (!best || best.saving < rationCost * MIN_RATION_SAVING_SHARE) return null;

  return {
    fromItemId: best.from.itemId,
    fromName: best.from.name,
    toItemId: best.to.itemId,
    toName: best.to.name,
    feedClass: best.feedClass,
    shiftKgDmPerHeadDay: round(best.shiftKgDm, 3),
    savingPerHeadDay: round(best.saving, 2),
    savingPerDay: round(best.saving * head, 2),
    rationCostPerHeadDay: round(rationCost, 2),
    savingPercent: round((best.saving / rationCost) * 100, 1),
  };
}

export interface CropOption {
  key: string;
  yieldTHa: number | null;
  pricePerT: number | null;
  costPerHa: number | null;
  isFeed: boolean;
  perennial?: boolean;
  grownLastSeason: boolean;
  /** Own feed is short, so this crop saves a purchase (spec 15.1.6). */
  feedShortage: boolean;
}

export interface RankedCrop {
  key: string;
  marginPerHa: number;
  score: number;
  reasons: ('rotation_penalty' | 'feed_shortage_bonus')[];
}

const ROTATION_PENALTY = 0.25;
const FEED_BONUS = 0.15;

/** Yield, price and cost are all known, so the margin is. */
const priced = (o: CropOption) => o.yieldTHa !== null && o.pricePerT !== null && o.costPerHa !== null;

/** Rank next-season crops by expected margin, adjusted for rotation and feed need. */
export function rankCropOptions(options: readonly CropOption[]): RankedCrop[] {
  return options
    .filter(priced)
    .map((o) => {
      const margin = o.yieldTHa! * o.pricePerT! - o.costPerHa!;
      const reasons: RankedCrop['reasons'] = [];
      let score = margin;
      if (o.grownLastSeason && !o.perennial) {
        score -= Math.abs(margin) * ROTATION_PENALTY;
        reasons.push('rotation_penalty');
      }
      if (o.isFeed && o.feedShortage) {
        score += Math.abs(margin) * FEED_BONUS;
        reasons.push('feed_shortage_bonus');
      }
      return { key: o.key, marginPerHa: round(margin, 2), score: round(score, 2), reasons };
    })
    .sort((a, b) => b.score - a.score);
}

/** No crop takes more of the arable land than this, so one bad price or one disease cannot take the farm. */
export const MAX_CROP_SHARE = 0.4;

export interface CropField {
  id: string;
  areaHa: number;
  /** The crop the field carries now, or carried last. Repeating it costs the rotation penalty. */
  lastCropKey: string | null;
}

export interface CropAllocationRules {
  /** Hectares that stay under a crop whatever is suggested: perennial stands and fields already planned. */
  committedHa?: Readonly<Record<string, number>>;
  /** Hectares of each crop the herd's feed needs. */
  feedNeedHa?: Readonly<Record<string, number>>;
  /** Largest share of the arable land one crop may take, 0..1. Two priced crops may take half each. */
  maxShare?: number;
}

export type CropReason = RankedCrop['reasons'][number] | 'feed_need' | 'share_limit';

export interface CropAssignment {
  fieldId: string;
  key: string;
  marginPerHa: number;
  reasons: CropReason[];
  /** The field's own ranking, best first, before the farm-wide limits. */
  ranked: RankedCrop[];
}

export interface CropAllocation {
  /** In the order the fields were given. */
  assignments: CropAssignment[];
  /** Hectares under each crop once the suggestion is followed, committed area included. */
  areaHa: Record<string, number>;
  /** All the arable land: the fields to plan and the committed area. */
  totalHa: number;
  /** The most one crop may take. A crop's first field is allowed even when larger. */
  capHa: number;
  /** Feed crops whose need the plan does not cover. */
  feedShort: string[];
}

const EPS = 1e-6;

/**
 * Next crop for each free field, chosen for the whole farm (spec 15.1.6). Ranked field by field, every field
 * gets the same best-paying crop. Here the herd's winter feed goes first, onto the fields where it gives up
 * the least margin, and then each remaining field takes the best score per hectare that keeps every crop
 * within its share of the land. When every crop is at its share, the field goes to the smallest one.
 */
export function allocateCrops(
  fields: readonly CropField[],
  options: readonly CropOption[],
  rules: CropAllocationRules = {},
): CropAllocation {
  const area = new Map<string, number>(Object.entries(rules.committedHa ?? {}).filter(([, ha]) => ha > 0));
  const held = (key: string) => area.get(key) ?? 0;
  const totalHa = fields.reduce((sum, f) => sum + f.areaHa, 0) + [...area.values()].reduce((sum, ha) => sum + ha, 0);
  const keys = [...new Set(options.filter(priced).map((o) => o.key))];
  const capHa = keys.length === 0 ? 0 : Math.max(rules.maxShare ?? MAX_CROP_SHARE, 1 / keys.length) * totalHa;
  const fits = (key: string, field: CropField) => held(key) === 0 || held(key) + field.areaHa <= capHa + EPS;

  const ranking = new Map(
    fields.map((f) => [f.id, rankCropOptions(options.map((o) => ({ ...o, grownLastSeason: o.key === f.lastCropKey })))]),
  );
  const ranked = (field: CropField) => ranking.get(field.id)!;
  const scoreOf = (field: CropField, key: string) => ranked(field).find((r) => r.key === key)!.score;

  const open = fields.filter((f) => f.areaHa > 0 && ranked(f).length > 0);
  const chosen = new Map<string, { key: string; reasons: CropReason[] }>();
  const take = (field: CropField, key: string, reason?: CropReason) => {
    const own = ranked(field).find((r) => r.key === key)!;
    chosen.set(field.id, { key, reasons: reason ? [...own.reasons, reason] : [...own.reasons] });
    area.set(key, held(key) + field.areaHa);
    open.splice(open.indexOf(field), 1);
  };

  // The herd's winter feed first, the largest gap first, on the fields where it costs the least.
  const needs = Object.entries(rules.feedNeedHa ?? {})
    .filter(([key, ha]) => keys.includes(key) && ha > held(key) + EPS)
    .sort(([a, x], [b, y]) => y - held(b) - (x - held(a)) || a.localeCompare(b));
  for (const [key, needHa] of needs) {
    while (held(key) < needHa - EPS) {
      const candidates = open.filter((f) => fits(key, f));
      if (candidates.length === 0) break;
      const loss = (f: CropField) => ranked(f)[0].score - scoreOf(f, key);
      const field = candidates.reduce((a, b) =>
        loss(b) < loss(a) - EPS || (Math.abs(loss(b) - loss(a)) <= EPS && b.areaHa < a.areaHa) ? b : a,
      );
      take(field, key, 'feed_need');
    }
  }

  // Then the best score per hectare anywhere. On a tie the larger field goes first, while there is room.
  while (open.length > 0) {
    let best: { field: CropField; key: string; score: number } | null = null;
    for (const field of open) {
      const option = ranked(field).find((r) => fits(r.key, field));
      if (!option) continue;
      if (!best || option.score > best.score + EPS || (Math.abs(option.score - best.score) <= EPS && field.areaHa > best.field.areaHa)) {
        best = { field, key: option.key, score: option.score };
      }
    }
    if (best) {
      take(best.field, best.key, best.key === ranked(best.field)[0].key ? undefined : 'share_limit');
      continue;
    }
    const field = open.reduce((a, b) => (b.areaHa > a.areaHa ? b : a));
    take(field, ranked(field).reduce((a, b) => (held(b.key) < held(a.key) - EPS ? b : a)).key, 'share_limit');
  }

  return {
    assignments: fields.flatMap((field) => {
      const pick = chosen.get(field.id);
      if (!pick) return [];
      const own = ranked(field).find((r) => r.key === pick.key)!;
      return [{ fieldId: field.id, key: pick.key, marginPerHa: own.marginPerHa, reasons: pick.reasons, ranked: ranked(field) }];
    }),
    areaHa: Object.fromEntries([...area].map(([key, ha]) => [key, round(ha, 4)])),
    totalHa: round(totalHa, 4),
    capHa: round(capHa, 4),
    feedShort: Object.entries(rules.feedNeedHa ?? {})
      .filter(([key, ha]) => ha > held(key) + EPS)
      .map(([key]) => key)
      .sort(),
  };
}
