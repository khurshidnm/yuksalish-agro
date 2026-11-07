/**
 * Turn what a LoRaWAN network server posts into readings (docs/tracking.md). Pure, so every vendor's
 * quirk can be pinned by a test.
 *
 * The network server's codec decodes the radio payload into an object, and every vendor names its
 * fields differently, so known names are tried in turn and `config.fieldMap` on the device can point
 * at any other. A value that cannot be right is dropped (null), never stored as 0: a collar without
 * a GPS fix often reports 0,0, and that is a spot in the Gulf of Guinea, not a sheep.
 */
import type { TrackerKind } from '../devices/devices.service';

export interface ReadingFields {
  lat: number | null;
  lng: number | null;
  activity: number | null;
  temperatureC: number | null;
  batteryPct: number | null;
}

/** One message from a tracker, before the device it came from is known. */
export interface RawUplink {
  externalId: string;
  recordedAt: Date;
  /** The codec's decoded object, read once the device's kind and field map are known. */
  object?: Record<string, unknown>;
  /** Values the message already names, such as a status event's battery or a solved location. */
  fields?: Partial<ReadingFields>;
  rssi?: number | null;
  snr?: number | null;
  gatewayId?: string | null;
}

export type FieldMap = Partial<Record<keyof ReadingFields, string>>;

const EMPTY: ReadingFields = { lat: null, lng: null, activity: null, temperatureC: null, batteryPct: null };

/** A DevEUI in any common spelling becomes 16 upper-case hex digits; other ids pass trimmed. */
export function normalizeExternalId(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  const hex = text.replace(/[\s:-]/g, '');
  if (/^[0-9a-f]{16}$/i.test(hex)) return hex.toUpperCase();
  return /^[A-Za-z0-9_.-]{4,64}$/.test(text) ? text : null;
}

const num = (value: unknown): number | null => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `a.b.c` inside an object. */
function at(object: Record<string, unknown>, path: string): unknown {
  let value: unknown = object;
  for (const key of path.split('.')) {
    if (!isObject(value)) return undefined;
    value = value[key];
  }
  return value;
}

/** Codecs often nest the position. These containers are searched after the top level. */
const CONTAINERS = ['gps', 'gnss', 'location', 'position', 'data', 'payload'];

function first(object: Record<string, unknown>, names: readonly string[]): unknown {
  const scopes = [object, ...CONTAINERS.map((c) => object[c]).filter(isObject)];
  for (const scope of scopes) {
    for (const name of names) {
      if (scope[name] !== undefined && scope[name] !== null) return scope[name];
    }
  }
  return undefined;
}

const ALIASES = {
  lat: ['latitude', 'lat', 'gpsLatitude', 'Latitude'],
  lng: ['longitude', 'lng', 'lon', 'long', 'gpsLongitude', 'Longitude'],
  activity: ['activity', 'activityCount', 'activityLevel', 'steps', 'stepCount', 'motion', 'motionCount', 'act'],
  temperatureC: ['bodyTemperature', 'rumenTemperature', 'rumenTemp', 'temperature', 'temp', 'temperatureC'],
  batteryPct: ['batteryPct', 'batteryPercent', 'batteryLevel', 'battery_level', 'battery', 'bat'],
} as const;

/** A codec that says the GPS has no fix: its position, if any, is stale or made up. */
const FIX_FLAGS = ['fix', 'gnssFix', 'gpsFix', 'valid', 'gpsValid', 'positionValid'];

/** Keep only values that can be right. */
export function plausible(fields: Partial<ReadingFields>): ReadingFields {
  const lat = num(fields.lat);
  const lng = num(fields.lng);
  const position =
    lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6);
  const temperatureC = num(fields.temperatureC);
  const batteryPct = num(fields.batteryPct);
  const activity = num(fields.activity);
  return {
    lat: position ? lat : null,
    lng: position ? lng : null,
    activity: activity !== null && activity >= 0 ? activity : null,
    // A living sheep is about 38.5-40 °C; outside 30-45 the sensor is out of the animal or broken.
    temperatureC: temperatureC !== null && temperatureC >= 30 && temperatureC <= 45 ? temperatureC : null,
    batteryPct: batteryPct !== null && batteryPct >= 0 && batteryPct <= 100 ? batteryPct : null,
  };
}

/**
 * Read a codec's object for a device. A collar's or an ear tag's "temperature" is the air around it,
 * not the sheep, so body temperature is taken by name only from a bolus, or wherever `fieldMap` says.
 * A battery under 5 with a fraction is volts, not percent, and is left out unless mapped.
 */
export function decodeObject(object: Record<string, unknown>, kind: TrackerKind, fieldMap: FieldMap = {}): ReadingFields {
  const pick = (key: keyof ReadingFields, names: readonly string[]) =>
    fieldMap[key] !== undefined ? at(object, fieldMap[key]!) : names.length ? first(object, names) : undefined;

  const noFix = FIX_FLAGS.some((flag) => {
    const value = first(object, [flag]);
    return value === false || value === 0 || value === 'false';
  });
  const battery = pick('batteryPct', ALIASES.batteryPct);
  const batteryNum = num(battery);
  const looksLikeVolts = fieldMap.batteryPct === undefined && batteryNum !== null && batteryNum < 5 && !Number.isInteger(batteryNum);

  return plausible({
    lat: noFix ? null : (pick('lat', ALIASES.lat) as number),
    lng: noFix ? null : (pick('lng', ALIASES.lng) as number),
    activity: pick('activity', ALIASES.activity) as number,
    temperatureC: pick('temperatureC', kind === 'bolus' ? ALIASES.temperatureC : []) as number,
    batteryPct: looksLikeVolts ? null : batteryNum,
  });
}

/** The fields of one uplink for a known device: the codec's object first, then what the message named. */
export function readingFields(raw: RawUplink, kind: TrackerKind, fieldMap?: FieldMap): ReadingFields {
  const decoded = raw.object ? decodeObject(raw.object, kind, fieldMap) : EMPTY;
  const named = plausible(raw.fields ?? {});
  return {
    lat: decoded.lat ?? named.lat,
    lng: decoded.lat !== null ? decoded.lng : named.lng,
    activity: decoded.activity ?? named.activity,
    temperatureC: decoded.temperatureC ?? named.temperatureC,
    batteryPct: decoded.batteryPct ?? named.batteryPct,
  };
}

export const hasData = (f: ReadingFields) => Object.values(f).some((v) => v !== null);

const time = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
};

/** The strongest of the gateways that heard it. */
function bestSignal(list: unknown, gateway: (r: Record<string, unknown>) => unknown) {
  const heard = (Array.isArray(list) ? list : []).filter(isObject);
  const best = heard.reduce<Record<string, unknown> | null>((b, r) => ((num(r.rssi) ?? -999) > (num(b?.rssi) ?? -999) ? r : b), null);
  if (!best) return {};
  const id = gateway(best);
  return { rssi: num(best.rssi), snr: num(best.snr), gatewayId: typeof id === 'string' ? id : null };
}

export type Adapted = { uplink: RawUplink } | { ignored: string } | { invalid: string };

/**
 * ChirpStack v4 HTTP integration, JSON encoding: `POST …?event=up|status|location`.
 * `up` carries the codec's `object`; `status` the battery in percent; `location` a solved position.
 */
export function fromChirpstack(event: string | undefined, body: unknown): Adapted {
  if (!isObject(body)) return { invalid: 'body' };
  if (event !== 'up' && event !== 'status' && event !== 'location') return { ignored: event ?? 'none' };
  const device = isObject(body.deviceInfo) ? body.deviceInfo : {};
  const externalId = normalizeExternalId(device.devEui);
  if (!externalId) return { invalid: 'deviceInfo.devEui' };
  const recordedAt = time(body.time) ?? new Date();

  if (event === 'status') {
    if (body.batteryLevelUnavailable === true || body.externalPowerSource === true) return { ignored: 'status' };
    return { uplink: { externalId, recordedAt, fields: { batteryPct: num(body.batteryLevel) } } };
  }
  if (event === 'location') {
    const location = isObject(body.location) ? body.location : {};
    return { uplink: { externalId, recordedAt, fields: { lat: num(location.latitude), lng: num(location.longitude) } } };
  }
  return {
    uplink: {
      externalId,
      recordedAt,
      object: isObject(body.object) ? body.object : undefined,
      ...bestSignal(body.rxInfo, (r) => r.gatewayId),
    },
  };
}

/**
 * The Things Stack webhook: an uplink message, or a solved location. Any other message type the
 * webhook was set to send is ignored.
 */
export function fromTheThingsStack(body: unknown): Adapted {
  if (!isObject(body)) return { invalid: 'body' };
  const ids = isObject(body.end_device_ids) ? body.end_device_ids : {};
  const externalId = normalizeExternalId(ids.dev_eui);
  if (!externalId) return { invalid: 'end_device_ids.dev_eui' };

  if (isObject(body.location_solved)) {
    const location = isObject(body.location_solved.location) ? body.location_solved.location : {};
    const recordedAt = time(body.received_at) ?? new Date();
    return { uplink: { externalId, recordedAt, fields: { lat: num(location.latitude), lng: num(location.longitude) } } };
  }
  if (!isObject(body.uplink_message)) return { ignored: 'not an uplink' };
  const up = body.uplink_message;
  const battery = isObject(up.last_battery_percentage) ? num(up.last_battery_percentage.value) : null;
  return {
    uplink: {
      externalId,
      recordedAt: time(up.received_at) ?? time(body.received_at) ?? new Date(),
      object: isObject(up.decoded_payload) ? up.decoded_payload : undefined,
      fields: { batteryPct: battery },
      ...bestSignal(up.rx_metadata, (r) => (isObject(r.gateway_ids) ? r.gateway_ids.gateway_id : undefined)),
    },
  };
}
