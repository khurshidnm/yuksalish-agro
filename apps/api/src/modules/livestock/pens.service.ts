/**
 * Lambing pens. A barn section marked as a pen holds one ewe with her lambs for a few days after
 * lambing. Where an animal is kept stays in animals.facility_id; a pen stay adds only who went in,
 * when, when she is due out, and where she was before.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { addDays } from '@yap/shared';
import { LAMBING_DESK, penReleaseDate } from '@yap/shared/formulas/lambing';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate } from '../../core/query';
import { getFacility, updateFacility } from '../farm/facilities.service';
import { assertNotFuture, assertOnFarm, getAnimalOrThrow, isOnFarm, onFarm } from './refs';

const { animals, facilities: f, lambCare, lambingRecords: l, penStays: s } = schema;
const barn = alias(f, 'barn');

/** A ewe that lambed longer ago than this is penned on her own: her lambs are no longer newborn. */
const LAMBS_FOLLOW_DAYS = 14;

export const penStayInput = z.object({
  id: clientId,
  facilityId: z.uuid(),
  eweId: z.uuid(),
  lambingId: z.uuid().nullish(),
  sinceDate: isoDate.optional(),
  /** Planned stay in days; the starting value is LAMBING_DESK.penDays. */
  days: z.number().int().min(1).max(60).optional(),
  notes: z.string().trim().max(500).nullish(),
});
export const penReleaseInput = z.object({ date: isoDate.optional() });
export const penMarkInput = z.object({ lambingPen: z.boolean() });

/** Stays that still hold someone: not released, and the ewe is still on the farm. */
const openStay = and(isNull(s.releasedDate), onFarm());

/** Mark a barn section as a lambing pen, or take the mark off. */
export async function markPen(facilityId: string, lambingPen: boolean) {
  const facility = await getFacility(facilityId);
  if (!facility.parentId) throw badRequest('NOT_A_SECTION', 'Only a section of a barn can be a lambing pen');
  if (facility.status !== 'active') throw conflict('FACILITY_ARCHIVED', 'This section is archived');
  if (!lambingPen) {
    const [held] = await tx()
      .select({ id: s.id })
      .from(s)
      .innerJoin(animals, eq(animals.id, s.eweId))
      .where(and(eq(s.farmId, ctx().farmId), eq(s.facilityId, facilityId), openStay))
      .limit(1);
    if (held) throw conflict('PEN_OCCUPIED', 'A ewe is in this pen: release her first');
  }
  const row = await updateFacility(facilityId, { lambingPen });
  await recordEvent({ type: lambingPen ? 'facility.pen_marked' : 'facility.pen_unmarked', entityType: 'facility', entityId: facilityId, data: { name: row.name } });
  return { id: row.id, name: row.name, parentId: row.parentId, lambingPen: row.lambingPen };
}

/** Sections that could be pens, with their barn: the list the zootechnician marks pens in. */
export async function listSections() {
  return tx()
    .select({ id: f.id, name: f.name, parentId: f.parentId, parentName: barn.name, capacity: f.capacity, lambingPen: f.lambingPen })
    .from(f)
    .innerJoin(barn, eq(barn.id, f.parentId))
    .where(and(eq(f.farmId, ctx().farmId), eq(f.status, 'active')))
    .orderBy(asc(barn.name), asc(f.name));
}

/** Her newborn lambs, less those raised elsewhere, plus lambs fostered onto her. */
async function lambsWith(eweId: string, lambIds: string[]): Promise<{ id: string; tag: string }[]> {
  const raisedElsewhere = sql`exists (select 1 from ${lambCare} lc where lc.lamb_id = ${animals.id} and lc.mothering in ('fostered', 'bottle'))`;
  const fosteredToHer = sql`exists (select 1 from ${lambCare} lc where lc.lamb_id = ${animals.id} and lc.mothering = 'fostered' and lc.foster_ewe_id = ${eweId})`;
  return tx()
    .select({ id: animals.id, tag: animals.tag })
    .from(animals)
    .where(
      and(
        eq(animals.farmId, ctx().farmId),
        onFarm(),
        or(lambIds.length ? and(inArray(animals.id, lambIds), sql`not ${raisedElsewhere}`) : undefined, fosteredToHer),
      ),
    )
    .orderBy(asc(animals.tag));
}

async function newbornIds(eweId: string, lambingId: string | null | undefined, sinceDate: string): Promise<{ lambingId: string | null; lambIds: string[] }> {
  const where = and(eq(l.farmId, ctx().farmId), eq(l.eweId, eweId));
  const [lambing] = lambingId
    ? await tx().select().from(l).where(and(where, eq(l.id, lambingId)))
    : await tx()
        .select()
        .from(l)
        .where(and(where, gte(l.date, addDays(sinceDate, -LAMBS_FOLLOW_DAYS)), lte(l.date, sinceDate)))
        .orderBy(desc(l.date))
        .limit(1);
  if (lambingId && !lambing) throw badRequest('INVALID_REFERENCE', 'This lambing belongs to another ewe', { field: 'lambingId' });
  return { lambingId: lambing?.id ?? null, lambIds: (lambing?.lambs ?? []).flatMap((lamb) => (lamb.alive && lamb.animalId ? [lamb.animalId] : [])) };
}

/** Put a ewe and her newborn lambs into a pen. */
export async function putInPen(i: z.infer<typeof penStayInput>) {
  const x = ctx();
  const sinceDate = i.sinceDate ?? today();
  assertNotFuture(sinceDate);

  // The pen row is the lock: two phones cannot fill the same pen at once.
  const [pen] = await tx()
    .select()
    .from(f)
    .where(and(eq(f.id, i.facilityId), eq(f.farmId, x.farmId)))
    .for('update');
  if (!pen) throw notFound('Facility');
  if (!pen.lambingPen || pen.status !== 'active') throw badRequest('NOT_A_LAMBING_PEN', `${pen.name} is not a lambing pen`);

  const ewe = await getAnimalOrThrow(i.eweId, { lock: true });
  if (ewe.sex !== 'female') throw badRequest('ANIMAL_NOT_FEMALE', `Animal ${ewe.tag} is not a female`);
  assertOnFarm(ewe);

  const held = await tx()
    .select({ id: s.id, eweId: s.eweId, facilityId: s.facilityId, eweTag: animals.tag, status: animals.status })
    .from(s)
    .innerJoin(animals, eq(animals.id, s.eweId))
    .where(and(eq(s.farmId, x.farmId), isNull(s.releasedDate), or(eq(s.facilityId, pen.id), eq(s.eweId, ewe.id))));
  const hers = held.find((stay) => stay.eweId === ewe.id);
  if (hers && i.id && hers.id === i.id && hers.facilityId === pen.id) {
    // The phone's queue delivered this very stay before and lost the answer: nothing to do again.
    const [same] = await tx().select().from(s).where(eq(s.id, hers.id));
    const newborn = await newbornIds(ewe.id, same.lambingId, same.sinceDate);
    return { ...same, lambs: await lambsWith(ewe.id, newborn.lambIds) };
  }
  if (hers) throw conflict('EWE_ALREADY_IN_PEN', `Ewe ${ewe.tag} is already in a pen`, { stayId: hers.id, facilityId: hers.facilityId });
  const stale: string[] = [];
  for (const stay of held) {
    // A ewe that died or was sold in the pen no longer holds it.
    if (!isOnFarm(stay.status)) stale.push(stay.id);
    else throw conflict('PEN_OCCUPIED', `Ewe ${stay.eweTag} is in this pen`, { stayId: stay.id, eweTag: stay.eweTag });
  }
  if (stale.length) await tx().update(s).set({ releasedDate: sinceDate }).where(inArray(s.id, stale));

  const newborn = await newbornIds(ewe.id, i.lambingId, sinceDate);
  const lambs = await lambsWith(ewe.id, newborn.lambIds);
  const [stay] = await tx()
    .insert(s)
    .values({
      ...(i.id ? { id: i.id } : {}),
      tenantId: x.tenantId,
      farmId: x.farmId,
      createdBy: x.userId,
      facilityId: pen.id,
      eweId: ewe.id,
      lambingId: newborn.lambingId,
      sinceDate,
      plannedReleaseDate: penReleaseDate(sinceDate, i.days ?? LAMBING_DESK.penDays),
      previousFacilityId: ewe.facilityId,
      notes: i.notes || null,
    })
    .returning();
  await tx()
    .update(animals)
    .set({ facilityId: pen.id })
    .where(and(eq(animals.farmId, x.farmId), inArray(animals.id, [ewe.id, ...lambs.map((lamb) => lamb.id)])));
  await recordEvent({
    type: 'animal.penned',
    entityType: 'animal',
    entityId: ewe.id,
    occurredAt: sinceDate,
    data: { stayId: stay.id, facilityId: pen.id, pen: pen.name, lambs: lambs.length, plannedReleaseDate: stay.plannedReleaseDate },
  });
  return { ...stay, lambs };
}

/** Let a ewe and her lambs out: they go back to where she was kept before. */
export async function releaseFromPen(stayId: string, i: z.infer<typeof penReleaseInput> = {}) {
  const x = ctx();
  const [stay] = await tx()
    .select()
    .from(s)
    .where(and(eq(s.id, stayId), eq(s.farmId, x.farmId)))
    .for('update');
  if (!stay) throw notFound('Pen stay');
  if (stay.releasedDate) throw conflict('PEN_STAY_CLOSED', 'She has already been let out of this pen');
  const date = i.date ?? today();
  assertNotFuture(date);
  if (date < stay.sinceDate) throw badRequest('RELEASE_BEFORE_ENTRY', 'She cannot leave the pen before she went in', { sinceDate: stay.sinceDate });

  const [updated] = await tx().update(s).set({ releasedDate: date }).where(eq(s.id, stay.id)).returning();
  // Only those still in the pen move: an animal taken elsewhere meanwhile stays where it was put.
  const moved = await tx()
    .update(animals)
    .set({ facilityId: stay.previousFacilityId })
    .where(
      and(
        eq(animals.farmId, x.farmId),
        eq(animals.facilityId, stay.facilityId),
        or(
          eq(animals.id, stay.eweId),
          eq(animals.damId, stay.eweId),
          sql`exists (select 1 from ${lambCare} lc where lc.lamb_id = ${animals.id} and lc.foster_ewe_id = ${stay.eweId})`,
        ),
      ),
    )
    .returning({ id: animals.id });
  await recordEvent({
    type: 'animal.pen_released',
    entityType: 'animal',
    entityId: stay.eweId,
    occurredAt: date,
    data: { stayId: stay.id, facilityId: stay.facilityId, moved: moved.length },
  });
  return updated;
}

/** Every lambing pen with who is in it, since when, and when she is due out. */
export async function listPens() {
  const x = ctx();
  const day = today();
  const pens = await tx()
    .select({ id: f.id, name: f.name, parentId: f.parentId, parentName: barn.name })
    .from(f)
    .leftJoin(barn, eq(barn.id, f.parentId))
    .where(and(eq(f.farmId, x.farmId), eq(f.lambingPen, true), eq(f.status, 'active')))
    .orderBy(asc(barn.name), asc(f.name));
  if (pens.length === 0) return [];

  const stays = await tx()
    .select({
      id: s.id,
      facilityId: s.facilityId,
      eweId: s.eweId,
      eweTag: animals.tag,
      sinceDate: s.sinceDate,
      plannedReleaseDate: s.plannedReleaseDate,
    })
    .from(s)
    .innerJoin(animals, eq(animals.id, s.eweId))
    .where(and(eq(s.farmId, x.farmId), openStay));
  // Lambs standing in the pen with her now.
  const lambs = stays.length
    ? await tx()
        .select({ id: animals.id, tag: animals.tag, facilityId: animals.facilityId })
        .from(animals)
        .where(
          and(
            eq(animals.farmId, x.farmId),
            onFarm(),
            inArray(animals.facilityId, stays.map((stay) => stay.facilityId)),
            notInArray(animals.id, stays.map((stay) => stay.eweId)),
          ),
        )
        .orderBy(asc(animals.tag))
    : [];

  return pens.map((pen) => {
    const stay = stays.find((row) => row.facilityId === pen.id) ?? null;
    return {
      ...pen,
      free: stay === null,
      stay: stay && {
        id: stay.id,
        eweId: stay.eweId,
        eweTag: stay.eweTag,
        sinceDate: stay.sinceDate,
        plannedReleaseDate: stay.plannedReleaseDate,
        /** Past the planned day and still in. */
        releaseDue: stay.plannedReleaseDate <= day,
        lambs: lambs.filter((lamb) => lamb.facilityId === pen.id).map(({ id, tag }) => ({ id, tag })),
      },
    };
  });
}
