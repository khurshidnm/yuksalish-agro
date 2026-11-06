import { describe, expect, it } from 'vitest';
import { actualOf, bookOf, countPayload, differenceOf, enterCount } from './count-entry';
import type { CountLine } from './types';

const line = (systemQty: number, actualQty = systemQty, itemId = 'nz'): CountLine => ({
  id: `line-${itemId}`,
  itemId,
  itemName: 'NZ Nazorat ozuqa',
  unit: 'kg',
  systemQty,
  actualQty,
  diffQty: actualQty - systemQty,
  diffCost: null,
});

describe('a number typed on the count sheet', () => {
  it('goes to the server with the book it was typed against', () => {
    const entries = enterCount({}, line(1521.333), 1518.333);
    expect(countPayload(entries, [line(1521.333)])).toEqual([{ itemId: 'nz', actualQty: 1518.333, systemQty: 1521.333 }]);
  });

  it('keeps that book when a refetch moves the line after 7 are issued', () => {
    const entries = enterCount({}, line(1521.333), 1518.333);
    const moved = line(1514.333);
    expect(bookOf(entries, moved)).toBe(1521.333);
    // 1518.333 − 1521.333. Against the moved line it would read +4, the false surplus.
    expect(differenceOf(entries, moved)).toBe(-3);
    expect(countPayload(entries, [moved])).toEqual([{ itemId: 'nz', actualQty: 1518.333, systemQty: 1521.333 }]);
  });

  it('keeps the first book through a correction, even if the line moved in between', () => {
    const typed = enterCount({}, line(100), 98);
    const corrected = enterCount(typed, line(90), 97);
    expect(corrected.nz).toEqual({ actual: 97, book: 100 });
    expect(differenceOf(corrected, line(90))).toBe(-3);
  });

  it('a cleared number is blank, with no difference', () => {
    const entries = enterCount({}, line(100), null);
    expect(actualOf(entries, line(100))).toBeNull();
    expect(differenceOf(entries, line(100))).toBe(0);
  });
});

describe('a line nobody typed on', () => {
  it('shows the sheet as read and is not sent', () => {
    const entries = enterCount({}, line(50, 50, 'other'), 49);
    expect(bookOf(entries, line(90, 85))).toBe(90);
    expect(actualOf(entries, line(90, 85))).toBe(85);
    expect(differenceOf(entries, line(90, 85))).toBe(-5);
    expect(countPayload(entries, [line(90, 85), line(50, 50, 'other')])).toEqual([{ itemId: 'other', actualQty: 49, systemQty: 50 }]);
  });
});
