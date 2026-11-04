import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ANIMAL_ON_FARM_STATUSES, FACILITY_TYPES } from '@yap/shared';
import { capacityUsePercent } from '@yap/shared/formulas/land';
import { ctx, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { schema } from '../../db/client';
import { facilityGeometry, measureIfArea } from './geometry';

const { animals, facilities: t, herds } = schema;

export const facilityInput = z.object({
  id: clientId,
  type: z.enum(FACILITY_TYPES),
  name: z.string().trim().min(1).max(120),
  capacity: z.number().int().min(0).max(10_000_000).nullish(),
  capacityUnit: z.string().trim().max(20).nullish(),
  parentId: z.uuid().nullish(),
  boundary: facilityGeometry.nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});
export type FacilityInput = z.infer<typeof facilityInput>;

export const facilityListQuery = listQuery.extend({
  type: z.enum(FACILITY_TYPES).optional(),
  status: z.enum(['active', 'archived']).default('active'),
});

type Facility = typeof t.$inferSelect;

function assertPoint(lat: number | null | undefined, lng: number | null | undefined): void {
  if ((lat == null) !== (lng == null)) {
    throw badRequest('COORDINATES_INCOMPLETE', 'Enter both latitude and longitude');
  }
}

/** A section sits directly under a barn; deeper nesting would make occupancy ambiguous. */
async function assertParent(parentId: string | null | undefined, selfId?: string): Promise<void> {
  if (!parentId) return;
  if (parentId === selfId) throw badRequest('INVALID_PARENT', 'A facility cannot contain itself');
  const [parent] = await tx()
    .select({ id: t.id, parentId: t.parentId })
    .from(t)
    .where(and(eq(t.id, parentId), eq(t.farmId, ctx().farmId)));
  if (!parent) throw badRequest('INVALID_PARENT', 'The parent facility was not found');
  if (parent.parentId) throw badRequest('INVALID_PARENT', 'A section cannot contain other sections');
}

/** Animals on the farm per facility. An animal's own location wins over its herd's. */
async function headByFacility(): Promise<Map<string, number>> {
  const rows = await tx()
    .select({
      facilityId: sql<string | null>`coalesce(${animals.facilityId}, ${herds.facilityId})`,
      head: count(),
    })
    .from(animals)
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .where(and(eq(animals.farmId, ctx().farmId), inArray(animals.status, [...ANIMAL_ON_FARM_STATUSES])))
    .groupBy(sql`1`);
  return new Map(rows.filter((r) => r.facilityId).map((r) => [r.facilityId!, r.head]));
}

async function withOccupancy<T extends { id: string; capacity: number | null; parentId: string | null }>(rows: T[]) {
  const head = await headByFacility();
  const sections = await tx()
    .select({ id: t.id, parentId: t.parentId })
    .from(t)
    .where(and(eq(t.farmId, ctx().farmId), sql`${t.parentId} is not null`));
  const totalHead = (id: string) =>
    (head.get(id) ?? 0) +
    sections.filter((s) => s.parentId === id).reduce((sum, s) => sum + (head.get(s.id) ?? 0), 0);
  return rows.map((row) => {
    const occupied = totalHead(row.id);
    return { ...row, occupiedHead: occupied, capacityUsePercent: capacityUsePercent(occupied, row.capacity) };
  });
}

export async function listFacilities(q: z.infer<typeof facilityListQuery>) {
  const where = and(
    eq(t.farmId, ctx().farmId),
    eq(t.status, q.status),
    q.type ? eq(t.type, q.type) : undefined,
    searchAny(q.search, [t.name, t.notes]),
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select()
      .from(t)
      .where(where)
      .orderBy(...sortBy(q.sort, { name: t.name, type: t.type, capacity: t.capacity }, [asc(t.type), asc(t.name)], t.id))
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: await withOccupancy(page.data) };
}

export async function lookupFacilities(q: { search?: string; type?: (typeof FACILITY_TYPES)[number] }) {
  return tx()
    .select({ id: t.id, name: t.name, type: t.type, parentId: t.parentId })
    .from(t)
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        eq(t.status, 'active'),
        q.type ? eq(t.type, q.type) : undefined,
        searchAny(q.search, [t.name]),
      ),
    )
    .orderBy(asc(t.name))
    .limit(50);
}

export async function getFacility(id: string): Promise<Facility> {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Facility');
  return row;
}

export async function getFacilityCard(id: string) {
  const [row] = await withOccupancy([await getFacility(id)]);
  const sections = await tx()
    .select()
    .from(t)
    .where(and(eq(t.parentId, id), eq(t.status, 'active')))
    .orderBy(asc(t.name));
  return { ...row, sections: await withOccupancy(sections) };
}

export async function createFacility(input: FacilityInput): Promise<Facility> {
  assertPoint(input.lat, input.lng);
  await assertParent(input.parentId);
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({
      ...(id ? { id } : {}),
      ...values,
      areaHa: await measureIfArea(input.boundary),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
    })
    .returning();
  await recordEvent({ type: 'facility.created', entityType: 'facility', entityId: row.id, data: { name: row.name, type: row.type } });
  return row;
}

export async function updateFacility(id: string, input: Partial<FacilityInput>): Promise<Facility> {
  const current = await getFacility(id);
  assertPoint(input.lat === undefined ? current.lat : input.lat, input.lng === undefined ? current.lng : input.lng);
  await assertParent(input.parentId, id);
  const { id: _ignored, ...values } = input;
  const patch: Partial<typeof t.$inferInsert> = { ...values };
  if (input.boundary !== undefined) patch.areaHa = await measureIfArea(input.boundary);
  const [row] = await tx().update(t).set(patch).where(eq(t.id, id)).returning();
  await recordEvent({ type: 'facility.updated', entityType: 'facility', entityId: id, data: { name: row.name } });
  return row;
}

/** Archived, not deleted: herds, warehouses and cameras keep pointing at facilities. */
export async function archiveFacility(id: string): Promise<{ id: string }> {
  const facility = await getFacility(id);
  const [{ occupiedHead }] = await withOccupancy([facility]);
  if (occupiedHead > 0) {
    throw conflict('FACILITY_OCCUPIED', 'Animals are still kept here', { occupiedHead });
  }
  const [section] = await tx()
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.parentId, id), ne(t.status, 'archived')))
    .limit(1);
  if (section) throw conflict('FACILITY_HAS_SECTIONS', 'Archive the sections of this facility first');
  await tx().update(t).set({ status: 'archived' }).where(eq(t.id, id));
  await recordEvent({ type: 'facility.archived', entityType: 'facility', entityId: id, data: { name: facility.name } });
  return { id };
}
