/**
 * Pretend to be a LoRaWAN network server, so the flock map can be tried before any collar arrives.
 * Posts collar and bolus readings through the public ingest endpoint with an API key, exactly as a
 * vendor bridge would. For development and demos only: it invents its readings.
 *
 *   pnpm --filter @yap/api tracking:simulate -- --key yap_... --list trackers.csv
 *       [--url http://localhost:4000] [--centre 39.5,64.8] [--every 60] [--backfill 24] [--once]
 *
 * `--list` is the same list "Import trackers" takes: one `DevEUI[, kind][, ear tag]` per line.
 * The first collar wanders off, the second stands still all day, the third runs low on battery,
 * and the first bolus runs a fever after an hour, so every alert can be seen.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    key: { type: 'string' },
    list: { type: 'string' },
    url: { type: 'string', default: 'http://localhost:4000' },
    centre: { type: 'string', default: '39.5,64.8' },
    every: { type: 'string', default: '60' },
    backfill: { type: 'string', default: '0' },
    once: { type: 'boolean', default: false },
  },
});

if (!values.key || !values.list) {
  console.error('Usage: tracking:simulate -- --key <events:write key> --list <trackers.csv> [--url] [--centre lat,lng] [--every s] [--backfill h] [--once]');
  process.exit(1);
}

interface Tracker {
  externalId: string;
  kind: 'collar' | 'bolus' | 'ear_tag';
}

const KINDS = new Set(['collar', 'bolus', 'ear_tag']);
const trackers: Tracker[] = readFileSync(values.list, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.split(/[,;\t]/).map((c) => c.trim()))
  .filter((cells) => /^[0-9a-f:\- ]{16,23}$/i.test(cells[0] ?? ''))
  .map((cells) => ({ externalId: cells[0]!, kind: (KINDS.has(cells[1]?.toLowerCase() ?? '') ? cells[1]!.toLowerCase() : 'collar') as Tracker['kind'] }));
if (trackers.length === 0) {
  console.error(`No DevEUI found in ${values.list}`);
  process.exit(1);
}

const [centreLat, centreLng] = values.centre.split(',').map(Number) as [number, number];
const everyS = Math.max(10, Number(values.every));
const M_PER_DEG_LAT = 111_195;
const mPerDegLng = M_PER_DEG_LAT * Math.cos((centreLat * Math.PI) / 180);

/** Seeded, so two runs tell the same story. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = random(2026);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());

const collars = trackers.filter((t) => t.kind !== 'bolus');
const boluses = trackers.filter((t) => t.kind === 'bolus');
const stray = collars[0]?.externalId;
const still = collars[1]?.externalId;
const lowBattery = collars[2]?.externalId;
const feverish = boluses[0]?.externalId;

/** Each sheep's place in the flock, metres east and north of its centre. */
const offset = new Map(collars.map((c) => [c.externalId, { x: gauss() * 40, y: gauss() * 40 }]));
const battery = new Map(trackers.map((t) => [t.externalId, t.externalId === lowBattery ? 22 : 90 + rnd() * 10]));
const started = Date.now();

const tashkentHour = (at: number) => (new Date(at).getUTCHours() + 5) % 24;
const daytime = (at: number) => tashkentHour(at) >= 7 && tashkentHour(at) < 20;

/** The flock grazes slowly round a 300 m loop by day and rests by night. */
function flockCentre(at: number) {
  const angle = (at / 3_600_000) * 0.35;
  return { x: 300 * Math.cos(angle), y: 300 * Math.sin(angle) };
}

function step(at: number) {
  const centre = flockCentre(at);
  const day = daytime(at);
  const readings: Record<string, unknown>[] = [];
  const hoursIn = (at - started) / 3_600_000;
  for (const c of collars) {
    const o = offset.get(c.externalId)!;
    if (c.externalId !== still || !day) {
      o.x = o.x * 0.9 + gauss() * (day ? 8 : 2);
      o.y = o.y * 0.9 + gauss() * (day ? 8 : 2);
    }
    let x = centre.x + o.x;
    let y = centre.y + o.y;
    if (c.externalId === still && day) [x, y] = [o.x, o.y]; // left behind where the flock was at dawn
    if (c.externalId === stray) y += Math.min(900, Math.max(0, hoursIn + 1) * 400);
    battery.set(c.externalId, Math.max(1, battery.get(c.externalId)! - 0.002));
    readings.push({
      externalId: c.externalId,
      recordedAt: new Date(at).toISOString(),
      lat: centreLat + y / M_PER_DEG_LAT,
      lng: centreLng + x / mPerDegLng,
      activity: c.externalId === still && day ? 1 + rnd() * 2 : day ? 30 + rnd() * 30 : 5 + rnd() * 8,
      batteryPct: Math.round(battery.get(c.externalId)! * 10) / 10,
    });
  }
  for (const b of boluses) {
    const fever = b.externalId === feverish && at - started > 3_600_000 ? 1.6 : 0;
    const drinking = rnd() < 0.05 ? -1.5 : 0; // cold water drops the rumen for a while
    battery.set(b.externalId, Math.max(1, battery.get(b.externalId)! - 0.001));
    readings.push({
      externalId: b.externalId,
      recordedAt: new Date(at).toISOString(),
      temperatureC: Math.round((39.1 + gauss() * 0.15 + fever + drinking) * 100) / 100,
      batteryPct: Math.round(battery.get(b.externalId)! * 10) / 10,
    });
  }
  return readings;
}

async function post(readings: Record<string, unknown>[]) {
  for (let i = 0; i < readings.length; i += 500) {
    const res = await fetch(`${values.url}/api/v1/tracking/readings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': values.key! },
      body: JSON.stringify({ readings: readings.slice(i, i + 500) }),
    });
    const body = (await res.json().catch(() => null)) as { data?: { accepted: number; unknown: string[] }; error?: { message: string } } | null;
    if (!res.ok) throw new Error(`${res.status}: ${body?.error?.message ?? 'no answer'}`);
    if (body?.data?.unknown.length) console.warn(`Not registered on this farm: ${body.data.unknown.slice(0, 5).join(', ')}${body.data.unknown.length > 5 ? '…' : ''}`);
  }
}

async function main() {
  const backfillMs = Number(values.backfill) * 3_600_000;
  if (backfillMs > 0) {
    let batch: Record<string, unknown>[] = [];
    for (let at = Date.now() - backfillMs; at < Date.now(); at += everyS * 1000) {
      batch.push(...step(at));
      if (batch.length >= 2000) {
        await post(batch);
        batch = [];
      }
    }
    await post(batch);
    console.info(`Backfilled ${values.backfill} h for ${trackers.length} trackers.`);
  }
  await post(step(Date.now()));
  console.info(`${new Date().toISOString()} sent ${trackers.length} readings`);
  if (values.once) return;
  setInterval(() => {
    post(step(Date.now()))
      .then(() => console.info(`${new Date().toISOString()} sent ${trackers.length} readings`))
      .catch((e: unknown) => console.error(e instanceof Error ? e.message : e));
  }, everyS * 1000);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
