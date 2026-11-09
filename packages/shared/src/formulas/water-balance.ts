/**
 * Field water balance: how much water the crop uses, how much the root zone has lost,
 * and when the field needs irrigation.
 *
 * Equation, table and figure numbers refer to FAO Irrigation and Drainage Paper 56 (Allen,
 * Pereira, Raes and Smith, 1998). Single crop coefficient method (FAO-56 ch. 6 and 8).
 * Same convention as index.ts: missing data is `null`, never 0, and a zero denominator is `null`.
 */

function known(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

// ─── Crop coefficient curve ─────────────────────────────────────────────────

/** A crop coefficient curve (FAO-56 Fig. 25): three Kc values and four stage lengths in days. */
export interface KcCurve {
  kcIni: number;
  kcMid: number;
  kcEnd: number;
  lIni: number;
  lDev: number;
  lMid: number;
  lLate: number;
}

export type GrowthStage = 'initial' | 'development' | 'mid' | 'late';

function validCurve(c: KcCurve): boolean {
  return [c.kcIni, c.kcMid, c.kcEnd, c.lIni, c.lDev, c.lMid, c.lLate].every((v) => known(v) && v >= 0);
}

/** Days from planting to harvest: the four stage lengths together. */
export function seasonLength(curve: KcCurve): number {
  return curve.lIni + curve.lDev + curve.lMid + curve.lLate;
}

/**
 * Growth stage on `day` days after planting (planting day is 0, harvest day is `seasonLength`).
 * A day belongs to the stage it starts in: day `lIni` is the first day of development.
 * The harvest day itself is still late season. Null outside the season.
 */
export function growthStage(curve: KcCurve, day: number): GrowthStage | null {
  if (!validCurve(curve) || !known(day) || day < 0 || day > seasonLength(curve)) return null;
  if (day < curve.lIni) return 'initial';
  if (day < curve.lIni + curve.lDev) return 'development';
  if (day < curve.lIni + curve.lDev + curve.lMid) return 'mid';
  return 'late';
}

/**
 * Crop coefficient on `dayOfSeason` days after planting (FAO-56 Fig. 25, eq. 66): Kc ini through
 * the initial stage, a straight line up to Kc mid over development, Kc mid through mid season,
 * a straight line to Kc end over late season, reaching it on the harvest day. Null before
 * planting, after harvest, or for a curve with a negative or missing value.
 */
export function cropCoefficient(curve: KcCurve, dayOfSeason: number): number | null {
  if (!validCurve(curve) || !known(dayOfSeason)) return null;
  const day = dayOfSeason;
  if (day < 0 || day > seasonLength(curve)) return null;
  const devStart = curve.lIni;
  const midStart = devStart + curve.lDev;
  const lateStart = midStart + curve.lMid;
  // Each division below runs only inside its stage, so a stage length of 0 never divides.
  if (day <= devStart) return curve.kcIni;
  if (day < midStart) return curve.kcIni + ((day - devStart) / curve.lDev) * (curve.kcMid - curve.kcIni);
  if (day <= lateStart) return curve.kcMid;
  return curve.kcMid + ((day - lateStart) / curve.lLate) * (curve.kcEnd - curve.kcMid);
}

// ─── Crop presets ───────────────────────────────────────────────────────────

export interface CropWaterPreset extends KcCurve {
  /** Effective rooting depth, m (FAO-56 Table 22, lower end of the range). */
  rootDepthM: number;
  /** Share of total available water the crop can use before it suffers, p (FAO-56 Table 22). */
  depletionFraction: number;
  /** Grown under standing water: the root-zone balance below does not apply. */
  flooded?: boolean;
  /**
   * A perennial's season restarts each spring on this date (MM-DD): its Kc curve runs from regrowth,
   * not from the sowing years ago. The root zone is taken as full again after the winter.
   */
  regrowth?: string;
}

export type CropWaterKey = 'wheat' | 'barley' | 'rice' | 'alfalfa' | 'corn' | 'cotton';

/**
 * Water presets for the crops grown on Uzbek farms.
 *
 * Kc values are FAO-56 Table 12 (sub-humid climate, RHmin about 45 %, wind about 2 m/s). Under
 * a dry, windy Uzbek summer the true Kc mid and Kc end run higher (FAO-56 eq. 62), so these are
 * a floor rather than an estimate. Root depth is the lower end of the Table 22 range and p its
 * value for ETc about 5 mm/day; on 8-10 mm July days the crop suffers sooner (FAO-56 notes p
 * falls by about 0.04 per mm above 5).
 *
 * Stage lengths start from FAO-56 Table 11 and are calibrated to Uzbekistan's calendar:
 * winter cereals sown in October and harvested in late May or June, row crops sown in April.
 */
export const CROP_WATER_PRESETS: Record<CropWaterKey, CropWaterPreset> = {
  // Winter wheat, sown early to mid October, harvested in June (240 days).
  // Table 11: 30/140/40/30, the Mediterranean row (November sowing).
  // Table 12, winter wheat: Kc ini 0.4 with frozen soils (0.7 with non-frozen soils assumes a
  // surface kept wet by winter rain, which an Uzbek October-November does not provide),
  // Kc mid 1.15, Kc end 0.25-0.4 (0.25: the crop dries in the field before the combine).
  // Table 22, winter wheat: Zr 1.5-1.8 m, p 0.55.
  wheat: {
    kcIni: 0.4,
    kcMid: 1.15,
    kcEnd: 0.25,
    lIni: 30,
    lDev: 140,
    lMid: 40,
    lLate: 30,
    rootDepthM: 1.5,
    depletionFraction: 0.55,
  },
  // Winter barley, sown in October, harvested in late May (220 days): the wheat calendar,
  // shorter. Table 11 lists only spring and short-season barley (120-150 days).
  // Table 12, barley: Kc ini 0.3, Kc mid 1.15, Kc end 0.25. Table 22, barley: Zr 1.0-1.5 m, p 0.55.
  barley: {
    kcIni: 0.3,
    kcMid: 1.15,
    kcEnd: 0.25,
    lIni: 30,
    lDev: 130,
    lMid: 40,
    lLate: 20,
    rootDepthM: 1.0,
    depletionFraction: 0.55,
  },
  // Paddy rice, transplanted or sown in May, harvested in October (150 days).
  // Table 11: 30/30/60/30 (Tropics; Mediterranean).
  // Table 12, rice: Kc ini 1.05, Kc mid 1.20, Kc end 0.90-0.60 (0.75, the midpoint).
  // Table 22, rice: Zr 0.5-1.0 m, p 0.20, measured from saturation rather than field capacity.
  rice: {
    kcIni: 1.05,
    kcMid: 1.2,
    kcEnd: 0.75,
    lIni: 30,
    lDev: 30,
    lMid: 60,
    lLate: 30,
    rootDepthM: 0.5,
    depletionFraction: 0.2,
    flooded: true,
  },
  // Lucerne as one averaged season, from spring regrowth on 1 March through the last cut in
  // October and the regrowth after it, until the frosts of mid-November stop it (255 days, to
  // 11 November). Bukhara lucerne is cut 4-5 times and watered into November. Table 11 gives only
  // cutting cycles (first cycle 10/20/20/10), so the stages here stand for the whole season of cuts.
  // Table 12, alfalfa hay, averaged cutting effects: Kc ini 0.40, Kc mid 0.95, Kc end 0.90.
  // Table 22, alfalfa for hay: Zr 1.0-2.0 m, p 0.55.
  alfalfa: {
    kcIni: 0.4,
    kcMid: 0.95,
    kcEnd: 0.9,
    lIni: 10,
    lDev: 30,
    lMid: 190,
    lLate: 25,
    rootDepthM: 1.0,
    depletionFraction: 0.55,
    // Alfalfa wakes in early March in the Bukhara oasis.
    regrowth: '03-01',
  },
  // Grain maize sown in April, harvested in September (150 days).
  // Table 11: 30/40/50/30 (April; Spain, California).
  // Table 12, maize field (grain): Kc ini 0.30, Kc mid 1.20, Kc end 0.60-0.35 (0.60: harvested
  // at high grain moisture). Table 22, maize field (grain): Zr 1.0-1.7 m, p 0.55.
  corn: {
    kcIni: 0.3,
    kcMid: 1.2,
    kcEnd: 0.6,
    lIni: 30,
    lDev: 40,
    lMid: 50,
    lLate: 30,
    rootDepthM: 1.0,
    depletionFraction: 0.55,
  },
  // Cotton sown mid April, picked through October (195 days).
  // Table 11: 30/50/60/55 (March; Egypt, Pakistan, California).
  // Table 12, cotton: Kc ini 0.35, Kc mid 1.15-1.20 (1.15), Kc end 0.70-0.50 (0.60, the midpoint).
  // Table 22, cotton: Zr 1.0-1.7 m, p 0.65.
  cotton: {
    kcIni: 0.35,
    kcMid: 1.15,
    kcEnd: 0.6,
    lIni: 30,
    lDev: 50,
    lMid: 60,
    lLate: 55,
    rootDepthM: 1.0,
    depletionFraction: 0.65,
  },
};

// ─── Soil water ─────────────────────────────────────────────────────────────

/**
 * First day of the current season: the sowing date, or for a perennial the latest spring regrowth
 * on or before `today` that is not before the sowing.
 */
export function seasonStart(preset: Pick<CropWaterPreset, 'regrowth'>, sowingDate: string, today: string): string {
  if (!preset.regrowth) return sowingDate;
  const year = Number(today.slice(0, 4));
  let regrowth = `${year}-${preset.regrowth}`;
  if (regrowth > today) regrowth = `${year - 1}-${preset.regrowth}`;
  return regrowth > sowingDate ? regrowth : sowingDate;
}

export type SoilTexture =
  | 'sand'
  | 'loamy_sand'
  | 'sandy_loam'
  | 'loam'
  | 'silt_loam'
  | 'silt'
  | 'silty_clay_loam'
  | 'silty_clay'
  | 'clay';

export interface SoilWaterProperties {
  /** Volumetric water content at field capacity, θFC, m³/m³. */
  fieldCapacity: number;
  /** Volumetric water content at the wilting point, θWP, m³/m³. */
  wiltingPoint: number;
}

/** Soil water by texture: midpoints of the FAO-56 Table 19 ranges (given in each comment as FC; WP). */
export const SOIL_TEXTURES: Record<SoilTexture, SoilWaterProperties> = {
  sand: { fieldCapacity: 0.12, wiltingPoint: 0.045 }, // 0.07-0.17; 0.02-0.07
  loamy_sand: { fieldCapacity: 0.15, wiltingPoint: 0.065 }, // 0.11-0.19; 0.03-0.10
  sandy_loam: { fieldCapacity: 0.23, wiltingPoint: 0.11 }, // 0.18-0.28; 0.06-0.16
  loam: { fieldCapacity: 0.25, wiltingPoint: 0.12 }, // 0.20-0.30; 0.07-0.17
  silt_loam: { fieldCapacity: 0.29, wiltingPoint: 0.15 }, // 0.22-0.36; 0.09-0.21
  silt: { fieldCapacity: 0.32, wiltingPoint: 0.17 }, // 0.28-0.36; 0.12-0.22
  silty_clay_loam: { fieldCapacity: 0.335, wiltingPoint: 0.205 }, // 0.30-0.37; 0.17-0.24
  silty_clay: { fieldCapacity: 0.36, wiltingPoint: 0.23 }, // 0.30-0.42; 0.17-0.29
  clay: { fieldCapacity: 0.36, wiltingPoint: 0.22 }, // 0.32-0.40; 0.20-0.24
};

/**
 * Total available water in the root zone, mm (FAO-56 eq. 82): TAW = 1000·(θFC − θWP)·Zr.
 * Null for an unknown texture or a root depth that is missing or not above 0.
 */
export function totalAvailableWaterMm(texture: SoilTexture, rootDepthM: number | null): number | null {
  const soil = Object.hasOwn(SOIL_TEXTURES, texture) ? SOIL_TEXTURES[texture] : undefined;
  if (!soil || !known(rootDepthM) || rootDepthM <= 0) return null;
  return 1000 * (soil.fieldCapacity - soil.wiltingPoint) * rootDepthM;
}

/** Readily available water, mm (FAO-56 eq. 83): RAW = p·TAW. Null when TAW is unknown or p is outside 0 to 1. */
export function readilyAvailableWaterMm(tawMm: number | null, p: number): number | null {
  if (!known(tawMm) || !known(p) || p < 0 || p > 1) return null;
  return p * tawMm;
}

/**
 * Water stress coefficient Ks (FAO-56 eq. 84): 1 while depletion is within RAW, then falling in a
 * straight line to 0 at TAW. Null for a TAW not above 0 or a RAW outside 0 to TAW.
 */
export function waterStressCoefficient(depletionMm: number, tawMm: number, rawMm: number): number | null {
  if (!known(depletionMm) || !known(tawMm) || !known(rawMm) || tawMm <= 0 || rawMm < 0 || rawMm > tawMm) return null;
  if (depletionMm <= rawMm) return 1;
  if (tawMm === rawMm) return 0;
  return Math.min(1, Math.max(0, (tawMm - depletionMm) / (tawMm - rawMm)));
}

/**
 * Rain that reaches the root zone, mm. FAO-56 ch. 8: a daily rain below about 0.2·ET0 evaporates
 * from the soil surface, so it counts as 0; a larger rain counts in full (what overflows the root
 * zone is deep percolation in the balance). Missing rain is read as no rain, because weather
 * stations commonly leave dry days blank. Null when there is rain but ET0 is unknown.
 */
export function effectiveRainfallMm(rainMm: number | null, et0Mm: number | null): number | null {
  if (!known(rainMm) || rainMm <= 0) return 0;
  if (!known(et0Mm)) return null;
  // rain < 0.2·ET0, written without 0.2: in binary 0.2 × 6 is 1.2000000000000002, which would drop a 1.2 mm rain.
  return 5 * rainMm < et0Mm ? 0 : rainMm;
}

export interface WaterBalanceDay {
  /** YYYY-MM-DD, consecutive days. */
  date: string;
  et0Mm: number | null;
  /** Crop coefficient for the day, from `cropCoefficient`. */
  kc: number | null;
  /** Missing is read as no rain (see `effectiveRainfallMm`). */
  rainMm: number | null;
  /** Gross irrigation applied, mm over the field. */
  irrigationMm: number;
}

export interface WaterBalanceInput {
  /** Oldest first. */
  days: WaterBalanceDay[];
  tawMm: number;
  rawMm: number;
  /** Root-zone depletion at the end of the day before the first day, mm. */
  initialDepletionMm: number;
  /** Share of applied irrigation that reaches the root zone, above 0 and at most 1. Default 1. */
  irrigationEfficiency?: number;
}

export interface WaterBalanceRow {
  date: string;
  /** Water the crop used: Ks·Kc·ET0 (FAO-56 eq. 80), so already reduced under stress. */
  etcMm: number | null;
  effectiveRainMm: number | null;
  /** Water stress coefficient used for the day, from the previous day's depletion (eq. 84). */
  ks: number | null;
  /** Water that drained below the roots: rain and irrigation beyond refilling to field capacity. */
  deepPercolationMm: number | null;
  /** Root-zone depletion at the end of the day, mm, within 0 and TAW. */
  depletionMm: number | null;
}

/**
 * Daily root-zone depletion (FAO-56 eq. 85) with no runoff and no capillary rise:
 * Dr,i = Dr,i−1 − Pe,i − I,i·efficiency + ETc adj,i, then held within 0 and TAW; whatever would take
 * it below 0 is deep percolation (eq. 88). ETc adj = Ks·Kc·ET0 with Ks from Dr,i−1 (eqs. 80, 84).
 *
 * A day with unknown ET0 or Kc makes that day's depletion unknown, and every later day too:
 * the balance is a running sum and does not recover by itself. Invalid TAW, RAW or efficiency
 * makes every day unknown. Effective rain is still reported for each day it can be.
 */
export function soilWaterBalance(i: WaterBalanceInput): WaterBalanceRow[] {
  const { tawMm, rawMm } = i;
  const efficiency = i.irrigationEfficiency ?? 1;
  const valid =
    known(tawMm) &&
    tawMm > 0 &&
    known(rawMm) &&
    rawMm >= 0 &&
    rawMm <= tawMm &&
    known(efficiency) &&
    efficiency > 0 &&
    efficiency <= 1 &&
    known(i.initialDepletionMm);

  let depletion: number | null = valid ? Math.min(tawMm, Math.max(0, i.initialDepletionMm)) : null;

  return i.days.map((d) => {
    const effectiveRainMm = effectiveRainfallMm(d.rainMm, d.et0Mm);
    const previous = depletion;
    const ks = previous == null ? null : waterStressCoefficient(previous, tawMm, rawMm);
    if (
      previous == null ||
      ks == null ||
      effectiveRainMm == null ||
      !known(d.et0Mm) ||
      d.et0Mm < 0 ||
      !known(d.kc) ||
      d.kc < 0 ||
      !known(d.irrigationMm) ||
      d.irrigationMm < 0
    ) {
      depletion = null;
      return { date: d.date, etcMm: null, effectiveRainMm, ks: null, deepPercolationMm: null, depletionMm: null };
    }

    const etcMm = ks * d.kc * d.et0Mm;
    const balance = previous - effectiveRainMm - d.irrigationMm * efficiency + etcMm;
    const deepPercolationMm = Math.max(0, -balance);
    depletion = Math.min(tawMm, Math.max(0, balance));
    return { date: d.date, etcMm, effectiveRainMm, ks, deepPercolationMm, depletionMm: depletion };
  });
}

// ─── Irrigation volumes ─────────────────────────────────────────────────────

/** Depth of water a volume spreads to over an area, mm: 1 mm on 1 ha is 10 m³. Null for an area not above 0. */
export function irrigationDepthMm(volumeM3: number | null, areaHa: number | null): number | null {
  if (!known(volumeM3) || !known(areaHa) || areaHa <= 0) return null;
  return volumeM3 / (10 * areaHa);
}

/**
 * Water to deliver to bring a field back to field capacity, m³: depletion·10·ha / efficiency.
 * Null for an area not above 0 or an efficiency outside above 0 to at most 1.
 */
export function refillVolumeM3(depletionMm: number | null, areaHa: number | null, efficiency: number): number | null {
  if (!known(depletionMm) || !known(areaHa) || areaHa <= 0) return null;
  if (!known(efficiency) || efficiency <= 0 || efficiency > 1) return null;
  return (depletionMm * 10 * areaHa) / efficiency;
}

/**
 * The first forecast date on which depletion reaches RAW, so the field is due for irrigation:
 * forecast[0] when it is already there. Forecast rain is not counted, since a forecast shower
 * may not come. Null when RAW is not reached within the forecast, or when a day it needs has
 * no ETc.
 */
export function projectDueDate(i: {
  /** Depletion at the start of the first forecast day, mm. */
  depletionMm: number;
  rawMm: number;
  /** Consecutive days, oldest first. */
  forecast: { date: string; etcMm: number | null }[];
}): string | null {
  if (!known(i.depletionMm) || !known(i.rawMm) || i.forecast.length === 0) return null;
  if (i.depletionMm >= i.rawMm) return i.forecast[0].date;
  let depletion = i.depletionMm;
  for (const day of i.forecast) {
    if (!known(day.etcMm)) return null;
    depletion += day.etcMm;
    if (depletion >= i.rawMm) return day.date;
  }
  return null;
}
