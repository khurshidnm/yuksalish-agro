import type { BalanceLine, FeedNutrientField, MixShortfall, NutrientAmounts } from '@yap/shared/formulas/nutrition';

export interface RationLine {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  kgPerHeadDay: number;
  dryMatterPct?: number | null;
  dryMatterKg?: number | null;
  unitCostPerKg: number | null;
  costPerHeadDay: number | null;
}

export interface Ration {
  id: string;
  name: string;
  state: string;
  notes: string | null;
  lines: RationLine[];
  totalKgPerHeadDay: number;
  /** Null when a feed has no dry matter percent. */
  totalDryMatterKg?: number | null;
  costPerHeadDay: number | null;
  costPerSeason: number | null;
  seasonDays: number;
}

export interface FeedBalanceRow {
  itemId: string;
  name: string;
  unit: string;
  stockQty: number;
  plannedDaily: number | null;
  actualDaily: number | null;
  daysByPlan: number | null;
  daysByActual: number | null;
  days: number | null;
  basis: 'actual' | 'plan' | null;
  actualDaysCovered: number | null;
  minDays: number;
  belowMinimum: boolean;
}

export interface FeedPlan {
  herds: {
    herdId: string;
    herdName: string;
    state: string;
    head: number;
    /** Suckling lambs in the herd, left out of its adult ration. */
    lambs?: number;
    rationId: string;
    rationName: string | null;
    lines: { itemId: string; itemName: string; unit: string; kgPerHeadDay: number; dailyKg: number }[];
    dailyKg: number;
    costPerDay: number | null;
  }[];
  withoutRation: { herdId: string; herdName: string; head: number }[];
}

export interface WinterRow {
  itemId: string;
  name: string;
  unit: string;
  requiredKg: number;
  stockKg: number | null;
  shortageKg: number | null;
  surplusKg: number | null;
  dailyKg: number;
  coverageDays: number | null;
  runsOutOn: string | null;
  unitCostPerKg: number | null;
  purchaseCost: number | null;
  cropId: string | null;
  cropName: { uz: string; ru: string; en: string } | null;
  yieldTHa: number | null;
  hectares: number | null;
}

export interface WinterPlan {
  days: number;
  head: number;
  basis: 'herds' | 'scenario';
  rows: WinterRow[];
  totals: { requiredKg: number; shortageKg: number; purchaseCost: number | null; shortItems: number };
}

/** Why a herd, or a request, has no requirement to compare with. */
export type NoRequirementReason = 'no_animals' | 'no_weight' | 'mixed_species' | 'species_not_covered' | 'state_not_covered';

/** What one animal needs in a day, as the requirement table gives it. */
export interface RequirementView {
  dryMatterKg: number;
  meMj: number;
  crudeProteinG: number;
  calciumG: number;
  phosphorusG: number;
  weightUsedKg: number;
  /** The weight was outside the printed rows and the nearest row was read. */
  weightClamped: boolean;
  gainG: number;
  gainClamped: boolean;
  rows: string[];
}

export interface RequirementChoice {
  stage?: 'early' | 'late';
  litter?: 1 | 2;
}

export interface RationNutrients {
  state: string;
  stage: 'early' | 'late' | null;
  litter: 1 | 2 | null;
  /** Per head per day. A nutrient is null when a feed lacks its figure. */
  supply: NutrientAmounts;
  roughageSharePct: number | null;
  missing: { itemId: string; itemName: string; fields: FeedNutrientField[] }[];
  herds: {
    herdId: string;
    herdName: string;
    species: string | null;
    head: number;
    weighedHead: number;
    avgWeightKg: number | null;
    reason: NoRequirementReason | null;
    requirement: RequirementView | null;
    lines: BalanceLine[];
  }[];
}

export type MixMissingField = FeedNutrientField | 'isRoughage' | 'price';

export interface LeastCostMix {
  status: 'optimal' | 'infeasible' | 'missing_data' | 'no_requirement';
  herd: { herdId: string; herdName: string; species: string | null; head: number; weighedHead: number; avgWeightKg: number | null } | null;
  state: string;
  stage: 'early' | 'late' | null;
  litter: 1 | 2 | null;
  weightKg: number | null;
  requirement: RequirementView | null;
  reason: NoRequirementReason | null;
  minRoughageSharePct: number;
  missing: { itemId: string; itemName: string; fields: MixMissingField[] }[];
  seasonDays: number;
  lines: { itemId: string; itemName: string; isRoughage: boolean; kgPerHeadDay: number; dryMatterKg: number; unitCostPerKg: number; costPerHeadDay: number }[];
  costPerHeadDay: number | null;
  costPerSeason: number | null;
  balance: BalanceLine[];
  roughageSharePct: number | null;
  shortfalls: MixShortfall[];
}
