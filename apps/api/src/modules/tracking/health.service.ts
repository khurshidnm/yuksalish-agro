/**
 * The health rules over live readings (docs/tracking.md), run every 10 minutes for each farm, and
 * the nightly summary that outlives the raw readings. The rules live in
 * packages/shared/src/formulas/tracking.ts; this file only feeds them and keeps alerts in step.
 */
import { addDays, ANIMAL_ON_FARM_STATUSES, round } from '@yap/shared';
import { localHourOf } from '@yap/shared/formulas/agro-weather';
import {
  daySummary,
  herdFever,
  herdInactivity,
  herdIsolation,
  isDaytime,
  silentAfterMsFor,
  TRACKING_RULES,
  type AnimalFixes,
  type AnimalTemperatures,
  type AnimalWindow,
  type Fix,
} from '@yap/shared/formulas/tracking';
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray, sql } from 'drizzle-orm';
import { schema } from '../../db/client';
import type { TrackingFlag } from '../../db/schema/tracking';
import { ctx, today, tx } from '../../core/context';
import { recordEvent } from '../../core/journal';
import { raiseAlert, resolveByDedupKey } from '../alerts/alerts.service';

const { animals, animalTrackDays, animalTracking, devices, herds, trackerAssignments: a, trackerReadings: r, trackerState } = schema;

const ON_FARM = [...ANIMAL_ON_FARM_STATUSES];
const HOUR = 3_600_000;

/** Days of a sheep's own daily medians that make its normal temperature. */
const BASELINE_DAYS = 7;

interface Tracked {
  animalId: string;
  tag: string;
  herdId: string | null;
  herdName: string | null;
  flags: Partial<Record<TrackingFlag, string>>;
}

/** What each rule said about one animal: true, false, or null when it could not tell. */
type Verdict = { flag: TrackingFlag; raised: boolean | null; data?: Record<string, unknown> };

const FLAG_RULE: Record<TrackingFlag, string> = {
  isolated: 'animal_isolated',
  inactive: 'animal_inactive',
  fever: 'animal_fever',
};

const UZ_TITLE: Record<TrackingFlag, (tag: string) => string> = {
  isolated: (tag) => `${tag} podadan ajralib qoldi`,
  inactive: (tag) => `${tag} deyarli harakatlanmayapti`,
  fever: (tag) => `${tag} isitmasi bo'lishi mumkin`,
};

export interface HealthRun {
  evaluated: number;
  raised: number;
  cleared: number;
  splitHerds: number;
  silent: number | null;
  lowBattery: number;
}

/**
 * One run of the health rules. `checkSilence` is false on the first run after the server was away:
 * the trackers spoke, but nobody was listening, so their silence is the server's.
 */
export async function evaluateHealth(now: Date = new Date(), checkSilence = true): Promise<HealthRun> {
  const farm = ctx().farmId;
  const tracked: Tracked[] = await tx()
    .selectDistinct({
      animalId: animals.id,
      tag: animals.tag,
      herdId: animals.herdId,
      herdName: herds.name,
      flags: sql<Partial<Record<TrackingFlag, string>>>`coalesce(${animalTracking.flags}, '{}'::jsonb)`,
    })
    .from(a)
    .innerJoin(animals, eq(animals.id, a.animalId))
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .leftJoin(animalTracking, eq(animalTracking.animalId, animals.id))
    .where(and(eq(a.farmId, farm), isNull(a.removedOn), inArray(animals.status, ON_FARM)));

  const ids = tracked.map((t) => t.animalId);
  const windowStart = new Date(now.getTime() - TRACKING_RULES.inactiveWindowMs);
  const readings = ids.length
    ? await tx()
        .select({ animalId: r.animalId, at: r.recordedAt, lat: r.lat, lng: r.lng, activity: r.activity, temperatureC: r.temperatureC })
        .from(r)
        .where(and(eq(r.farmId, farm), inArray(r.animalId, ids), gte(r.recordedAt, windowStart), lte(r.recordedAt, now)))
    : [];
  const baselineFrom = addDays(today(), -BASELINE_DAYS);
  const baselines = ids.length
    ? await tx()
        .select({ animalId: animalTrackDays.animalId, c: animalTrackDays.temperatureMedianC })
        .from(animalTrackDays)
        .where(
          and(
            eq(animalTrackDays.farmId, farm),
            inArray(animalTrackDays.animalId, ids),
            gte(animalTrackDays.date, baselineFrom),
            lt(animalTrackDays.date, today()),
            isNotNull(animalTrackDays.temperatureMedianC),
          ),
        )
    : [];

  const readingsOf = groupBy(readings, (x) => x.animalId!);
  const baselineOf = groupBy(baselines, (x) => x.animalId);
  const daytime = isDaytime(localHourOf(now.toISOString(), ctx().timezone));

  const verdicts = new Map<string, Verdict[]>();
  const say = (animalId: string, v: Verdict) => verdicts.set(animalId, [...(verdicts.get(animalId) ?? []), v]);
  let splitHerds = 0;

  for (const [herdId, members] of groupBy(tracked, (t) => t.herdId)) {
    if (!herdId) continue; // sheep without a herd have no flock to be compared with
    const own = (id: string) => readingsOf.get(id) ?? [];

    // Apart from the flock
    const fixesOf = (id: string): Fix[] =>
      own(id).flatMap((x) => (x.lat !== null && x.lng !== null ? [{ lat: x.lat, lng: x.lng, at: x.at.getTime() }] : []));
    const isolation = herdIsolation(
      members.map((m): AnimalFixes => ({ animalId: m.animalId, fixes: fixesOf(m.animalId) })),
      now.getTime(),
    );
    await herdSplitAlert(herdId, members[0]!.herdName, isolation?.kind === 'split' ? isolation : null, isolation !== null);
    if (isolation?.kind === 'split') splitHerds += 1;
    if (isolation?.kind === 'ok') {
      const apart = new Map(isolation.isolated.map((x) => [x.animalId, x.distanceM]));
      for (const m of members) {
        const latest = fixesOf(m.animalId).sort((x, y) => y.at - x.at)[0];
        const fresh = latest && now.getTime() - latest.at <= TRACKING_RULES.fixFreshMs;
        const distance = apart.get(m.animalId);
        say(m.animalId, { flag: 'isolated', raised: fresh ? distance !== undefined : null, data: { distance: distance ? Math.round(distance) : null } });
      }
    }

    // Not moving, by daylight only
    if (daytime) {
      const inactivity = herdInactivity(
        members.map(
          (m): AnimalWindow => ({
            animalId: m.animalId,
            fixes: fixesOf(m.animalId),
            activity: own(m.animalId).flatMap((x) => (x.activity !== null ? [x.activity] : [])),
          }),
        ),
      );
      if (inactivity) {
        const still = new Set(inactivity.inactive.map((x) => x.animalId));
        for (const m of members) {
          const hasData = own(m.animalId).length >= Math.min(TRACKING_RULES.inactiveMinFixes, TRACKING_RULES.inactiveMinActivityReadings);
          say(m.animalId, { flag: 'inactive', raised: hasData ? still.has(m.animalId) : null, data: { hours: TRACKING_RULES.inactiveWindowMs / HOUR } });
        }
      }
    }

    // Fever
    const feverFrom = now.getTime() - TRACKING_RULES.feverWindowMs;
    const fever = herdFever(
      members.map(
        (m): AnimalTemperatures => ({
          animalId: m.animalId,
          recent: own(m.animalId).flatMap((x) => (x.temperatureC !== null && x.at.getTime() >= feverFrom ? [x.temperatureC] : [])),
          baselineDays: (baselineOf.get(m.animalId) ?? []).map((b) => b.c!),
        }),
      ),
    );
    if (fever) {
      const hot = new Map(fever.fever.map((x) => [x.animalId, x]));
      for (const m of members) {
        const recent = own(m.animalId).filter((x) => x.temperatureC !== null && x.at.getTime() >= feverFrom).length;
        const x = hot.get(m.animalId);
        say(m.animalId, {
          flag: 'fever',
          raised: recent >= TRACKING_RULES.feverMinReadings ? x !== undefined : null,
          data: x ? { temperature: round(x.medianC, 1), overHerd: round(x.overHerdC, 1), urgent: x.urgent } : undefined,
        });
      }
    }
  }

  let raised = 0;
  let cleared = 0;
  for (const m of tracked) {
    const flags = { ...m.flags };
    for (const v of verdicts.get(m.animalId) ?? []) {
      const dedupKey = `${FLAG_RULE[v.flag]}:${m.animalId}`;
      if (v.raised === true) {
        if (!flags[v.flag]) {
          flags[v.flag] = now.toISOString();
          raised += 1;
        }
        await raiseAnimalAlert(m, v);
      } else if (v.raised === false && flags[v.flag]) {
        // Only fresh data that says all is well clears a flag; silence keeps it.
        delete flags[v.flag];
        await resolveByDedupKey(dedupKey);
        cleared += 1;
      }
    }
    if (JSON.stringify(flags) !== JSON.stringify(m.flags)) {
      await tx().update(animalTracking).set({ flags }).where(eq(animalTracking.animalId, m.animalId));
    }
  }

  const silent = checkSilence ? await silenceAlert(now) : null;
  const lowBattery = await batteryAlert();
  return { evaluated: tracked.length, raised, cleared, splitHerds, silent, lowBattery };
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}

async function raiseAnimalAlert(m: Tracked, v: Verdict) {
  const urgent = v.flag === 'fever' && v.data?.urgent === true;
  await raiseAlert({
    ruleKey: FLAG_RULE[v.flag],
    dedupKey: `${FLAG_RULE[v.flag]}:${m.animalId}`,
    severity: urgent ? 'urgent' : 'attention',
    title: UZ_TITLE[v.flag](m.tag),
    link: `/livestock/animals/${m.animalId}?tab=location`,
    entityType: 'animal',
    entityId: m.animalId,
    source: 'device',
    data: { tag: m.tag, ...v.data },
    notify: ['shepherd', 'veterinarian', 'zootechnician'],
  });
}

async function herdSplitAlert(
  herdId: string,
  herdName: string | null,
  split: { tracked: number; apart: number } | null,
  known: boolean,
) {
  const dedupKey = `tracking_herd_split:${herdId}`;
  if (!split) {
    if (known) await resolveByDedupKey(dedupKey);
    return;
  }
  await raiseAlert({
    ruleKey: 'tracking_herd_split',
    dedupKey,
    severity: 'attention',
    title: `${herdName ?? 'Poda'} bo'linib ketdi`,
    link: `/livestock/tracking?herd=${herdId}`,
    entityType: 'herd',
    entityId: herdId,
    source: 'device',
    data: { herd: herdName ?? '', apart: split.apart, tracked: split.tracked },
    notify: ['shepherd', 'zootechnician', 'director'],
  });
}

/** Fitted trackers that should be reporting: on an animal on the farm. */
const fittedTrackers = () =>
  tx()
    .select({
      deviceId: a.deviceId,
      kind: sql<string>`${devices.config}->>'trackerKind'`,
      fittedOn: a.fittedOn,
      lastReadingAt: trackerState.lastReadingAt,
      batteryPct: trackerState.batteryPct,
    })
    .from(a)
    .innerJoin(animals, eq(animals.id, a.animalId))
    .innerJoin(devices, eq(devices.id, a.deviceId))
    .leftJoin(trackerState, eq(trackerState.deviceId, a.deviceId))
    .where(and(eq(a.farmId, ctx().farmId), isNull(a.removedOn), inArray(animals.status, ON_FARM)));

/**
 * One alert for all silent trackers. When none of them reports, the fault is the gateway or the
 * network server, and the text says so. A tracker fitted today gets until tomorrow to start.
 */
async function silenceAlert(now: Date): Promise<number> {
  const fitted = await fittedTrackers();
  const due = fitted.filter((t) => t.lastReadingAt !== null || t.fittedOn < today());
  const silent = due.filter((t) => !t.lastReadingAt || now.getTime() - t.lastReadingAt.getTime() > silentAfterMsFor(t.kind));
  const dedupKey = `tracking_silent:${ctx().farmId}`;
  if (silent.length === 0) {
    await resolveByDedupKey(dedupKey);
    return 0;
  }
  const all = silent.length === due.length && due.length >= TRACKING_RULES.minHerdTracked;
  const hours = TRACKING_RULES.silentAfterMs / HOUR;
  const bolusHours = TRACKING_RULES.bolusSilentAfterMs / HOUR;
  await raiseAlert({
    ruleKey: 'tracking_silent',
    dedupKey,
    severity: 'attention',
    title: all ? 'Hech bir treker signal bermayapti' : `${silent.length} ta treker signal bermayapti`,
    link: '/livestock/tracking?tab=trackers',
    source: 'device',
    data: { count: silent.length, total: due.length, hours, bolusHours, ...(all ? { textKey: 'tracking_silent_all' } : {}) },
    notify: ['zootechnician', 'director'],
  });
  return silent.length;
}

async function batteryAlert(): Promise<number> {
  const low = (await fittedTrackers()).filter((t) => t.batteryPct !== null && t.batteryPct < TRACKING_RULES.lowBatteryPct);
  const dedupKey = `tracking_battery:${ctx().farmId}`;
  if (low.length === 0) {
    await resolveByDedupKey(dedupKey);
    return 0;
  }
  await raiseAlert({
    ruleKey: 'tracking_battery',
    dedupKey,
    severity: 'info',
    title: `${low.length} ta trekerning batareyasi kam`,
    link: '/livestock/tracking?tab=trackers',
    source: 'device',
    data: { count: low.length, percent: TRACKING_RULES.lowBatteryPct },
    notify: ['zootechnician', 'director'],
  });
  return low.length;
}

// ─── Nightly ────────────────────────────────────────────────────────────────

/** Days looked back for a missing summary: a server that was off for a week still fills them in. */
const SUMMARY_LOOKBACK_DAYS = 7;

/**
 * Summarise each animal's day once the day is over. Yesterday is always redone, for readings that
 * arrived late from a gateway that was offline; earlier days only if they have no summary yet.
 */
export async function summarizeDays(): Promise<number> {
  const farm = ctx().farmId;
  const yesterday = addDays(today(), -1);
  const done = await tx()
    .selectDistinct({ date: animalTrackDays.date })
    .from(animalTrackDays)
    .where(and(eq(animalTrackDays.farmId, farm), gte(animalTrackDays.date, addDays(today(), -SUMMARY_LOOKBACK_DAYS))));
  const doneDays = new Set(done.map((d) => d.date));
  let written = 0;
  for (let back = SUMMARY_LOOKBACK_DAYS; back >= 1; back -= 1) {
    const date = addDays(today(), -back);
    if (date !== yesterday && doneDays.has(date)) continue;
    written += await summarizeDay(date);
  }
  return written;
}

async function summarizeDay(date: string): Promise<number> {
  const c = ctx();
  const start = sql`(${date}::date)::timestamp at time zone ${c.timezone}`;
  const end = sql`(${addDays(date, 1)}::date)::timestamp at time zone ${c.timezone}`;
  const rows = await tx()
    .select({ animalId: r.animalId, at: r.recordedAt, lat: r.lat, lng: r.lng, activity: r.activity, temperatureC: r.temperatureC })
    .from(r)
    .where(and(eq(r.farmId, c.farmId), isNotNull(r.animalId), sql`${r.recordedAt} >= ${start}`, sql`${r.recordedAt} < ${end}`));
  if (rows.length === 0) return 0;
  const values = [...groupBy(rows, (x) => x.animalId!)].map(([animalId, list]) => {
    const s = daySummary(list.map((x) => ({ ...x, at: x.at.getTime() })));
    return {
      tenantId: c.tenantId,
      farmId: c.farmId,
      animalId,
      date,
      readings: list.length,
      fixes: s.fixes,
      distanceM: s.distanceM === null ? null : round(s.distanceM, 1),
      activityMean: s.activityMean,
      temperatureMedianC: s.temperatureMedianC === null ? null : round(s.temperatureMedianC, 2),
      temperatureMaxC: s.temperatureMaxC,
    };
  });
  await tx()
    .insert(animalTrackDays)
    .values(values)
    .onConflictDoUpdate({
      target: [animalTrackDays.animalId, animalTrackDays.date],
      set: Object.fromEntries(
        ['readings', 'fixes', 'distance_m', 'activity_mean', 'temperature_median_c', 'temperature_max_c'].map((col) => [
          col.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase()),
          sql.raw(`excluded.${col}`),
        ]),
      ),
    });
  return values.length;
}

/**
 * A tracker comes off an animal that left the farm, on the day it left, so the collar is free for
 * another and nobody is told a sold ewe went silent.
 */
export async function releaseExited(): Promise<number> {
  const freed = await tx()
    .update(a)
    .set({ removedOn: sql`greatest(${a.fittedOn}, coalesce(${animals.exitDate}, ${today()}::date))` })
    .from(animals)
    .where(and(eq(a.farmId, ctx().farmId), isNull(a.removedOn), eq(animals.id, a.animalId), notInArray(animals.status, ON_FARM)))
    .returning({ id: a.id });
  if (freed.length) await recordEvent({ type: 'tracking.trackers_released', entityType: 'tracker', data: { count: freed.length } });
  return freed.length;
}
