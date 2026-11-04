import { and, asc, desc, eq, getTableColumns, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ANIMAL_ON_FARM_STATUSES, PHYSIOLOGICAL_STATES, round } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { ensureCostCenter, renameCostCenter } from '../../core/costCenters';
import { badRequest, conflict } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { assertInFarm, assertNotFuture, assertOnFarm, getHerdOrThrow, herdHeadCount, onFarm, type Herd } from './refs';

const {
  animals,
  costCenters,
  dailyLogs,
  facilities,
  herdTransfers,
  herds: t,
  items,
  pastureMoves,
  rationLines,
  rations,
  fields,
} = schema;

export const herdInput = z.object({
  id: clientId,
  name: z.string().trim().min(1).max(120),
  state: z.enum(PHYSIOLOGICAL_STATES).optional(),
  facilityId: z.uuid().nullish(),
  rationId: z.uuid().nullish(),
  notes: z.string().max(1000).nullish(),
});
export type HerdInput = z.infer<typeof herdInput>;

export const herdListQuery = listQuery.extend({
  status: z.enum(['active', 'archived']).default('active'),
});

const liveHead = sql<number>`(
  select count(*) from animals a
  where a.herd_id = ${t.id} and a.status in ('active', 'pregnant', 'sick', 'quarantine')
)`.mapWith(Number);

async function assertRefs(i: Partial<HerdInput>): Promise<void> {
  await assertInFarm(facilities, i.facilityId, 'Facility');
  await assertInFarm(rations, i.rationId, 'Ration');
}

/** Every herd is a cost center from the moment it exists (spec 4.1 p.5). */
export async function createHerd(input: HerdInput): Promise<Herd> {
  const c = ctx();
  await assertRefs(input);
  const { id, ...values } = input;
  const [herd] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  const costCenterId = await ensureCostCenter('herd', herd.id, herd.name);
  const [row] = await tx().update(t).set({ costCenterId }).where(eq(t.id, herd.id)).returning();
  await recordEvent({ type: 'herd.created', entityType: 'herd', entityId: herd.id, data: { name: herd.name } });
  return row;
}

export async function updateHerd(id: string, input: Partial<HerdInput>) {
  const herd = await getHerdOrThrow(id, { lock: true });
  await assertRefs(input);
  const { id: _ignored, ...values } = input;
  const [row] = await tx().update(t).set(values).where(eq(t.id, id)).returning();
  // Cost reports show this name.
  if (input.name && input.name !== herd.name && herd.costCenterId) {
    await renameCostCenter(herd.costCenterId, input.name);
  }
  // Animals follow their herd into a new building.
  if (input.facilityId !== undefined && input.facilityId !== herd.facilityId) {
    await tx()
      .update(animals)
      .set({ facilityId: input.facilityId })
      .where(and(eq(animals.herdId, id), onFarm()));
  }
  return row;
}

/** History points at herds, so a finished herd is archived and only if it is empty. */
export async function archiveHerd(id: string) {
  await getHerdOrThrow(id, { lock: true });
  const head = await herdHeadCount(id);
  if (head > 0) throw conflict('HERD_NOT_EMPTY', `This herd still has ${head} animals`, { head });
  const [row] = await tx().update(t).set({ status: 'archived' }).where(eq(t.id, id)).returning();
  await recordEvent({ type: 'herd.archived', entityType: 'herd', entityId: id });
  return row;
}

export async function listHerds(q: z.infer<typeof herdListQuery>) {
  const where = and(eq(t.farmId, ctx().farmId), eq(t.status, q.status), searchAny(q.search, [t.name]));
  return paged(q, t, where, (limit, offset) =>
    tx()
      .select({
        ...getTableColumns(t),
        headCount: liveHead,
        facilityName: facilities.name,
        rationName: rations.name,
      })
      .from(t)
      .leftJoin(facilities, eq(facilities.id, t.facilityId))
      .leftJoin(rations, eq(rations.id, t.rationId))
      .where(where)
      .orderBy(...sortBy(q.sort, { name: t.name, state: t.state, createdAt: t.createdAt }, asc(t.name), t.id))
      .limit(limit)
      .offset(offset),
  );
}

export async function lookupHerds(search: string | undefined) {
  return tx()
    .select({ id: t.id, name: t.name, state: t.state, headCount: liveHead })
    .from(t)
    .where(and(eq(t.farmId, ctx().farmId), eq(t.status, 'active'), searchAny(search, [t.name])))
    .orderBy(asc(t.name))
    .limit(50);
}

export async function getHerdCard(id: string) {
  const herd = await getHerdOrThrow(id);

  const composition = await tx()
    .select({
      category: animals.category,
      status: animals.status,
      head: sql<number>`count(*)`.mapWith(Number),
      averageKg: sql<number | null>`round(avg(${animals.currentWeightKg}), 2)`.mapWith((v) => (v === null ? null : Number(v))),
    })
    .from(animals)
    .where(and(eq(animals.herdId, id), onFarm()))
    .groupBy(animals.category, animals.status);

  const [weight] = await tx()
    .select({
      averageKg: sql<number | null>`round(avg(${animals.currentWeightKg}), 2)`.mapWith((v) => (v === null ? null : Number(v))),
      totalKg: sql<number | null>`sum(${animals.currentWeightKg})`.mapWith((v) => (v === null ? null : Number(v))),
    })
    .from(animals)
    .where(and(eq(animals.herdId, id), onFarm()));

  const headCount = composition.reduce((sum, row) => sum + row.head, 0);

  let ration = null;
  if (herd.rationId) {
    const [header] = await tx()
      .select({ id: rations.id, name: rations.name, state: rations.state })
      .from(rations)
      .where(eq(rations.id, herd.rationId));
    const lines = await tx()
      .select({
        itemId: rationLines.itemId,
        itemName: items.name,
        unit: items.unit,
        kgPerHeadDay: rationLines.kgPerHeadDay,
      })
      .from(rationLines)
      .innerJoin(items, eq(items.id, rationLines.itemId))
      .where(eq(rationLines.rationId, herd.rationId))
      .orderBy(asc(items.name));
    ration = header
      ? {
          ...header,
          lines: lines.map((l) => ({ ...l, dailyKg: round(l.kgPerHeadDay * headCount, 3) })),
        }
      : null;
  }

  // Occupancy counts every herd in the building, not only this one.
  let facility = null;
  if (herd.facilityId) {
    const [row] = await tx()
      .select({ id: facilities.id, name: facilities.name, capacity: facilities.capacity })
      .from(facilities)
      .where(eq(facilities.id, herd.facilityId));
    const [occupied] = await tx()
      .select({ head: sql<number>`count(*)`.mapWith(Number) })
      .from(animals)
      .where(and(eq(animals.facilityId, herd.facilityId), onFarm()));
    facility = row ? { ...row, occupied: occupied.head } : null;
  }

  const recentLogs = await tx()
    .select({
      id: dailyLogs.id,
      date: dailyLogs.date,
      headCount: dailyLogs.headCount,
      condition: dailyLogs.condition,
      waterL: dailyLogs.waterL,
    })
    .from(dailyLogs)
    .where(eq(dailyLogs.herdId, id))
    .orderBy(desc(dailyLogs.date))
    .limit(14);

  const pasture = await tx()
    .select({
      id: pastureMoves.id,
      fieldId: pastureMoves.fieldId,
      fieldNumber: fields.number,
      fieldName: fields.name,
      areaHa: fields.areaHa,
      outDate: pastureMoves.outDate,
      returnDate: pastureMoves.returnDate,
    })
    .from(pastureMoves)
    .innerJoin(fields, eq(fields.id, pastureMoves.fieldId))
    .where(eq(pastureMoves.herdId, id))
    .orderBy(desc(pastureMoves.outDate))
    .limit(10);

  return { ...herd, headCount, ...weight, composition, ration, facility, recentLogs, pasture };
}

// ─── Transfers between herds (spec 8.4) ─────────────────────────────────────

export const transferInput = z
  .object({
    /** Explicit animals, or a whole herd through fromHerdId. */
    animalIds: z.array(z.uuid()).min(1).max(5000).optional(),
    fromHerdId: z.uuid().optional(),
    toHerdId: z.uuid(),
    date: isoDate.optional(),
    reason: z.string().trim().max(300).nullish(),
  })
  .refine((v) => !!v.animalIds !== !!v.fromHerdId, { message: 'Send either animalIds or fromHerdId' });

export async function transfer(input: z.infer<typeof transferInput>) {
  const c = ctx();
  const date = input.date ?? today();
  assertNotFuture(date);
  const target = await getHerdOrThrow(input.toHerdId, { lock: true });
  if (target.status !== 'active') throw badRequest('HERD_ARCHIVED', 'This herd is archived');

  const selection = input.animalIds
    ? inArray(animals.id, input.animalIds)
    : and(eq(animals.herdId, input.fromHerdId!), inArray(animals.status, [...ANIMAL_ON_FARM_STATUSES]));

  const rows = await tx()
    .select({ id: animals.id, tag: animals.tag, herdId: animals.herdId, status: animals.status })
    .from(animals)
    // `<>` alone would skip animals with no herd yet: NULL compares as unknown.
    .where(
      and(
        eq(animals.farmId, c.farmId),
        selection,
        or(isNull(animals.herdId), ne(animals.herdId, input.toHerdId)),
      ),
    )
    .for('update');

  if (input.animalIds) {
    // Anything not returned is either already in the target herd or not on this farm.
    const known = await tx()
      .select({ id: animals.id })
      .from(animals)
      .where(and(eq(animals.farmId, c.farmId), inArray(animals.id, input.animalIds)));
    if (known.length !== new Set(input.animalIds).size) {
      throw badRequest('INVALID_REFERENCE', 'Some animals were not found on this farm');
    }
    rows.forEach(assertOnFarm);
  }
  if (rows.length === 0) return { moved: 0 };

  const ids = rows.map((r) => r.id);
  await tx()
    .update(animals)
    .set({ herdId: input.toHerdId, facilityId: target.facilityId })
    .where(inArray(animals.id, ids));
  await tx()
    .insert(herdTransfers)
    .values(
      rows.map((row) => ({
        tenantId: c.tenantId,
        farmId: c.farmId,
        createdBy: c.userId,
        animalId: row.id,
        fromHerdId: row.herdId,
        toHerdId: input.toHerdId,
        date,
        reason: input.reason,
      })),
    );
  await recordEvent({
    type: 'animal.transferred',
    entityType: 'herd',
    entityId: input.toHerdId,
    occurredAt: date,
    data: { count: ids.length, reason: input.reason },
  });
  return { moved: ids.length };
}
