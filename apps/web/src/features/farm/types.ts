import type { DOCUMENT_TYPES, FACILITY_TYPES, IRRIGATION_NODE_TYPES, LAND_USES } from '@yap/shared';
import type { Geometry } from 'geojson';

export type LandUse = (typeof LAND_USES)[number];
export type FacilityType = (typeof FACILITY_TYPES)[number];
export type IrrigationNodeType = (typeof IRRIGATION_NODE_TYPES)[number];
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export type I18nName = { uz: string; ru: string; en: string };

export interface CurrentCrop {
  planId: string;
  cropId: string;
  cropKey: string;
  cropName: I18nName;
  variety: string | null;
  seasonId: string;
  seasonName: string;
  isCurrentSeason: boolean;
  status: string;
  areaHa: number;
  sowingDatePlan: string | null;
  sowingDateFact: string | null;
  expectedYieldTHa: number | null;
}

export interface FieldRow {
  id: string;
  number: string;
  name: string | null;
  landUse: LandUse;
  areaHa: number;
  soilType: string | null;
  soilTexture: string | null;
  salinityLevel: string | null;
  irrigationSource: string | null;
  status: 'active' | 'archived';
  notes: string | null;
  hasBoundary: boolean;
  currentCrop: CurrentCrop | null;
  /** The newest groundwater observation. Only on list rows. */
  groundwater?: Omit<GroundwaterObservation, 'id' | 'notes'> | null;
}

export interface RotationRow {
  planId: string;
  seasonId: string;
  seasonName: string;
  startDate: string;
  cropKey: string;
  cropName: I18nName;
  variety: string | null;
  areaHa: number;
  status: string;
  expectedYieldTHa: number | null;
  harvestT: number | null;
  yieldTHa: number | null;
  costPerTon: number | null;
}

export interface SoilAnalysis {
  id: string;
  date: string;
  n: number | null;
  p: number | null;
  k: number | null;
  ph: number | null;
  humus: number | null;
  salinity: number | null;
  lab: string | null;
  fileId: string | null;
  notes: string | null;
}

export type GroundwaterRisk = 'shallow' | 'within_critical_range';

export interface GroundwaterObservation {
  id: string;
  date: string;
  depthM: number;
  mineralisationGl: number | null;
  notes: string | null;
  /** The depth against the published critical range. Mineralisation is never judged. */
  risk: GroundwaterRisk | null;
}

export type FertiliserNutrient = 'n' | 'p2o5' | 'k2o';

export interface NutrientAdvice {
  removalPerT: number | null;
  uptakeKgHa: number | null;
  soilMgKg: number | null;
  soilStockKgHa: number | null;
  soilUse: number | null;
  soilSupplyKgHa: number | null;
  fertiliserUse: number | null;
  rateKgHa: number | null;
  reason: 'no_yield' | 'no_removal' | 'no_soil_value' | 'nitrate_not_supported' | 'fixes_nitrogen' | 'no_soil_coefficient' | null;
}

export interface FieldFertiliser {
  planId: string;
  cropId: string;
  cropKey: string;
  family: string | null;
  targetYieldTHa: number | null;
  removalSource: 'farm' | 'typical' | null;
  analysis: { id: string; date: string; stale: boolean } | null;
  nutrients: Record<FertiliserNutrient, NutrientAdvice>;
  products: {
    products: { id: string; name: string; kgHa: number; gives: Record<FertiliserNutrient, number> }[];
    uncovered: FertiliserNutrient[];
  } | null;
  productsWithoutContent: { id: string; name: string }[];
}

export interface FieldCard extends Omit<FieldRow, 'hasBoundary' | 'groundwater'> {
  boundary: Geometry | null;
  rotation: RotationRow[];
  soilAnalyses: SoilAnalysis[];
  /** Null when the field has no current plan. */
  fertiliser: FieldFertiliser | null;
  /** Oldest first. */
  groundwater: GroundwaterObservation[];
}

/** What the field form needs, from a list row or a card. */
export type EditableField = Omit<FieldRow, 'hasBoundary' | 'currentCrop' | 'groundwater'> & { hasBoundary: boolean };

export interface Facility {
  id: string;
  type: FacilityType;
  name: string;
  capacity: number | null;
  capacityUnit: string | null;
  parentId: string | null;
  boundary: Geometry | null;
  lat: number | null;
  lng: number | null;
  areaHa: number | null;
  status: 'active' | 'archived';
  notes: string | null;
  occupiedHead: number;
  capacityUsePercent: number | null;
}

export interface IrrigationNode {
  id: string;
  type: IrrigationNodeType;
  name: string;
  capacityM3h: number | null;
  limitM3: number | null;
  fieldIds: string[];
  notes: string | null;
  period: { from: string; to: string };
  actualM3: number;
  usedPercent: number | null;
  overLimit: boolean;
}

export type ExpiryState = 'expired' | 'expiring' | 'valid';

export interface FarmDocument {
  id: string;
  type: DocumentType;
  title: string;
  number: string | null;
  fileId: string | null;
  fileName: string | null;
  fileMimeType: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  entityType: string | null;
  entityId: string | null;
  notes: string | null;
  expiryState: ExpiryState | null;
  fileUrl: string | null;
}

export interface ResponsiblePerson {
  role: string;
  fullName: string;
  phone: string | null;
}

export interface AreaBalance {
  totalAreaHa: number | null;
  assignedHa: number;
  unassignedHa: number | null;
  overAssigned: boolean;
  byLandUse: { landUse: LandUse; count: number; areaHa: number }[];
}

export interface Passport {
  id: string;
  name: string;
  region: string | null;
  district: string | null;
  address: string | null;
  totalAreaHa: number | null;
  lat: number | null;
  lng: number | null;
  cadastreNumber: string | null;
  passport: {
    landRightType?: string | null;
    leaseContractNo?: string | null;
    leaseContractDate?: string | null;
    leaseValidUntil?: string | null;
    bankName?: string | null;
    bankAccount?: string | null;
    mfo?: string | null;
    notes?: string | null;
    responsiblePersons: ResponsiblePerson[];
  };
  tenant: { name: string; legalName: string | null; tin: string | null; legalForm: string | null; taxRegime: string | null };
  areaBalance: AreaBalance;
}

export interface WeatherDay {
  date: string;
  tempMin: number | null;
  tempMax: number | null;
  precipitationMm: number | null;
  windMaxKmh: number | null;
  weatherCode: number | null;
  isForecast: boolean;
  frost: boolean | null;
}

export interface WeatherHour {
  time: string;
  periodHours: number;
  tempC: number | null;
  rhPct: number | null;
  windMs: number | null;
  precipMm: number | null;
  weatherCode: number | null;
}

export interface FieldProps {
  kind: 'field';
  id: string;
  number: string;
  name: string | null;
  landUse: LandUse;
  areaHa: number;
  cropKey: string | null;
  cropName: I18nName | null;
  cropStatus: string | null;
}

export interface FacilityProps {
  kind: 'facility';
  id: string;
  name: string;
  facilityType: FacilityType;
  capacity: number | null;
  capacityUnit: string | null;
  areaHa: number | null;
  parentId: string | null;
}

export type MapProps = FieldProps | FacilityProps;

export interface MapFeature {
  type: 'Feature';
  id: string;
  geometry: Geometry;
  properties: MapProps;
}

export interface UnmappedField {
  id: string;
  number: string;
  name: string | null;
  areaHa: number;
  landUse: LandUse;
}

export interface FarmMapData {
  type: 'FeatureCollection';
  center: { lat: number; lng: number } | null;
  features: MapFeature[];
  unmappedFields: UnmappedField[];
}
