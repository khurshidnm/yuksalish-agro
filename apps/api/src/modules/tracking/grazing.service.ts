/**
 * Where the flock spent its time (docs/tracking.md). The raw readings are about a hundred thousand
 * rows a day for 700 sheep and expire after a month, so each finished day is counted once, at
 * night, into `grazing_cell_days` and `grazing_field_days`. A request reads only those: at most
 * one row per used cell per herd per day, found by the (farm, date) index.
 */
import { addDays, round } from '@yap/shared';
import { animalDaysPerHa, GRAZING_RULES, grazingDay, heatmap, type GrazingAnimal } from '@yap/shared/formulas/grazing';
import type { Fix } from '@yap/shared/formulas/tracking';
import { and, desc, eq, gte, isNotNull, lt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';

const { animals, fields, grazingCellDays: cells, grazingFieldDays: fieldDays, trackerReadings: r } = schema;

const PERIODS = ['7', '30', '90'] as const;
const INSERT_CHUNK = 1000;

export const grazingQuery = z.object({
  days: z.enum(PERIODS).default('30'),
  herdId: z.uuid().optional(),
});

/** The period ends yesterday: today is still being grazed and is counted tonight. */
export async function grazing(q: z.infer<typeof grazingQuery>) {
  const farm = ctx().farmId;
  const days = Number(q.days);
  const to = addDays(today(), -1);
  const from = addDays(today(), -days);
  const inPeriod = <T extends typeof cells | typeof fieldDays>(t: T) =>
    and(eq(t.farmId, farm), gte(t.date, from), lte(t.date, to), q.herdId ? eq(t.herdId, q.herdId) : undefined);

  const [totals] = await tx()
    .select({ fixes: sql<number | null>`sum(${cells.fixes})`.mapWith(Number), days: sql<number>`count(distinct ${cells.date})`.mapWith(Number) })
    .from(cells)
    .where(inPeriod(cells));
  const base = { days, from, to, cellDeg: GRAZING_RULES.cellE7 / 1e7, minAnimalDayHours: GRAZING_RULES.minAnimalDayHours };
  if (!totals || !totals.fixes) return { ...base, daysWithData: 0, totalFixes: null, cells: null, truncated: false, fields: null };

  const fixes = sql<number>`sum(${cells.fixes})`.mapWith(Number);
  const top = await tx()
    .select({ x: cells.cellX, y: cells.cellY, fixes })
    .from(cells)
    .where(inPeriod(cells))
    .groupBy(cells.cellX, cells.cellY)
    .orderBy(desc(fixes), cells.cellY, cells.cellX)
    .limit(GRAZING_RULES.maxCells + 1);
  const map = heatmap(top.slice(0, GRAZING_RULES.maxCells), totals.fixes);

  const used = await tx()
    .select({
      fieldId: fieldDays.fieldId,
      number: fields.number,
      name: fields.name,
      landUse: fields.landUse,
      areaHa: fields.areaHa,
      fixes: sql<number>`sum(${fieldDays.fixes})`.mapWith(Number),
      animalDays: sql<number>`sum(${fieldDays.animals})`.mapWith(Number),
      animalHours: sql<number>`sum(${fieldDays.animalHours})`.mapWith(Number),
      daysUsed: sql<number>`count(distinct ${fieldDays.date})`.mapWith(Number),
    })
    .from(fieldDays)
    .innerJoin(fields, eq(fields.id, fieldDays.fieldId))
    .where(inPeriod(fieldDays))
    .groupBy(fieldDays.fieldId, fields.number, fields.name, fields.landUse, fields.areaHa)
    .orderBy(desc(sql`sum(${fieldDays.animalHours})`), fields.number);

  return {
    ...base,
    daysWithData: totals.days,
    totalFixes: totals.fixes,
    cells: map?.cells.map((c) => ({ ...c, share: round(c.share, 5) })) ?? null,
    truncated: top.length > GRAZING_RULES.maxCells,
    fields: used.map((f) => {
      const perHa = animalDaysPerHa(f.animalDays, f.areaHa);
      return {
        ...f,
        animalHours: round(f.animalHours, 1),
        /** This field's share of every fix in the period. */
        share: round(f.fixes / totals.fixes!, 4),
        animalDaysPerHa: perHa === null ? null : round(perHa, 1),
      };
    }),
  };
}

// ─── Nightly ────────────────────────────────────────────────────────────────

/**
 * Count each finished day into the grid and the fields. Yesterday is always redone, for readings
 * that arrived late; earlier days only if they have nothing yet, as far back as the raw readings
 * are kept. Then the grid older than the longest map is dropped.
 */
export async function summarizeGrazing(): Promise<number> {
  const c = ctx();
  const yesterday = addDays(today(), -1);
  const lookback = Math.max(1, Math.min(GRAZING_RULES.lookbackDays, c.settings.retention.trackerReadingsDays));
  const done = await tx()
    .selectDistinct({ date: cells.date })
    .from(cells)
    .where(and(eq(cells.farmId, c.farmId), gte(cells.date, addDays(today(), -lookback))));
  const doneDays = new Set(done.map((d) => d.date));
  let written = 0;
  for (let back = lookback; back >= 1; back -= 1) {
    const date = addDays(today(), -back);
    if (date !== yesterday && doneDays.has(date)) continue;
    written += await summarizeGrazingDay(date);
  }
  await tx().delete(cells).where(and(eq(cells.farmId, c.farmId), lt(cells.date, addDays(today(), -GRAZING_RULES.keepCellDays))));
  return written;
}

/** One local day of fixes into cells and fields; the day's earlier rows are replaced. Returns the fixes counted. */
export async function summarizeGrazingDay(date: string): Promise<number> {
  const c = ctx();
  const bounds = await tx().execute<{ start: Date; end: Date }>(
    sql`select (${date}::date)::timestamp at time zone ${c.timezone} as "start", (${addDays(date, 1)}::date)::timestamp at time zone ${c.timezone} as "end"`,
  );
  const { start, end } = bounds.rows[0]!;
  const rows = await tx()
    .select({ animalId: r.animalId, herdId: animals.herdId, at: r.recordedAt, lat: r.lat, lng: r.lng })
    .from(r)
    .innerJoin(animals, eq(animals.id, r.animalId))
    .where(and(eq(r.farmId, c.farmId), isNotNull(r.lat), isNotNull(r.lng), gte(r.recordedAt, new Date(start)), lt(r.recordedAt, new Date(end))));

  // A day whose readings have expired keeps the grid it was given while they were here.
  if (rows.length === 0) return 0;
  await tx().delete(cells).where(and(eq(cells.farmId, c.farmId), eq(cells.date, date)));
  await tx().delete(fieldDays).where(and(eq(fieldDays.farmId, c.farmId), eq(fieldDays.date, date)));

  const byAnimal = new Map<string, GrazingAnimal & { fixes: Fix[] }>();
  for (const row of rows) {
    const animal = byAnimal.get(row.animalId!) ?? { animalId: row.animalId!, herdId: row.herdId, fixes: [] };
    animal.fixes.push({ lat: row.lat!, lng: row.lng!, at: row.at.getTime() });
    byAnimal.set(row.animalId!, animal);
  }
  const outlines = await tx()
    .select({ id: fields.id, geometry: fields.boundary })
    .from(fields)
    .where(and(eq(fields.farmId, c.farmId), isNotNull(fields.boundary)));
  const day = grazingDay([...byAnimal.values()], outlines, new Date(end).getTime());

  const own = { tenantId: c.tenantId, farmId: c.farmId, date };
  for (let i = 0; i < day.cells.length; i += INSERT_CHUNK) {
    await tx()
      .insert(cells)
      .values(day.cells.slice(i, i + INSERT_CHUNK).map((cell) => ({ ...own, herdId: cell.herdId, cellX: cell.x, cellY: cell.y, fixes: cell.fixes })));
  }
  if (day.fields.length) {
    await tx()
      .insert(fieldDays)
      .values(day.fields.map((f) => ({ ...own, herdId: f.herdId, fieldId: f.fieldId, fixes: f.fixes, animals: f.animals, animalHours: round(f.animalHours, 2) })));
  }
  return day.fixes;
}
