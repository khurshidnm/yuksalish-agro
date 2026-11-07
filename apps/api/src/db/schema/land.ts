import { doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, boolean } from 'drizzle-orm/pg-core';
import { dec, day, money, pk, qty, ts } from './_helpers';
import { tenantColumns, tenantOnlyColumns } from './_tenant';
import { crops, files } from './core';
import { assets } from './assets';
import { employees } from './hr';
import { items, stockBatches, warehouses } from './inventory';

export type GeoJsonGeometry = { type: string; coordinates: unknown };

/**
 * Land contour. Arable fields are the cost centers; pasture, reserve, yard and infrastructure
 * are contours too, so the farm's 210 ha add up (spec 6.2).
 *
 * `boundary` holds GeoJSON. The PostGIS `geom` column is derived from it in post-schema.sql.
 * `areaHa` is computed server-side by PostGIS via core/geo.ts when a boundary is saved.
 */
export const fields = pgTable(
  'fields',
  {
    id: pk(),
    ...tenantColumns(),
    number: text().notNull(),
    name: text(),
    landUse: text().notNull().default('arable'),
    areaHa: dec(12, 4).notNull().default(0),
    boundary: jsonb().$type<GeoJsonGeometry>(),
    soilType: text(),
    /** FAO texture class (SOIL_TEXTURES), which sets how much water the soil holds. */
    soilTexture: text(),
    salinityLevel: text(),
    irrigationSource: text(),
    costCenterId: uuid(),
    status: text().notNull().default('active'),
    notes: text(),
  },
  (t) => [unique().on(t.farmId, t.number), index().on(t.tenantId)],
);

export const facilities = pgTable(
  'facilities',
  {
    id: pk(),
    ...tenantColumns(),
    type: text().notNull(),
    name: text().notNull(),
    capacity: integer(),
    capacityUnit: text(),
    /** Barn sections point at their barn. */
    parentId: uuid(),
    boundary: jsonb().$type<GeoJsonGeometry>(),
    lat: doublePrecision(),
    lng: doublePrecision(),
    areaHa: dec(12, 4),
    status: text().notNull().default('active'),
    notes: text(),
  },
  (t) => [index().on(t.farmId, t.type)],
);

export const irrigationNodes = pgTable('irrigation_nodes', {
  id: pk(),
  ...tenantColumns(),
  type: text().notNull(),
  name: text().notNull(),
  capacityM3h: dec(12, 2),
  limitM3: dec(16, 2),
  geometry: jsonb().$type<GeoJsonGeometry>(),
  fieldIds: jsonb().$type<string[]>().notNull().default([]),
  notes: text(),
});

export const seasons = pgTable(
  'seasons',
  {
    id: pk(),
    ...tenantColumns(),
    name: text().notNull(),
    kind: text().notNull(),
    startDate: day().notNull(),
    endDate: day().notNull(),
    isCurrent: boolean().notNull().default(false),
  },
  (t) => [index().on(t.farmId)],
);

export const cropPlans = pgTable(
  'crop_plans',
  {
    id: pk(),
    ...tenantColumns(),
    seasonId: uuid().notNull().references(() => seasons.id),
    fieldId: uuid().notNull().references(() => fields.id),
    cropId: uuid().notNull().references(() => crops.id),
    /** Tech card the estimate came from; planned operations are generated from it. */
    techCardId: uuid(),
    variety: text(),
    areaHa: dec(12, 4).notNull(),
    sowingDatePlan: day(),
    sowingDateFact: day(),
    seedRateKgHa: dec(10, 2),
    expectedYieldTHa: dec(10, 3),
    plannedCost: money(),
    /** Share of the harvest kept for own livestock, percent (spec 7.1). */
    ownUsePct: dec(5, 2).notNull().default(0),
    status: text().notNull().default('planned'),
    notes: text(),
  },
  (t) => [unique().on(t.seasonId, t.fieldId, t.cropId), index().on(t.fieldId)],
);

/** Texnologik karta: ordered operations with norms for one crop (spec 7.1). */
export const techCards = pgTable('tech_cards', {
  id: pk(),
  ...tenantOnlyColumns(),
  cropId: uuid().notNull().references(() => crops.id),
  name: text().notNull(),
  lines: jsonb()
    .$type<
      {
        type: string;
        name: string;
        offsetDays: number;
        seedKgHa?: number;
        fertilizerKgHa?: number;
        waterM3Ha?: number;
        laborDaysHa?: number;
        costPerHa?: number;
      }[]
    >()
    .notNull()
    .default([]),
  expectedYieldTHa: dec(10, 3),
});

export const fieldOperations = pgTable(
  'field_operations',
  {
    id: pk(),
    ...tenantColumns(),
    type: text().notNull(),
    /** 'planned' operations with a past date are overdue. */
    status: text().notNull().default('done'),
    date: day().notNull(),
    /** Date the work was planned for; compared with `date` for the on-time KPI (spec 14.3). */
    plannedDate: day(),
    fieldId: uuid().notNull().references(() => fields.id),
    cropPlanId: uuid().references(() => cropPlans.id),
    assetId: uuid().references(() => assets.id),
    employeeId: uuid().references(() => employees.id),
    areaDoneHa: dec(12, 4),
    waterM3: dec(14, 2),
    durationH: dec(8, 2),
    fuelL: dec(12, 2),
    /** Type-specific data: method, condition, pests, dose, withdrawal days... */
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    lat: doublePrecision(),
    lng: doublePrecision(),
    photoFileIds: jsonb().$type<string[]>().notNull().default([]),
    /** Weather snapshot attached automatically (spec 7.3). */
    weather: jsonb().$type<Record<string, unknown>>(),
    notes: text(),
  },
  (t) => [index().on(t.farmId, t.date), index().on(t.fieldId, t.date)],
);

export const fieldOperationMaterials = pgTable(
  'field_operation_materials',
  {
    id: pk(),
    ...tenantColumns(),
    operationId: uuid().notNull().references(() => fieldOperations.id, { onDelete: 'cascade' }),
    itemId: uuid().notNull().references(() => items.id),
    warehouseId: uuid().notNull().references(() => warehouses.id),
    qty: qty().notNull(),
    normPerHa: dec(12, 3),
    totalCost: money().notNull().default(0),
  },
  (t) => [index().on(t.operationId)],
);

export const harvests = pgTable(
  'harvests',
  {
    id: pk(),
    ...tenantColumns(),
    fieldId: uuid().notNull().references(() => fields.id),
    cropPlanId: uuid().references(() => cropPlans.id),
    date: day().notNull(),
    grossT: qty().notNull(),
    moisturePct: dec(5, 2),
    quality: text(),
    assetId: uuid().references(() => assets.id),
    itemId: uuid().references(() => items.id),
    warehouseId: uuid().references(() => warehouses.id),
    batchId: uuid().references(() => stockBatches.id),
    notes: text(),
  },
  (t) => [index().on(t.fieldId)],
);

export const soilAnalyses = pgTable(
  'soil_analyses',
  {
    id: pk(),
    ...tenantColumns(),
    fieldId: uuid().notNull().references(() => fields.id),
    date: day().notNull(),
    n: dec(10, 3),
    p: dec(10, 3),
    k: dec(10, 3),
    ph: dec(4, 2),
    humus: dec(6, 3),
    salinity: dec(8, 3),
    lab: text(),
    fileId: uuid().references(() => files.id),
    notes: text(),
  },
  (t) => [index().on(t.fieldId, t.date)],
);

export const weatherDaily = pgTable(
  'weather_daily',
  {
    id: pk(),
    ...tenantColumns(),
    date: day().notNull(),
    tempMin: dec(5, 2),
    tempMax: dec(5, 2),
    precipitationMm: dec(7, 2),
    windMaxKmh: dec(6, 2),
    weatherCode: integer(),
    /** Daily means for crop water use (FAO-56). */
    rhMeanPct: dec(5, 2),
    dewPointC: dec(5, 2),
    /** Mean wind at 2 m above ground. */
    windMeanMs: dec(5, 2),
    /** Measured solar radiation. Forecasts have none; water use then estimates it from the temperature range. */
    solarMj: dec(6, 2),
    isForecast: boolean().notNull().default(false),
    source: text().notNull().default('met-norway'),
    fetchedAt: ts().notNull().defaultNow(),
  },
  (t) => [unique().on(t.farmId, t.date)],
);

/**
 * Forecast points for hour-level advice: spraying windows, heat stress, night frost. MET Norway
 * gives hourly points for about 2.5 days and 6-hourly points after that; `periodHours` says which.
 */
export const weatherHourly = pgTable(
  'weather_hourly',
  {
    id: pk(),
    ...tenantColumns(),
    time: ts().notNull(),
    periodHours: integer().notNull().default(1),
    tempC: dec(5, 2),
    rhPct: dec(5, 2),
    /** Wind at 10 m, as forecast. */
    windMs: dec(5, 2),
    precipMm: dec(7, 2),
    weatherCode: integer(),
    fetchedAt: ts().notNull().defaultNow(),
  },
  (t) => [unique().on(t.farmId, t.time)],
);

/** A Sentinel-2 scene that was read for the farm, clear or not, so it is not read twice. */
export const satelliteScenes = pgTable(
  'satellite_scenes',
  {
    id: pk(),
    ...tenantColumns(),
    sceneId: text().notNull(),
    date: day().notNull(),
    source: text().notNull().default('sentinel-2'),
    /** Cloud cover of the whole 110 km tile, as published. */
    tileCloudPct: dec(5, 2),
    /** Share of the farm's field cells that were clear. */
    clearPct: dec(5, 2),
    status: text().notNull().default('done'),
  },
  (t) => [unique().on(t.farmId, t.sceneId), index().on(t.farmId, t.date)],
);

export interface VegetationGrid {
  /** Bounds in degrees; the grid is north-up in latitude and longitude. */
  west: number;
  south: number;
  east: number;
  north: number;
  width: number;
  height: number;
  /** Base64 bytes, row 0 north: NDVI as round((ndvi + 1) × 100), 255 where unknown. */
  data: string;
}

export interface WeakZoneRecord {
  areaHa: number;
  meanNdvi: number;
  /** Centre of the zone, for walking to it. */
  lat: number;
  lng: number;
}

/** Crop health of one field in one clear scene. */
export const fieldVegetation = pgTable(
  'field_vegetation',
  {
    id: pk(),
    ...tenantColumns(),
    fieldId: uuid().notNull().references(() => fields.id),
    sceneId: uuid().notNull().references(() => satelliteScenes.id),
    date: day().notNull(),
    clearPct: dec(5, 2).notNull(),
    cellCount: integer().notNull(),
    ndviMean: dec(5, 3),
    ndviP10: dec(5, 3),
    ndviP50: dec(5, 3),
    ndviP90: dec(5, 3),
    grid: jsonb().$type<VegetationGrid>(),
    weakZones: jsonb().$type<WeakZoneRecord[]>().notNull().default([]),
  },
  (t) => [unique().on(t.fieldId, t.sceneId), index().on(t.fieldId, t.date)],
);

/** Cut-and-weigh samples that calibrate pasture biomass against NDVI. */
export const pastureSamples = pgTable(
  'pasture_samples',
  {
    id: pk(),
    ...tenantColumns(),
    fieldId: uuid().notNull().references(() => fields.id),
    date: day().notNull(),
    biomassKgHa: dec(10, 1).notNull(),
    /** NDVI of the field from the nearest clear scene within a week, stored when the sample is saved. */
    ndvi: dec(5, 3),
    notes: text(),
  },
  (t) => [index().on(t.fieldId, t.date)],
);
