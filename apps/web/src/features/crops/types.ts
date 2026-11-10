import type { CROP_FAMILIES } from '@yap/shared';
import type { I18nName } from '@/features/farm/types';

export type { I18nName };

export interface Season {
  id: string;
  name: string;
  kind: 'autumn' | 'spring' | 'summer';
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  /** The day of the season's last harvest; null before anything is harvested. */
  lastHarvestDate: string | null;
}

export type CropFamily = (typeof CROP_FAMILIES)[number];

export interface CropRef {
  id: string;
  key: string;
  name: I18nName;
  isFeed: boolean;
  defaultYieldTHa: number | null;
  /** Place in the rotation, as the farm set it. Null: the typical family for the crop is used. */
  family: CropFamily | null;
  /** Nutrients one tonne of produce takes from the field, kg/t. Null: the typical figure is used. */
  removalNKgT: number | null;
  removalP2o5KgT: number | null;
  removalK2oKgT: number | null;
  typical: { family: CropFamily | null; removal: { n: number; p2o5: number; k2o: number } | null };
}

export interface RotationNote {
  rule: 'same_crop' | 'cereal_run' | 'cereal_after_cereal' | 'legume_after_legume' | 'after_legume' | 'after_perennial_grass';
  level: 'warning' | 'good';
  source: string;
}

export interface RotationCheck {
  notes: RotationNote[];
  /** The field's earlier crops, newest first. */
  history: { key: string; family: CropFamily | null; name: I18nName; seasonName: string }[];
}

export interface TechCardLine {
  type: string;
  name: string;
  offsetDays: number;
  seedKgHa?: number | null;
  fertilizerKgHa?: number | null;
  waterM3Ha?: number | null;
  laborDaysHa?: number | null;
  costPerHa?: number | null;
}

export interface TechCard {
  id: string;
  cropId: string;
  name: string;
  lines: TechCardLine[];
  expectedYieldTHa: number | null;
  costPerHa: number | null;
  norms: { seedKgHa: number; fertilizerKgHa: number; waterM3Ha: number; laborDaysHa: number };
}

export interface CropPlan {
  id: string;
  seasonId: string;
  seasonName: string;
  fieldId: string;
  fieldNumber: string;
  fieldName: string | null;
  fieldAreaHa: number;
  cropId: string;
  cropKey: string;
  cropName: I18nName;
  isFeed: boolean;
  techCardId: string | null;
  variety: string | null;
  areaHa: number;
  sowingDatePlan: string | null;
  sowingDateFact: string | null;
  seedRateKgHa: number | null;
  expectedYieldTHa: number | null;
  plannedCost: number | null;
  ownUsePct: number;
  status: 'planned' | 'sown' | 'growing' | 'harvested' | 'cancelled';
  notes: string | null;
  expectedHarvestT: number | null;
  planned: { ownUseT: number; saleT: number } | null;
  harvestedT: number;
  operationsDone: number;
  operationsOverdue: number;
  irrigations: number;
  lastWorkDate: string | null;
}

export interface PlanEstimate {
  techCardId: string | null;
  techCardName: string | null;
  seedRateKgHa: number | null;
  expectedYieldTHa: number | null;
  expectedHarvestT: number | null;
  costPerHa: number | null;
  plannedCost: number | null;
}

export interface PlanFactRow {
  planId: string;
  fieldId: string;
  fieldNumber: string;
  cropKey: string;
  cropName: I18nName;
  status: CropPlan['status'];
  areaHa: number;
  expectedYieldTHa: number | null;
  expectedHarvestT: number | null;
  harvestedT: number;
  actualYieldTHa: number | null;
  yieldDeviationPercent: number | null;
  /** Null when no watering was recorded. */
  waterM3: number | null;
  waterM3PerTon: number | null;
  plannedCost: number | null;
  actualCost: number | null;
  costDeviation: number | null;
  costPerTon: number | null;
  harvestValue: number | null;
}

export interface PlanFact {
  seasonId: string | null;
  rows: PlanFactRow[];
  totals: {
    areaHa: number;
    expectedHarvestT: number | null;
    harvestedT: number;
    waterM3: number | null;
    plannedCost: number | null;
    actualCost: number | null;
  } | null;
}

export interface CropsSummary {
  fields: { sown: number; irrigated: number; harvested: number; total: number };
  overdue: { id: string; type: string; date: string; fieldNumber: string }[];
  harvest: { plannedT: number; actualT: number };
  kpis: { yieldTHa: number | null; onTimePercent: number | null; waterM3PerTon: number | null };
  /** Each crop's yield on its own, largest harvest first: hay, silage and grain do not average. */
  yields: { cropKey: string; cropName: I18nName; areaHa: number; harvestedT: number; yieldTHa: number | null }[];
}

export interface OperationMaterial {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  warehouseId: string;
  warehouseName: string;
  qty: number;
  normPerHa: number | null;
  totalCost: number | null;
}

export interface Operation {
  id: string;
  type: string;
  status: 'planned' | 'done';
  overdue: boolean;
  date: string;
  plannedDate: string | null;
  fieldId: string;
  fieldNumber: string;
  fieldName: string | null;
  cropPlanId: string | null;
  cropName: I18nName | null;
  assetId: string | null;
  assetName: string | null;
  employeeId: string | null;
  employeeName: string | null;
  areaDoneHa: number | null;
  waterM3: number | null;
  durationH: number | null;
  fuelL: number | null;
  details: Record<string, unknown>;
  lat: number | null;
  lng: number | null;
  photoFileIds: string[];
  photos?: { id: string; url: string }[];
  weather: { tempMin?: number | null; tempMax?: number | null; precipitationMm?: number | null } | null;
  notes: string | null;
  materials: OperationMaterial[];
}

export interface Harvest {
  id: string;
  fieldId: string;
  fieldNumber: string;
  fieldName: string | null;
  cropPlanId: string | null;
  cropName: I18nName | null;
  date: string;
  grossT: number;
  moisturePct: number | null;
  quality: string | null;
  assetId: string | null;
  assetName: string | null;
  itemId: string | null;
  itemName: string | null;
  unit: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  batchId: string | null;
  notes: string | null;
  employeeId: string | null;
  employeeName: string | null;
  areaDoneHa: number | null;
  value: number | null;
  withdrawalWarning?: { safeFrom: string } | null;
}
