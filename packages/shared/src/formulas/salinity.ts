/**
 * Salinity: how much water a leaching takes, and when shallow groundwater deserves a warning.
 * Both are shown as a suggestion beside what the farm records, never as an order.
 */
import type { SALINITY_LEVELS, SOIL_TEXTURE_CLASSES } from '../enums';

export type SalinityLevel = (typeof SALINITY_LEVELS)[number];
type SoilTexture = (typeof SOIL_TEXTURE_CLASSES)[number];

/** How the source groups soils by mechanical composition. */
export type TextureGroup = 'light' | 'medium' | 'heavy';

/**
 * FAO texture classes filed under the source's three groups. The source speaks of light, medium and
 * heavy soils without naming FAO classes, so this filing is ours: sands and sandy loams are light,
 * loams and silts medium, clay loams and clays heavy.
 */
export const TEXTURE_GROUP: Readonly<Record<SoilTexture, TextureGroup>> = {
  sand: 'light',
  loamy_sand: 'light',
  sandy_loam: 'light',
  loam: 'medium',
  silt_loam: 'medium',
  silt: 'medium',
  silty_clay_loam: 'heavy',
  silty_clay: 'heavy',
  clay: 'heavy',
};

type Range = readonly [min: number, max: number];

/**
 * Operational leaching norms, m³/ha, by salinity and soil group.
 * Source: Хамидов М.Х., Бегматов И.А., Маматалиев А.Б. «Технологии промывки засолённых земель: Учебник»,
 * Ташкент, НИУ «ТИИИМСХ», 2023, table 28. Heavy, strongly saline soil has no entry there: it needs
 * capital leaching with drainage and larger norms, which is an engineer's project, not a field job.
 */
export const LEACHING_NORM_M3_HA: Readonly<Record<Exclude<SalinityLevel, 'none'>, Readonly<Record<TextureGroup, Range | null>>>> = {
  low: { light: [1500, 2000], medium: [2000, 2500], heavy: [2000, 2500] },
  medium: { light: [2500, 3000], medium: [3000, 4000], heavy: [3500, 4500] },
  high: { light: [4000, 5000], medium: [5000, 6000], heavy: null },
};

/** The textbook the leaching norms come from, as the screen names it. */
export const LEACHING_SOURCE = 'Хамидов М.Х., Бегматов И.А., Маматалиев А.Б. «Технологии промывки засолённых земель», ТИИИМСХ, 2023';

export interface LeachingNorm {
  minM3Ha: number;
  maxM3Ha: number;
  /** The soil group the norm is for; null when the field's texture is unknown and the range spans all groups. */
  group: TextureGroup | null;
}

export type LeachingAdvice =
  | { norm: LeachingNorm; reason: null }
  | { norm: null; reason: 'not_saline' | 'level_unknown' | 'capital_leaching' };

/**
 * Suggested leaching norm for a field. Without a texture the answer is the whole span of the
 * published groups for that level, so nothing is assumed about the soil.
 */
export function leachingNorm(level: string | null | undefined, texture: string | null | undefined): LeachingAdvice {
  if (level === 'none') return { norm: null, reason: 'not_saline' };
  if (level !== 'low' && level !== 'medium' && level !== 'high') return { norm: null, reason: 'level_unknown' };
  const row = LEACHING_NORM_M3_HA[level];
  const group = texture && Object.hasOwn(TEXTURE_GROUP, texture) ? TEXTURE_GROUP[texture as SoilTexture] : null;
  if (group) {
    const range = row[group];
    return range ? { norm: { minM3Ha: range[0], maxM3Ha: range[1], group }, reason: null } : { norm: null, reason: 'capital_leaching' };
  }
  const ranges = Object.values(row).filter((r): r is Range => r !== null);
  return {
    norm: { minM3Ha: Math.min(...ranges.map((r) => r[0])), maxM3Ha: Math.max(...ranges.map((r) => r[1])), group: null },
    reason: null,
  };
}

/**
 * Critical depth of the water table. Source: FAO Soils Bulletin 39, «Salt-affected soils and their
 * management» (Abrol, Yadav, Massoud, 1988), chapter 3: "In general, the critical depth of water
 * table ranges between 1.5 to 3.0 metres depending on soil characteristics, root zone of crops, salt
 * content of groundwater, etc". Above the range salts rise into the root zone on almost any soil;
 * inside it they may. Uzbek monitoring practice no longer uses one critical depth, and no numeric
 * rule joining depth and mineralisation was found, so mineralisation is shown as measured, unjudged.
 */
export const GROUNDWATER_CRITICAL_DEPTH_M = { min: 1.5, max: 3.0 } as const;
export const GROUNDWATER_SOURCE = 'FAO Soils Bulletin 39 (1988)';

export type GroundwaterRisk = 'shallow' | 'within_critical_range';

/** Null for water deeper than the critical range, and for a missing depth. */
export function groundwaterRisk(depthM: number | null | undefined): GroundwaterRisk | null {
  if (depthM == null || !Number.isFinite(depthM) || depthM < 0) return null;
  if (depthM < GROUNDWATER_CRITICAL_DEPTH_M.min) return 'shallow';
  if (depthM <= GROUNDWATER_CRITICAL_DEPTH_M.max) return 'within_critical_range';
  return null;
}
