/** The rules behind the field screens, separate from React so they can be tested directly. */
import { deviationPercent, round } from '@yap/shared';
import type { NewRecord, OutboxRecord, SentRecord } from '@/lib/outbox';
import type { TodayData, TodayHerd } from './data';

export interface DirectoryAnimal {
  id: string;
  tag: string;
  sex: string;
  category: string;
  status: string;
  herdId: string | null;
  codes: string[];
  expectedDate: string | null;
}

/**
 * Find animals as a person types. Exact tag or scanned code first, then the number on the tag, so
 * "123" finds YA-0123, then any part of the tag.
 */
export function matchAnimals(animals: DirectoryAnimal[], query: string, limit = 6): DirectoryAnimal[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const number = /^\d+$/.test(q) ? Number(q) : null;

  const rank = (animal: DirectoryAnimal): number | null => {
    const tag = animal.tag.toLowerCase();
    if (tag === q || animal.codes.some((code) => code.toLowerCase() === q)) return 0;
    const tail = tag.match(/(\d+)$/)?.[1];
    if (number !== null && tail !== undefined && Number(tail) === number) return 1;
    return tag.includes(q) ? 2 : null;
  };

  const found: { animal: DirectoryAnimal; score: number }[] = [];
  for (const animal of animals) {
    const score = rank(animal);
    if (score !== null) found.push({ animal, score });
  }
  return found
    .sort((a, b) => a.score - b.score || a.animal.tag.localeCompare(b.animal.tag))
    .slice(0, limit)
    .map((f) => f.animal);
}

/** A sensible +/- step: 10 kg on 600 kg, 1 kg on 12 kg, 100 g on 3.6 kg. */
export function stepFor(quantity: number): number {
  if (quantity >= 500) return 10;
  if (quantity >= 50) return 5;
  if (quantity >= 10) return 1;
  if (quantity >= 1) return 0.5;
  return 0.1;
}

export function stepUp(value: number | null, step: number): number {
  return round((value ?? 0) + step, 3);
}

export function stepDown(value: number | null, step: number): number {
  return Math.max(0, round((value ?? 0) - step, 3));
}

/** Percent away from plan once it is worth mentioning, else null. */
export function notableDeviation(actual: number | null, planned: number, threshold: number): number | null {
  if (actual === null) return null;
  const raw = deviationPercent(actual, planned);
  if (raw === null) return null;
  const percent = round(raw, 0);
  return Math.abs(percent) > threshold ? percent : null;
}

export type HerdDayStatus = 'todo' | 'queued' | 'failed' | 'conflict' | 'logged';

interface HerdDay {
  id: string;
  log?: unknown;
}

export function dailyLogRecord(records: OutboxRecord[], herdId: string, date: string): OutboxRecord | undefined {
  return records.find((r) => r.kind === 'daily_log' && r.meta.herdId === herdId && r.meta.date === date);
}

/** Where a daily log in the queue opens: for its own date, which may be an earlier day than today. */
export function dailyLogLink(record: OutboxRecord): string {
  return `/today/daily-log/${record.meta.herdId as string}?date=${record.meta.date as string}`;
}

/** The record a daily log screen edits. Asking for a date reaches a queued record, and nothing else in the past. */
export function logToOpen(records: OutboxRecord[], herdId: string, askedDate: string | null, today: string): OutboxRecord | undefined {
  return (askedDate ? dailyLogRecord(records, herdId, askedDate) : undefined) ?? dailyLogRecord(records, herdId, today);
}

export interface LogLine {
  itemId: string;
  itemName: string;
  unit: string;
  plannedQty: number;
  qtyOnHand: number;
  actualQty: number | null;
}

export interface SavedLogValues {
  lines: { itemId: string; actualQty: number }[];
  waterL: number | null;
  condition: string;
  notes: string | null;
}

/**
 * The ration prefilled, so an ordinary day takes one tap. A saved day opens with its saved amounts, and every
 * one of them stays, even for feed no longer in today's ration or lists: that feed was given.
 */
export function startingLines(herd: TodayHerd, feedItems: TodayData['feedItems'], saved: SavedLogValues | null, queuedLines: Partial<LogLine>[] = []): LogLine[] {
  const lines: LogLine[] = herd.lines.map((line) => ({
    ...line,
    actualQty: saved ? (saved.lines.find((l) => l.itemId === line.itemId)?.actualQty ?? 0) : line.plannedQty,
  }));
  for (const extra of saved?.lines ?? []) {
    if (lines.some((l) => l.itemId === extra.itemId)) continue;
    const item = feedItems.find((i) => i.id === extra.itemId);
    const queued = queuedLines.find((l) => l.itemId === extra.itemId);
    lines.push({
      itemId: extra.itemId,
      itemName: item?.name ?? queued?.itemName ?? extra.itemId,
      unit: item?.unit ?? queued?.unit ?? 'kg',
      plannedQty: 0,
      qtyOnHand: item?.qtyOnHand ?? 0,
      actualQty: extra.actualQty,
    });
  }
  return lines;
}

/** A herd's state today, trusting the queue over the last download. */
export function herdDayStatus(
  herd: HerdDay,
  records: OutboxRecord[],
  sent: SentRecord[],
  date: string,
  dataDate: string,
): HerdDayStatus {
  const record = dailyLogRecord(records, herd.id, date);
  if (record?.status === 'conflict') return 'conflict';
  if (record?.status === 'failed' || record?.status === 'stuck') return 'failed';
  if (record) return 'queued';
  if (dataDate === date && herd.log) return 'logged';
  return sent.some((s) => s.kind === 'daily_log' && s.meta.herdId === herd.id && s.meta.date === date) ? 'logged' : 'todo';
}

/** Feed already promised by records still in the queue, for this item. */
export function queuedFeed(records: OutboxRecord[], itemId: string, exceptId?: string): number {
  let total = 0;
  for (const record of records) {
    if (record.kind !== 'daily_log' || record.id === exceptId || record.status === 'conflict') continue;
    // A correction changes an amount that is already off the stock figure, so it cannot be counted.
    if (record.method !== 'POST') continue;
    for (const line of (record.body.lines as { itemId: string; actualQty: number }[] | undefined) ?? []) {
      if (line.itemId === itemId) total += line.actualQty;
    }
  }
  return round(total, 3);
}

/** What to say before someone signs out, if anything: the keys of a title and of the paragraphs under it. */
export function signOutWarning(unsent: number, noSignal: boolean): { title: string; body: string[] } | null {
  if (unsent === 0 && !noSignal) return null;
  return {
    title: unsent > 0 ? 'signOut.unsentTitle' : 'signOut.noSignalTitle',
    body: [...(unsent > 0 ? ['signOut.unsentBody'] : []), ...(noSignal ? ['signOut.noSignalBody'] : [])],
  };
}

/** Animals a queued record has already taken off the farm. */
export function animalsLeaving(records: OutboxRecord[]): Set<string> {
  return new Set(records.filter((r) => r.kind === 'death').map((r) => r.body.animalId as string));
}

/** Ewes whose lambing is on this phone, waiting or just sent: the watch list shows them as done. */
export function ewesLambed(records: OutboxRecord[], sent: SentRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const record of [...records, ...sent]) {
    if (record.kind === 'lambing' && typeof record.meta.eweId === 'string') ids.add(record.meta.eweId);
  }
  return ids;
}

/** Pens a queued or just-sent record on this phone has filled: the stored list of free pens is older. */
export function pensTaken(records: OutboxRecord[], sent: SentRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const record of [...records, ...sent]) {
    if (record.kind === 'pen_stay' && typeof record.meta.facilityId === 'string') ids.add(record.meta.facilityId);
  }
  return ids;
}

export type Mothering = 'with_dam' | 'fostered' | 'bottle';

export interface LambCareDraft {
  /** The id the lambing form gave the lamb, which is its id on the server too. */
  lambId: string;
  colostrum: boolean;
  navelTreated: boolean;
  mothering: Mothering;
  fosterEweId: string | null;
}

export interface AfterLambing {
  ewe: { id: string; tag: string };
  lambingId: string;
  /** When the form was saved: the hour colostrum was given, if it was. */
  at: string;
  date: string;
  lambs: LambCareDraft[];
  penId: string | null;
  titles: { care: (n: number) => string; pen: string };
}

/**
 * What follows a lambing in the queue: a care record per lamb, then the pen. They carry the ewe's
 * tag, so they wait behind her lambing if that one gets stuck. Only what was done is sent: a late
 * delivery must not wipe what someone has recorded since.
 */
export function afterLambingRecords(input: AfterLambing): NewRecord[] {
  const meta = { tag: input.ewe.tag, eweId: input.ewe.id };
  const records: NewRecord[] = [];
  input.lambs.forEach((lamb, index) => {
    const fostered = lamb.mothering === 'fostered' && lamb.fosterEweId !== null;
    const body: Record<string, unknown> = {
      ...(lamb.colostrum ? { colostrumAt: input.at } : {}),
      ...(lamb.navelTreated ? { navelTreated: true } : {}),
      ...(lamb.mothering === 'bottle' ? { mothering: 'bottle' } : {}),
      ...(fostered ? { mothering: 'fostered', fosterEweId: lamb.fosterEweId } : {}),
    };
    if (Object.keys(body).length === 0) return;
    records.push({ kind: 'lamb_care', path: `/livestock/lambs/${lamb.lambId}/care`, body, title: input.titles.care(index + 1), meta: { ...meta, lambId: lamb.lambId } });
  });
  if (input.penId) {
    records.push({
      kind: 'pen_stay',
      path: '/livestock/pens/stays',
      body: { facilityId: input.penId, eweId: input.ewe.id, lambingId: input.lambingId, sinceDate: input.date },
      title: input.titles.pen,
      meta: { ...meta, facilityId: input.penId },
    });
  }
  return records;
}

/** A care form is ready when every fostered lamb has its foster ewe. */
export function careReady(lambs: LambCareDraft[]): boolean {
  return lambs.every((lamb) => lamb.mothering !== 'fostered' || lamb.fosterEweId !== null);
}
