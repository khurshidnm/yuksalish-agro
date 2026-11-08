/**
 * What the flock map and the passport read. No money and no personal data here, so `livestock.view`
 * is enough: the shepherd who walks with the flock sees it.
 */
import { addDays, ANIMAL_ON_FARM_STATUSES } from '@yap/shared';
import { medianPoint, silentAfterMsFor, TRACKING_RULES } from '@yap/shared/formulas/tracking';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import type { TrackerKind } from '../devices/devices.service';
import { animalTrackers } from './trackers.service';

const { animals, animalTrackDays, animalTracking, devices, herds, trackerAssignments: a, trackerReadings: r, trackerState } = schema;

const MAX_TRACK_POINTS = 2000;
const MAX_TRACK_DAYS = 31;
const HISTORY_DAYS = 90;

export const liveQuery = z.object({ herdId: z.uuid().optional() });

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Every animal wearing a tracker now, where it is and how it is, and each herd's centre. */
export async function live(q: z.infer<typeof liveQuery>) {
  const farm = ctx().farmId;
  const now = Date.now();
  const worn = await tx()
    .select({
      animalId: animals.id,
      tag: animals.tag,
      herdId: animals.herdId,
      herdName: herds.name,
      kind: sql<TrackerKind>`${devices.config}->>'trackerKind'`,
      externalId: devices.externalId,
      lastReadingAt: trackerState.lastReadingAt,
      batteryPct: trackerState.batteryPct,
    })
    .from(a)
    .innerJoin(animals, eq(animals.id, a.animalId))
    .innerJoin(devices, eq(devices.id, a.deviceId))
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .leftJoin(trackerState, eq(trackerState.deviceId, devices.id))
    .where(
      and(
        eq(a.farmId, farm),
        isNull(a.removedOn),
        inArray(animals.status, [...ANIMAL_ON_FARM_STATUSES]),
        q.herdId ? eq(animals.herdId, q.herdId) : undefined,
      ),
    )
    .orderBy(asc(animals.tag));

  const animalIds = [...new Set(worn.map((w) => w.animalId))];
  const states = animalIds.length
    ? await tx().select().from(animalTracking).where(and(eq(animalTracking.farmId, farm), inArray(animalTracking.animalId, animalIds)))
    : [];
  const stateOf = new Map(states.map((s) => [s.animalId, s]));

  const silent = (at: Date | null, kind: string) => !at || now - at.getTime() > silentAfterMsFor(kind);
  const fresh = (at: Date | null) => !!at && now - at.getTime() <= TRACKING_RULES.silentAfterMs;

  const byAnimal = new Map<string, (typeof worn)[number][]>();
  for (const w of worn) byAnimal.set(w.animalId, [...(byAnimal.get(w.animalId) ?? []), w]);

  const list = [...byAnimal.values()].map((trackers) => {
    const first = trackers[0]!;
    const s = stateOf.get(first.animalId);
    const batteries = trackers.map((t) => t.batteryPct).filter((b): b is number => b !== null);
    return {
      animalId: first.animalId,
      tag: first.tag,
      herdId: first.herdId,
      herdName: first.herdName,
      lat: s?.lat ?? null,
      lng: s?.lng ?? null,
      positionAt: iso(s?.positionAt ?? null),
      temperatureC: s?.temperatureC ?? null,
      lastReadingAt: iso(s?.lastReadingAt ?? null),
      flags: s?.flags ?? {},
      batteryPct: batteries.length ? Math.min(...batteries) : null,
      silent: trackers.every((t) => silent(t.lastReadingAt, t.kind)),
    };
  });

  const herdGroups = new Map<string, typeof list>();
  for (const x of list) if (x.herdId) herdGroups.set(x.herdId, [...(herdGroups.get(x.herdId) ?? []), x]);
  const herdList = [...herdGroups].map(([id, members]) => {
    const located = members.filter((m) => m.lat !== null && fresh(m.positionAt ? new Date(m.positionAt) : null));
    return {
      id,
      name: members[0]!.herdName,
      tracked: members.length,
      located: located.length,
      silent: members.filter((m) => m.silent).length,
      flagged: members.filter((m) => Object.keys(m.flags).length > 0).length,
      centre: medianPoint(located.map((m) => ({ lat: m.lat!, lng: m.lng! }))),
    };
  });

  const low = TRACKING_RULES.lowBatteryPct;
  return {
    now: new Date(now).toISOString(),
    silentAfterMinutes: TRACKING_RULES.silentAfterMs / 60_000,
    bolusSilentAfterMinutes: TRACKING_RULES.bolusSilentAfterMs / 60_000,
    lowBatteryPct: low,
    summary: {
      tracked: list.length,
      located: herdList.reduce((sum, h) => sum + h.located, 0) + list.filter((x) => !x.herdId && x.lat !== null).length,
      silent: list.filter((x) => x.silent).length,
      flagged: list.filter((x) => Object.keys(x.flags).length > 0).length,
      lowBattery: list.filter((x) => x.batteryPct !== null && x.batteryPct < low).length,
    },
    herds: herdList,
    animals: list,
  };
}

async function animalOrThrow(id: string) {
  const [animal] = await tx()
    .select({ id: animals.id, tag: animals.tag, herdId: animals.herdId })
    .from(animals)
    .where(and(eq(animals.id, id), eq(animals.farmId, ctx().farmId)));
  if (!animal) throw notFound('Animal');
  return animal;
}

/** The passport's header: the animal's state now and every tracker it has worn. */
export async function animalSummary(id: string) {
  const animal = await animalOrThrow(id);
  const [state] = await tx().select().from(animalTracking).where(eq(animalTracking.animalId, id));
  return {
    animalId: animal.id,
    tag: animal.tag,
    state: state
      ? {
          lat: state.lat,
          lng: state.lng,
          positionAt: iso(state.positionAt),
          temperatureC: state.temperatureC,
          temperatureAt: iso(state.temperatureAt),
          activity: state.activity,
          activityAt: iso(state.activityAt),
          lastReadingAt: iso(state.lastReadingAt),
          flags: state.flags,
        }
      : null,
    trackers: (await animalTrackers(id)).map((t) => ({ ...t, lastReadingAt: iso(t.lastReadingAt) })),
  };
}

export const trackQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/** Positions in a window, the last 24 hours by default, thinned evenly to at most 2000 points. */
export async function track(id: string, q: z.infer<typeof trackQuery>) {
  await animalOrThrow(id);
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 86_400_000);
  if (from >= to) throw badRequest('INVALID_RANGE', 'The start must be before the end');
  if (to.getTime() - from.getTime() > MAX_TRACK_DAYS * 86_400_000) throw badRequest('RANGE_TOO_LONG', `At most ${MAX_TRACK_DAYS} days`);

  const points = await tx()
    .select({ at: r.recordedAt, lat: r.lat, lng: r.lng })
    .from(r)
    .where(and(eq(r.farmId, ctx().farmId), eq(r.animalId, id), gte(r.recordedAt, from), lte(r.recordedAt, to), isNotNull(r.lat)))
    .orderBy(asc(r.recordedAt));
  const step = Math.ceil(points.length / MAX_TRACK_POINTS);
  const kept = step > 1 ? points.filter((_, i) => i % step === 0 || i === points.length - 1) : points;
  return { from: from.toISOString(), to: to.toISOString(), points: kept.map((p) => ({ at: p.at.toISOString(), lat: p.lat!, lng: p.lng! })) };
}

export const seriesQuery = z.object({ days: z.coerce.number().int().min(1).max(30).default(7) });

/** Hourly temperature and activity for the charts, and the daily summaries that outlive raw data. */
export async function series(id: string, q: z.infer<typeof seriesQuery>) {
  await animalOrThrow(id);
  const since = new Date(Date.now() - q.days * 86_400_000);
  const hourly = await tx()
    .select({
      hour: sql<string>`to_char(date_trunc('hour', ${r.recordedAt} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:00:00"Z"')`,
      temperatureC: sql<number | null>`round(avg(${r.temperatureC})::numeric, 2)`.mapWith((v) => (v === null ? null : Number(v))),
      activity: sql<number | null>`avg(${r.activity})`.mapWith((v) => (v === null ? null : Number(v))),
      fixes: sql<number>`count(${r.lat})`.mapWith(Number),
    })
    .from(r)
    .where(and(eq(r.farmId, ctx().farmId), eq(r.animalId, id), gte(r.recordedAt, since)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const days = await tx()
    .select({
      date: animalTrackDays.date,
      fixes: animalTrackDays.fixes,
      distanceM: animalTrackDays.distanceM,
      activityMean: animalTrackDays.activityMean,
      temperatureMedianC: animalTrackDays.temperatureMedianC,
      temperatureMaxC: animalTrackDays.temperatureMaxC,
    })
    .from(animalTrackDays)
    .where(and(eq(animalTrackDays.farmId, ctx().farmId), eq(animalTrackDays.animalId, id), gte(animalTrackDays.date, addDays(today(), -HISTORY_DAYS))))
    .orderBy(asc(animalTrackDays.date));
  return { days: q.days, hourly, history: days };
}
