import { type ScaleAnimal, type ScalePlanRow, type ScaleRow } from '@yap/shared/formulas/scale-file';

/** One code with the animals that carry it: POST /livestock/animals/match-codes. */
export interface CodeMatches {
  code: string;
  matches: ScaleAnimal[];
}

/** One row of the body of POST /livestock/weighing-campaigns/:id/entries/bulk. */
export interface BulkEntry {
  code: string;
  animalId: string;
  weightKg: number;
  method: 'scale' | 'rfid';
}

/** What the bulk route answers. */
export interface BulkResult {
  applied: number;
  failed: { code: string; error: string }[];
}

/** The codes worth asking the server about: each once, and only from lines that can be used. */
export function codesToMatch(rows: readonly ScaleRow[]): string[] {
  return [...new Set(rows.filter((row) => row.problem === null && row.code !== null).map((row) => row.code!))];
}

/** A code the server was not asked about, or answered nothing for, matches no animal. */
export function matcherOf(found: readonly CodeMatches[]): (code: string) => readonly ScaleAnimal[] {
  const byCode = new Map(found.map((entry) => [entry.code, entry.matches]));
  return (code) => byCode.get(code) ?? [];
}

/** The lines that can be recorded, less those the person unticked. */
export function chosenRows(plan: readonly ScalePlanRow[], excluded: ReadonlySet<number>): ScalePlanRow[] {
  return plan.filter((row) => row.status === 'ready' && !excluded.has(row.line));
}

/**
 * What is sent. Only lines the plan calls ready, each naming its animal by id: the server does not
 * look the code up a second time, so it cannot land on another animal than the one shown.
 */
export function bulkEntries(plan: readonly ScalePlanRow[], excluded: ReadonlySet<number>): BulkEntry[] {
  return chosenRows(plan, excluded).map((row) => ({ code: row.code!, animalId: row.animal!.id, weightKg: row.weightKg!, method: row.method }));
}
