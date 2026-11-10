/**
 * Pregnancy scanning. A scan counts the foetuses a ewe carries: the count goes onto her pregnancy,
 * every expected-lambs figure reads it from there (formulas/lambing.ts), and a count of 0 closes
 * the pregnancy as "not pregnant", so she shows as open again.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { MAX_SCAN_FETUSES } from '@yap/shared/formulas/lambing';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate } from '../../core/query';
import { closePregnancy } from './breeding.service';
import { assertNotFuture, getHerdOrThrow, onFarm } from './refs';

const { animals, breedingRecords: b, herds, pregnancyScans: s } = schema;

const fetusCount = z.number().int().min(0).max(MAX_SCAN_FETUSES);
const note = z.string().trim().max(500).nullish();
const scannedBy = z.string().trim().max(120).nullish();

export const scanInput = z.object({ id: clientId, date: isoDate.optional(), fetusCount, scannedBy, notes: note });
export type ScanInput = z.infer<typeof scanInput>;

/** A whole scanning day: one count per ewe, found by tag or by id. */
export const bulkScanInput = z.object({
  /** When set, only ewes of this herd are accepted: a tag from another herd is a slip. */
  herdId: z.uuid().nullish(),
  date: isoDate.optional(),
  scannedBy,
  entries: z
    .array(
      z
        .object({ eweId: z.uuid().optional(), tag: z.string().trim().min(1).max(60).optional(), fetusCount, notes: note })
        .refine((v) => !!v.eweId !== !!v.tag, { message: 'Give the ewe by id or by tag', path: ['tag'] }),
    )
    .min(1)
    .max(2000),
});

export const scanEwesQuery = z.object({
  herdId: z.uuid().optional(),
  /** 1, 2 or 3 for ewes carrying that many; `none` for those not scanned yet. */
  fetusCount: z.enum(['none', '1', '2', '3']).optional(),
});

type Pregnancy = typeof b.$inferSelect;

async function lockOpenPregnancy(id: string): Promise<Pregnancy> {
  const [row] = await tx()
    .select()
    .from(b)
    .where(and(eq(b.id, id), eq(b.farmId, ctx().farmId)))
    .for('update');
  if (!row) throw notFound('Pregnancy');
  if (row.status !== 'pregnant') throw conflict('PREGNANCY_NOT_OPEN', 'This pregnancy is already closed');
  return row;
}

async function writeScan(pregnancy: Pregnancy, i: ScanInput & { date: string }) {
  if (i.date < pregnancy.matingDate) {
    throw badRequest('SCAN_BEFORE_MATING', 'A scan cannot be earlier than the mating date', { matingDate: pregnancy.matingDate });
  }
  const c = ctx();
  const [scan] = await tx()
    .insert(s)
    .values({
      ...(i.id ? { id: i.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      breedingId: pregnancy.id,
      eweId: pregnancy.eweId,
      date: i.date,
      fetusCount: i.fetusCount,
      scannedBy: i.scannedBy || null,
      notes: i.notes || null,
    })
    .returning();

  // The pregnancy carries the latest scan by date; an older one entered late changes nothing there.
  const latest = !pregnancy.scanDate || i.date >= pregnancy.scanDate;
  if (latest) await tx().update(b).set({ fetusCount: i.fetusCount, scanDate: i.date }).where(eq(b.id, pregnancy.id));
  await recordEvent({
    type: 'animal.scanned',
    entityType: 'animal',
    entityId: pregnancy.eweId,
    occurredAt: i.date,
    severity: i.fetusCount === 0 ? 'attention' : 'info',
    data: { scanId: scan.id, breedingId: pregnancy.id, fetusCount: i.fetusCount },
  });
  // Empty: the pregnancy closes as "not pregnant" and the ewe returns to active, free to be mated.
  // An older "empty" entered after a newer scan found lambs is history: the newer scan stands.
  const closed = latest && i.fetusCount === 0;
  if (closed) await closePregnancy(pregnancy.id, { status: 'failed', notes: i.notes ?? undefined });
  return { scan, closed };
}

/** One scan on one pregnancy. */
export async function recordScan(breedingId: string, i: ScanInput) {
  const date = i.date ?? today();
  assertNotFuture(date);
  const pregnancy = await lockOpenPregnancy(breedingId);
  const { scan, closed } = await writeScan(pregnancy, { ...i, date });
  return { ...scan, closed };
}

export async function listScans(breedingId: string) {
  const rows = await tx()
    .select()
    .from(s)
    .where(and(eq(s.breedingId, breedingId), eq(s.farmId, ctx().farmId)))
    .orderBy(desc(s.date), desc(s.createdAt));
  // A visiting specialist's name is personal data (rule 8).
  return hasPermission('pii.view') ? rows : rows.map((row) => ({ ...row, scannedBy: null }));
}

type SkipReason = 'UNKNOWN_TAG' | 'NOT_IN_HERD' | 'NOT_PREGNANT' | 'DUPLICATE' | 'SCAN_BEFORE_MATING';

/** A scanning day. What cannot be recorded is listed, and the rest is saved. */
export async function bulkScan(i: z.infer<typeof bulkScanInput>) {
  const date = i.date ?? today();
  assertNotFuture(date);
  if (i.herdId) await getHerdOrThrow(i.herdId);
  const farmId = ctx().farmId;

  const ids = i.entries.flatMap((e) => (e.eweId ? [e.eweId] : []));
  const tags = i.entries.flatMap((e) => (e.tag ? [e.tag.toLowerCase()] : []));
  const found = await tx()
    .select({ id: animals.id, tag: animals.tag, herdId: animals.herdId })
    .from(animals)
    .where(
      and(
        eq(animals.farmId, farmId),
        onFarm(),
        sql`(${ids.length ? inArray(animals.id, ids) : sql`false`} or ${tags.length ? inArray(sql`lower(${animals.tag})`, tags) : sql`false`})`,
      ),
    );
  const byId = new Map(found.map((a) => [a.id, a]));
  const byTag = new Map(found.map((a) => [a.tag.toLowerCase(), a]));

  const open = found.length
    ? await tx()
        .select()
        .from(b)
        .where(and(eq(b.farmId, farmId), eq(b.status, 'pregnant'), inArray(b.eweId, found.map((a) => a.id))))
        .for('update')
    : [];
  const pregnancyOf = new Map(open.map((p) => [p.eweId, p]));

  const skipped: { tag: string | null; eweId: string | null; reason: SkipReason }[] = [];
  const seen = new Set<string>();
  let recorded = 0;
  let closed = 0;
  for (const entry of i.entries) {
    const animal = entry.eweId ? byId.get(entry.eweId) : byTag.get(entry.tag!.toLowerCase());
    const skip = (reason: SkipReason) => skipped.push({ tag: animal?.tag ?? entry.tag ?? null, eweId: animal?.id ?? entry.eweId ?? null, reason });
    if (!animal) {
      skip('UNKNOWN_TAG');
      continue;
    }
    if (i.herdId && animal.herdId !== i.herdId) {
      skip('NOT_IN_HERD');
      continue;
    }
    if (seen.has(animal.id)) {
      skip('DUPLICATE');
      continue;
    }
    seen.add(animal.id);
    const pregnancy = pregnancyOf.get(animal.id);
    if (!pregnancy) {
      skip('NOT_PREGNANT');
      continue;
    }
    if (date < pregnancy.matingDate) {
      skip('SCAN_BEFORE_MATING');
      continue;
    }
    const written = await writeScan(pregnancy, { date, fetusCount: entry.fetusCount, scannedBy: i.scannedBy, notes: entry.notes });
    recorded += 1;
    if (written.closed) closed += 1;
  }
  return { date, recorded, closed, skipped };
}

/**
 * Ewes with an open pregnancy and what their scan found: the work list for a scanning day, and
 * the list from which twin and triplet bearers are moved to their own herd.
 */
export async function scanEwes(q: z.infer<typeof scanEwesQuery>) {
  const farmId = ctx().farmId;
  const rows = await tx()
    .select({
      breedingId: b.id,
      eweId: b.eweId,
      tag: animals.tag,
      herdId: animals.herdId,
      herdName: herds.name,
      expectedDate: b.expectedDate,
      fetusCount: b.fetusCount,
      scanDate: b.scanDate,
    })
    .from(b)
    .innerJoin(animals, eq(animals.id, b.eweId))
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .where(
      and(
        eq(b.farmId, farmId),
        eq(animals.farmId, farmId),
        eq(b.status, 'pregnant'),
        onFarm(),
        q.herdId ? eq(animals.herdId, q.herdId) : undefined,
      ),
    )
    .orderBy(asc(animals.tag));

  const summary = { total: rows.length, notScanned: 0, single: 0, twin: 0, triplet: 0, fetuses: 0 };
  for (const row of rows) {
    if (row.fetusCount === null) summary.notScanned += 1;
    else {
      summary.fetuses += row.fetusCount;
      if (row.fetusCount === 1) summary.single += 1;
      if (row.fetusCount === 2) summary.twin += 1;
      if (row.fetusCount >= 3) summary.triplet += 1;
    }
  }
  const wanted = q.fetusCount;
  const ewes = wanted === undefined ? rows : rows.filter((row) => (wanted === 'none' ? row.fetusCount === null : row.fetusCount === Number(wanted)));
  return { summary, ewes };
}
