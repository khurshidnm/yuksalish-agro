/**
 * The simulation's side of the farm: who is in the flock, where they sleep and graze, and the
 * collars and boluses they wear. Everything it registers carries a DevEUI starting 53494D ("SIM" in
 * hex), so `removeSimulation` can take it all away again before real trackers arrive.
 */
import { ANIMAL_ON_FARM_STATUSES } from '@yap/shared';
import { and, desc, eq, inArray, isNull, like, notExists, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { schema } from '../../../db/client';
import { ctx, tx, withTenant, type Identity } from '../../../core/context';
import { recordEvent } from '../../../core/journal';
import { activeFarms } from '../../../jobs/index';
import { resolveByDedupKey } from '../../alerts/alerts.service';
import { createKey, listKeys, revokeKey } from '../../settings/api-keys.service';
import { importTrackers } from '../trackers.service';
import { nearestOnEdge, type LatLng, type SimFarm, type SimHerd, type SimSheep } from './world';

const { alerts, animals, animalTrackDays, animalTracking, devices, facilities, fields, herds, pastureMoves, species, trackerAssignments, tenants } =
  schema;

export const SIM_PREFIX = '53494D';
export const SIM_KEY_NAME = 'Tracking simulator';

/** Fixed per animal, so a sheep keeps its collar across restarts, and a new lamb gets a new one. */
function devEui(kind: '01' | '02', animalId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < animalId.length; i++) {
    h ^= animalId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${SIM_PREFIX}${kind}${(h >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/** The farm with the most sheep on it, or the one asked for. */
export async function pickFarm(farmId?: string): Promise<Identity> {
  const farms = await activeFarms();
  if (farmId) {
    const farm = farms.find((f) => f.farmId === farmId);
    if (!farm) throw new Error(`No active farm ${farmId}`);
    return farm;
  }
  let best: { farm: Identity; head: number } | null = null;
  for (const farm of farms) {
    const head = await withTenant(farm, async () => (await onFarmSheep()).length);
    if (head > (best?.head ?? 0)) best = { farm, head };
  }
  if (!best) throw new Error('No farm has sheep on it to simulate');
  return best.farm;
}

async function onFarmSheep() {
  return tx()
    .select({ animalId: animals.id, tag: animals.tag, herdId: animals.herdId })
    .from(animals)
    .innerJoin(species, eq(species.id, animals.speciesId))
    .where(and(eq(animals.farmId, ctx().farmId), eq(species.key, 'sheep'), inArray(animals.status, [...ANIMAL_ON_FARM_STATUSES])))
    .orderBy(animals.tag);
}

/** The outer ring of a polygon, or of the largest polygon of a multipolygon, as points. */
function outerRing(boundary: { type: string; coordinates: unknown } | null): LatLng[] | null {
  if (!boundary) return null;
  const rings =
    boundary.type === 'Polygon'
      ? [(boundary.coordinates as number[][][])[0]]
      : boundary.type === 'MultiPolygon'
        ? (boundary.coordinates as number[][][][]).map((p) => p[0])
        : [];
  const best = rings.filter(Boolean).sort((a, b) => b!.length - a!.length)[0];
  return best ? best.map(([lng, lat]) => ({ lat: lat!, lng: lng! })) : null;
}

const square = (at: LatLng, halfM: number): LatLng[] => {
  const dLat = halfM / 111_195;
  const dLng = halfM / (111_195 * Math.cos((at.lat * Math.PI) / 180));
  return [
    { lat: at.lat - dLat, lng: at.lng - dLng },
    { lat: at.lat - dLat, lng: at.lng + dLng },
    { lat: at.lat + dLat, lng: at.lng + dLng },
    { lat: at.lat + dLat, lng: at.lng - dLng },
  ];
};

const centre = (ring: LatLng[]): LatLng => ({ lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length, lng: ring.reduce((s, p) => s + p.lng, 0) / ring.length });

/**
 * The flock as the farm records it: each herd's barn from its facility, its pasture from its open
 * pasture move or else the largest pasture, and a gateway on the barn roof and on each trough's mast.
 */
export async function loadFarm(): Promise<SimFarm> {
  const c = ctx();
  const farm = c.farmId;
  const sheep = (await onFarmSheep()).filter((s): s is typeof s & { herdId: string } => s.herdId !== null);
  const herdIds = [...new Set(sheep.map((s) => s.herdId))];
  const herdRows = herdIds.length ? await tx().select().from(herds).where(inArray(herds.id, herdIds)) : [];

  const fieldRows = await tx().select().from(fields).where(eq(fields.farmId, farm));
  const pastures = fieldRows.filter((f) => f.landUse === 'pasture' && outerRing(f.boundary)).sort((a, b) => (b.areaHa ?? 0) - (a.areaHa ?? 0));
  const facilityRows = await tx().select().from(facilities).where(eq(facilities.farmId, farm));
  const byId = new Map(facilityRows.map((f) => [f.id, f]));
  const barns = facilityRows.filter((f) => f.type === 'barn' && outerRing(f.boundary));
  const openMoves = herdIds.length
    ? await tx()
        .select({ herdId: pastureMoves.herdId, fieldId: pastureMoves.fieldId })
        .from(pastureMoves)
        .where(and(inArray(pastureMoves.herdId, herdIds), isNull(pastureMoves.returnDate)))
    : [];

  const [farmRow] = await tx().select().from(schema.farms).where(eq(schema.farms.id, farm));
  const farmCentre: LatLng = { lat: farmRow?.lat ?? 39.74, lng: farmRow?.lng ?? 64.79 };

  const simHerds: SimHerd[] = herdRows.map((h) => {
    // A section of a barn has no outline of its own: the barn it belongs to has.
    let facility = h.facilityId ? byId.get(h.facilityId) : undefined;
    while (facility && !outerRing(facility.boundary) && facility.parentId) facility = byId.get(facility.parentId);
    const pen = outerRing(facility?.boundary ?? null) ?? outerRing(barns[0]?.boundary ?? null) ?? square(farmCentre, 40);
    const moved = openMoves.find((m) => m.herdId === h.id);
    const field = (moved && fieldRows.find((f) => f.id === moved.fieldId && outerRing(f.boundary))) ?? pastures[0];
    const pasture = outerRing(field?.boundary ?? null) ?? square({ lat: centre(pen).lat + 0.012, lng: centre(pen).lng }, 450);
    return { id: h.id, name: h.name, pen, pasture, trough: nearestOnEdge(pasture, centre(pen)) };
  });

  const gateways = [
    { id: 'gw-barn-roof', at: centre(simHerds[0]?.pen ?? square(farmCentre, 40)) },
    ...simHerds.map((h, i) => ({ id: `gw-trough-mast-${i + 1}`, at: h.trough })),
  ];

  const [tenant] = await tx().select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, c.tenantId));
  return {
    seed: farm,
    tzOffsetMin: offsetMinutes(tenant?.timezone ?? c.timezone),
    herds: simHerds,
    sheep: sheep.map((s): SimSheep => ({ ...s, collar: devEui('01', s.animalId), bolus: devEui('02', s.animalId) })),
    gateways,
  };
}

/** Minutes a time zone is ahead of UTC now. */
function offsetMinutes(timeZone: string): number {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone }));
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((local.getTime() - utc.getTime()) / 60_000);
}

/**
 * Fit a collar and a bolus to every sheep that lacks one, through the same import a farmer uses
 * for the seller's list, and give the simulator a key of its own. Run it again and only new sheep
 * get trackers; a key from an earlier run is revoked.
 */
export async function setupSimulation(world: SimFarm): Promise<{ key: string; fitted: number; registered: number }> {
  const rows = world.sheep.flatMap((s) => [
    { externalId: s.collar, kind: 'collar' as const, animal: s.tag },
    ...(s.bolus ? [{ externalId: s.bolus, kind: 'bolus' as const, animal: s.tag }] : []),
  ]);
  let fitted = 0;
  let registered = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const result = await importTrackers({ dryRun: false, rows: rows.slice(i, i + 1000) });
    if (!result.applied) {
      const first = result.rows.find((r) => r.error);
      throw new Error(`The tracker import refused ${result.summary.errors} row(s), first: ${first?.externalId} ${first?.error}`);
    }
    fitted += result.summary.fit;
    registered += result.summary.register;
  }
  for (const old of (await listKeys()).filter((k) => k.name === SIM_KEY_NAME && !k.revokedAt)) await revokeKey(old.id);
  const { key } = await createKey({ name: SIM_KEY_NAME, scopes: ['events:write'] });
  return { key, fitted, registered };
}

/** The first and last simulated reading on this farm, to know what history is already there. */
export async function simulatedSpan(): Promise<{ first: Date | null; last: Date | null }> {
  const r = schema.trackerReadings;
  const [row] = await tx()
    .select({ first: sql<string | null>`min(${r.recordedAt})`, last: sql<string | null>`max(${r.recordedAt})` })
    .from(r)
    .innerJoin(devices, eq(devices.id, r.deviceId))
    .where(and(eq(r.farmId, ctx().farmId), like(devices.externalId, `${SIM_PREFIX}%`)));
  return { first: row?.first ? new Date(row.first) : null, last: row?.last ? new Date(row.last) : null };
}

/**
 * Take the simulation away: its trackers with all their readings, what it left on each sheep, its
 * open alerts, and its key. Real trackers and everything about them stay.
 */
export async function removeSimulation(): Promise<{ trackers: number; animals: number; alerts: number }> {
  const farm = ctx().farmId;
  const sims = await tx()
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.farmId, farm), like(devices.externalId, `${SIM_PREFIX}%`)));
  const simIds = sims.map((d) => d.id);
  const touched = simIds.length
    ? [...new Set((await tx().select({ animalId: trackerAssignments.animalId }).from(trackerAssignments).where(inArray(trackerAssignments.deviceId, simIds))).map((r) => r.animalId))]
    : [];

  // Readings, states and fittings go with their devices.
  if (simIds.length) await tx().delete(devices).where(inArray(devices.id, simIds));

  // What is left on an animal that wore nothing real.
  if (touched.length) {
    const fittedEver = (animalId: AnyPgColumn) =>
      tx().select({ one: sql`1` }).from(trackerAssignments).where(eq(trackerAssignments.animalId, animalId));
    await tx().delete(animalTracking).where(and(inArray(animalTracking.animalId, touched), notExists(fittedEver(animalTracking.animalId))));
    await tx().delete(animalTrackDays).where(and(inArray(animalTrackDays.animalId, touched), notExists(fittedEver(animalTrackDays.animalId))));
  }

  // The sheep's own alerts, and the farm-wide ones: the next health run raises those again if still true.
  const open = await tx()
    .select({ dedupKey: alerts.dedupKey })
    .from(alerts)
    .where(
      and(
        eq(alerts.farmId, farm),
        sql`${alerts.status} <> 'resolved'`,
        or(
          touched.length ? and(inArray(alerts.ruleKey, ['animal_isolated', 'animal_inactive', 'animal_fever']), inArray(alerts.entityId, touched)) : undefined,
          inArray(alerts.ruleKey, ['tracking_herd_split', 'tracking_silent', 'tracking_battery']),
        ),
      ),
    )
    .orderBy(desc(alerts.createdAt));
  for (const a of open) await resolveByDedupKey(a.dedupKey);

  for (const key of (await listKeys()).filter((k) => k.name === SIM_KEY_NAME && !k.revokedAt)) await revokeKey(key.id);
  await recordEvent({ type: 'tracking.simulation_removed', entityType: 'tracker', data: { trackers: simIds.length, animals: touched.length, alerts: open.length } });
  return { trackers: simIds.length, animals: touched.length, alerts: open.length };
}
