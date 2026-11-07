/**
 * Which tracker each animal wears. Fitting 700 collars one by one is a day of tapping, so the
 * import takes the seller's list (DevEUI per collar) with the ear tag each one went on.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ANIMAL_ON_FARM_STATUSES } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { isoDate, listQuery, paged, sortBy } from '../../core/query';
import { isTracker, registerTrackers, TRACKER_KINDS, type TrackerKind } from '../devices/devices.service';
import { findByCode } from '../livestock/animals.service';
import { normalizeExternalId } from './decode';

const { animals, animalIdentifiers, devices, herds, trackerAssignments: a, trackerState } = schema;

type Animal = typeof animals.$inferSelect;

const kindOf = sql<TrackerKind>`${devices.config}->>'trackerKind'`;
const onFarm = (status: string) => (ANIMAL_ON_FARM_STATUSES as readonly string[]).includes(status);

function assertNotFuture(date: string) {
  if (date > today()) throw badRequest('DATE_IN_FUTURE', 'The date is in the future');
}

// ─── List ───────────────────────────────────────────────────────────────────

export const trackerListQuery = listQuery.extend({
  kind: z.enum(TRACKER_KINDS).optional(),
  fitted: z.enum(['yes', 'no']).optional(),
  herdId: z.uuid().optional(),
});

const wornBy = (extra: SQL) =>
  sql`exists (select 1 from ${a} join ${animals} on ${animals.id} = ${a.animalId}
              where ${a.deviceId} = ${devices.id} and ${a.removedOn} is null and ${extra})`;

export async function list(q: z.infer<typeof trackerListQuery>) {
  const term = q.search ? `%${q.search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const where = and(
    eq(devices.farmId, ctx().farmId),
    sql`${kindOf} is not null`,
    q.kind ? sql`${kindOf} = ${q.kind}` : undefined,
    q.fitted === 'yes' ? wornBy(sql`true`) : q.fitted === 'no' ? sql`not ${wornBy(sql`true`)}` : undefined,
    q.herdId ? wornBy(sql`${animals.herdId} = ${q.herdId}`) : undefined,
    term ? or(ilike(devices.externalId, term), ilike(devices.name, term), wornBy(sql`${animals.tag} ilike ${term}`)) : undefined,
  );
  return paged(q, devices, where, (limit, offset) =>
    tx()
      .select({
        id: devices.id,
        externalId: devices.externalId,
        name: devices.name,
        kind: kindOf,
        status: devices.status,
        lastReadingAt: trackerState.lastReadingAt,
        batteryPct: trackerState.batteryPct,
        rssi: trackerState.rssi,
        assignmentId: a.id,
        fittedOn: a.fittedOn,
        animalId: animals.id,
        animalTag: animals.tag,
        herdId: animals.herdId,
        herdName: herds.name,
      })
      .from(devices)
      .leftJoin(trackerState, eq(trackerState.deviceId, devices.id))
      .leftJoin(a, and(eq(a.deviceId, devices.id), isNull(a.removedOn)))
      .leftJoin(animals, eq(animals.id, a.animalId))
      .leftJoin(herds, eq(herds.id, animals.herdId))
      .where(where)
      .orderBy(
        ...sortBy(
          q.sort,
          { externalId: devices.externalId, lastReadingAt: trackerState.lastReadingAt, batteryPct: trackerState.batteryPct, animalTag: animals.tag },
          asc(devices.externalId),
          devices.id,
        ),
      )
      .limit(limit)
      .offset(offset),
  );
}

// ─── Fit and remove one ─────────────────────────────────────────────────────

export const fitInput = z.object({
  deviceId: z.uuid(),
  animalId: z.uuid(),
  fittedOn: isoDate.optional(),
  notes: z.string().trim().max(500).nullish(),
});

export const removeInput = z.object({
  removedOn: isoDate.optional(),
  notes: z.string().trim().max(500).nullish(),
});

async function trackerOrThrow(id: string, lock = false) {
  const query = tx()
    .select()
    .from(devices)
    .where(and(eq(devices.id, id), eq(devices.farmId, ctx().farmId)));
  const [device] = lock ? await query.for('update') : await query;
  if (!device || !isTracker(device)) throw notFound('Tracker');
  return device;
}

async function animalOnFarmOrThrow(id: string): Promise<Animal> {
  const [animal] = await tx()
    .select()
    .from(animals)
    .where(and(eq(animals.id, id), eq(animals.farmId, ctx().farmId)));
  if (!animal) throw notFound('Animal');
  if (!onFarm(animal.status)) throw conflict('ANIMAL_NOT_ON_FARM', 'This animal is no longer on the farm');
  return animal;
}

/**
 * Close what the new fitting replaces: this device on any animal, and a tracker of the same kind on
 * this animal. A sheep wears one collar; a collar is on one sheep.
 */
async function closeReplaced(devicesToFree: string[], animalKinds: { animalId: string; kind: TrackerKind }[], on: string) {
  const byKind = new Map<TrackerKind, string[]>();
  for (const x of animalKinds) byKind.set(x.kind, [...(byKind.get(x.kind) ?? []), x.animalId]);
  const sameKind = byKind.size
    ? or(
        ...[...byKind].map(
          ([kind, animalIds]) =>
            sql`(${inArray(a.animalId, animalIds)} and ${a.deviceId} in (select ${devices.id} from ${devices} where ${kindOf} = ${kind}))`,
        ),
      )
    : undefined;
  const freed = devicesToFree.length ? inArray(a.deviceId, devicesToFree) : undefined;
  if (!sameKind && !freed) return [];
  return tx()
    .update(a)
    .set({ removedOn: sql`greatest(${a.fittedOn}, ${on}::date)` })
    .where(and(eq(a.farmId, ctx().farmId), isNull(a.removedOn), or(freed, sameKind)))
    .returning({ id: a.id, deviceId: a.deviceId, animalId: a.animalId });
}

export async function fit(input: z.infer<typeof fitInput>) {
  const c = ctx();
  const fittedOn = input.fittedOn ?? today();
  assertNotFuture(fittedOn);
  const device = await trackerOrThrow(input.deviceId, true);
  const animal = await animalOnFarmOrThrow(input.animalId);
  const kind = device.config.trackerKind as TrackerKind;

  const [current] = await tx()
    .select({ id: a.id, animalId: a.animalId })
    .from(a)
    .where(and(eq(a.deviceId, device.id), isNull(a.removedOn)));
  if (current?.animalId === animal.id) throw conflict('TRACKER_ALREADY_FITTED', 'This tracker is already on this animal');

  const replaced = await closeReplaced([device.id], [{ animalId: animal.id, kind }], fittedOn);
  const [row] = await tx()
    .insert(a)
    .values({ tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId, deviceId: device.id, animalId: animal.id, fittedOn, notes: input.notes })
    .returning();
  await recordEvent({
    type: 'tracking.tracker_fitted',
    entityType: 'animal',
    entityId: animal.id,
    data: { tag: animal.tag, deviceId: device.id, externalId: device.externalId, kind, replaced: replaced.length },
  });
  return row;
}

export async function remove(assignmentId: string, input: z.infer<typeof removeInput>) {
  const removedOn = input.removedOn ?? today();
  assertNotFuture(removedOn);
  const [row] = await tx()
    .select({ assignment: a, tag: animals.tag, externalId: devices.externalId })
    .from(a)
    .innerJoin(animals, eq(animals.id, a.animalId))
    .innerJoin(devices, eq(devices.id, a.deviceId))
    .where(and(eq(a.id, assignmentId), eq(a.farmId, ctx().farmId)))
    .for('update', { of: a });
  if (!row) throw notFound('Tracker assignment');
  if (row.assignment.removedOn) throw conflict('TRACKER_ALREADY_REMOVED', 'This tracker was already taken off');
  if (removedOn < row.assignment.fittedOn) throw badRequest('REMOVED_BEFORE_FITTED', 'A tracker cannot come off before it was fitted');
  const [updated] = await tx()
    .update(a)
    .set({ removedOn, notes: input.notes ?? row.assignment.notes })
    .where(eq(a.id, assignmentId))
    .returning();
  await recordEvent({
    type: 'tracking.tracker_removed',
    entityType: 'animal',
    entityId: row.assignment.animalId,
    data: { tag: row.tag, deviceId: row.assignment.deviceId, externalId: row.externalId },
  });
  return updated;
}

// ─── Import ─────────────────────────────────────────────────────────────────

export const importInput = z.object({
  /** Check the list and say what would happen, changing nothing. */
  dryRun: z.boolean().default(false),
  fittedOn: isoDate.optional(),
  rows: z
    .array(
      z.object({
        externalId: z.string().trim().min(1).max(64),
        kind: z.enum(TRACKER_KINDS),
        /** Ear tag, RFID or any identifier of the animal it is on; empty to only register the tracker. */
        animal: z.string().trim().max(64).nullish(),
      }),
    )
    .min(1)
    .max(1000),
});

export type ImportAction = 'register' | 'register_and_fit' | 'fit' | 'move' | 'unchanged';

interface ImportRow {
  index: number;
  externalId: string;
  kind: TrackerKind;
  animalTag: string | null;
  action: ImportAction | null;
  error: string | null;
}

/** Find many animals in two queries, then fall back to the forgiving lookup for what is left. */
async function animalsByCode(codes: string[]): Promise<Map<string, Animal>> {
  const found = new Map<string, Animal>();
  if (codes.length === 0) return found;
  const farm = eq(animals.farmId, ctx().farmId);
  for (const row of await tx().select().from(animals).where(and(farm, inArray(animals.tag, codes)))) found.set(row.tag, row);
  const left = codes.filter((code) => !found.has(code));
  if (left.length) {
    const rows = await tx()
      .select({ value: animalIdentifiers.value, animal: animals })
      .from(animalIdentifiers)
      .innerJoin(animals, eq(animals.id, animalIdentifiers.animalId))
      .where(and(farm, inArray(animalIdentifiers.value, left)));
    for (const row of rows) found.set(row.value, row.animal);
  }
  for (const code of codes.filter((c) => !found.has(c))) {
    const animal = await findByCode(code);
    if (animal) found.set(code, animal);
  }
  return found;
}

/**
 * All or nothing: if any row is wrong, nothing changes and every row says why. A half-imported
 * flock is harder to fix than a list with three typos.
 */
export async function importTrackers(input: z.infer<typeof importInput>) {
  const c = ctx();
  const fittedOn = input.fittedOn ?? today();
  assertNotFuture(fittedOn);

  const rows: ImportRow[] = input.rows.map((r, index) => {
    const externalId = normalizeExternalId(r.externalId);
    return { index, externalId: externalId ?? r.externalId, kind: r.kind, animalTag: r.animal || null, action: null, error: externalId ? null : 'INVALID_EXTERNAL_ID' };
  });
  const seenIds = new Set<string>();
  for (const row of rows.filter((r) => !r.error)) {
    if (seenIds.has(row.externalId)) row.error = 'DUPLICATE_IN_IMPORT';
    seenIds.add(row.externalId);
  }

  // External ids are unique across the workspace, so look beyond this farm.
  const ids = rows.filter((r) => !r.error).map((r) => r.externalId);
  const existing = ids.length ? await tx().select().from(devices).where(inArray(devices.externalId, ids)) : [];
  const byExternal = new Map(existing.map((d) => [d.externalId!, d]));
  const current = existing.length
    ? await tx()
        .select({ deviceId: a.deviceId, animalId: a.animalId })
        .from(a)
        .where(and(inArray(a.deviceId, existing.map((d) => d.id)), isNull(a.removedOn)))
    : [];
  const wearer = new Map(current.map((x) => [x.deviceId, x.animalId]));
  const found = await animalsByCode([...new Set(rows.flatMap((r) => (r.animalTag && !r.error ? [r.animalTag] : [])))]);

  const animalKinds = new Set<string>();
  for (const row of rows) {
    if (row.error) continue;
    const device = byExternal.get(row.externalId);
    if (device && (device.farmId !== c.farmId || !isTracker(device))) {
      row.error = 'EXTERNAL_ID_TAKEN';
      continue;
    }
    if (device && device.config.trackerKind !== row.kind) {
      row.error = 'TRACKER_KIND_MISMATCH';
      continue;
    }
    if (!row.animalTag) {
      row.action = device ? 'unchanged' : 'register';
      continue;
    }
    const animal = found.get(row.animalTag);
    if (!animal) {
      row.error = 'ANIMAL_NOT_FOUND';
      continue;
    }
    if (!onFarm(animal.status)) {
      row.error = 'ANIMAL_NOT_ON_FARM';
      continue;
    }
    const key = `${animal.id}:${row.kind}`;
    if (animalKinds.has(key)) {
      row.error = 'DUPLICATE_ANIMAL';
      continue;
    }
    animalKinds.add(key);
    row.animalTag = animal.tag;
    const on = device ? wearer.get(device.id) : undefined;
    row.action = !device ? 'register_and_fit' : on === animal.id ? 'unchanged' : on ? 'move' : 'fit';
  }

  const summary = {
    rows: rows.length,
    register: rows.filter((r) => r.action === 'register' || r.action === 'register_and_fit').length,
    fit: rows.filter((r) => r.action === 'register_and_fit' || r.action === 'fit' || r.action === 'move').length,
    move: rows.filter((r) => r.action === 'move').length,
    unchanged: rows.filter((r) => r.action === 'unchanged').length,
    errors: rows.filter((r) => r.error).length,
  };
  if (input.dryRun || summary.errors > 0) return { applied: false, fittedOn, summary, rows };

  const created = await registerTrackers(
    rows
      .filter((r) => r.action === 'register' || r.action === 'register_and_fit')
      .map((r) => ({ externalId: r.externalId, kind: r.kind, name: `${r.kind === 'collar' ? 'Collar' : r.kind === 'bolus' ? 'Bolus' : 'Ear tag'} ${r.externalId.slice(-6)}` })),
  );
  const deviceId = new Map([...existing, ...created].map((d) => [d.externalId!, d.id]));
  const fits = rows
    .filter((r) => r.action === 'register_and_fit' || r.action === 'fit' || r.action === 'move')
    .map((r) => ({ deviceId: deviceId.get(r.externalId)!, animalId: found.get(r.animalTag!)!.id, kind: r.kind }));
  await closeReplaced(
    fits.map((f) => f.deviceId),
    fits.map((f) => ({ animalId: f.animalId, kind: f.kind })),
    fittedOn,
  );
  if (fits.length) {
    await tx()
      .insert(a)
      .values(fits.map((f) => ({ tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId, deviceId: f.deviceId, animalId: f.animalId, fittedOn })));
  }
  await recordEvent({ type: 'tracking.trackers_imported', entityType: 'tracker_import', data: { ...summary, fittedOn } });
  return { applied: true, fittedOn, summary, rows };
}

/** The trackers an animal wears now and wore before, newest first. */
export async function animalTrackers(animalId: string) {
  return tx()
    .select({
      assignmentId: a.id,
      deviceId: devices.id,
      externalId: devices.externalId,
      kind: kindOf,
      fittedOn: a.fittedOn,
      removedOn: a.removedOn,
      lastReadingAt: trackerState.lastReadingAt,
      batteryPct: trackerState.batteryPct,
    })
    .from(a)
    .innerJoin(devices, eq(devices.id, a.deviceId))
    .leftJoin(trackerState, eq(trackerState.deviceId, devices.id))
    .where(and(eq(a.animalId, animalId), eq(a.farmId, ctx().farmId)))
    .orderBy(sql`${a.removedOn} is not null`, desc(a.fittedOn));
}
