/**
 * Crop planning and machinery calculations (spec 7.1, 7.3, 12.3, 14.3).
 * General formulas such as yieldPerHectare and costPerTon are in ./index.
 */

export interface TechCardLineLike {
  costPerHa?: number;
  seedKgHa?: number;
  fertilizerKgHa?: number;
  waterM3Ha?: number;
  laborDaysHa?: number;
}

export interface TechCardNorms {
  costPerHa: number;
  seedKgHa: number;
  fertilizerKgHa: number;
  waterM3Ha: number;
  laborDaysHa: number;
}

/** Per-hectare totals over all operations of a tech card. */
export function techCardNorms(lines: TechCardLineLike[]): TechCardNorms {
  const total: TechCardNorms = { costPerHa: 0, seedKgHa: 0, fertilizerKgHa: 0, waterM3Ha: 0, laborDaysHa: 0 };
  for (const line of lines) {
    total.costPerHa += line.costPerHa ?? 0;
    total.seedKgHa += line.seedKgHa ?? 0;
    total.fertilizerKgHa += line.fertilizerKgHa ?? 0;
    total.waterM3Ha += line.waterM3Ha ?? 0;
    total.laborDaysHa += line.laborDaysHa ?? 0;
  }
  return total;
}

/** Xarajat smetasi: cost per hectare of the tech card × planned area. */
export function planCostEstimate(lines: TechCardLineLike[], areaHa: number): number {
  return techCardNorms(lines).costPerHa * areaHa;
}

/** Kutilayotgan hosil (t): area × expected yield. Null when the yield is unknown. */
export function expectedHarvestT(areaHa: number, yieldTPerHa: number | null | undefined): number | null {
  if (yieldTPerHa === null || yieldTPerHa === undefined) return null;
  return areaHa * yieldTPerHa;
}

/** Tons kept for own livestock and tons left for sale (spec 7.1). */
export function harvestSplit(totalT: number, ownUsePct: number): { ownUseT: number; saleT: number } {
  const ownUseT = (totalT * ownUsePct) / 100;
  return { ownUseT, saleT: totalT - ownUseT };
}

/** Suv sarfi (m³/t). No watering recorded is missing data, so null, never 0 m³ a ton (rule 5). */
export function waterPerTon(waterM3: number | null, harvestT: number): number | null {
  if (waterM3 === null || harvestT <= 0 || !(waterM3 > 0)) return null;
  return waterM3 / harvestT;
}

/** Tadbirlarni o'z vaqtida bajarish (%): done on or before the planned date. */
export function onTimePercent(onTime: number, total: number): number | null {
  if (total <= 0) return null;
  return (onTime / total) * 100;
}

export interface FuelNormInput {
  motoHours?: number | null;
  volumeHa?: number | null;
  normLPerHour?: number | null;
  normLPerHa?: number | null;
}

/**
 * Normative fuel for a shift. A per-hectare norm wins when the shift has a measured area,
 * because it does not reward slow work. Null when no norm applies (spec 12.3).
 */
export function fuelNormLiters(i: FuelNormInput): number | null {
  if (i.normLPerHa && i.volumeHa) return i.normLPerHa * i.volumeHa;
  if (i.normLPerHour && i.motoHours) return i.normLPerHour * i.motoHours;
  return null;
}
