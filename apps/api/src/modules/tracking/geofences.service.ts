/**
 * Zones a herd must stay in or keep out of (docs/tracking.md). The outline is a field's boundary
 * or a polygon drawn for the zone. The rule that reads them is in
 * packages/shared/src/formulas/tracking.ts; the health run calls it through `activeZones`.
 */
import { GEOFENCE_KINDS } from '@yap/shared';
import { areaProblem, type Zone, type ZoneKind } from '@yap/shared/formulas/tracking';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import type { GeoJsonGeometry } from '../../db/schema';
import { ctx, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId } from '../../core/query';

const { fields, geofences: g, herds } = schema;

/** Corners in one outline at most: a hand-drawn zone has a few dozen. */
const MAX_RING_POINTS = 500;

const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).rest(z.number());
const ring = z
  .array(position)
  .min(4)
  .max(MAX_RING_POINTS)
  .refine((points) => {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    return first[0] === last[0] && first[1] === last[1];
  }, 'The outline must be closed');
const zoneGeometry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1).max(20) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring).min(1).max(20)).min(1).max(20) }),
]);

export const zoneInput = z.object({
  id: clientId,
  name: z.string().trim().min(1).max(120),
  kind: z.enum(GEOFENCE_KINDS),
  /** The zone follows this field's boundary... */
  fieldId: z.uuid().nullish(),
  /** ...or has its own outline. Exactly one of the two. */
  geometry: zoneGeometry.nullish(),
  /** Null or absent: the zone binds every herd. */
  herdId: z.uuid().nullish(),
  active: z.boolean().default(true),
});
export const zonePatch = zoneInput.omit({ id: true, active: true }).partial().extend({ active: z.boolean().optional() });

type ZoneInput = z.infer<typeof zoneInput>;

const columns = {
  id: g.id,
  name: g.name,
  kind: g.kind,
  fieldId: g.fieldId,
  fieldNumber: fields.number,
  fieldName: fields.name,
  herdId: g.herdId,
  herdName: herds.name,
  active: g.active,
  ownGeometry: g.geometry,
  fieldBoundary: fields.boundary,
  createdAt: g.createdAt,
};

const select = () => tx().select(columns).from(g).leftJoin(fields, eq(fields.id, g.fieldId)).leftJoin(herds, eq(herds.id, g.herdId));

type Row = Awaited<ReturnType<typeof select>>[number];

const present = ({ ownGeometry, fieldBoundary, ...row }: Row) => ({
  ...row,
  kind: row.kind as ZoneKind,
  /** The outline the rule reads: the field's as it is drawn today, or the zone's own. */
  geometry: row.fieldId ? fieldBoundary : ownGeometry,
});

export async function list() {
  const rows = await select().where(eq(g.farmId, ctx().farmId)).orderBy(asc(g.name), asc(g.id));
  return rows.map(present);
}

export async function get(id: string) {
  const [row] = await select().where(and(eq(g.id, id), eq(g.farmId, ctx().farmId)));
  if (!row) throw notFound('Zone');
  return present(row);
}

/** The zones the health run judges positions against. */
export async function activeZones(): Promise<Zone[]> {
  const rows = await select().where(and(eq(g.farmId, ctx().farmId), eq(g.active, true)));
  return rows.map(present).map((z) => ({ id: z.id, name: z.name, kind: z.kind, herdId: z.herdId, geometry: z.geometry }));
}

/** Longitude and latitude only, to 7 decimals (about a centimetre): what a drawn corner is worth. */
function tidy(geometry: NonNullable<ZoneInput['geometry']>): GeoJsonGeometry {
  const corner = (p: number[]) => [Math.round(p[0]! * 1e7) / 1e7, Math.round(p[1]! * 1e7) / 1e7];
  const rings = (polygon: number[][][]) => polygon.map((r) => r.map(corner));
  return geometry.type === 'Polygon'
    ? { type: 'Polygon', coordinates: rings(geometry.coordinates) }
    : { type: 'MultiPolygon', coordinates: geometry.coordinates.map(rings) };
}

/** A zone has one outline: a field of this farm that has a boundary, or a polygon that does not cross itself. */
async function outlineOf(fieldId: string | null | undefined, geometry: ZoneInput['geometry']) {
  if (Boolean(fieldId) === Boolean(geometry)) {
    throw badRequest('ZONE_OUTLINE_REQUIRED', 'A zone needs one outline: either a field or a drawn shape');
  }
  if (fieldId) {
    const [field] = await tx()
      .select({ id: fields.id, boundary: fields.boundary })
      .from(fields)
      .where(and(eq(fields.id, fieldId), eq(fields.farmId, ctx().farmId)));
    if (!field) throw notFound('Field');
    if (areaProblem(field.boundary) !== null) {
      throw badRequest('ZONE_FIELD_NO_BOUNDARY', 'This field has no boundary on the map yet, so it cannot be a zone');
    }
    return { fieldId, geometry: null };
  }
  const drawn = tidy(geometry!);
  const problem = areaProblem(drawn);
  if (problem) throw badRequest('INVALID_GEOMETRY', 'The drawn shape is not a valid area', { problem });
  return { fieldId: null, geometry: drawn };
}

async function assertHerd(herdId: string | null | undefined) {
  if (!herdId) return;
  const [herd] = await tx().select({ id: herds.id }).from(herds).where(and(eq(herds.id, herdId), eq(herds.farmId, ctx().farmId)));
  if (!herd) throw notFound('Herd');
}

export async function create(input: ZoneInput) {
  const c = ctx();
  const outline = await outlineOf(input.fieldId, input.geometry);
  await assertHerd(input.herdId);
  const [row] = await tx()
    .insert(g)
    .values({
      id: input.id,
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      name: input.name,
      kind: input.kind,
      herdId: input.herdId ?? null,
      active: input.active,
      ...outline,
    })
    .returning({ id: g.id });
  await recordEvent({
    type: 'tracking.zone_created',
    entityType: 'geofence',
    entityId: row!.id,
    data: { name: input.name, kind: input.kind, herdId: input.herdId ?? null, fieldId: outline.fieldId },
  });
  return get(row!.id);
}

export async function update(id: string, patch: z.infer<typeof zonePatch>) {
  const before = await get(id);
  // A new outline replaces the old one whole: a field in place of a drawing, or the other way round.
  const outline = patch.fieldId !== undefined || patch.geometry !== undefined ? await outlineOf(patch.fieldId, patch.geometry) : {};
  await assertHerd(patch.herdId);
  await tx()
    .update(g)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.herdId !== undefined ? { herdId: patch.herdId } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...outline,
      updatedAt: new Date(),
    })
    .where(and(eq(g.id, id), eq(g.farmId, ctx().farmId)));
  const after = await get(id);
  const switched = patch.active !== undefined && patch.active !== before.active;
  await recordEvent({
    type: switched ? (after.active ? 'tracking.zone_switched_on' : 'tracking.zone_switched_off') : 'tracking.zone_updated',
    entityType: 'geofence',
    entityId: id,
    data: { name: after.name, kind: after.kind, herdId: after.herdId, fieldId: after.fieldId, active: after.active },
  });
  return after;
}

export async function remove(id: string) {
  const zone = await get(id);
  await tx().delete(g).where(and(eq(g.id, id), eq(g.farmId, ctx().farmId)));
  await recordEvent({ type: 'tracking.zone_removed', entityType: 'geofence', entityId: id, data: { name: zone.name, kind: zone.kind } });
  return { id };
}
