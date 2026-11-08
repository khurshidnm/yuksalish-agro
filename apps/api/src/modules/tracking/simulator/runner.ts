/**
 * Delivers the world's messages to AgroPanel as a network server would: live, one ChirpStack `up`
 * event per uplink through the real ingest endpoint; history, in batches through the readings
 * endpoint, as a vendor bridge sends what it buffered.
 */
import { randomUUID } from 'node:crypto';
import { INTERVAL_MS, unit, type Uplink, type World } from './world';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface Transport {
  post(path: string, body: unknown): Promise<{ status: number; body: unknown }>;
}

export function httpTransport(baseUrl: string, key: string): Transport {
  return {
    async post(path, body) {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: res.status, body: json };
    },
  };
}

/** A ChirpStack v4 `up` event in JSON encoding, as its HTTP integration posts it. */
export function chirpstackUp(u: Uplink, applicationName: string) {
  return {
    deduplicationId: randomUUID(),
    time: new Date(u.at).toISOString(),
    deviceInfo: {
      tenantId: 'simulation',
      tenantName: 'AgroPanel simulation',
      applicationId: 'flock',
      applicationName,
      deviceProfileId: u.kind,
      deviceProfileName: u.kind === 'collar' ? 'GPS collar (simulated)' : 'Rumen bolus (simulated)',
      deviceName: `${u.kind} ${u.tag}`,
      devEui: u.devEui.toLowerCase(),
      tags: { tag: u.tag },
    },
    devAddr: u.devEui.slice(-8).toLowerCase(),
    adr: true,
    dr: 3,
    fCnt: u.fCnt,
    fPort: u.kind === 'collar' ? 2 : 3,
    confirmed: false,
    object: u.object,
    rxInfo: u.rxInfo.map((r) => ({ gatewayId: r.gatewayId, uplinkId: Math.floor(unit(u.devEui, u.at, r.gatewayId) * 65535), rssi: r.rssi, snr: r.snr })),
    txInfo: { frequency: 868_100_000 + 200_000 * (u.fCnt % 3), modulation: { lora: { bandwidth: 125_000, spreadingFactor: 9, codeRate: 'CR_4_5' } } },
  };
}

/** A ChirpStack `status` event: once a day the network server asks each device for its battery. */
export function chirpstackStatus(devEui: string, tag: string, at: number, batteryLevel: number, applicationName: string) {
  return {
    deduplicationId: randomUUID(),
    time: new Date(at).toISOString(),
    deviceInfo: { tenantId: 'simulation', applicationId: 'flock', applicationName, deviceName: tag, devEui: devEui.toLowerCase() },
    margin: 8,
    externalPowerSource: false,
    batteryLevelUnavailable: false,
    batteryLevel: Math.round(batteryLevel * 10) / 10,
  };
}

/** An uplink in AgroPanel's own batch format, heard by its strongest gateway. */
export function toReading(u: Uplink) {
  const best = u.rxInfo.reduce((a, b) => (b.rssi > a.rssi ? b : a));
  const o = u.object as Record<string, number | boolean | undefined>;
  const fix = u.kind === 'collar' && o.gnssFix !== false;
  return {
    externalId: u.devEui,
    recordedAt: new Date(u.at).toISOString(),
    lat: fix ? (o.latitude as number) : null,
    lng: fix ? (o.longitude as number) : null,
    activity: u.kind === 'collar' ? ((o.activity as number) ?? null) : null,
    temperatureC: u.kind === 'bolus' ? ((o.temperature as number) ?? null) : null,
    batteryPct: (o.battery as number) ?? null,
    rssi: best.rssi,
    snr: best.snr,
    gatewayId: best.gatewayId,
  };
}

/** Run `fn` over `items`, `width` at a time. */
async function inParallel<T>(items: T[], width: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

export type Log = (line: string) => void;

/** History from `from` to `to`, two hours of farm life at a time, 500 readings per request. */
export async function backfill(world: World, transport: Transport, from: number, to: number, log: Log): Promise<number> {
  const window = 2 * HOUR;
  let sent = 0;
  let reported = from;
  const began = Date.now();
  for (let t = from; t < to; t += window) {
    const readings = world.uplinks(t, Math.min(to, t + window)).map(toReading);
    const batches: (typeof readings)[] = [];
    for (let i = 0; i < readings.length; i += 500) batches.push(readings.slice(i, i + 500));
    await inParallel(batches, 3, async (batch) => {
      // A busy server may refuse a batch for now (409 or 5xx): wait a little and send it again.
      for (let attempt = 1; ; attempt++) {
        const res = await transport.post('/api/v1/tracking/readings', { readings: batch });
        if (res.status === 200) break;
        if (attempt >= 4 || (res.status !== 409 && res.status < 500)) {
          throw new Error(`History refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
        }
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
      sent += batch.length;
    });
    if (t + window - reported >= 12 * HOUR || t + window >= to) {
      reported = t + window;
      const done = Math.min(1, (t + window - from) / (to - from));
      log(`History ${Math.round(done * 100)}%: ${sent} readings up to ${new Date(Math.min(to, t + window)).toISOString()} (${Math.round((Date.now() - began) / 1000)} s)`);
    }
  }
  return sent;
}

export interface LiveOptions {
  tickMs: number;
  applicationName: string;
  log: Log;
  signal: AbortSignal;
  /** Called with each tick's end, so a supervisor can see the simulation is alive. */
  onTick?: (at: number) => void;
}

/**
 * Live: every tick, post what the flock sent since the last one, one request per uplink, four at a
 * time. A message that fails is lost, as it would be: the network server does not retry.
 */
export async function live(world: World, transport: Transport, from: number, o: LiveOptions): Promise<void> {
  let last = from;
  const stats = { sent: 0, accepted: 0, failed: 0, statuses: 0 };
  let nextReport = Date.now() + 10 * MIN;
  const devices = world.farm.sheep.flatMap((s) => [
    { devEui: s.collar, kind: 'collar' as const, tag: s.tag },
    ...(s.bolus ? [{ devEui: s.bolus, kind: 'bolus' as const, tag: s.tag }] : []),
  ]);

  while (!o.signal.aborted) {
    const now = Date.now();
    const uplinks = world.uplinks(last, now);
    // Once a day, at its own time, each device answers the network server's battery question.
    const statuses = devices.filter((d) => {
      const at = Math.floor(now / DAY) * DAY + unit(d.devEui, 'status') * DAY;
      return at > last && at <= now;
    });
    last = now;

    await inParallel(uplinks, 4, async (u) => {
      stats.sent += 1;
      try {
        const res = await transport.post('/api/v1/tracking/ingest/chirpstack?event=up', chirpstackUp(u, o.applicationName));
        if (res.status === 200) stats.accepted += 1;
        else stats.failed += 1;
      } catch {
        stats.failed += 1;
      }
    });
    await inParallel(statuses, 4, async (d) => {
      try {
        await transport.post(
          '/api/v1/tracking/ingest/chirpstack?event=status',
          chirpstackStatus(d.devEui, d.tag, now, world.batteryAt(d.devEui, d.kind, now), o.applicationName),
        );
        stats.statuses += 1;
      } catch {
        // A lost status costs one battery figure until tomorrow.
      }
    });
    o.onTick?.(now);

    if (Date.now() >= nextReport) {
      nextReport = Date.now() + 10 * MIN;
      const story = world.story(now);
      o.log(
        `Last 10 min: ${stats.sent} uplinks, ${stats.accepted} accepted, ${stats.failed} lost on the way, ${stats.statuses} battery reports. ` +
          `Flock: ${story.phase}. Strayed: ${story.strayed.join(', ') || 'none'}. Ill: ${story.ill.join(', ') || 'none'}. Collar off: ${story.collarOff.join(', ') || 'none'}.`,
      );
      stats.sent = stats.accepted = stats.failed = stats.statuses = 0;
    }
    await sleep(o.tickMs - (Date.now() - now), o.signal);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

export { INTERVAL_MS };
