import { and, asc, desc, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DEVICE_STATUSES, DEVICE_TYPES, SEVERITIES } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { seal, sha256 } from '../../core/crypto';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { raiseAlert, resolveByDedupKey } from '../alerts/alerts.service';
import { fromDay, toDay } from '../settings/audit.service';

const { apiKeys, devices, events, facilities, tenants } = schema;

type Device = typeof devices.$inferSelect;

/** Minutes without a signal before a device counts as offline, unless it sets its own. */
export const DEFAULT_OFFLINE_MINUTES = 10;

/**
 * Frames of one event come seconds apart, or once a minute from a slow reporter. Past this gap it is
 * a new event, even if the last one was acknowledged, and someone must hear about it now.
 */
const EVENT_BURST_MS = 2 * 60_000;

export const CAMERA_ZONES = ['barn', 'feed_store', 'gate', 'pump'] as const;
export type CameraZone = (typeof CAMERA_ZONES)[number];

/** Spec 25.3: 9 to 11 cameras. */
export const CAMERA_PLAN: { zone: CameraZone; min: number; max: number }[] = [
  { zone: 'barn', min: 4, max: 6 },
  { zone: 'feed_store', min: 2, max: 2 },
  { zone: 'gate', min: 2, max: 2 },
  { zone: 'pump', min: 1, max: 1 },
];

/** Uzbek titles for the standard event types; other types show as sent. */
const EVENT_TITLES: Record<string, string> = {
  smoke: "Tutun belgisi aniqlandi",
  fire: "Yong'in belgisi aniqlandi",
  person: 'Ish vaqtidan tashqari odam aniqlandi',
  vehicle: 'Notanish transport aniqlandi',
  gate_open: 'Darvoza ochildi',
  inactivity: 'Uzoq vaqt harakatsiz hayvon',
  isolation: 'Podadan ajralib qolgan hayvon',
  lambing_activity: 'Qo\'zilash belgilari',
  trough_empty: "Oxur bo'sh",
  animal_count: 'Hayvonlar soni reyestrga mos emas',
};

const httpUrl = z.url({ protocol: /^https?$/ }).max(500);

export const deviceInput = z.object({
  id: clientId,
  type: z.enum(DEVICE_TYPES),
  name: z.string().trim().min(2).max(120),
  facilityId: z.uuid().nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  /** RTSP or NVR address. Any user:password in it is sealed and removed from the stored URL. */
  streamUrl: z.string().trim().max(500).nullish(),
  onvifUrl: z.string().trim().max(500).nullish(),
  status: z.enum(DEVICE_STATUSES).optional(),
  apiKeyId: z.uuid().nullish(),
  zone: z.enum(CAMERA_ZONES).nullish(),
  /** Browser-playable address from a stream gateway such as MediaMTX: HLS, MP4 or an embed page. */
  liveUrl: httpUrl.nullish(),
  offlineAfterMinutes: z.number().int().min(1).max(1440).nullish(),
  notes: z.string().max(1000).nullish(),
});
export type DeviceInput = z.infer<typeof deviceInput>;

export const deviceListQuery = listQuery.extend({
  type: z.enum(DEVICE_TYPES).optional(),
  status: z.enum(DEVICE_STATUSES).optional(),
});

/** Standard event format (docs/device-events.md). */
export const deviceEvent = z.object({
  deviceId: z.uuid(),
  type: z.string().regex(/^[a-z0-9_.-]+$/).max(64),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  severity: z.enum(SEVERITIES).default('info'),
  data: z.record(z.string(), z.unknown()).default({}),
  snapshotUrl: httpUrl.optional(),
});
export type DeviceEvent = z.infer<typeof deviceEvent>;

export const heartbeatInput = z.object({ deviceId: z.uuid() });

export const eventFeedQuery = listQuery.extend({
  deviceId: z.uuid().optional(),
  type: z.string().max(64).optional(),
  severity: z.enum(SEVERITIES).optional(),
  source: z.enum(['camera', 'sensor']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/**
 * Cameras share the alerts engine's `camera_offline` rule, so one outage is one alert whichever
 * side finds it first, and it has that rule's translated text. The engine covers cameras only,
 * so other devices get their own rule key.
 */
const offlineRule = (device: Pick<Device, 'type'>) => (device.type === 'camera' ? 'camera_offline' : 'device_offline');
const offlineKey = (device: Pick<Device, 'id' | 'type'>) => `${offlineRule(device)}:${device.id}`;

/** Passwords must not sit in plain text in the table, backups or the audit log (spec 16.1). */
function sealStreamUrl(raw: string): { streamUrl: string; streamCredentials?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('INVALID_STREAM_URL', 'This stream address is not valid');
  }
  if (!url.username && !url.password) return { streamUrl: raw };
  const streamCredentials = seal(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`);
  url.username = '';
  url.password = '';
  return { streamUrl: url.toString(), streamCredentials };
}

function assertNoCredentials(raw: string | null | undefined): void {
  if (!raw) return;
  try {
    const url = new URL(raw);
    if (!url.username && !url.password) return;
  } catch {
    // Reported below as an invalid address.
  }
  throw badRequest('INVALID_STREAM_URL', 'Put the address here without a user name or password');
}

function present(row: Device) {
  const { streamCredentials, config, ...rest } = row;
  return {
    ...rest,
    hasStreamCredentials: !!streamCredentials,
    zone: (config.zone as CameraZone | undefined) ?? null,
    liveUrl: (config.liveUrl as string | undefined) ?? null,
    offlineAfterMinutes: (config.offlineAfterMinutes as number | undefined) ?? null,
  };
}

/** Foreign keys do not see RLS, so a linked id must be checked against this farm explicitly. */
async function assertLinksBelongToFarm(input: Partial<DeviceInput>): Promise<void> {
  const { farmId } = ctx();
  if (input.facilityId) {
    const [row] = await tx()
      .select({ id: facilities.id })
      .from(facilities)
      .where(and(eq(facilities.id, input.facilityId), eq(facilities.farmId, farmId)));
    if (!row) throw notFound('Facility');
  }
  if (input.apiKeyId) {
    const [row] = await tx()
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, input.apiKeyId), eq(apiKeys.farmId, farmId)));
    if (!row) throw notFound('API key');
  }
}

export async function list(q: z.infer<typeof deviceListQuery>) {
  const where = and(
    eq(devices.farmId, ctx().farmId),
    q.type ? eq(devices.type, q.type) : undefined,
    q.status ? eq(devices.status, q.status) : undefined,
    searchAny(q.search, [devices.name]),
  );
  const page = await paged(q, devices, where, (limit, offset) =>
    tx()
      .select()
      .from(devices)
      .where(where)
      .orderBy(...sortBy(q.sort, { name: devices.name, status: devices.status, lastSeenAt: devices.lastSeenAt }, asc(devices.name), devices.id))
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: page.data.map(present) };
}

async function getRow(id: string): Promise<Device> {
  const [row] = await tx()
    .select()
    .from(devices)
    .where(and(eq(devices.id, id), eq(devices.farmId, ctx().farmId)));
  if (!row) throw notFound('Device');
  return row;
}

export const get = async (id: string) => present(await getRow(id));

function configFrom(input: Partial<DeviceInput>, existing: Record<string, unknown> = {}) {
  const config = { ...existing };
  for (const key of ['zone', 'liveUrl', 'offlineAfterMinutes'] as const) {
    if (input[key] === undefined) continue;
    if (input[key] === null) delete config[key];
    else config[key] = input[key];
  }
  return config;
}

export async function create(input: DeviceInput) {
  await assertLinksBelongToFarm(input);
  assertNoCredentials(input.onvifUrl);
  const c = ctx();
  const { id, zone: _zone, liveUrl: _live, offlineAfterMinutes: _minutes, streamUrl, ...values } = input;
  const [row] = await tx()
    .insert(devices)
    .values({
      ...(id ? { id } : {}),
      ...values,
      ...(streamUrl ? sealStreamUrl(streamUrl) : {}),
      config: configFrom(input),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
    })
    .returning();
  await recordEvent({ type: 'device.created', entityType: 'device', entityId: row.id, data: { name: row.name, type: row.type } });
  return present(row);
}

export async function update(id: string, input: Partial<DeviceInput>) {
  const existing = await getRow(id);
  await assertLinksBelongToFarm(input);
  assertNoCredentials(input.onvifUrl);
  const { id: _id, zone: _zone, liveUrl: _live, offlineAfterMinutes: _minutes, streamUrl, ...values } = input;

  const stream =
    streamUrl === undefined
      ? {}
      : streamUrl
        ? // A URL without credentials keeps the stored ones: the form shows the URL without them.
          sealStreamUrl(streamUrl)
        : { streamUrl: null, streamCredentials: null };

  const [row] = await tx()
    .update(devices)
    .set({ ...values, ...stream, config: configFrom(input, existing.config) })
    .where(eq(devices.id, id))
    .returning();
  return present(row);
}

export async function remove(id: string) {
  const row = await getRow(id);
  await tx().delete(devices).where(eq(devices.id, id));
  await resolveByDedupKey(offlineKey(row));
  await recordEvent({ type: 'device.removed', entityType: 'device', entityId: id, data: { name: row.name } });
  return { id };
}

/** The camera layout from spec 25.3 against what is actually registered. */
export async function plan() {
  const rows = await tx()
    .select({
      zone: sql<string | null>`${devices.config}->>'zone'`,
      registered: sql<number>`count(*)`.mapWith(Number),
      online: sql<number>`count(*) filter (where ${devices.status} = 'online')`.mapWith(Number),
    })
    .from(devices)
    .where(and(eq(devices.farmId, ctx().farmId), eq(devices.type, 'camera')))
    .groupBy(sql`${devices.config}->>'zone'`);
  const byZone = new Map(rows.map((r) => [r.zone, r]));
  return CAMERA_PLAN.map((p) => ({
    ...p,
    registered: byZone.get(p.zone)?.registered ?? 0,
    online: byZone.get(p.zone)?.online ?? 0,
  }));
}

// ─── Ingest ─────────────────────────────────────────────────────────────────

async function loadDevices(ids: string[]): Promise<Map<string, Device>> {
  // Keys skip the member checks in the guard, so a suspended workspace must be stopped here.
  const [tenant] = await tx().select({ status: tenants.status }).from(tenants).where(eq(tenants.id, ctx().tenantId));
  if (tenant?.status !== 'active') throw forbidden('This workspace is suspended', 'TENANT_SUSPENDED');
  const rows = await tx()
    .select()
    .from(devices)
    .where(and(eq(devices.farmId, ctx().farmId), inArray(devices.id, ids)));
  return new Map(rows.map((d) => [d.id, d]));
}

/** The id of the key making this request, for devices bound to one key. */
async function callerKeyId(rawKey: string): Promise<string | null> {
  const [row] = await tx().select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.keyHash, sha256(rawKey)));
  return row?.id ?? null;
}

const eventRejection = (e: DeviceEvent, device: Device | undefined, keyId: string | null): string | null => {
  if (!device) return 'DEVICE_NOT_FOUND';
  if (device.apiKeyId && device.apiKeyId !== keyId) return 'DEVICE_KEY_MISMATCH';
  // A wrong device clock must not put events into next year's reports.
  if (e.occurredAt && Date.parse(e.occurredAt) > Date.now() + 86_400_000) return 'INVALID_EVENT_TIME';
  return null;
};

async function store(device: Device, e: DeviceEvent): Promise<void> {
  const source = device.type === 'camera' ? 'camera' : 'sensor';
  await recordEvent({
    type: e.type.includes('.') ? e.type : `${source}.${e.type}`,
    severity: e.severity,
    source,
    entityType: 'device',
    entityId: device.id,
    deviceId: device.id,
    occurredAt: e.occurredAt ? new Date(e.occurredAt) : undefined,
    data: { ...e.data, ...(e.snapshotUrl ? { snapshotUrl: e.snapshotUrl } : {}), deviceName: device.name },
  });

  if (e.severity === 'urgent') {
    const label = EVENT_TITLES[e.type.split('.').pop()!] ?? e.type;
    await raiseAlert({
      ruleKey: 'device_event',
      // One alert per device and type while it is open: a burst of smoke frames is one problem.
      dedupKey: `device_event:${device.id}:${e.type}`,
      newAfterMs: EVENT_BURST_MS,
      severity: 'urgent',
      title: `${device.name}: ${label}`,
      link: '/cameras',
      entityType: 'device',
      entityId: device.id,
      source: 'device',
      data: { deviceName: device.name, eventType: e.type, ...(e.snapshotUrl ? { snapshotUrl: e.snapshotUrl } : {}) },
    });
  }
}

/**
 * Record that devices are alive. A signal every few seconds is telemetry, not a change anyone
 * edited, so the audit trigger is off for this one statement and on again straight after.
 */
async function markSeen(seen: Device[]): Promise<void> {
  if (seen.length === 0) return;
  const now = new Date();
  await tx().execute(sql`select set_config('app.skip_audit', 'on', true)`);
  await tx()
    .update(devices)
    .set({ lastSeenAt: now, status: 'online' })
    .where(inArray(devices.id, seen.map((d) => d.id)));
  await tx().execute(sql`select set_config('app.skip_audit', 'off', true)`);

  for (const device of seen.filter((d) => d.status === 'offline')) {
    await resolveByDedupKey(offlineKey(device));
    await recordEvent({ type: 'device.online', entityType: 'device', entityId: device.id, deviceId: device.id, source: 'system', data: { name: device.name } });
  }
}

const codeMessage: Record<string, string> = {
  DEVICE_NOT_FOUND: 'Device not found',
  DEVICE_KEY_MISMATCH: 'This key is not bound to this device',
  INVALID_EVENT_TIME: 'The event time is in the future',
};

function rejectionError(code: string) {
  const message = codeMessage[code];
  if (code === 'DEVICE_NOT_FOUND') return notFound('Device');
  if (code === 'DEVICE_KEY_MISMATCH') return forbidden(message, code);
  return badRequest(code, message);
}

export async function ingest(e: DeviceEvent, rawKey: string) {
  const known = await loadDevices([e.deviceId]);
  const device = known.get(e.deviceId);
  const rejection = eventRejection(e, device, await callerKeyId(rawKey));
  if (rejection) throw rejectionError(rejection);
  await store(device!, e);
  await markSeen([device!]);
  return { accepted: true };
}

/** One bad event must not lose the rest of an offline buffer, so failures are reported per event. */
export async function ingestBatch(batch: DeviceEvent[], rawKey: string) {
  const known = await loadDevices([...new Set(batch.map((e) => e.deviceId))]);
  const keyId = await callerKeyId(rawKey);
  const seen = new Map<string, Device>();
  const rejected: { index: number; code: string }[] = [];
  for (const [index, e] of batch.entries()) {
    const device = known.get(e.deviceId);
    const code = eventRejection(e, device, keyId);
    if (code) {
      rejected.push({ index, code });
      continue;
    }
    await store(device!, e);
    seen.set(device!.id, device!);
  }
  await markSeen([...seen.values()]);
  return { accepted: batch.length - rejected.length, rejected };
}

export async function heartbeat(deviceId: string, rawKey: string) {
  const device = (await loadDevices([deviceId])).get(deviceId);
  if (!device) throw notFound('Device');
  if (device.apiKeyId && device.apiKeyId !== (await callerKeyId(rawKey))) {
    throw rejectionError('DEVICE_KEY_MISMATCH');
  }
  await markSeen([device]);
  return { status: 'online' };
}

export async function eventFeed(q: z.infer<typeof eventFeedQuery>) {
  const where = and(
    eq(events.farmId, ctx().farmId),
    q.source ? eq(events.source, q.source) : inArray(events.source, ['camera', 'sensor']),
    // The platform's own note that an alert was raised is not something a device reported.
    ne(events.type, 'alert.raised'),
    q.deviceId ? eq(events.deviceId, q.deviceId) : undefined,
    q.type ? eq(events.type, q.type) : undefined,
    q.severity ? eq(events.severity, q.severity) : undefined,
    fromDay(events.occurredAt, q.from),
    toDay(events.occurredAt, q.to),
  );
  return paged(q, events, where, (limit, offset) =>
    tx()
      .select({
        id: events.id,
        occurredAt: events.occurredAt,
        source: events.source,
        type: events.type,
        severity: events.severity,
        deviceId: events.deviceId,
        deviceName: devices.name,
        data: events.data,
      })
      .from(events)
      .leftJoin(devices, eq(devices.id, events.deviceId))
      .where(where)
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(limit)
      .offset(offset),
  );
}

/** Spec 16.2: warn when a device stops reporting. Runs as a job, once per farm. */
export async function detectOffline(now: Date = new Date()): Promise<number> {
  const rows = await tx()
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.farmId, ctx().farmId),
        eq(devices.status, 'online'),
        isNotNull(devices.lastSeenAt),
        lt(devices.lastSeenAt, now),
      ),
    );
  let count = 0;
  for (const device of rows) {
    const minutes = (device.config.offlineAfterMinutes as number | undefined) ?? DEFAULT_OFFLINE_MINUTES;
    if (now.getTime() - device.lastSeenAt!.getTime() < minutes * 60_000) continue;
    await tx().update(devices).set({ status: 'offline' }).where(eq(devices.id, device.id));
    await recordEvent({
      type: 'device.offline',
      severity: 'attention',
      entityType: 'device',
      entityId: device.id,
      deviceId: device.id,
      source: 'system',
      data: { name: device.name, lastSeenAt: device.lastSeenAt!.toISOString() },
    });
    const camera = device.type === 'camera';
    await raiseAlert({
      ruleKey: offlineRule(device),
      dedupKey: offlineKey(device),
      severity: 'attention',
      title: camera ? `Kamera oflayn: ${device.name}` : `${device.name} aloqada emas`,
      body: camera ? 'Kamera ulanishini tekshiring.' : `${minutes} daqiqadan beri signal yo'q`,
      link: '/cameras',
      entityType: 'device',
      entityId: device.id,
      source: camera ? 'rule' : 'device',
      data: camera ? { camera: device.name } : { deviceName: device.name, minutes },
    });
    count += 1;
  }
  return count;
}
