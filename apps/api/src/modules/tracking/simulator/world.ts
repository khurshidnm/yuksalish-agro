/**
 * A flock wearing GPS collars and rumen boluses, as a pure function of time (docs/tracking.md).
 *
 * Nothing is remembered between calls. Where a sheep is, how warm it is, and whether its collar's
 * radio reaches a gateway at a given moment all follow from the clock and a seed. So a restart
 * resumes exactly where it stopped, and a week of history and the live minutes after it are one
 * continuous story.
 *
 * The day is a winter day at Qorovulbozor: the night in the barn, out to pasture after sunrise,
 * grazing, a midday rest at the water trough, grazing again, home before dark. On top of that,
 * what really happens to a flock: a sheep wanders off, one falls ill and lies down, a collar slips
 * off, a battery runs flat, a GPS fix fails, a bolus deep in the rumen is heard only near a gateway.
 * Rates are made up but plausible. This invents data: never run it on a farm with real trackers.
 */

const M_PER_DEG = 111_195;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface LatLng {
  lat: number;
  lng: number;
}

interface XY {
  x: number;
  y: number;
}

export interface SimGateway {
  id: string;
  at: LatLng;
}

export interface SimHerd {
  id: string;
  name: string;
  /** Where the herd spends the night. */
  pen: LatLng[];
  /** Where it grazes. */
  pasture: LatLng[];
  /** Where it drinks and rests at midday: a trough on the pasture's edge nearest the barn. */
  trough: LatLng;
}

export interface SimSheep {
  animalId: string;
  tag: string;
  herdId: string;
  collar: string;
  bolus: string | null;
}

export interface SimFarm {
  seed: string;
  /** Minutes the farm's clock is ahead of UTC (Tashkent: 300). */
  tzOffsetMin: number;
  herds: SimHerd[];
  sheep: SimSheep[];
  gateways: SimGateway[];
}

export type Kind = 'collar' | 'bolus';

export interface RxInfo {
  gatewayId: string;
  rssi: number;
  snr: number;
}

/** One radio message as the network server would decode it. */
export interface Uplink {
  devEui: string;
  kind: Kind;
  animalId: string;
  tag: string;
  at: number;
  fCnt: number;
  /** What the device profile's codec makes of the payload. */
  object: Record<string, unknown>;
  rxInfo: RxInfo[];
}

export const INTERVAL_MS: Record<Kind, number> = { collar: 15 * MIN, bolus: 30 * MIN };

// ─── Deterministic randomness ───────────────────────────────────────────────

/** FNV-1a over the parts, so the same question always gets the same answer. */
function hash(parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const text = parts.join('|');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

/** A number in [0, 1) fixed by its key. */
export const unit = (...parts: (string | number)[]) => hash(parts) / 4294967296;

/** About a normal deviate (mean 0, sd 1), fixed by its key. */
const gauss = (...parts: (string | number)[]) =>
  ((unit(...parts, 'a') + unit(...parts, 'b') + unit(...parts, 'c') + unit(...parts, 'd') - 2) / 0.577) * 1;

/** Smooth wandering in [-1, 1]: three slow waves with phases fixed by the key. */
function wave(key: string, t: number, periodMs: number): number {
  const ratios = [1, 1.73, 2.91];
  const weights = [0.55, 0.3, 0.15];
  let v = 0;
  for (let i = 0; i < 3; i++) v += weights[i]! * Math.sin((2 * Math.PI * t) / (periodMs * ratios[i]!) + unit(key, i) * 2 * Math.PI);
  return v;
}

const smoothstep = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const lerp = (a: XY, b: XY, s: number): XY => ({ x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s });

// ─── Geometry in metres around the farm ─────────────────────────────────────

interface Frame {
  origin: LatLng;
  cosLat: number;
}

const toXY = (f: Frame, p: LatLng): XY => ({ x: (p.lng - f.origin.lng) * M_PER_DEG * f.cosLat, y: (p.lat - f.origin.lat) * M_PER_DEG });
const toLatLng = (f: Frame, p: XY): LatLng => ({ lat: f.origin.lat + p.y / M_PER_DEG, lng: f.origin.lng + p.x / (M_PER_DEG * f.cosLat) });

function centroid(poly: XY[]): XY {
  return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length };
}

export function inside(poly: XY[], p: XY): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** The point itself if it is inside, else the nearest point towards the centre that is. */
function keepInside(poly: XY[], p: XY, centre: XY): XY {
  if (inside(poly, p)) return p;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (inside(poly, lerp(p, centre, mid))) hi = mid;
    else lo = mid;
  }
  return lerp(p, centre, Math.min(1, hi + 0.02));
}

function halfSize(poly: XY[]): XY {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { x: (Math.max(...xs) - Math.min(...xs)) / 2, y: (Math.max(...ys) - Math.min(...ys)) / 2 };
}

const distance = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

/** The point of a polygon's edge nearest to `p`. */
export function nearestOnEdge(poly: LatLng[], p: LatLng): LatLng {
  const f: Frame = { origin: p, cosLat: Math.cos((p.lat * Math.PI) / 180) };
  const ring = poly.map((q) => toXY(f, q));
  let best: XY = ring[0]!;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const ab = { x: b.x - a.x, y: b.y - a.y };
    const len = ab.x * ab.x + ab.y * ab.y || 1;
    const s = Math.max(0, Math.min(1, -(a.x * ab.x + a.y * ab.y) / len));
    const q = { x: a.x + ab.x * s, y: a.y + ab.y * s };
    if (Math.hypot(q.x, q.y) < Math.hypot(best.x, best.y)) best = q;
  }
  return toLatLng(f, best);
}

// ─── The day ────────────────────────────────────────────────────────────────

export type Phase = 'night' | 'out' | 'graze' | 'rest' | 'home' | 'pen';

/** Minute of the day each phase starts, in farm time. A winter day: sunrise 07:15, sunset 17:15. */
const SCHEDULE: [number, Phase][] = [
  [0, 'night'],
  [7 * 60 + 30, 'out'],
  [8 * 60 + 15, 'graze'],
  [12 * 60, 'rest'],
  [13 * 60 + 30, 'graze'],
  [16 * 60 + 30, 'home'],
  [17 * 60 + 15, 'pen'],
  [21 * 60, 'night'],
];

interface PhaseAt {
  phase: Phase;
  /** Start and end of this phase, ms. */
  from: number;
  to: number;
  /** Start of the farm's day, ms. */
  dayStart: number;
  day: number;
}

export interface Clock {
  tzOffsetMin: number;
}

function phaseAt(clock: Clock, t: number): PhaseAt {
  const shifted = t + clock.tzOffsetMin * MIN;
  const day = Math.floor(shifted / DAY);
  const dayStart = day * DAY - clock.tzOffsetMin * MIN;
  const minute = (shifted - day * DAY) / MIN;
  let i = SCHEDULE.length - 1;
  while (SCHEDULE[i]![0] > minute) i--;
  const next = SCHEDULE[i + 1]?.[0] ?? 24 * 60;
  return { phase: SCHEDULE[i]![1], from: dayStart + SCHEDULE[i]![0] * MIN, to: dayStart + next * MIN, dayStart, day };
}

const localHour = (clock: Clock, t: number) => (((t + clock.tzOffsetMin * MIN) % DAY) + DAY) % DAY / HOUR;

// ─── The world ──────────────────────────────────────────────────────────────

interface HerdFrame {
  herd: SimHerd;
  pen: XY[];
  penC: XY;
  penHalf: XY;
  pasture: XY[];
  pastureC: XY;
  pastureHalf: XY;
  trough: XY;
}

interface Stray {
  animalId: string;
  from: number;
  to: number;
  dir: XY;
  distanceM: number;
}

interface Illness {
  animalId: string;
  onset: number;
  until: number;
  peakC: number;
}

interface Drop {
  animalId: string;
  at: number;
  until: number;
}

export interface SheepState {
  animalId: string;
  tag: string;
  herdId: string;
  phase: Phase;
  /** Where the sheep is. */
  position: LatLng;
  /** Where its collar is: not the same once the collar slipped off. */
  collarAt: LatLng;
  activity: number;
  temperatureC: number;
  ill: boolean;
  strayed: boolean;
  collarOff: boolean;
}

/** The world for one farm. Build it once; every question it answers depends on the time alone. */
export class World {
  readonly farm: SimFarm;
  private frame: Frame;
  private herds: Map<string, HerdFrame>;
  private sheepByHerd: Map<string, SimSheep[]>;
  private gateways: { id: string; at: XY }[];
  private incidentCache = new Map<number, { strays: Stray[]; illnesses: Illness[]; drops: Drop[] }>();

  constructor(farm: SimFarm) {
    if (farm.herds.length === 0 || farm.sheep.length === 0) throw new Error('The simulation needs a herd with sheep in it');
    this.farm = farm;
    const first = farm.herds[0]!;
    const origin = first.pen[0]!;
    this.frame = { origin, cosLat: Math.cos((origin.lat * Math.PI) / 180) };
    this.herds = new Map(
      farm.herds.map((h) => {
        const pen = h.pen.map((p) => toXY(this.frame, p));
        const pasture = h.pasture.map((p) => toXY(this.frame, p));
        const pastureC = centroid(pasture);
        // The trough stands a little inside the pasture, so the flock rests on grass.
        const edge = toXY(this.frame, h.trough);
        const trough = lerp(edge, pastureC, Math.min(1, 40 / Math.max(1, distance(edge, pastureC))));
        return [h.id, { herd: h, pen, penC: centroid(pen), penHalf: halfSize(pen), pasture, pastureC, pastureHalf: halfSize(pasture), trough }];
      }),
    );
    this.sheepByHerd = new Map();
    for (const s of farm.sheep) this.sheepByHerd.set(s.herdId, [...(this.sheepByHerd.get(s.herdId) ?? []), s]);
    this.gateways = farm.gateways.map((g) => ({ id: g.id, at: toXY(this.frame, g.at) }));
  }

  private clock(): Clock {
    return { tzOffsetMin: this.farm.tzOffsetMin };
  }

  // ── Where the flock is ──

  /** A slow loop across the pasture, a different one each day. */
  private grazePoint(h: HerdFrame, day: number, t: number): XY {
    const key = `${this.farm.seed}:${h.herd.id}:${day}`;
    const p = {
      x: h.pastureC.x + h.pastureHalf.x * 0.55 * wave(`${key}:x`, t, 5 * HOUR),
      y: h.pastureC.y + h.pastureHalf.y * 0.55 * wave(`${key}:y`, t, 6.5 * HOUR),
    };
    return keepInside(h.pasture, p, h.pastureC);
  }

  /** The centre of the herd, and which way it is going while it walks. */
  private herdCentre(h: HerdFrame, t: number): { at: XY; heading: XY | null; p: PhaseAt } {
    const p = phaseAt(this.clock(), t);
    const s = (t - p.from) / (p.to - p.from);
    const walk = (from: XY, to: XY) => {
      const len = distance(from, to) || 1;
      return { at: lerp(from, to, smoothstep(s)), heading: { x: (to.x - from.x) / len, y: (to.y - from.y) / len }, p };
    };
    switch (p.phase) {
      case 'out':
        return walk(h.penC, this.grazePoint(h, p.day, p.to));
      case 'home':
        return walk(this.grazePoint(h, p.day, p.from), h.penC);
      case 'graze':
        return { at: this.grazePoint(h, p.day, t), heading: null, p };
      case 'rest': {
        // Twenty minutes to the trough, the rest, twenty minutes back to the grass.
        const lead = 20 * MIN;
        if (t < p.from + lead) return { at: lerp(this.grazePoint(h, p.day, p.from), h.trough, smoothstep((t - p.from) / lead)), heading: null, p };
        if (t > p.to - lead) return { at: lerp(h.trough, this.grazePoint(h, p.day, p.to), smoothstep((t - (p.to - lead)) / lead)), heading: null, p };
        return { at: h.trough, heading: null, p };
      }
      default:
        return { at: h.penC, heading: null, p };
    }
  }

  // ── What happens on a day ──

  private incidents(day: number) {
    const cached = this.incidentCache.get(day);
    if (cached) return cached;
    const seed = this.farm.seed;
    const dayStart = day * DAY - this.farm.tzOffsetMin * MIN;
    const pick = (...key: (string | number)[]) => this.farm.sheep[Math.floor(unit(seed, ...key) * this.farm.sheep.length)]!;

    const strays: Stray[] = [];
    // Most days one sheep drifts off while the flock grazes, and the shepherd brings it back.
    if (unit(seed, 'stray', day) < 0.6) {
      const morning = unit(seed, 'stray-am', day) < 0.5;
      const from = dayStart + (morning ? 9.5 * HOUR : 14 * HOUR) + unit(seed, 'stray-t', day) * HOUR;
      const angle = unit(seed, 'stray-dir', day) * 2 * Math.PI;
      strays.push({
        animalId: pick('stray-who', day).animalId,
        from,
        to: from + (1.8 + unit(seed, 'stray-len', day) * 1.2) * HOUR,
        dir: { x: Math.cos(angle), y: Math.sin(angle) },
        distanceM: 650 + unit(seed, 'stray-far', day) * 650,
      });
    }

    const illnesses: Illness[] = [];
    // About one new case every three days, three to five days long.
    for (const n of [0, 1]) {
      if (unit(seed, 'ill', day, n) < (n === 0 ? 0.3 : 0.08)) {
        const onset = dayStart + unit(seed, 'ill-t', day, n) * DAY;
        illnesses.push({
          animalId: pick('ill-who', day, n).animalId,
          onset,
          until: onset + (3 + unit(seed, 'ill-len', day, n) * 2) * DAY,
          peakC: 1.4 + unit(seed, 'ill-peak', day, n) * 0.9,
        });
      }
    }

    const drops: Drop[] = [];
    // Now and then a collar slips off on the pasture, and is found and fitted again next morning.
    if (unit(seed, 'drop', day) < 0.12) {
      drops.push({ animalId: pick('drop-who', day).animalId, at: dayStart + (10 + unit(seed, 'drop-t', day) * 5) * HOUR, until: dayStart + DAY + 9 * HOUR });
    }

    const result = { strays, illnesses, drops };
    this.incidentCache.set(day, result);
    if (this.incidentCache.size > 64) this.incidentCache.delete(this.incidentCache.keys().next().value!);
    return result;
  }

  /** Everything that touches a sheep at `t`, looking back far enough for long illnesses. */
  private touching(animalId: string, t: number) {
    const day = phaseAt(this.clock(), t).day;
    let stray: Stray | undefined;
    let illness: Illness | undefined;
    let drop: Drop | undefined;
    for (let d = day - 5; d <= day; d++) {
      const i = this.incidents(d);
      stray ??= i.strays.find((x) => x.animalId === animalId && x.from <= t && t < x.to);
      illness ??= i.illnesses.find((x) => x.animalId === animalId && x.onset <= t && t < x.until);
      drop ??= i.drops.find((x) => x.animalId === animalId && x.at <= t && t < x.until);
    }
    return { stray, illness, drop };
  }

  private feverAt(illness: Illness | undefined, t: number): number {
    if (!illness) return 0;
    const up = smoothstep((t - illness.onset) / (8 * HOUR));
    const down = smoothstep((illness.until - t) / (14 * HOUR));
    return illness.peakC * Math.min(up, down);
  }

  // ── One sheep ──

  private placeXY(s: SimSheep, t: number, p?: PhaseAt): XY {
    const h = this.herds.get(s.herdId)!;
    const centre = this.herdCentre(h, t);
    const phase = p ?? centre.p;
    const id = s.animalId;
    const r = Math.sqrt(unit(id, 'r'));
    const a = unit(id, 'a') * 2 * Math.PI;
    const lame = unit(id, 'lame') < 0.012;
    switch (phase.phase) {
      case 'night':
      case 'pen': {
        const q = {
          x: h.penC.x + h.penHalf.x * 0.85 * (r * Math.cos(a) * 0.85 + 0.15 * wave(`${id}:pen-x`, t, 50 * MIN)),
          y: h.penC.y + h.penHalf.y * 0.85 * (r * Math.sin(a) * 0.85 + 0.15 * wave(`${id}:pen-y`, t, 50 * MIN)),
        };
        return keepInside(h.pen, q, h.penC);
      }
      case 'out':
      case 'home': {
        // A column on the move, the lame at the back.
        const heading = centre.heading ?? { x: 0, y: 1 };
        const lag = (lame ? 0.9 + unit(id, 'lag2') * 0.1 : unit(id, 'lag')) * 260;
        const side = (unit(id, 'side') * 2 - 1) * 22;
        return { x: centre.at.x - heading.x * lag - heading.y * side, y: centre.at.y - heading.y * lag + heading.x * side };
      }
      case 'rest': {
        const spread = 28;
        return {
          x: centre.at.x + spread * (r * Math.cos(a) + 0.3 * wave(`${id}:rest-x`, t, 40 * MIN)),
          y: centre.at.y + spread * (r * Math.sin(a) + 0.3 * wave(`${id}:rest-y`, t, 40 * MIN)),
        };
      }
      case 'graze': {
        // The flock loosens and tightens over the day; each sheep wanders within it.
        const spread = 75 + 40 * (wave(`${s.herdId}:${phase.day}:spread`, t, 3 * HOUR) + 1) / 2;
        const q = {
          x: centre.at.x + spread * (r * Math.cos(a) * 1.1 + 0.55 * wave(`${id}:graze-x`, t, 38 * MIN)),
          y: centre.at.y + spread * (r * Math.sin(a) * 1.1 + 0.55 * wave(`${id}:graze-y`, t, 38 * MIN)),
        };
        return keepInside(h.pasture, q, h.pastureC);
      }
    }
  }

  /** Where a sheep is and how it is at `t`, incidents included. */
  sheepAt(s: SimSheep, t: number): SheepState {
    const p = phaseAt(this.clock(), t);
    const { stray, illness, drop } = this.touching(s.animalId, t);
    const fever = this.feverAt(illness, t);
    const lame = unit(s.animalId, 'lame') < 0.012;
    let at = this.placeXY(s, t, p);

    // A sick sheep with a high fever lies down where grazing began, and the flock moves on.
    const lyingDown = fever > 1.0 && p.phase === 'graze';
    if (lyingDown) at = this.placeXY(s, p.from + 5 * MIN);

    if (stray) {
      const out = smoothstep((t - stray.from) / (45 * MIN));
      const back = smoothstep((stray.to - t) / (40 * MIN));
      const far = stray.distanceM * Math.min(out, back);
      at = { x: at.x + stray.dir.x * far, y: at.y + stray.dir.y * far };
    }

    const collarAt = drop ? this.placeXY(s, drop.at) : at;

    const rate: Record<Phase, number> = { night: 5, pen: 22, out: 118, home: 112, graze: 52, rest: 9 };
    const slot = Math.floor(t / INTERVAL_MS.collar);
    let activity = rate[p.phase] * (0.85 + 0.3 * unit(s.animalId, 'act')) * (0.8 + 0.4 * unit(s.animalId, 'act', slot));
    if (stray) activity *= 1.4;
    if (illness) activity *= 0.35;
    if (lyingDown) activity *= 0.3;
    if (lame) activity *= 0.55;
    if (drop) activity = 0;

    return {
      animalId: s.animalId,
      tag: s.tag,
      herdId: s.herdId,
      phase: p.phase,
      position: toLatLng(this.frame, at),
      collarAt: toLatLng(this.frame, collarAt),
      activity: Math.round(activity),
      temperatureC: this.rumenTemperature(s, t, fever),
      ill: illness !== undefined,
      strayed: stray !== undefined,
      collarOff: drop !== undefined,
    };
  }

  /**
   * Rumen temperature: the sheep's own normal, a daily rhythm that peaks in the afternoon, a sharp
   * drop each time it drinks cold water, and a fever when it is ill.
   */
  private rumenTemperature(s: SimSheep, t: number, fever: number): number {
    const id = s.animalId;
    const base = 39.15 + 0.18 * gauss(id, 'base');
    const rhythm = 0.22 * Math.sin((2 * Math.PI * (localHour(this.clock(), t) - 10.5)) / 24);
    const { dayStart, day } = phaseAt(this.clock(), t);
    let drink = 0;
    // At the trough at midday, back in the barn at dusk, before going out in the morning.
    for (const [start, width] of [
      [12 * HOUR + 5 * MIN, 45 * MIN],
      [17 * HOUR + 15 * MIN, 30 * MIN],
      [7 * HOUR, 25 * MIN],
    ] as const) {
      const at = dayStart + start + unit(id, 'drink', day, start) * width;
      const since = t - at;
      if (since >= 0 && since < 2 * HOUR) drink -= (1.8 + 1.7 * unit(id, 'gulp', day, start)) * Math.exp(-since / (22 * MIN));
    }
    const noise = 0.05 * gauss(id, 'temp', Math.floor(t / MIN));
    return Math.round((base + rhythm + drink + fever + noise) * 100) / 100;
  }

  // ── Batteries and radio ──

  /** Battery left, %. Most last years; a few were fitted half flat; one dies within the week. */
  batteryAt(devEui: string, kind: Kind, t: number): number {
    const fitted = Date.UTC(2026, 9, 25);
    const days = Math.max(0, (t - fitted) / DAY);
    if (kind === 'bolus') return Math.max(0, 75 + 25 * unit(devEui, 'bat') - 0.05 * days);
    const start = unit(devEui, 'dying') < 0.002 ? 1.2 : unit(devEui, 'low') < 0.015 ? 14 + 8 * unit(devEui, 'bat') : 60 + 40 * unit(devEui, 'bat');
    return Math.max(0, start - (start < 30 ? 0.2 : 0.09) * days);
  }

  /** Which gateways hear a device at a place, and how well. A bolus speaks from inside the sheep. */
  private hear(devEui: string, kind: Kind, at: LatLng, k: number): RxInfo[] {
    const p = toXY(this.frame, at);
    // EU868 at SF9: 14 dBm out, -129 dBm the weakest a gateway decodes. The body and the rumen absorb.
    const loss = kind === 'bolus' ? 45 : 4;
    const heard: RxInfo[] = [];
    for (const g of this.gateways) {
      const d = Math.max(5, distance(p, g.at));
      const rssi = 14 - loss - (31.5 + 27 * Math.log10(d)) + 4 * gauss(devEui, k, g.id);
      if (rssi < -129) continue;
      heard.push({ gatewayId: g.id, rssi: Math.round(rssi), snr: Math.max(-20, Math.min(12, Math.round(((rssi + 121) / 2.5) * 10) / 10)) });
    }
    // Two devices speaking at once: about 2% of messages are lost to collisions.
    return unit(devEui, k, 'collision') < 0.02 ? [] : heard;
  }

  // ── Messages ──

  private devices(): { devEui: string; kind: Kind; sheep: SimSheep }[] {
    return this.farm.sheep.flatMap((s) => [
      { devEui: s.collar, kind: 'collar' as const, sheep: s },
      ...(s.bolus ? [{ devEui: s.bolus, kind: 'bolus' as const, sheep: s }] : []),
    ]);
  }

  /** Every message a gateway heard in (from, to], oldest first. Silent and unheard ones are left out. */
  uplinks(from: number, to: number): Uplink[] {
    const out: Uplink[] = [];
    for (const { devEui, kind, sheep } of this.devices()) {
      const interval = INTERVAL_MS[kind];
      const phase = unit(devEui, 'phase') * interval;
      for (let k = Math.ceil((from - phase) / interval) - 1; ; k++) {
        const at = Math.round(phase + k * interval + (unit(devEui, k, 'jitter') * 2 - 1) * 20_000);
        if (at > to) break;
        if (at <= from) continue;
        const battery = this.batteryAt(devEui, kind, at);
        if (battery <= 0) continue;
        const state = this.sheepAt(sheep, at);
        const where = kind === 'collar' ? state.collarAt : state.position;
        const rxInfo = this.hear(devEui, kind, where, k);
        if (rxInfo.length === 0) continue;
        out.push({ devEui, kind, animalId: sheep.animalId, tag: sheep.tag, at, fCnt: k & 0xffff, object: this.decoded(devEui, kind, state, where, battery, k), rxInfo });
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** What a typical codec reports. GPS is a few metres off, and now and then it has no fix at all. */
  private decoded(devEui: string, kind: Kind, state: SheepState, where: LatLng, battery: number, k: number): Record<string, unknown> {
    if (kind === 'bolus') return { temperature: state.temperatureC, battery: Math.floor(battery) };
    if (unit(devEui, k, 'nofix') < 0.004) return { latitude: 0, longitude: 0, gnssFix: false, satellites: 0, activity: state.activity, battery: Math.floor(battery) };
    const jitter = 3 / M_PER_DEG;
    return {
      latitude: Math.round((where.lat + gauss(devEui, k, 'lat') * jitter) * 1e6) / 1e6,
      longitude: Math.round((where.lng + (gauss(devEui, k, 'lng') * jitter) / this.frame.cosLat) * 1e6) / 1e6,
      gnssFix: true,
      satellites: 6 + Math.floor(unit(devEui, k, 'sats') * 6),
      activity: state.activity,
      battery: Math.floor(battery),
    };
  }

  /** What is going on now, for the log: who strayed, who is ill, whose collar is off. */
  story(t: number): { strayed: string[]; ill: string[]; collarOff: string[]; phase: Phase } {
    const states = this.farm.sheep.map((s) => this.sheepAt(s, t));
    return {
      phase: phaseAt(this.clock(), t).phase,
      strayed: states.filter((s) => s.strayed).map((s) => s.tag),
      ill: states.filter((s) => s.ill).map((s) => s.tag),
      collarOff: states.filter((s) => s.collarOff).map((s) => s.tag),
    };
  }
}
