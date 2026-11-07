/**
 * Readings from collars and boluses (docs/tracking.md). A network server posts each uplink as it
 * arrives, about once a second for a flock of 700, so this path stays a handful of statements.
 * Readings are telemetry, not domain actions: they do not go to the journal, which is kept for ever.
 */
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { assertActiveWorkspace, callerKeyId, isTracker, markSeen, type TrackerKind } from '../devices/devices.service';
import { hasData, normalizeExternalId, readingFields, type FieldMap, type RawUplink, type ReadingFields } from './decode';

const { devices, trackerAssignments, trackerReadings, trackerState, animalTracking } = schema;

type Device = typeof devices.$inferSelect;

/** A wrong device clock must not put readings into next year. */
const MAX_FUTURE_MS = 86_400_000;

/** Our own batch format, for vendor-cloud bridges and the simulator. */
export const readingsInput = z.object({
  readings: z
    .array(
      z.object({
        externalId: z.string().min(1).max(64),
        recordedAt: z.iso.datetime({ offset: true }),
        lat: z.number().nullish(),
        lng: z.number().nullish(),
        activity: z.number().nullish(),
        temperatureC: z.number().nullish(),
        batteryPct: z.number().nullish(),
        rssi: z.number().int().nullish(),
        snr: z.number().nullish(),
        gatewayId: z.string().max(64).nullish(),
      }),
    )
    .min(1)
    .max(500),
});

export function uplinksFromReadings(input: z.infer<typeof readingsInput>): (RawUplink | null)[] {
  return input.readings.map((r) => {
    const externalId = normalizeExternalId(r.externalId);
    if (!externalId) return null;
    const { externalId: _id, recordedAt, rssi, snr, gatewayId, ...fields } = r;
    return { externalId, recordedAt: new Date(recordedAt), fields, rssi, snr, gatewayId };
  });
}

export interface IngestResult {
  accepted: number;
  /** Uplinks that reached us but held nothing the codec decoded: check the device profile's codec. */
  empty: number;
  /** External ids not registered on this farm. They are answered 200 so the server does not retry. */
  unknown: string[];
  rejected: { index: number; code: string }[];
}

interface Row {
  device: Device;
  animalId: string | null;
  at: Date;
  fields: ReadingFields;
  rssi: number | null;
  snr: number | null;
  gatewayId: string | null;
}

const fieldMapOf = (device: Device): FieldMap | undefined =>
  typeof device.config.fieldMap === 'object' && device.config.fieldMap !== null ? (device.config.fieldMap as FieldMap) : undefined;

/** `null` entries are uplinks that failed to parse; they are reported by index. */
export async function ingest(uplinks: (RawUplink | null)[], rawKey: string): Promise<IngestResult> {
  await assertActiveWorkspace();
  const c = ctx();
  const ids = [...new Set(uplinks.flatMap((u) => (u ? [u.externalId] : [])))];
  const found = ids.length
    ? await tx()
        .select()
        .from(devices)
        .where(and(eq(devices.farmId, c.farmId), inArray(devices.externalId, ids)))
    : [];
  const byExternal = new Map(found.map((d) => [d.externalId!, d]));
  const keyId = found.some((d) => d.apiKeyId) ? await callerKeyId(rawKey) : null;
  const worn = found.length
    ? await tx()
        .select({ deviceId: trackerAssignments.deviceId, animalId: trackerAssignments.animalId })
        .from(trackerAssignments)
        .where(and(inArray(trackerAssignments.deviceId, found.map((d) => d.id)), isNull(trackerAssignments.removedOn)))
    : [];
  const wearer = new Map(worn.map((w) => [w.deviceId, w.animalId]));

  const unknown = new Set<string>();
  const rejected: IngestResult['rejected'] = [];
  const rows: Row[] = [];
  for (const [index, u] of uplinks.entries()) {
    if (!u) {
      rejected.push({ index, code: 'VALIDATION_ERROR' });
      continue;
    }
    const device = byExternal.get(u.externalId);
    if (!device) {
      unknown.add(u.externalId);
      continue;
    }
    const code = !isTracker(device)
      ? 'NOT_A_TRACKER'
      : device.apiKeyId && device.apiKeyId !== keyId
        ? 'DEVICE_KEY_MISMATCH'
        : u.recordedAt.getTime() > Date.now() + MAX_FUTURE_MS
          ? 'INVALID_READING_TIME'
          : null;
    if (code) {
      rejected.push({ index, code });
      continue;
    }
    rows.push({
      device,
      animalId: wearer.get(device.id) ?? null,
      at: u.recordedAt,
      fields: readingFields(u, device.config.trackerKind as TrackerKind, fieldMapOf(device)),
      rssi: u.rssi ?? null,
      snr: u.snr ?? null,
      gatewayId: u.gatewayId ?? null,
    });
  }

  const withData = rows.filter((r) => hasData(r.fields));
  await storeReadings(withData);
  await updateTrackerState(rows);
  await updateAnimals(withData);
  await markSeen([...new Map(rows.map((r) => [r.device.id, r.device])).values()]);

  return { accepted: rows.length, empty: rows.length - withData.length, unknown: [...unknown], rejected };
}

/**
 * A repeat of a stored reading fills in what the first copy lacked and changes nothing else, so a
 * status event that shares an uplink's time adds its battery to that uplink's row.
 */
async function storeReadings(rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const c = ctx();
  // One statement cannot touch a row twice, so repeats inside this batch are merged first.
  const merged = new Map<string, Row>();
  for (const r of rows) {
    const key = `${r.device.id}@${r.at.getTime()}`;
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, fields: mergeFields(prev.fields, r.fields) } : r);
  }
  const keep = (column: string) => sql.raw(`coalesce(tracker_readings.${column}, excluded.${column})`);
  await tx()
    .insert(trackerReadings)
    .values(
      [...merged.values()].map((r) => ({
        tenantId: c.tenantId,
        farmId: c.farmId,
        deviceId: r.device.id,
        animalId: r.animalId,
        recordedAt: r.at,
        ...r.fields,
        rssi: r.rssi,
        snr: r.snr,
        gatewayId: r.gatewayId,
      })),
    )
    .onConflictDoUpdate({
      target: [trackerReadings.deviceId, trackerReadings.recordedAt],
      set: Object.fromEntries(
        ['lat', 'lng', 'activity', 'temperature_c', 'battery_pct', 'rssi', 'snr', 'gateway_id'].map((col) => [camel(col), keep(col)]),
      ),
    });
}

const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());

const mergeFields = (a: ReadingFields, b: ReadingFields): ReadingFields => ({
  lat: a.lat ?? b.lat,
  lng: a.lat !== null ? a.lng : b.lng,
  activity: a.activity ?? b.activity,
  temperatureC: a.temperatureC ?? b.temperatureC,
  batteryPct: a.batteryPct ?? b.batteryPct,
});

/** The newest of `rows` that has `pick`, or undefined. */
function newest<T>(rows: Row[], pick: (r: Row) => T | null): { row: Row; value: T } | undefined {
  let best: { row: Row; value: T } | undefined;
  for (const row of rows) {
    const value = pick(row);
    if (value === null || value === undefined) continue;
    if (!best || row.at > best.row.at) best = { row, value };
  }
  return best;
}

function groupBy<K>(rows: Row[], key: (r: Row) => K | null): Map<K, Row[]> {
  const groups = new Map<K, Row[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return groups;
}

/**
 * `columns` take the incoming value only when its time (`timeColumn`) is newer than the stored one:
 * readings can arrive out of order from a gateway that was offline.
 */
function ifNewer(table: string, timeColumn: string, columns: string[]): Record<string, SQL> {
  const newer = `excluded.${timeColumn} is not null and (${table}.${timeColumn} is null or excluded.${timeColumn} >= ${table}.${timeColumn})`;
  return Object.fromEntries(
    [...columns, timeColumn].map((col) => [camel(col), sql.raw(`case when ${newer} then excluded.${col} else ${table}.${col} end`)]),
  );
}

async function updateTrackerState(rows: Row[]): Promise<void> {
  const c = ctx();
  const values = [...groupBy(rows, (r) => r.device.id)].map(([deviceId, list]) => {
    const last = newest(list, (r) => r.at)!.row;
    const battery = newest(list, (r) => r.fields.batteryPct);
    return {
      tenantId: c.tenantId,
      farmId: c.farmId,
      deviceId,
      lastReadingAt: last.at,
      batteryPct: battery?.value ?? null,
      batteryAt: battery?.row.at ?? null,
      rssi: last.rssi,
      snr: last.snr,
      gatewayId: last.gatewayId,
    };
  });
  if (values.length === 0) return;
  await tx()
    .insert(trackerState)
    .values(values)
    .onConflictDoUpdate({
      target: trackerState.deviceId,
      set: {
        ...ifNewer('tracker_state', 'battery_at', ['battery_pct']),
        ...ifNewer('tracker_state', 'last_reading_at', ['rssi', 'snr', 'gateway_id']),
        updatedAt: new Date(),
      },
    });
}

async function updateAnimals(rows: Row[]): Promise<void> {
  const c = ctx();
  const values = [...groupBy(rows, (r) => r.animalId)].map(([animalId, list]) => {
    const position = newest(list, (r) => (r.fields.lat !== null ? { lat: r.fields.lat, lng: r.fields.lng! } : null));
    const temperature = newest(list, (r) => r.fields.temperatureC);
    const activity = newest(list, (r) => r.fields.activity);
    return {
      tenantId: c.tenantId,
      farmId: c.farmId,
      animalId,
      lat: position?.value.lat ?? null,
      lng: position?.value.lng ?? null,
      positionAt: position?.row.at ?? null,
      temperatureC: temperature?.value ?? null,
      temperatureAt: temperature?.row.at ?? null,
      activity: activity?.value ?? null,
      activityAt: activity?.row.at ?? null,
      lastReadingAt: newest(list, (r) => r.at)!.row.at,
    };
  });
  if (values.length === 0) return;
  await tx()
    .insert(animalTracking)
    .values(values)
    .onConflictDoUpdate({
      target: animalTracking.animalId,
      set: {
        ...ifNewer('animal_tracking', 'position_at', ['lat', 'lng']),
        ...ifNewer('animal_tracking', 'temperature_at', ['temperature_c']),
        ...ifNewer('animal_tracking', 'activity_at', ['activity']),
        lastReadingAt: sql`greatest(animal_tracking.last_reading_at, excluded.last_reading_at)`,
        updatedAt: new Date(),
      },
    });
}
