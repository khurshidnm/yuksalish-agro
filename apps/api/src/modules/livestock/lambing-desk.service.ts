/**
 * The lambing desk: who is about to lamb, which lambs need a person, and which pens are free.
 * It reads what the breeding, care and pen services record; it writes nothing itself.
 */
import { and, asc, count, eq, inArray, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { addDays, diffDays } from '@yap/shared';
import { LAMBING_DESK } from '@yap/shared/formulas/lambing';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { lambsNeedingAttention } from './lamb-care.service';
import { listPens } from './pens.service';
import { onFarm } from './refs';

const { animals, breedingRecords: b, facilities, herds, lambingRecords: l } = schema;
const barn = alias(facilities, 'barn');

export const watchQuery = z.object({
  /** Ewes due within this many days are listed, with every overdue one. */
  days: z.coerce.number().int().min(1).max(60).default(LAMBING_DESK.watchDays),
});

/** Days ahead that the "due this week" count looks. */
const WEEK_DAYS = 7;

/**
 * The night-watch list: ewes due within `days` and overdue ones, soonest first, with what the
 * shepherd needs at the pen door.
 */
export async function nightWatch(days: number = LAMBING_DESK.watchDays) {
  const farmId = ctx().farmId;
  const day = today();
  const rows = await tx()
    .select({
      breedingId: b.id,
      eweId: b.eweId,
      tag: animals.tag,
      expectedDate: b.expectedDate,
      expectedEarliest: b.expectedEarliest,
      expectedLatest: b.expectedLatest,
      fetusCount: b.fetusCount,
      herdId: animals.herdId,
      herdName: herds.name,
      facilityId: facilities.id,
      facilityName: facilities.name,
      barnName: barn.name,
      lambingPen: facilities.lambingPen,
    })
    .from(b)
    .innerJoin(animals, eq(animals.id, b.eweId))
    .leftJoin(herds, eq(herds.id, animals.herdId))
    // Her own place wins over her herd's, as on the facility card.
    .leftJoin(facilities, sql`${facilities.id} = coalesce(${animals.facilityId}, ${herds.facilityId})`)
    .leftJoin(barn, eq(barn.id, facilities.parentId))
    .where(and(eq(b.farmId, farmId), eq(animals.farmId, farmId), eq(b.status, 'pregnant'), onFarm(), lte(b.expectedDate, addDays(day, days))))
    .orderBy(asc(b.expectedDate), asc(animals.tag));

  // Her earlier lambings on this farm: whether there were any, and what went wrong.
  const earlier = rows.length
    ? await tx()
        .select({ eweId: l.eweId, date: l.date, complications: l.complications, lambsBorn: l.lambsBorn, lambsAlive: l.lambsAlive })
        .from(l)
        .where(and(eq(l.farmId, farmId), inArray(l.eweId, rows.map((row) => row.eweId))))
        .orderBy(asc(l.date))
    : [];
  const history = new Map<string, typeof earlier>();
  for (const row of earlier) history.set(row.eweId, [...(history.get(row.eweId) ?? []), row]);

  const ewes = rows.map(({ lambingPen, ...row }) => {
    const past = history.get(row.eweId) ?? [];
    return {
      ...row,
      /** Negative once the expected date has passed. */
      daysLeft: diffDays(day, row.expectedDate),
      overdue: row.expectedLatest < day,
      /** No lambing on record here. A bought ewe's earlier lambings are not known. */
      firstLambing: past.length === 0,
      complications: past.flatMap((p) => (p.complications ? [{ date: p.date, text: p.complications }] : [])),
      /** Lambs she lost at birth before, in total. */
      stillborn: past.reduce((sum, p) => sum + (p.lambsBorn - p.lambsAlive), 0),
      inPen: lambingPen === true,
    };
  });
  const pens = await listPens();
  return {
    today: day,
    days,
    ewes,
    /** So the lambing form can offer a pen, also with no connection. */
    freePens: pens.filter((pen) => pen.free).map(({ id, name, parentName }) => ({ id, name, parentName })),
  };
}

/** Everything the desk shows, in one answer. */
export async function desk(days: number = LAMBING_DESK.watchDays) {
  const farmId = ctx().farmId;
  const day = today();
  const [due] = await tx()
    .select({
      // Past her expected date but inside the window still counts as due: she can lamb any hour.
      dueThisWeek: sql<number>`count(*) filter (where ${b.expectedDate} <= ${addDays(day, WEEK_DAYS)}::date and ${b.expectedLatest} >= ${day}::date)`.mapWith(Number),
      overdue: sql<number>`count(*) filter (where ${b.expectedLatest} < ${day}::date)`.mapWith(Number),
    })
    .from(b)
    .innerJoin(animals, eq(animals.id, b.eweId))
    .where(and(eq(b.farmId, farmId), eq(animals.farmId, farmId), eq(b.status, 'pregnant'), onFarm()));
  const [lambed] = await tx()
    .select({ ewes: count(), lambsAlive: sql<number>`coalesce(sum(${l.lambsAlive}), 0)`.mapWith(Number) })
    .from(l)
    .where(and(eq(l.farmId, farmId), eq(l.date, day)));

  const watch = await nightWatch(days);
  const attention = await lambsNeedingAttention();
  const pens = await listPens();
  return {
    today: day,
    limits: { watchDays: days, colostrumHours: LAMBING_DESK.colostrumHours, penDays: LAMBING_DESK.penDays },
    counts: {
      dueThisWeek: due.dueThisWeek,
      overdue: due.overdue,
      lambedToday: lambed.ewes,
      lambsToday: lambed.lambsAlive,
      lambsNeedingAttention: attention.lambs.length,
      pensTotal: pens.length,
      pensFree: pens.filter((pen) => pen.free).length,
    },
    watch: watch.ewes,
    attention: attention.lambs,
    pens,
  };
}
