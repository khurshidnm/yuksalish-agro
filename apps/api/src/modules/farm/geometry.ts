import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { round } from '@yap/shared';
import { tx } from '../../core/context';
import { badRequest } from '../../core/errors';
import { computeAreaHa } from '../../core/geo';
import type { GeoJsonGeometry } from '../../db/schema';

const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).rest(z.number());

const ring = z
  .array(position)
  .min(4)
  .refine((points) => {
    const first = points[0];
    const last = points[points.length - 1];
    return first[0] === last[0] && first[1] === last[1];
  }, 'The outline must be closed');

const point = z.object({ type: z.literal('Point'), coordinates: position });
const lineString = z.object({ type: z.literal('LineString'), coordinates: z.array(position).min(2) });
const polygon = z.object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1) });
const multiPolygon = z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring).min(1)).min(1) });

/** An outline with an area: fields and buildings. */
export const areaGeometry = z.discriminatedUnion('type', [polygon, multiPolygon]);
/** A facility can also be a line, such as a road or a fence. */
export const facilityGeometry = z.discriminatedUnion('type', [lineString, polygon, multiPolygon]);
/** Irrigation network elements: canal lines, pump points. */
export const networkGeometry = z.discriminatedUnion('type', [point, lineString, polygon, multiPolygon]);

const hasArea = (g: { type: string }) => g.type === 'Polygon' || g.type === 'MultiPolygon';

/**
 * Validate an outline and measure it with PostGIS. A self-crossing outline would otherwise
 * produce a plausible-looking but wrong area, so it is refused rather than measured.
 */
export async function measureBoundary(boundary: GeoJsonGeometry): Promise<number> {
  const invalid = () => badRequest('INVALID_GEOMETRY', 'The drawn shape is not a valid area');
  let valid: unknown;
  try {
    const result = await tx().execute(
      sql`select ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(boundary)}), 4326)) as valid`,
    );
    valid = result.rows[0].valid;
  } catch {
    throw invalid();
  }
  if (!valid) throw invalid();
  const ha = round(await computeAreaHa(boundary), 4);
  if (!(ha > 0)) throw invalid();
  return ha;
}

/** Area of a facility outline; null when it is a line or there is no outline. */
export async function measureIfArea(boundary: GeoJsonGeometry | null | undefined): Promise<number | null> {
  return boundary && hasArea(boundary) ? measureBoundary(boundary) : null;
}
