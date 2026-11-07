import type { CountLine } from './types';

/** What was typed on a line, with the book on screen when it was typed. */
export type CountEntries = Record<string, { actual: number | null; book: number }>;

const round3 = (value: number) => Number(value.toFixed(3));

export const actualOf = (entries: CountEntries, line: CountLine) => (line.itemId in entries ? entries[line.itemId].actual : line.actualQty);

/** A number was counted against the book on screen. A refetch that moves the line must not change what it means. */
export const bookOf = (entries: CountEntries, line: CountLine) => (line.itemId in entries ? entries[line.itemId].book : line.systemQty);

export const enterCount = (entries: CountEntries, line: CountLine, actual: number | null): CountEntries => ({
  ...entries,
  [line.itemId]: { actual, book: bookOf(entries, line) },
});

export function differenceOf(entries: CountEntries, line: CountLine) {
  const actual = actualOf(entries, line);
  return actual === null ? 0 : round3(actual - bookOf(entries, line));
}

export const countPayload = (entries: CountEntries, lines: CountLine[]) =>
  lines.flatMap((line) => (line.itemId in entries ? [{ itemId: line.itemId, actualQty: entries[line.itemId].actual, systemQty: entries[line.itemId].book }] : []));
