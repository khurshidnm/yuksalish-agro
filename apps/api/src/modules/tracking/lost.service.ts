/**
 * "Last seen": the animals to go and look for, with where each was last and how to get there
 * (docs/tracking.md). It raises no alert of its own: a silent tracker is already in
 * `tracking_silent` and a stray in `animal_isolated`, and a third alert would say the same twice.
 */
import { lastSeenList, TRACKING_RULES } from '@yap/shared/formulas/tracking';
import type { z } from 'zod';
import { live, type liveQuery } from './tracking.service';

/** Rows sent at most. When a gateway is down every animal is silent, and the answer is the gateway. */
const MAX_LOST = 200;

const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : null);

export async function lost(q: z.infer<typeof liveQuery>) {
  const data = await live(q);
  const now = new Date(data.now).getTime();
  const byId = new Map(data.animals.map((a) => [a.animalId, a]));
  const centres = new Map(data.herds.flatMap((h) => (h.centre ? [[h.id, h.centre] as const] : [])));
  const list = lastSeenList(
    data.animals.map((a) => ({
      animalId: a.animalId,
      herdId: a.herdId,
      lat: a.lat,
      lng: a.lng,
      positionAt: ms(a.positionAt),
      lastReadingAt: ms(a.lastReadingAt),
      silent: a.silent,
      isolated: Boolean(a.flags.isolated),
    })),
    centres,
    now,
  );
  const minutes = (value: number | null) => (value === null ? null : Math.round(value / 60_000));
  return {
    now: data.now,
    silentAfterMinutes: data.silentAfterMinutes,
    tracked: data.summary.tracked,
    /** Nothing reports at all: look at the gateway before looking for sheep. */
    allSilent: data.summary.tracked >= TRACKING_RULES.minHerdTracked && data.summary.silent === data.summary.tracked,
    total: list.length,
    animals: list.slice(0, MAX_LOST).map((x) => {
      const a = byId.get(x.animalId)!;
      return {
        animalId: a.animalId,
        tag: a.tag,
        herdId: a.herdId,
        herdName: a.herdName,
        reason: x.reason,
        lat: a.lat,
        lng: a.lng,
        positionAt: a.positionAt,
        lastReadingAt: a.lastReadingAt,
        minutesSinceContact: minutes(x.sinceContactMs),
        minutesSincePosition: minutes(x.sincePositionMs),
        distanceFromHerdM: x.distanceFromHerdM === null ? null : Math.round(x.distanceFromHerdM),
        batteryPct: a.batteryPct,
      };
    }),
  };
}
