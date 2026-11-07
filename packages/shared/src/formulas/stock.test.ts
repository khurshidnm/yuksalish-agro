import { describe, expect, it } from 'vitest';
import { round, weightedAverageCost } from './index';
import { consumeInProportion } from './stock';

const batch = (id: string, qtyRemaining: number, unitCost: number) => ({ id, qtyRemaining, unitCost });
const taken = (r: ReturnType<typeof consumeInProportion>) => round(r.lines.reduce((sum, l) => sum + l.qty, 0), 3);

describe('consumeInProportion', () => {
  // 100 l at 10 000 + 100 l at 30 000 = 4 000 000 for 200 l, an average of 20 000.
  const twoPrices = [batch('old', 100, 10_000), batch('new', 100, 30_000)];

  it('takes every batch in proportion, each at its own cost', () => {
    const r = consumeInProportion(twoPrices, 50);
    expect(r.lines).toEqual([
      { batchId: 'old', qty: 25, unitCost: 10_000 },
      { batchId: 'new', qty: 25, unitCost: 30_000 },
    ]);
    // 25 x 10 000 + 25 x 30 000 = 1 000 000, the same as 50 x 20 000.
    expect(r.totalCost).toBe(1_000_000);
    expect(r.shortage).toBe(0);
  });

  it('leaves the average where it was, and the value what it should be', () => {
    const r = consumeInProportion(twoPrices, 50);
    const left = twoPrices.map((b, index) => ({ ...b, qtyRemaining: b.qtyRemaining - r.lines[index].qty }));
    expect(weightedAverageCost(left)).toBe(20_000);
    // 75 x 10 000 + 75 x 30 000 = 3 000 000, and 3 000 000 + 1 000 000 is what was paid.
    expect(left.reduce((sum, b) => sum + b.qtyRemaining * b.unitCost, 0)).toBe(3_000_000);
  });

  it('weights by what each batch holds', () => {
    // 300 + 100 = 400 l. An issue of 100 takes three quarters from the larger batch.
    const r = consumeInProportion([batch('a', 300, 10), batch('b', 100, 20)], 100);
    expect(r.lines.map((l) => l.qty)).toEqual([75, 25]);
    // 75 x 10 + 25 x 20 = 1250, and the average is (3000 + 2000) / 400 = 12.5.
    expect(r.totalCost).toBe(1250);
  });

  it('empties every batch when everything is taken', () => {
    const r = consumeInProportion(twoPrices, 200);
    expect(r.lines.map((l) => l.qty)).toEqual([100, 100]);
    expect(r.totalCost).toBe(4_000_000);
  });

  it('places every thousandth when the shares do not divide evenly', () => {
    // 2 / 3 = 0.666..., so the rounded parts must still add up to exactly 2.
    const r = consumeInProportion([batch('a', 1, 1), batch('b', 1, 1), batch('c', 1, 1)], 2);
    expect(r.lines.map((l) => l.qty)).toEqual([0.667, 0.667, 0.666]);
    expect(taken(r)).toBe(2);
  });

  it('leaves out a batch too small to give up a thousandth, and still places the whole issue', () => {
    const r = consumeInProportion([batch('big', 1000, 10), batch('crumb', 0.001, 99)], 1);
    expect(r.lines).toEqual([{ batchId: 'big', qty: 1, unitCost: 10 }]);
  });

  it('skips empty batches', () => {
    const r = consumeInProportion([batch('x', 0, 5), batch('y', 100, 20)], 10);
    expect(r.lines).toEqual([{ batchId: 'y', qty: 10, unitCost: 20 }]);
  });

  it('reports a shortage instead of going negative', () => {
    const r = consumeInProportion(twoPrices, 250);
    expect(r.shortage).toBe(50);
    expect(r.lines.map((l) => l.qty)).toEqual([100, 100]);
  });

  it('reports everything as short when nothing is held', () => {
    expect(consumeInProportion([], 5)).toEqual({ lines: [], totalCost: 0, shortage: 5 });
  });

  it('never takes more than a batch holds and always places the exact quantity', () => {
    let seed = 20261104;
    const next = (limit: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % limit;
    };
    for (let run = 0; run < 2000; run++) {
      const batches = Array.from({ length: 1 + next(6) }, (_, index) =>
        batch(`b${index}`, (1 + next(next(2) ? 2_000_000 : 40)) / 1000, 1 + next(50_000)),
      );
      const held = round(batches.reduce((sum, b) => sum + b.qtyRemaining, 0), 3);
      const qty = Math.max(0.001, round((next(1 + Math.round(held * 1000)) / 1000), 3));
      const r = consumeInProportion(batches, qty);
      expect(r.shortage).toBe(0);
      expect(taken(r)).toBe(qty);
      for (const line of r.lines) {
        expect(line.qty).toBeLessThanOrEqual(batches.find((b) => b.id === line.batchId)!.qtyRemaining);
      }
    }
  });
});
