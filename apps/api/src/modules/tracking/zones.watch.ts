/**
 * The two herd-level watches of the health run: animals out of their zone, and a herd on the move
 * at night. The rules are in packages/shared/src/formulas/tracking.ts; this file feeds them and
 * keeps one alert per herd in step, never one per animal.
 */
import { localClock } from '@yap/shared';
import {
  NIGHT_RULES,
  nightElapsedMs,
  nightMovement,
  outOfZone,
  ZONE_RULES,
  zonesFor,
  type AnimalFixes,
  type Fix,
  type ZoneVerdict,
} from '@yap/shared/formulas/tracking';
import { ctx } from '../../core/context';
import { raiseAlert, resolveByDedupKey } from '../alerts/alerts.service';
import { activeZones } from './geofences.service';

export interface Watched {
  animalId: string;
  herdId: string | null;
  herdName: string | null;
}

/**
 * What the zones say about each animal: out, not out, or `null` when its fixes cannot tell. An
 * animal without a herd is bound by no zone, so it is never out.
 */
export async function judgeZones(tracked: readonly Watched[], fixesOf: (animalId: string) => Fix[], now: Date): Promise<Map<string, ZoneVerdict | null>> {
  const zones = await activeZones();
  const byHerd = new Map<string, ReturnType<typeof zonesFor<(typeof zones)[number]>>>();
  const verdicts = new Map<string, ZoneVerdict | null>();
  for (const m of tracked) {
    if (!m.herdId) {
      verdicts.set(m.animalId, { out: false, breach: null });
      continue;
    }
    if (!byHerd.has(m.herdId)) byHerd.set(m.herdId, zonesFor(zones, m.herdId));
    const bound = byHerd.get(m.herdId)!;
    verdicts.set(m.animalId, bound.length ? outOfZone(fixesOf(m.animalId), bound, now.getTime()) : { out: false, breach: null });
  }
  return verdicts;
}

/**
 * One alert per herd with animals out of their zone, naming the zone most of them left or entered.
 * `out` is every animal flagged after this run, including one whose collar has since gone quiet.
 * A herd with nobody out has its alert resolved.
 */
export async function zoneAlerts(tracked: readonly Watched[], out: ReadonlySet<string>, verdicts: ReadonlyMap<string, ZoneVerdict | null>): Promise<void> {
  const herds = new Map<string, Watched[]>();
  for (const m of tracked) if (m.herdId) herds.set(m.herdId, [...(herds.get(m.herdId) ?? []), m]);

  for (const [herdId, members] of herds) {
    const dedupKey = `geofence_exit:${herdId}`;
    const count = members.filter((m) => out.has(m.animalId)).length;
    if (count === 0) {
      await resolveByDedupKey(dedupKey);
      continue;
    }
    const breaches = members.flatMap((m) => verdicts.get(m.animalId)?.breach ?? []);
    // Every flagged animal is silent now: what was said stands until one of them is heard again.
    if (breaches.length === 0) continue;
    const tally = new Map<string, { name: string; kind: string; count: number }>();
    for (const b of breaches) tally.set(b.zoneId, { name: b.zoneName, kind: b.kind, count: (tally.get(b.zoneId)?.count ?? 0) + 1 });
    const zone = [...tally.values()].sort((a, b) => b.count - a.count)[0]!;
    const herd = members[0]!.herdName ?? '';
    const inside = zone.kind === 'inside';
    await raiseAlert({
      ruleKey: 'geofence_exit',
      dedupKey,
      severity: 'attention',
      title: inside ? `${herd}: ${count} bosh yopiq hududda` : `${herd}: ${count} bosh ruxsat etilgan hududdan tashqarida`,
      link: `/livestock/tracking?herd=${herdId}`,
      entityType: 'herd',
      entityId: herdId,
      source: 'device',
      data: { herd, count, tracked: members.length, zone: zone.name, fixes: ZONE_RULES.exitFixes, ...(inside ? { textKey: 'geofence_exit_forbidden' } : {}) },
      notify: ['shepherd', 'zootechnician', 'director'],
    });
  }
}

/**
 * A herd whose centre travels at night raises one urgent alert. It stays open through the night,
 * because a flock that stopped somewhere else still needs someone to go, and the first run by day
 * resolves it. True when the herd is moving now. A farm that grazes at night switches the watch off
 * (`settings.tracking.nightWatch`): then nothing is raised, and an alert left open is closed.
 */
export async function nightWatch(herdId: string, herdName: string | null, members: readonly AnimalFixes[], now: Date): Promise<boolean> {
  const dedupKey = `night_movement:${herdId}`;
  const clock = localClock(ctx().timezone, now);
  const elapsed = ctx().settings.tracking.nightWatch ? nightElapsedMs(clock.hour, clock.minute) : null;
  if (elapsed === null) {
    await resolveByDedupKey(dedupKey);
    return false;
  }
  const movement = nightMovement(members, now.getTime(), now.getTime() - elapsed);
  if (!movement?.moved) return false;
  await raiseAlert({
    ruleKey: 'night_movement',
    dedupKey,
    severity: 'urgent',
    title: `${herdName ?? 'Poda'} tunda harakatlanmoqda`,
    link: `/livestock/tracking?herd=${herdId}`,
    entityType: 'herd',
    entityId: herdId,
    source: 'device',
    data: {
      herd: herdName ?? '',
      distance: Math.round(movement.movedM),
      minutes: Math.round(Math.min(elapsed, NIGHT_RULES.windowMs) / 60_000),
      tracked: movement.tracked,
      speedKmh: movement.speedKmh === null ? null : Math.round(movement.speedKmh * 10) / 10,
      reason: movement.reason,
    },
    notify: ['shepherd', 'zootechnician', 'director'],
  });
  return true;
}
