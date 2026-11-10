/**
 * Fertiliser rate from a soil test, by the nutrient balance method taught in CIS agrochemistry.
 *
 * Source of the method and of every coefficient below, unless another is named beside the number:
 * Шеуджен А.Х., Громова Л.И., Онищенко Л.М. «Методы расчета доз удобрений», учебное пособие,
 * Краснодар, КубГАУ, 2010 (pp. 32-39 and the appendix), which reprints tables from
 * Ягодин Б.А., Жуков Ю.П., Кобзаренко В.И. «Агрохимия», 2002; Сычёв В.Г., 2000; Михайлов Н.Н., Книпер В.П., 1971.
 *
 *   Д = (У × Н − З × К1) / К2
 *
 *   Д   rate of the nutrient, kg/ha
 *   У   target yield, t/ha
 *   Н   the crop's removal of the nutrient per tonne of main produce, by-product included, kg/t
 *   З   stock of the available nutrient in the arable layer, kg/ha: З = 3 × П for П in mg/kg,
 *       because a hectare of arable layer weighs about 3 000 t
 *   К1  share of the soil stock the crop takes up
 *   К2  share of the fertiliser the crop takes up in the year it is applied
 *
 * The source itself warns that these shares are «до сих пор слабо разработаны»: the result is an
 * estimate to start a conversation with an agronomist, and the screen says so.
 *
 * What the stored soil test can and cannot support:
 *  - `p` and `k` are mobile P₂O₅ and exchangeable K₂O in mg/kg. They are read as Machigin extracts
 *    (1 % ammonium carbonate), the standard method for the carbonate soils of Central Asia, because
 *    the published soil shares below exist only for that method.
 *  - `n` is nitrate nitrogen. No published method was found that turns one nitrate sample of the
 *    arable layer into a nitrogen rate: the handbook's own nitrogen example uses hydrolysable
 *    nitrogen, and НИЦ МКВК (2005) writes that nitrate «высокая динамичность» is exactly what makes
 *    this hard. So the nitrogen rate is null with a reason, never a guess.
 */
import type { CropFamily } from './rotation';

export type Nutrient = 'n' | 'p2o5' | 'k2o';
export const NUTRIENTS: readonly Nutrient[] = ['n', 'p2o5', 'k2o'];

export interface NutrientSet<T = number | null> {
  n: T;
  p2o5: T;
  k2o: T;
}

/** The handbook the method and its coefficients come from, as the screen names it. */
export const FERTILISER_SOURCE = 'Шеуджен А.Х., Громова Л.И., Онищенко Л.М. «Методы расчета доз удобрений», КубГАУ, 2010';

/** mg/kg of soil to kg/ha of arable layer (the layer weighs about 3·10⁶ kg per hectare). */
export const ARABLE_LAYER_FACTOR = 3;

/**
 * Typical removal with one tonne of main produce and its by-product, kg/t. Used until the farm
 * enters its own figures for a crop, and labelled "typical" wherever it shows.
 *
 * Cereals, rice and maize: Ягодин, Жуков, Кобзаренко «Агрохимия» (2002), as reprinted in the appendix
 * of Шеуджен и др. (2010), pp. 57-58 (winter wheat, winter barley, rice, maize for grain, maize green mass).
 * Lucerne hay: Гринец И.В., Гринец Л.В., Уральский ГАУ, 2024, table 1 (2.60 / 0.65 / 1.50 kg per centner).
 * Raw cotton: НИЦ МКВК «ИУВР-Фергана», «Применение минеральных удобрений под хлопчатник в условиях
 * Ферганской долины», Ташкент, 2005 (60 / about 20 / 50); another source gives 50 / 15 / 50.
 *
 * `corn` has no entry on purpose: it is cut as grain or as green mass, and the two differ eightfold
 * per tonne. The farm picks the one it grows.
 */
export const TYPICAL_REMOVAL_KG_T: Readonly<Record<string, NutrientSet<number>>> = {
  wheat: { n: 33.0, p2o5: 10.4, k2o: 21.7 },
  barley: { n: 27.3, p2o5: 10.4, k2o: 23.6 },
  rice: { n: 33.6, p2o5: 14.8, k2o: 32.8 },
  corn_grain: { n: 28.1, p2o5: 9.1, k2o: 23.6 },
  corn_silage: { n: 3.7, p2o5: 1.1, k2o: 3.5 },
  alfalfa: { n: 26, p2o5: 6.5, k2o: 15 },
  cotton: { n: 60, p2o5: 20, k2o: 50 },
};

/**
 * Share of the soil's mobile P₂O₅ and exchangeable K₂O a crop takes up on serozems, Machigin extract:
 * 15 % and 5 % for «зерновые, однолетние и многолетние травы» (Сычёв, 2000; table 15 in Шеуджен и др.).
 * The same table is empty for maize and other row crops on serozems, so those crops get no rate.
 */
export const SOIL_USE_SEROZEM: Readonly<Pick<NutrientSet<number>, 'p2o5' | 'k2o'>> = { p2o5: 0.15, k2o: 0.05 };
const SOIL_USE_FAMILIES: readonly CropFamily[] = ['cereal', 'annual_grass', 'perennial_grass'];

/**
 * Share of a mineral fertiliser taken up in the year it is applied: P₂O₅ 20 %, K₂O 70 %
 * (Михайлов, Книпер, 1971; table 14 in Шеуджен и др.). ВНИИА gives 15-20 % and 50-60 %.
 */
export const FERTILISER_USE_FIRST_YEAR: Readonly<Pick<NutrientSet<number>, 'p2o5' | 'k2o'>> = { p2o5: 0.2, k2o: 0.7 };

/** Crops that take most of their nitrogen from the air, whatever family the farm files them under. */
const NITROGEN_FIXING_KEYS = new Set(['alfalfa', 'clover', 'sainfoin']);

/** A soil test older than this is shown with a warning. The age comes from the product brief, not from a book. */
export const SOIL_TEST_MAX_AGE_YEARS = 3;

/** True once the analysis is more than SOIL_TEST_MAX_AGE_YEARS old, to the day. Dates are YYYY-MM-DD. */
export function soilTestIsStale(analysisDate: string, today: string): boolean {
  const limit = `${Number(analysisDate.slice(0, 4)) + SOIL_TEST_MAX_AGE_YEARS}${analysisDate.slice(4)}`;
  return today > limit;
}

/** The farm's own removal figures where it entered them, otherwise the typical ones for the crop's key. */
export function cropRemoval(
  key: string,
  stored: NutrientSet,
): { removal: NutrientSet; source: 'farm' | 'typical' | null } {
  const typical = TYPICAL_REMOVAL_KG_T[key] ?? null;
  const own = NUTRIENTS.some((x) => stored[x] !== null);
  if (own) return { removal: stored, source: 'farm' };
  if (typical) return { removal: typical, source: 'typical' };
  return { removal: { n: null, p2o5: null, k2o: null }, source: null };
}

export type NoRateReason =
  /** No target yield on the plan. */
  | 'no_yield'
  /** No removal figure for this crop and nutrient. */
  | 'no_removal'
  /** The analysis has no value for this nutrient. */
  | 'no_soil_value'
  /** Nitrate nitrogen cannot be turned into a rate by any published method we found. */
  | 'nitrate_not_supported'
  /** A legume takes most of its nitrogen from the air. */
  | 'fixes_nitrogen'
  /** No published soil share for this crop group on serozems. */
  | 'no_soil_coefficient';

export interface NutrientAdvice {
  removalPerT: number | null;
  /** What the target yield takes up: У × Н, kg/ha. */
  uptakeKgHa: number | null;
  soilMgKg: number | null;
  /** З: stock in the arable layer, kg/ha. */
  soilStockKgHa: number | null;
  soilUse: number | null;
  /** З × К1: what the soil gives the crop, kg/ha. */
  soilSupplyKgHa: number | null;
  fertiliserUse: number | null;
  /** Д, kg of the nutrient per hectare; 0 when the soil covers the crop. Null with `reason`. */
  rateKgHa: number | null;
  reason: NoRateReason | null;
}

export interface FertiliserInput {
  cropKey: string;
  family: CropFamily | null;
  targetYieldTHa: number | null;
  removal: NutrientSet;
  /** The stored analysis: nitrate N, mobile P₂O₅ and exchangeable K₂O, mg/kg. */
  soil: NutrientSet;
}

const r1 = (value: number) => Math.round(value * 10) / 10;

function positive(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

function known(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

/** Rate of each nutrient in kg/ha of active substance, with every input that produced it. */
export function fertiliserNeed(input: FertiliserInput): NutrientSet<NutrientAdvice> {
  const yieldT = positive(input.targetYieldTHa) ? input.targetYieldTHa : null;
  const soilShare = input.family !== null && SOIL_USE_FAMILIES.includes(input.family);

  const base = (x: Nutrient): NutrientAdvice => {
    const removalPerT = positive(input.removal[x]) ? input.removal[x] : null;
    const soilMgKg = known(input.soil[x]) ? input.soil[x] : null;
    return {
      removalPerT,
      uptakeKgHa: yieldT !== null && removalPerT !== null ? r1(yieldT * removalPerT) : null,
      soilMgKg,
      soilStockKgHa: null,
      soilUse: null,
      soilSupplyKgHa: null,
      fertiliserUse: null,
      rateKgHa: null,
      reason: null,
    };
  };

  const balanced = (x: 'p2o5' | 'k2o'): NutrientAdvice => {
    const row = base(x);
    if (yieldT === null) return { ...row, reason: 'no_yield' };
    if (row.removalPerT === null) return { ...row, reason: 'no_removal' };
    if (row.soilMgKg === null) return { ...row, reason: 'no_soil_value' };
    const stock = row.soilMgKg * ARABLE_LAYER_FACTOR;
    if (!soilShare) return { ...row, soilStockKgHa: r1(stock), reason: 'no_soil_coefficient' };
    const supply = stock * SOIL_USE_SEROZEM[x];
    const rate = Math.max(0, (yieldT * row.removalPerT - supply) / FERTILISER_USE_FIRST_YEAR[x]);
    return {
      ...row,
      soilStockKgHa: r1(stock),
      soilUse: SOIL_USE_SEROZEM[x],
      soilSupplyKgHa: r1(supply),
      fertiliserUse: FERTILISER_USE_FIRST_YEAR[x],
      rateKgHa: r1(rate),
    };
  };

  const nitrogen = (): NutrientAdvice => {
    const row = base('n');
    if (input.family === 'legume' || NITROGEN_FIXING_KEYS.has(input.cropKey)) return { ...row, reason: 'fixes_nitrogen' };
    if (yieldT === null) return { ...row, reason: 'no_yield' };
    if (row.removalPerT === null) return { ...row, reason: 'no_removal' };
    return { ...row, reason: 'nitrate_not_supported' };
  };

  return { n: nitrogen(), p2o5: balanced('p2o5'), k2o: balanced('k2o') };
}

export interface FertiliserProduct {
  id: string;
  name: string;
  /** Percent of the nutrient in the product as sold; null where the farm has not said. */
  nPct: number | null;
  p2o5Pct: number | null;
  k2oPct: number | null;
}

export interface ProductRate {
  id: string;
  name: string;
  /** Product as sold, kg/ha. */
  kgHa: number;
  /** Nutrients this much product brings, kg/ha. */
  gives: NutrientSet<number>;
}

export interface ProductPlan {
  products: ProductRate[];
  /** Nutrients with a rate above zero that no product on the list holds. */
  uncovered: Nutrient[];
}

const pctOf = (p: FertiliserProduct, x: Nutrient): number => {
  const value = x === 'n' ? p.nPct : x === 'p2o5' ? p.p2o5Pct : p.k2oPct;
  return positive(value) ? Math.min(value, 100) : 0;
};

/**
 * Kilograms per hectare of the products the farm keeps, for the rates above. Plain arithmetic, in the
 * order agronomists do it by hand: phosphorus first, from the product richest in it, then potassium,
 * then nitrogen, each time counting what the products already chosen bring of the other nutrients.
 * A nutrient with no rate (null) is not planned for; what comes with another product is still shown.
 * This is our own order of work, not a published optimum, and it never mixes more than one product
 * per nutrient.
 */
export function fertiliserProducts(need: NutrientSet, products: readonly FertiliserProduct[]): ProductPlan {
  const left: NutrientSet<number> = { n: need.n ?? 0, p2o5: need.p2o5 ?? 0, k2o: need.k2o ?? 0 };
  const chosen = new Map<string, { product: FertiliserProduct; kgHa: number }>();
  const uncovered: Nutrient[] = [];

  for (const x of ['p2o5', 'k2o', 'n'] as const) {
    if (left[x] <= 1e-9) continue;
    const carrier = products
      .filter((p) => pctOf(p, x) > 0)
      .reduce<FertiliserProduct | null>((best, p) => (best === null || pctOf(p, x) > pctOf(best, x) ? p : best), null);
    if (!carrier) {
      uncovered.push(x);
      continue;
    }
    const kgHa = left[x] / (pctOf(carrier, x) / 100);
    const already = chosen.get(carrier.id);
    chosen.set(carrier.id, { product: carrier, kgHa: (already?.kgHa ?? 0) + kgHa });
    for (const y of NUTRIENTS) left[y] = Math.max(0, left[y] - (kgHa * pctOf(carrier, y)) / 100);
  }

  return {
    products: [...chosen.values()].map(({ product, kgHa }) => ({
      id: product.id,
      name: product.name,
      kgHa: r1(kgHa),
      gives: {
        n: r1((kgHa * pctOf(product, 'n')) / 100),
        p2o5: r1((kgHa * pctOf(product, 'p2o5')) / 100),
        k2o: r1((kgHa * pctOf(product, 'k2o')) / 100),
      },
    })),
    uncovered,
  };
}
