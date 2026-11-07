import type { I18nName } from '../types';

export interface VegetationGrid {
  west: number;
  south: number;
  east: number;
  north: number;
  width: number;
  height: number;
  /** Base64 bytes, row 0 north: round((NDVI + 1) × 100), 255 where unknown. */
  data: string;
}

export interface WeakZone {
  areaHa: number;
  meanNdvi: number;
  lat: number;
  lng: number;
}

export interface VegetationReading {
  date: string;
  clearPct: number;
  cellCount: number;
  ndviMean: number | null;
  ndviP10: number | null;
  ndviP50: number | null;
  ndviP90: number | null;
  grid: VegetationGrid | null;
  weakZones: WeakZone[];
}

export interface VegetationPoint {
  date: string;
  mean: number;
  p10: number | null;
  p90: number | null;
}

export type SatelliteEventType = 'green_up' | 'harvest' | 'bare';
export type WorkCheckKind = 'no_green_up' | 'harvest_not_seen' | 'unrecorded_harvest';

export interface PastureEstimate {
  date: string | null;
  ndvi: number | null;
  biomassKgHa: number | null;
  head: number;
  intakeKgDmPerHeadDay: number;
  utilisation: number;
  grazingDays: number | null;
  model: { slope: number; intercept: number; r2: number | null; samples: number; calibrated: boolean };
  samples: { id: string; date: string; biomassKgHa: number; ndvi: number | null; notes: string | null }[];
}

export interface FieldHealth {
  fieldId: string;
  landUse: string;
  areaHa: number;
  crop: { cropKey: string; cropName: I18nName; status: string; sowingDate: string | null } | null;
  latest: VegetationReading | null;
  previousMean: number | null;
  series: VegetationPoint[];
  events: { type: SatelliteEventType; date: string }[];
  checks: { kind: WorkCheckKind; date: string }[];
  lastSceneDate: string | null;
  pasture: PastureEstimate | null;
}

export interface LatestReading extends VegetationReading {
  fieldId: string;
}

export interface SatelliteRefresh {
  scenes: number;
  readings: number;
  pending: number;
  unavailable: boolean;
}

export type AdviceGap = 'crop_unknown' | 'no_sowing_date' | 'not_sown_yet' | 'season_over' | 'flooded' | 'no_soil_texture' | 'no_weather';

export interface WaterAdvice {
  fieldId: string;
  number: string;
  areaHa: number;
  cropKey: string;
  cropName: I18nName;
  sowingDate: string | null;
  stage: 'initial' | 'development' | 'mid' | 'late' | null;
  kc: number | null;
  et0TodayMm: number | null;
  etcLast7Mm: number | null;
  etcNext7Mm: number | null;
  soilTexture: string | null;
  tawMm: number | null;
  rawMm: number | null;
  depletionMm: number | null;
  rawUsedPct: number | null;
  dueDate: string | null;
  refillM3: number | null;
  efficiency: number;
  lastIrrigation: { date: string; m3: number | null } | null;
  gap: AdviceGap | null;
}
