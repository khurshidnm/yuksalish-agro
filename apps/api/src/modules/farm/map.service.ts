import { and, asc, eq } from 'drizzle-orm';
import { ctx, tx } from '../../core/context';
import { schema } from '../../db/client';
import { currentPlans } from './fields.service';

const { facilities, farms, fields } = schema;

/** Everything drawn on the farm, as one GeoJSON FeatureCollection. */
export async function farmMap() {
  const farmId = ctx().farmId;
  const [farm] = await tx()
    .select({ lat: farms.lat, lng: farms.lng, totalAreaHa: farms.totalAreaHa })
    .from(farms)
    .where(eq(farms.id, farmId));

  const fieldRows = await tx()
    .select()
    .from(fields)
    .where(and(eq(fields.farmId, farmId), eq(fields.status, 'active')))
    .orderBy(asc(fields.number));
  const facilityRows = await tx()
    .select()
    .from(facilities)
    .where(and(eq(facilities.farmId, farmId), eq(facilities.status, 'active')))
    .orderBy(asc(facilities.name));

  const plans = await currentPlans(fieldRows.map((f) => f.id));

  const fieldFeatures = fieldRows.flatMap((f) => {
    if (!f.boundary) return [];
    const plan = plans.get(f.id);
    return [
      {
        type: 'Feature' as const,
        id: f.id,
        geometry: f.boundary,
        properties: {
          kind: 'field' as const,
          id: f.id,
          number: f.number,
          name: f.name,
          landUse: f.landUse,
          areaHa: f.areaHa,
          cropKey: plan?.cropKey ?? null,
          cropName: plan?.cropName ?? null,
          cropStatus: plan?.status ?? null,
        },
      },
    ];
  });

  const facilityFeatures = facilityRows.flatMap((f) => {
    const geometry = f.boundary ?? (f.lat != null && f.lng != null ? { type: 'Point', coordinates: [f.lng, f.lat] } : null);
    if (!geometry) return [];
    return [
      {
        type: 'Feature' as const,
        id: f.id,
        geometry,
        properties: {
          kind: 'facility' as const,
          id: f.id,
          name: f.name,
          facilityType: f.type,
          capacity: f.capacity,
          capacityUnit: f.capacityUnit,
          areaHa: f.areaHa,
          parentId: f.parentId,
        },
      },
    ];
  });

  return {
    type: 'FeatureCollection' as const,
    center: farm?.lat != null && farm?.lng != null ? { lat: farm.lat, lng: farm.lng } : null,
    features: [...fieldFeatures, ...facilityFeatures],
    /** Contours that exist but have not been drawn yet. */
    unmappedFields: fieldRows
      .filter((f) => !f.boundary)
      .map((f) => ({ id: f.id, number: f.number, name: f.name, areaHa: f.areaHa, landUse: f.landUse })),
  };
}
