/**
 * Calculation formulas from spec sections 8.6, 12.7, 14.3 and 25.1.
 *
 * Every function is pure and is the single implementation used by API, reports and UI,
 * so a number shown in two places cannot disagree.
 *
 * Convention: when a denominator is zero the result is `null`, never 0 or Infinity.
 * The UI renders null as "not enough data" (spec 15.2: do not guess).
 */

/** Round half away from zero to `digits` decimals, avoiding binary float artefacts. */
export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  const rounded = Math.round((Math.abs(value) + Number.EPSILON) * factor) / factor;
  return Math.sign(value) * rounded;
}

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function percent(numerator: number, denominator: number): number | null {
  const r = ratio(numerator, denominator);
  return r === null ? null : r * 100;
}

// ─── Livestock (8.6, 25.1) ──────────────────────────────────────────────────

export interface HerdCountInput {
  opening: number;
  born: number;
  purchased: number;
  sold: number;
  slaughtered: number;
  dead: number;
  /** Lost animals (status "yo'qolgan") also leave the herd. */
  lost?: number;
}

/** Poda soni = boshlang'ich + tug'ilgan + sotib olingan − sotilgan − so'yilgan − nobud bo'lgan */
export function herdCount(i: HerdCountInput): number {
  return i.opening + i.born + i.purchased - i.sold - i.slaughtered - i.dead - (i.lost ?? 0);
}

/** Qo'zilash foizi = tug'ilgan qo'zilar / qochirilgan sovliqlar × 100 */
export function lambingPercent(lambsBorn: number, ewesMated: number): number | null {
  return percent(lambsBorn, ewesMated);
}

/** Saqlanib qolish = tirik qo'zilar (sutdan ajratishda) / tug'ilgan qo'zilar × 100 */
export function survivalPercent(liveLambsAtWeaning: number, lambsBorn: number): number | null {
  return percent(liveLambsAtWeaning, lambsBorn);
}

/** Nobudgarchilik (%) = nobud bo'lganlar / o'rtacha bosh soni × 100 */
export function mortalityPercent(dead: number, averageHead: number): number | null {
  return percent(dead, averageHead);
}

/** O'rtacha kunlik o'sish (kg/kun) = (oxirgi vazn − oldingi vazn) / kunlar soni */
export function averageDailyGain(lastKg: number, previousKg: number, days: number): number | null {
  if (days <= 0) return null;
  return ratio(lastKg - previousKg, days);
}

export interface LiveWeightCostInput {
  feed: number;
  vet: number;
  labor: number;
  overhead: number;
  weightGainKg: number;
}

/** Tannarx(1 kg) = (X_ozuqa + X_vet + X_mehnat + X_umumiy) / ΔW_poda */
export function costPerKgLiveWeight(i: LiveWeightCostInput): number | null {
  if (i.weightGainKg <= 0) return null;
  return ratio(i.feed + i.vet + i.labor + i.overhead, i.weightGainKg);
}

/** Smallest share of a herd that must be weighed before its gain can stand for the whole herd. */
export const MIN_WEIGHED_SHARE = 0.5;

/**
 * Whole-herd weight gain from a weighed sample. Cost and feed cover every animal, so dividing them
 * by the gain of only those weighed gives an absurd figure. Below MIN_WEIGHED_SHARE this is null.
 */
export function scaleGainToHerd(measuredGainKg: number, weighedHead: number, head: number): number | null {
  if (head <= 0 || weighedHead <= 0 || weighedHead / head < MIN_WEIGHED_SHARE) return null;
  return (measuredGainKg / weighedHead) * head;
}

/** Ozuqa konversiyasi = ozuqa (kg quruq modda) / ΔW (kg) */
export function feedConversion(feedDryMatterKg: number, weightGainKg: number): number | null {
  if (weightGainKg <= 0) return null;
  return ratio(feedDryMatterKg, weightGainKg);
}

/** Bir sovliqdan daromad = (qo'zi sotuvi + jun) / sovliqlar soni */
export function revenuePerEwe(lambSales: number, wool: number, ewes: number): number | null {
  return ratio(lambSales + wool, ewes);
}

export const DEFAULT_GESTATION_DAYS = 150;

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid date: ${isoDate}`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Expected lambing date. Sheep gestation is 145–152 days (spec 8.2). */
export function expectedLambingDate(matingDate: string, gestationDays = DEFAULT_GESTATION_DAYS): string {
  return addDaysIso(matingDate, gestationDays);
}

/** Lambing window for the calendar: earliest and latest plausible dates. */
export function lambingWindow(
  matingDate: string,
  minDays = 145,
  maxDays = 152,
): { earliest: string; latest: string } {
  return { earliest: addDaysIso(matingDate, minDays), latest: addDaysIso(matingDate, maxDays) };
}

/** Earliest date meat or milk may be sold after a treatment (kutish muddati, spec 8.3). */
export function withdrawalUntil(treatmentDate: string, withdrawalDays: number): string {
  return addDaysIso(treatmentDate, Math.max(0, withdrawalDays));
}

// ─── Feed (25.1, 9.3) ───────────────────────────────────────────────────────

export interface RationConsumer {
  kgPerHeadPerDay: number;
  head: number;
}

/** Sum(ration × head): planned consumption per day for one feed item. */
export function dailyRequirementKg(consumers: RationConsumer[]): number {
  return consumers.reduce((sum, c) => sum + c.kgPerHeadPerDay * c.head, 0);
}

/** Zaxira kunlari = Qoldiq / Σ(Ratsion × N) */
export function feedDays(stockKg: number, consumers: RationConsumer[]): number | null {
  const daily = dailyRequirementKg(consumers);
  if (daily <= 0) return null;
  return stockKg / daily;
}

/** Days of stock at actual consumption (spec 24.1: "haqiqiy sarf asosida"). */
export function feedDaysByActual(stockKg: number, avgDailyActualKg: number): number | null {
  if (avgDailyActualKg <= 0) return null;
  return stockKg / avgDailyActualKg;
}

export interface WinterFeedInput {
  head: number;
  days: number;
  kgPerHeadPerDay: number;
  stockKg: number;
}

export interface WinterFeedResult {
  requiredKg: number;
  shortageKg: number;
  surplusKg: number;
}

/** Winter requirement for one feed: 500 ewes × winter days × ration (spec 9.3). */
export function winterFeedBalance(i: WinterFeedInput): WinterFeedResult {
  const requiredKg = i.head * i.days * i.kgPerHeadPerDay;
  const diff = i.stockKg - requiredKg;
  return { requiredKg, shortageKg: diff < 0 ? -diff : 0, surplusKg: diff > 0 ? diff : 0 };
}

/** Hectares needed to grow a shortage, given the expected yield in t/ha. */
export function hectaresForShortage(shortageKg: number, yieldTPerHa: number): number | null {
  if (yieldTPerHa <= 0) return null;
  return shortageKg / 1000 / yieldTPerHa;
}

/** Relative deviation of actual from norm, in percent. Positive means over norm. */
export function deviationPercent(actual: number, norm: number): number | null {
  if (norm === 0) return null;
  return ((actual - norm) / norm) * 100;
}

/** Daily feed cost per head (ratsion tannarxi). */
export function rationCostPerHeadDay(lines: { kgPerHeadPerDay: number; unitCostPerKg: number }[]): number {
  return lines.reduce((sum, l) => sum + l.kgPerHeadPerDay * l.unitCostPerKg, 0);
}

// ─── Crops (25.1) ───────────────────────────────────────────────────────────

export interface CropCostInput {
  seed: number;
  fertilizer: number;
  water: number;
  machinery: number;
  labor: number;
  overheadShare: number;
}

export function cropCostTotal(i: CropCostInput): number {
  return i.seed + i.fertilizer + i.water + i.machinery + i.labor + i.overheadShare;
}

/** Tannarx(1 t) = (urug' + o'g'it + suv + texnika + mehnat + umumiy ulush) / hosil */
export function costPerTon(i: CropCostInput, harvestTons: number): number | null {
  if (harvestTons <= 0) return null;
  return ratio(cropCostTotal(i), harvestTons);
}

/** Hosildorlik (t/ga) */
export function yieldPerHectare(harvestTons: number, areaHa: number): number | null {
  return ratio(harvestTons, areaHa);
}

// ─── Finance (25.1, 10.3) ───────────────────────────────────────────────────

/** Rentabellik (%) = (daromad − xarajat) / xarajat × 100 */
export function profitabilityPercent(revenue: number, cost: number): number | null {
  if (cost <= 0) return null;
  return percent(revenue - cost, cost);
}

/** Budget utilisation (ijro, %). */
export function budgetExecutionPercent(actual: number, planned: number): number | null {
  return percent(actual, planned);
}

/** Convert a foreign currency amount to the base currency. */
export function toBaseAmount(amount: number, fxRate: number): number {
  return round(amount * fxRate, 2);
}

export type OverheadBase = 'head' | 'area' | 'direct_cost' | 'hours';

export interface AllocationTarget {
  id: string;
  /** Value of the chosen base for this target: head count, hectares, direct cost or hours. */
  weight: number;
}

/**
 * Split shared overhead across cost centers in proportion to the chosen base (spec 25.1).
 * Shares are rounded to 2 decimals and the rounding remainder goes to the largest target,
 * so the shares always add up to exactly `total`.
 */
export function allocateOverhead(total: number, targets: AllocationTarget[]): Record<string, number> {
  const usable = targets.filter((t) => t.weight > 0);
  const weightSum = usable.reduce((sum, t) => sum + t.weight, 0);
  const result: Record<string, number> = {};
  if (weightSum === 0 || total === 0) return result;

  let allocated = 0;
  for (const t of usable) {
    const share = round((total * t.weight) / weightSum, 2);
    result[t.id] = share;
    allocated += share;
  }
  const largest = usable.reduce((a, b) => (b.weight > a.weight ? b : a));
  result[largest.id] = round(result[largest.id] + (total - allocated), 2);
  return result;
}

/** Straight-line depreciation per month. */
export function straightLineMonthly(cost: number, salvage: number, usefulLifeMonths: number): number | null {
  if (usefulLifeMonths <= 0) return null;
  return Math.max(0, cost - salvage) / usefulLifeMonths;
}

/** Units-of-production depreciation for a period. */
export function unitsOfProductionDepreciation(
  cost: number,
  salvage: number,
  totalUnits: number,
  unitsThisPeriod: number,
): number | null {
  if (totalUnits <= 0) return null;
  return (Math.max(0, cost - salvage) * unitsThisPeriod) / totalUnits;
}

/** Cost of one motor-hour or one hectare of work (spec 12.7). */
export function machineryUnitCost(
  costs: { fuel: number; labor: number; repairs: number; depreciation: number },
  units: number,
): number | null {
  if (units <= 0) return null;
  return ratio(costs.fuel + costs.labor + costs.repairs + costs.depreciation, units);
}

export interface LoanInstalment {
  period: number;
  principal: number;
  interest: number;
  payment: number;
  balance: number;
}

/** Monthly loan schedule. The final instalment absorbs rounding so the balance ends at 0. */
export function loanSchedule(
  principal: number,
  annualRatePercent: number,
  months: number,
  method: 'annuity' | 'equal_principal' = 'annuity',
): LoanInstalment[] {
  if (months <= 0 || principal <= 0) return [];
  const monthlyRate = annualRatePercent / 100 / 12;
  const rows: LoanInstalment[] = [];
  let balance = principal;
  const annuity =
    monthlyRate === 0
      ? principal / months
      : (principal * monthlyRate) / (1 - (1 + monthlyRate) ** -months);

  for (let period = 1; period <= months; period++) {
    const interest = round(balance * monthlyRate, 2);
    const isLast = period === months;
    const principalPart = isLast
      ? balance
      : round(method === 'annuity' ? annuity - interest : principal / months, 2);
    balance = round(balance - principalPart, 2);
    rows.push({
      period,
      principal: principalPart,
      interest,
      payment: round(principalPart + interest, 2),
      balance,
    });
  }
  return rows;
}

// ─── Inventory costing (9.2) ────────────────────────────────────────────────

export interface BatchLike {
  id: string;
  qtyRemaining: number;
  unitCost: number;
}

export interface BatchConsumption {
  batchId: string;
  qty: number;
  unitCost: number;
}

export interface ConsumptionResult {
  lines: BatchConsumption[];
  totalCost: number;
  /** Quantity that could not be covered by the batches. */
  shortage: number;
}

/** Weighted average unit cost of the remaining stock. */
export function weightedAverageCost(batches: Pick<BatchLike, 'qtyRemaining' | 'unitCost'>[]): number {
  const qty = batches.reduce((sum, b) => sum + b.qtyRemaining, 0);
  if (qty <= 0) return 0;
  return batches.reduce((sum, b) => sum + b.qtyRemaining * b.unitCost, 0) / qty;
}

/**
 * Consume `qty` from batches, which must already be sorted oldest first.
 * Quantity always leaves the oldest batches. The method only changes the cost: FIFO uses
 * each batch's own cost, AVG uses the weighted average of all remaining stock.
 */
export function consumeBatches(
  batches: BatchLike[],
  qty: number,
  method: 'fifo' | 'avg' = 'fifo',
): ConsumptionResult {
  const avg = method === 'avg' ? weightedAverageCost(batches) : 0;
  const lines: BatchConsumption[] = [];
  let left = qty;
  let totalCost = 0;

  for (const batch of batches) {
    if (left <= 0) break;
    const take = Math.min(left, batch.qtyRemaining);
    if (take <= 0) continue;
    const unitCost = method === 'avg' ? avg : batch.unitCost;
    lines.push({ batchId: batch.id, qty: take, unitCost });
    totalCost += take * unitCost;
    left -= take;
  }
  return { lines, totalCost: round(totalCost, 2), shortage: left > 1e-9 ? left : 0 };
}
