/** Figures for dashboards and reports (docs/contracts.md). All run inside the request context. */
import { and, between, count as countRows, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  ANIMAL_ON_FARM_STATUSES,
  addDays,
  feedConversion,
  herdCount,
  monthOf,
  mortalityPercent,
  round,
  scaleGainToHerd,
} from '@yap/shared';
import { averageHead, itemUnitToKg } from '@yap/shared/formulas/livestock';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { carryingPregnancy, onFarm } from './refs';

// Breeding figures have one owner, so the dashboard and the Breeding page cannot disagree.
export { lambingCalendar, reproductionKpis } from './breeding.summary';

const { animals, dailyLogLines, dailyLogs, items, weightRecords } = schema;

const count = sql<number>`count(*)`.mapWith(Number);

export async function herdSummary() {
  const rows = await tx()
    .select({ category: animals.category, status: animals.status, head: count })
    .from(animals)
    .where(and(eq(animals.farmId, ctx().farmId), onFarm()))
    .groupBy(animals.category, animals.status);

  // An animal has one status, so a pregnant ewe that falls ill stops being 'pregnant' there. She is
  // still carrying: the open pregnancies are the count, the same one the breeding page shows.
  const [carrying] = await tx()
    .select({ head: count })
    .from(animals)
    .where(and(eq(animals.farmId, ctx().farmId), onFarm(), carryingPregnancy));

  const byCategory: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    byCategory[row.category] = (byCategory[row.category] ?? 0) + row.head;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + row.head;
    total += row.head;
  }
  return {
    total,
    byCategory,
    byStatus,
    pregnant: carrying.head,
    sick: byStatus.sick ?? 0,
    quarantine: byStatus.quarantine ?? 0,
  };
}

/** When the animal joined the farm. created_at covers records with neither date. */
const arrivalDate = sql`coalesce(case when ${animals.origin} = 'born' then ${animals.birthDate} else ${animals.purchaseDate} end, ${animals.createdAt}::date)`;

/**
 * Poda harakati (spec 8.6). Works from the animals table, which every exit path updates, whether it
 * came from this module or from a sales document.
 */
export async function herdMovement(from: string, to: string) {
  const farm = eq(animals.farmId, ctx().farmId);

  const [opening] = await tx()
    .select({ head: count })
    .from(animals)
    .where(and(farm, sql`${arrivalDate} < ${from}`, sql`(${animals.exitDate} is null or ${animals.exitDate} >= ${from})`));

  const arrivals = await tx()
    .select({ origin: animals.origin, head: count })
    .from(animals)
    .where(and(farm, sql`${arrivalDate} between ${from} and ${to}`))
    .groupBy(animals.origin);

  const exits = await tx()
    .select({ status: animals.status, head: count })
    .from(animals)
    .where(and(farm, between(animals.exitDate, from, to)))
    .groupBy(animals.status);

  const arrived = (origin: string) => arrivals.find((a) => a.origin === origin)?.head ?? 0;
  const left = (status: string) => exits.find((e) => e.status === status)?.head ?? 0;

  const figures = {
    opening: opening.head,
    born: arrived('born'),
    purchased: arrived('purchased'),
    sold: left('sold'),
    slaughtered: left('slaughtered'),
    dead: left('dead'),
    lost: left('lost'),
  };
  const closing = herdCount(figures);
  return { ...figures, closing, averageHead: averageHead(figures.opening, closing, figures.purchased) };
}

export async function mortality(days: number) {
  const to = today();
  const from = addDays(to, -(days - 1));
  const movement = await herdMovement(from, to);
  return {
    dead: movement.dead,
    percent: mortalityPercent(movement.dead, movement.averageHead),
  };
}

/** Average recorded weight per month, oldest first; months with no weighing are null. */
export async function weightTrend(months: number) {
  const current = monthOf(today());
  const [year, month] = current.split('-').map(Number);
  const list: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    list.push(d.toISOString().slice(0, 7));
  }
  const rows = await tx()
    .select({
      month: sql<string>`to_char(${weightRecords.date}, 'YYYY-MM')`,
      avgKg: sql<number>`round(avg(${weightRecords.weightKg}), 2)`.mapWith(Number),
    })
    .from(weightRecords)
    .where(and(eq(weightRecords.farmId, ctx().farmId), gte(weightRecords.date, `${list[0]}-01`)))
    .groupBy(sql`1`);
  return list.map((m) => ({ month: m, avgKg: rows.find((r) => r.month === m)?.avgKg ?? null }));
}

/**
 * Live weight gained in a period: for each animal, its last weight minus its first.
 * An animal needs two weighings in the range to count, since one point shows no gain.
 */
export async function weightGain(from: string, to: string, herdId?: string) {
  const result = await tx().execute<{ animals: string; gain_kg: string | null; avg_daily_kg: string | null }>(sql`
    with spans as (
      select w.animal_id,
             (array_agg(w.weight_kg order by w.date, w.created_at))[1] as first_kg,
             (array_agg(w.weight_kg order by w.date desc, w.created_at desc))[1] as last_kg,
             min(w.date) as first_date,
             max(w.date) as last_date
      from weight_records w
      join animals a on a.id = w.animal_id
      where w.farm_id = ${ctx().farmId}
        and w.date between ${from} and ${to}
        ${herdId ? sql`and a.herd_id = ${herdId}` : sql``}
      group by w.animal_id
      having max(w.date) > min(w.date)
    )
    select count(*) as animals,
           sum(last_kg - first_kg) as gain_kg,
           avg((last_kg - first_kg) / (last_date - first_date)) as avg_daily_kg
    from spans`);
  const row = result.rows[0];
  return {
    animals: Number(row.animals),
    gainKg: row.gain_kg === null ? null : Number(row.gain_kg),
    /** O'rtacha kunlik o'sish, g. */
    adgG: row.avg_daily_kg === null ? null : Math.round(Number(row.avg_daily_kg) * 1000),
  };
}

/** Feed given in a period, as dry matter, from the daily logs. */
export async function feedDryMatter(from: string, to: string, herdId?: string) {
  const rows = await tx()
    .select({
      qty: dailyLogLines.actualQty,
      unit: items.unit,
      dryMatterPct: items.dryMatterPct,
    })
    .from(dailyLogLines)
    .innerJoin(dailyLogs, eq(dailyLogs.id, dailyLogLines.logId))
    .innerJoin(items, eq(items.id, dailyLogLines.itemId))
    .where(
      and(
        eq(dailyLogs.farmId, ctx().farmId),
        gte(dailyLogs.date, from),
        lte(dailyLogs.date, to),
        herdId ? eq(dailyLogs.herdId, herdId) : undefined,
      ),
    );
  let dryMatterKg = 0;
  let complete = true;
  for (const row of rows) {
    if (row.dryMatterPct === null) {
      complete = false;
      continue;
    }
    dryMatterKg += itemUnitToKg(row.qty, row.unit) * (row.dryMatterPct / 100);
  }
  // Without a dry-matter figure for every feed the total would quietly understate: report nothing.
  return { dryMatterKg: rows.length && complete ? round(dryMatterKg, 2) : null };
}

/** Growth KPIs for one herd or the whole farm over a period (spec 8.6, 14.3). */
export async function growthKpis(from: string, to: string, herdId?: string) {
  const gain = await weightGain(from, to, herdId);
  const feed = await feedDryMatter(from, to, herdId);
  // Feed covers every animal, so the gain must too: use the sample only if it can stand for the herd.
  const [{ head }] = await tx()
    .select({ head: countRows() })
    .from(animals)
    .where(
      and(
        eq(animals.farmId, ctx().farmId),
        inArray(animals.status, [...ANIMAL_ON_FARM_STATUSES]),
        herdId ? eq(animals.herdId, herdId) : undefined,
      ),
    );
  const herdGainKg = gain.gainKg === null ? null : scaleGainToHerd(gain.gainKg, gain.animals, head);
  return {
    ...gain,
    ...feed,
    head,
    herdGainKg,
    feedConversion: feed.dryMatterKg !== null && herdGainKg !== null ? feedConversion(feed.dryMatterKg, herdGainKg) : null,
  };
}
