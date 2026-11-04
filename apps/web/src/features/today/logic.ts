/** The rules behind the field screens, separate from React so they can be tested directly. */
import { deviationPercent, round } from '@yap/shared';
import type { OutboxRecord, SentRecord } from '@/lib/outbox';

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
  if (record?.status === 'failed') return 'failed';
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

/** Animals a queued record has already taken off the farm. */
export function animalsLeaving(records: OutboxRecord[]): Set<string> {
  return new Set(records.filter((r) => r.kind === 'death').map((r) => r.body.animalId as string));
}
