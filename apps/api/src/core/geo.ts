import { sql } from 'drizzle-orm';
import type { GeoJsonGeometry } from '../db/schema';
import { tx } from './context';
import { badRequest } from './errors';

/** Geodesic area in hectares, computed by PostGIS. This is the authoritative area. */
export async function computeAreaHa(boundary: GeoJsonGeometry): Promise<number> {
  try {
    const result = await tx().execute(
      sql`select ST_Area(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(boundary)}), 4326)::geography) / 10000 as ha`,
    );
    return Number(result.rows[0].ha);
  } catch {
    throw badRequest('INVALID_GEOMETRY', 'The drawn shape is not a valid area');
  }
}
