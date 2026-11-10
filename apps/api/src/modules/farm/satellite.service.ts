/**
 * Crop health from Sentinel-2 (ESA Copernicus), found through Element 84's Earth Search catalogue on
 * AWS. The data is free, needs no account, and may be used in a paid product with the credit
 * "Contains modified Copernicus Sentinel data". Only the image tiles over the farm are read, by HTTP
 * range requests: a scene costs a few megabytes and some seconds, which suits a small server.
 *
 * Each clear scene gives every field a 10 m NDVI grid, its spread, and the weak zones a person
 * should walk to. A field more than a fifth under cloud is left out of that scene rather than
 * reported from its clear part (spec 15.2: do not guess).
 *
 * The same scene also gives a moisture index, NDMI = (B8A − B11) / (B8A + B11), from the two 20 m
 * bands: one mean per field, over the same clear cells. Scenes read before it was added keep null.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { fromUrl } from 'geotiff';
import proj4 from 'proj4';
import { z } from 'zod';
import { addDays, round, todayIso } from '@yap/shared';
import {
  cellsInsidePolygon,
  erodeMask,
  ndmi,
  ndvi,
  ndviStats,
  reflectance,
  sclIsClear,
  weakZoneThreshold,
  weakZones,
} from '@yap/shared/formulas/vegetation';
import { ctx, tx, withTenant, type Identity } from '../../core/context';
import { safeError } from '../../core/errors';
import { schema } from '../../db/client';
import type { VegetationGrid, WeakZoneRecord } from '../../db/schema/land';

const { fields, satelliteScenes: scenes, fieldVegetation: veg } = schema;

export const STAC_SEARCH_URL = 'https://earth-search.aws.element84.com/v1/search';
const COLLECTION = 'sentinel-2-l2a';
/** How far back a new farm's history reaches. */
const LOOKBACK_DAYS = 120;
/** Scenes read per run, newest first; older ones follow in later runs. */
const MAX_SCENES_PER_RUN = 6;
/** Tiles cloudier than this rarely leave a field clear, so they are not read at all. */
const MAX_TILE_CLOUD_PCT = 90;
/** A field needs this share of clear cells to count in a scene. */
export const MIN_FIELD_CLEAR_PCT = 80;
export const CELL_M = 10;
/** Weak zones smaller than this are noise at 10 m. */
export const MIN_ZONE_HA = 0.2;
const MIN_ZONE_CELLS = Math.round((MIN_ZONE_HA * 10_000) / (CELL_M * CELL_M));
/** Window margin around the fields, so a 20 m SCL pixel at the edge is still read whole. */
const MARGIN_M = 40;
/** A farm spread wider than this is read field by field instead of as one window. */
const MAX_WINDOW_M = 20_000;
const SEARCH_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 60_000;

// ─── Catalogue ───────────────────────────────────────────────────────────────

const bandSchema = z.object({
  href: z.string(),
  'raster:bands': z.array(z.object({ scale: z.number().optional(), offset: z.number().optional() })).optional(),
});
const itemSchema = z.object({
  id: z.string(),
  bbox: z.array(z.number()).length(4),
  properties: z.object({
    datetime: z.string(),
    'eo:cloud_cover': z.number().optional(),
    'proj:epsg': z.number().optional(),
    'proj:code': z.string().optional(),
  }),
  // nir08 (B8A) and swir16 (B11) are the 20 m bands of the moisture index; a scene without them still gives NDVI.
  assets: z.object({ red: bandSchema, nir: bandSchema, scl: bandSchema, nir08: bandSchema.optional(), swir16: bandSchema.optional() }),
});
const searchSchema = z.object({ features: z.array(z.unknown()) });

export interface SceneRef {
  id: string;
  date: string;
  tileCloudPct: number | null;
  epsg: number;
  bbox: [number, number, number, number];
  red: { href: string; scale: number; offset: number };
  nir: { href: string; scale: number; offset: number };
  scl: { href: string };
  /** B8A and B11, 20 m. Missing on a scene whose catalogue entry lacks them. */
  nir08?: { href: string; scale: number; offset: number };
  swir16?: { href: string; scale: number; offset: number };
}

type Bbox = [west: number, south: number, east: number, north: number];

function bandRef(band: z.infer<typeof bandSchema>) {
  const info = band['raster:bands']?.[0];
  return { href: band.href, scale: info?.scale ?? 0.0001, offset: info?.offset ?? -0.1 };
}

function epsgOf(p: z.infer<typeof itemSchema>['properties']): number | null {
  if (p['proj:epsg']) return p['proj:epsg'];
  const match = p['proj:code']?.match(/^EPSG:(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Scenes over the farm, newest first. A tile reprocessed by ESA appears twice for one date; the
 * latest processing wins. A tile that holds only part of the farm is skipped: the overlapping tile
 * next to it holds all of it.
 */
export function pickScenes(features: unknown[], farm: Bbox, timeZone: string): SceneRef[] {
  const best = new Map<string, { ref: SceneRef; version: number }>();
  for (const raw of features) {
    const parsed = itemSchema.safeParse(raw);
    if (!parsed.success) continue;
    const item = parsed.data;
    const epsg = epsgOf(item.properties);
    if (!epsg) continue;
    const [w, s, e, n] = item.bbox;
    if (w > farm[0] || s > farm[1] || e < farm[2] || n < farm[3]) continue;
    // S2B_41TPE_20261013_1_L2A: tile 41TPE, processing 1.
    const parts = item.id.split('_');
    const tile = parts[1] ?? item.id;
    const version = Number(parts[3] ?? 0) || 0;
    const date = todayIso(timeZone, new Date(item.properties.datetime));
    const key = `${date}:${tile}`;
    const ref: SceneRef = {
      id: item.id,
      date,
      tileCloudPct: item.properties['eo:cloud_cover'] ?? null,
      epsg,
      bbox: [w, s, e, n],
      red: bandRef(item.assets.red),
      nir: bandRef(item.assets.nir),
      scl: { href: item.assets.scl.href },
      ...(item.assets.nir08 && item.assets.swir16
        ? { nir08: bandRef(item.assets.nir08), swir16: bandRef(item.assets.swir16) }
        : {}),
    };
    const known = best.get(key);
    if (!known || version > known.version) best.set(key, { ref, version });
  }
  // One scene per date: two tiles holding the whole farm show the same pixels.
  const byDate = new Map<string, SceneRef>();
  for (const { ref } of best.values()) {
    const known = byDate.get(ref.date);
    if (!known || (ref.tileCloudPct ?? 100) < (known.tileCloudPct ?? 100)) byDate.set(ref.date, ref);
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

async function searchScenes(farm: Bbox, from: string, to: string, timeZone: string): Promise<SceneRef[]> {
  const [w, s, e, n] = farm;
  const response = await fetch(STAC_SEARCH_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json' },
    body: JSON.stringify({
      collections: [COLLECTION],
      intersects: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
      datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
      query: { 'eo:cloud_cover': { lt: MAX_TILE_CLOUD_PCT } },
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
      limit: 100,
    }),
  });
  if (!response.ok) throw new Error(`catalogue answered HTTP ${response.status}`);
  return pickScenes(searchSchema.parse(await response.json()).features, farm, timeZone);
}

// ─── Rasters ─────────────────────────────────────────────────────────────────

/** A north-up window of one band in the scene's UTM projection. */
export interface BandWindow {
  values: ArrayLike<number>;
  width: number;
  height: number;
  /** UTM coordinates of the window's top-left corner. */
  originX: number;
  originY: number;
  resolution: number;
}

/** Projected bounds in metres: [minX, minY, maxX, maxY]. */
type UtmBounds = [number, number, number, number];

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms);
    }),
  ]);
}

async function readCogWindow(href: string, bounds: UtmBounds): Promise<BandWindow> {
  const tiff = await fromUrl(href);
  const image = await tiff.getImage();
  const [originX, originY] = image.getOrigin();
  const [resolution] = image.getResolution();
  const x0 = Math.max(0, Math.floor((bounds[0] - originX) / resolution));
  const y0 = Math.max(0, Math.floor((originY - bounds[3]) / resolution));
  const x1 = Math.min(image.getWidth(), Math.ceil((bounds[2] - originX) / resolution));
  const y1 = Math.min(image.getHeight(), Math.ceil((originY - bounds[1]) / resolution));
  if (x1 <= x0 || y1 <= y0) throw new Error('the fields lie outside this tile');
  const values = (await image.readRasters({ window: [x0, y0, x1, y1], interleave: true })) as unknown as ArrayLike<number>;
  return {
    values,
    width: x1 - x0,
    height: y1 - y0,
    originX: originX + x0 * resolution,
    originY: originY - y0 * resolution,
    resolution,
  };
}

/** Network seams, swapped out in tests. */
export const satelliteSources = {
  search: searchScenes,
  read: (href: string, bounds: UtmBounds) => withTimeout(readCogWindow(href, bounds), READ_TIMEOUT_MS, 'reading the image'),
};

function utmProjection(epsg: number): string {
  const north = epsg >= 32601 && epsg <= 32660;
  const south = epsg >= 32701 && epsg <= 32760;
  if (!north && !south) throw new Error(`unsupported projection EPSG:${epsg}`);
  const zone = north ? epsg - 32600 : epsg - 32700;
  return `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
}

function sample(band: BandWindow, x: number, y: number): number | null {
  const col = Math.floor((x - band.originX) / band.resolution);
  const row = Math.floor((band.originY - y) / band.resolution);
  if (col < 0 || row < 0 || col >= band.width || row >= band.height) return null;
  return band.values[row * band.width + col];
}

// ─── Fields ──────────────────────────────────────────────────────────────────

type Ring = [number, number][];

export interface FieldShape {
  id: string;
  rings: Ring[];
}

function ringsOf(boundary: unknown): Ring[] {
  const g = boundary as { type?: string; coordinates?: unknown } | null;
  if (g?.type === 'Polygon') return g.coordinates as Ring[];
  if (g?.type === 'MultiPolygon') return (g.coordinates as Ring[][]).flat();
  return [];
}

function bboxOf(rings: Ring[]): Bbox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
  }
  return [w, s, e, n];
}

/** Metres per degree on the WGS84 spheroid at a latitude. */
export function metresPerDegree(latDeg: number): { lat: number; lng: number } {
  const phi = (latDeg * Math.PI) / 180;
  const a = 6_378_137;
  const e2 = 0.006_694_379_990_14;
  const s = Math.sin(phi);
  const lng = ((Math.PI / 180) * a * Math.cos(phi)) / Math.sqrt(1 - e2 * s * s);
  const lat = ((Math.PI / 180) * a * (1 - e2)) / (1 - e2 * s * s) ** 1.5;
  return { lat, lng };
}

export interface FieldReading {
  fieldId: string;
  clearPct: number;
  cellCount: number;
  stats: { mean: number; p10: number; p50: number; p90: number } | null;
  /** Mean moisture index over the counted clear cells; null when the scene has no 20 m bands. */
  ndmiMean: number | null;
  grid: VegetationGrid;
  weakZones: WeakZoneRecord[];
}

/**
 * One field's NDVI grid. The grid is north-up in degrees with 10 m cells, so the map can lay it
 * over the field as an image; each cell takes the satellite pixel under its centre.
 */
export function readField(
  field: FieldShape,
  bands: { red: BandWindow; nir: BandWindow; scl: BandWindow; nir08?: BandWindow; swir16?: BandWindow },
  scene: Pick<SceneRef, 'epsg' | 'red' | 'nir' | 'nir08' | 'swir16'>,
): FieldReading | null {
  if (field.rings.length === 0) return null;
  const [west, south, east, north] = bboxOf(field.rings);
  const m = metresPerDegree((south + north) / 2);
  const width = Math.max(1, Math.ceil(((east - west) * m.lng) / CELL_M));
  const height = Math.max(1, Math.ceil(((north - south) * m.lat) / CELL_M));
  const gridEast = west + (width * CELL_M) / m.lng;
  const gridSouth = north - (height * CELL_M) / m.lat;

  // The polygon in local metres, origin at the grid's south-west corner.
  const local = field.rings.map((ring) => ring.map(([lng, lat]) => [(lng - west) * m.lng, (lat - gridSouth) * m.lat] as [number, number]));
  const inside = cellsInsidePolygon(local, { originX: 0, originY: height * CELL_M, cellSize: CELL_M, width, height });
  const core = erodeMask(inside, width, height, 1);

  const toUtm = proj4('EPSG:4326', utmProjection(scene.epsg));
  const values: (number | null)[] = new Array(width * height).fill(null);
  const moistureBands =
    bands.nir08 && bands.swir16 && scene.nir08 && scene.swir16
      ? { nir08: bands.nir08, swir16: bands.swir16, nirRef: scene.nir08, swirRef: scene.swir16 }
      : null;
  const moisture: (number | null)[] | null = moistureBands ? new Array(width * height).fill(null) : null;
  let insideCells = 0;
  let clearCells = 0;
  for (let row = 0; row < height; row++) {
    const lat = north - ((row + 0.5) * CELL_M) / m.lat;
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      if (!inside[i]) continue;
      insideCells++;
      const lng = west + ((col + 0.5) * CELL_M) / m.lng;
      const [x, y] = toUtm.forward([lng, lat]);
      const scl = sample(bands.scl, x, y);
      if (scl === null || !sclIsClear(scl)) continue;
      const redDn = sample(bands.red, x, y);
      const nirDn = sample(bands.nir, x, y);
      const value = ndvi(
        redDn === null ? null : reflectance(redDn, scene.red.scale, scene.red.offset),
        nirDn === null ? null : reflectance(nirDn, scene.nir.scale, scene.nir.offset),
      );
      if (value === null) continue;
      clearCells++;
      values[i] = value;
      if (moistureBands && moisture) {
        const nir8aDn = sample(moistureBands.nir08, x, y);
        const swirDn = sample(moistureBands.swir16, x, y);
        moisture[i] = ndmi(
          nir8aDn === null ? null : reflectance(nir8aDn, moistureBands.nirRef.scale, moistureBands.nirRef.offset),
          swirDn === null ? null : reflectance(swirDn, moistureBands.swirRef.scale, moistureBands.swirRef.offset),
        );
      }
    }
  }
  if (insideCells === 0) return null;

  const clearPct = round((clearCells * 100) / insideCells, 2);
  // Edge cells mix the crop with roads and canals; they are drawn but not counted.
  const coreValues = values.map((v, i) => (core[i] ? v : null));
  const counted = coreValues.some((v) => v !== null) ? coreValues : values;
  const stats = ndviStats(counted);
  // The moisture mean is taken over the cells NDVI counted, so the two lines describe the same ground.
  let moistureSum = 0;
  let moistureCells = 0;
  if (moisture) {
    counted.forEach((v, i) => {
      const wet = moisture[i];
      if (v === null || wet === null || wet === undefined) return;
      moistureSum += wet;
      moistureCells++;
    });
  }
  const threshold = stats ? weakZoneThreshold(stats) : null;
  const zones =
    threshold === null
      ? []
      : weakZones({ width, height, values: counted }, { threshold, minCells: MIN_ZONE_CELLS }).map((z) => ({
          areaHa: round((z.cells * CELL_M * CELL_M) / 10_000, 2),
          meanNdvi: round(z.meanNdvi, 3),
          lat: round(north - ((z.centroidRow + 0.5) * CELL_M) / m.lat, 6),
          lng: round(west + ((z.centroidCol + 0.5) * CELL_M) / m.lng, 6),
        }));

  const bytes = Buffer.alloc(width * height, 255);
  values.forEach((v, i) => {
    if (v !== null) bytes[i] = Math.round((v + 1) * 100);
  });

  return {
    fieldId: field.id,
    clearPct,
    cellCount: insideCells,
    stats: stats && { mean: round(stats.mean, 3), p10: round(stats.p10, 3), p50: round(stats.p50, 3), p90: round(stats.p90, 3) },
    ndmiMean: moistureCells > 0 ? round(moistureSum / moistureCells, 3) : null,
    grid: { west, south: gridSouth, east: gridEast, north, width, height, data: bytes.toString('base64') },
    weakZones: zones,
  };
}

/** Projected window covering a set of rings, with a margin. */
function utmBounds(rings: Ring[], epsg: number): UtmBounds {
  const toUtm = proj4('EPSG:4326', utmProjection(epsg));
  const [w, s, e, n] = bboxOf(rings);
  const corners = [
    [w, s],
    [w, n],
    [e, s],
    [e, n],
  ].map((p) => toUtm.forward(p));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return [Math.min(...xs) - MARGIN_M, Math.min(...ys) - MARGIN_M, Math.max(...xs) + MARGIN_M, Math.max(...ys) + MARGIN_M];
}

async function readBands(scene: SceneRef, rings: Ring[]) {
  const bounds = utmBounds(rings, scene.epsg);
  // The two 20 m windows hold a quarter of the pixels of a 10 m one, so the scene stays a few megabytes.
  const [red, nir, scl, nir08, swir16] = await Promise.all([
    satelliteSources.read(scene.red.href, bounds),
    satelliteSources.read(scene.nir.href, bounds),
    satelliteSources.read(scene.scl.href, bounds),
    scene.nir08 && scene.swir16 ? satelliteSources.read(scene.nir08.href, bounds) : undefined,
    scene.nir08 && scene.swir16 ? satelliteSources.read(scene.swir16.href, bounds) : undefined,
  ]);
  return { red, nir, scl, nir08, swir16 };
}

/** Every field of the scene, reading one window for the farm or, for a spread-out farm, one per field. */
export async function readScene(scene: SceneRef, shapes: FieldShape[]): Promise<FieldReading[]> {
  const all = shapes.flatMap((f) => f.rings);
  const [x0, y0, x1, y1] = utmBounds(all, scene.epsg);
  const groups = x1 - x0 > MAX_WINDOW_M || y1 - y0 > MAX_WINDOW_M ? shapes.map((s) => [s]) : [shapes];
  const readings: FieldReading[] = [];
  for (const group of groups) {
    const bands = await readBands(scene, group.flatMap((f) => f.rings));
    for (const shape of group) {
      const reading = readField(shape, bands, scene);
      if (reading) readings.push(reading);
    }
  }
  return readings;
}

// ─── Refresh ─────────────────────────────────────────────────────────────────

async function farmShapes(): Promise<FieldShape[]> {
  const rows = await tx()
    .select({ id: fields.id, boundary: fields.boundary })
    .from(fields)
    .where(and(eq(fields.farmId, ctx().farmId), eq(fields.status, 'active'), isNotNull(fields.boundary)));
  return rows.map((r) => ({ id: r.id, rings: ringsOf(r.boundary) })).filter((s) => s.rings.length > 0);
}

async function knownSceneIds(): Promise<Set<string>> {
  const rows = await tx().select({ sceneId: scenes.sceneId }).from(scenes).where(eq(scenes.farmId, ctx().farmId));
  return new Set(rows.map((r) => r.sceneId));
}

async function storeScene(scene: SceneRef, readings: FieldReading[]): Promise<number> {
  const c = ctx();
  const inside = readings.reduce((sum, r) => sum + r.cellCount, 0);
  const clear = readings.reduce((sum, r) => sum + (r.clearPct / 100) * r.cellCount, 0);
  const [row] = await tx()
    .insert(scenes)
    .values({
      tenantId: c.tenantId,
      farmId: c.farmId,
      sceneId: scene.id,
      date: scene.date,
      tileCloudPct: scene.tileCloudPct === null ? null : round(scene.tileCloudPct, 2),
      clearPct: inside > 0 ? round((clear * 100) / inside, 2) : null,
    })
    .onConflictDoNothing({ target: [scenes.farmId, scenes.sceneId] })
    .returning({ id: scenes.id });
  if (!row) return 0;
  const usable = readings.filter((r) => r.clearPct >= MIN_FIELD_CLEAR_PCT && r.stats);
  if (usable.length === 0) return 0;
  await tx()
    .insert(veg)
    .values(
      usable.map((r) => ({
        tenantId: c.tenantId,
        farmId: c.farmId,
        fieldId: r.fieldId,
        sceneId: row.id,
        date: scene.date,
        clearPct: r.clearPct,
        cellCount: r.cellCount,
        ndviMean: r.stats!.mean,
        ndviP10: r.stats!.p10,
        ndviP50: r.stats!.p50,
        ndviP90: r.stats!.p90,
        ndmiMean: r.ndmiMean,
        grid: r.grid,
        weakZones: r.weakZones,
      })),
    );
  return usable.length;
}

export interface SatelliteRefreshResult {
  /** Scenes read in this run. */
  scenes: number;
  /** Field readings stored, cloudy fields left out. */
  readings: number;
  /** Scenes still waiting for a later run. */
  pending: number;
  unavailable: boolean;
}

/**
 * Read new scenes for the farm. Runs outside a transaction: each database step is short, and the
 * network waits in between hold no connection. A scene that fails to read is tried again next run.
 */
export async function refreshSatellite(
  identity: Identity,
  options: { maxScenes?: number } = {},
): Promise<SatelliteRefreshResult> {
  const start = await withTenant(identity, async () => {
    const c = ctx();
    return { shapes: await farmShapes(), known: await knownSceneIds(), timeZone: c.timezone, today: todayIso(c.timezone) };
  });
  if (start.shapes.length === 0) return { scenes: 0, readings: 0, pending: 0, unavailable: false };

  let found: SceneRef[];
  try {
    found = await satelliteSources.search(bboxOf(start.shapes.flatMap((s) => s.rings)), addDays(start.today, -LOOKBACK_DAYS), start.today, start.timeZone);
  } catch (err) {
    console.warn(`[satellite] catalogue unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { scenes: 0, readings: 0, pending: 0, unavailable: true };
  }
  const fresh = found.filter((s) => !start.known.has(s.id));
  const batch = fresh.slice(0, options.maxScenes ?? MAX_SCENES_PER_RUN);

  let read = 0;
  let readings = 0;
  let failed = 0;
  for (const scene of batch) {
    try {
      const result = await readScene(scene, start.shapes);
      readings += await withTenant(identity, () => storeScene(scene, result));
      read++;
    } catch (err) {
      failed++;
      console.warn(`[satellite] scene ${scene.id} not read`, err instanceof Error ? err.message : safeError(err));
    }
  }
  return { scenes: read, readings, pending: fresh.length - read, unavailable: failed > 0 && read === 0 };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export interface VegetationView {
  date: string;
  clearPct: number;
  cellCount: number;
  ndviMean: number | null;
  ndviP10: number | null;
  ndviP50: number | null;
  ndviP90: number | null;
  /** Moisture index; null on scenes read before it was added. */
  ndmiMean: number | null;
  grid: VegetationGrid | null;
  weakZones: WeakZoneRecord[];
}

export interface VegetationPoint {
  date: string;
  mean: number;
  p10: number | null;
  p90: number | null;
  /** Moisture index (NDMI); null on scenes read before it was added. */
  ndmi: number | null;
}

function toView(row: typeof veg.$inferSelect): VegetationView {
  return {
    date: row.date,
    clearPct: row.clearPct,
    cellCount: row.cellCount,
    ndviMean: row.ndviMean,
    ndviP10: row.ndviP10,
    ndviP50: row.ndviP50,
    ndviP90: row.ndviP90,
    ndmiMean: row.ndmiMean,
    grid: row.grid,
    weakZones: row.weakZones,
  };
}

/** A field's clear observations, oldest first, without the grids. */
export async function vegetationSeries(fieldId: string, from?: string): Promise<VegetationPoint[]> {
  const rows = await tx()
    .select({ date: veg.date, mean: veg.ndviMean, p10: veg.ndviP10, p90: veg.ndviP90, ndmi: veg.ndmiMean })
    .from(veg)
    .where(and(eq(veg.farmId, ctx().farmId), eq(veg.fieldId, fieldId), from ? gte(veg.date, from) : undefined, isNotNull(veg.ndviMean)))
    .orderBy(asc(veg.date));
  return rows.map((r) => ({ date: r.date, mean: r.mean!, p10: r.p10, p90: r.p90, ndmi: r.ndmi }));
}

/** One field on one date, or its latest clear reading when no date is given. */
export async function vegetationOn(fieldId: string, date?: string): Promise<VegetationView | null> {
  const [row] = await tx()
    .select()
    .from(veg)
    .where(and(eq(veg.farmId, ctx().farmId), eq(veg.fieldId, fieldId), date ? eq(veg.date, date) : undefined))
    .orderBy(desc(veg.date))
    .limit(1);
  return row ? toView(row) : null;
}

/** The latest clear reading of each field since a date, for the farm map. */
export async function latestVegetation(since: string): Promise<(VegetationView & { fieldId: string })[]> {
  const rows = await tx()
    .selectDistinctOn([veg.fieldId])
    .from(veg)
    .where(and(eq(veg.farmId, ctx().farmId), gte(veg.date, since)))
    .orderBy(veg.fieldId, desc(veg.date));
  return rows.map((row) => ({ ...toView(row), fieldId: row.fieldId }));
}

/** When the farm was last looked at, clear or not. */
export async function lastSceneDate(): Promise<string | null> {
  const [row] = await tx()
    .select({ date: sql<string | null>`max(${scenes.date})::text` })
    .from(scenes)
    .where(eq(scenes.farmId, ctx().farmId));
  return row?.date ?? null;
}

/** Readings of several fields at once, newest first per field. For the alert rules. */
export async function recentReadings(fieldIds: string[], since: string) {
  if (fieldIds.length === 0) return [];
  return tx()
    .select({ fieldId: veg.fieldId, date: veg.date, mean: veg.ndviMean, weakZones: veg.weakZones })
    .from(veg)
    .where(and(eq(veg.farmId, ctx().farmId), inArray(veg.fieldId, fieldIds), gte(veg.date, since)))
    .orderBy(veg.fieldId, desc(veg.date));
}
