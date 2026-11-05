import { describe, expect, it } from 'vitest';
import { OUTLOOK_ASSUMPTIONS, feedCoverage, projectHerd } from './outlook';

const months = ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10'];

describe('projectHerd', () => {
  const rows = projectHerd({ months, head: 700, ewesDue: { '2027-02': 300, '2027-03': 400 }, assumptions: OUTLOOK_ASSUMPTIONS });
  const at = (month: string) => rows.find((row) => row.month === month)!;

  it('counts lambs born from the ewes due', () => {
    // 300 × 1.1 and 400 × 1.1
    expect(at('2027-02').lambsBorn).toBe(330);
    expect(at('2027-03').lambsBorn).toBe(440);
  });

  it('carries survivors, then sells them after six months, keeping a fifth', () => {
    // 770 born × 0.92 survive
    expect(at('2027-07').lambsOnFarm).toBe(708);
    expect(at('2027-07').head).toBe(1408);
    // 330 × 0.92 × 0.8
    expect(at('2027-08').lambsSold).toBe(243);
    // 440 × 0.92 × 0.8
    expect(at('2027-09').lambsSold).toBe(324);
    // What stays is the fifth kept for the flock.
    expect(at('2027-10').lambsOnFarm).toBe(142);
  });

  it('moves ewes from carrying to nursing for three months', () => {
    expect(at('2027-01')).toMatchObject({ carrying: 700, nursing: 0 });
    expect(at('2027-02')).toMatchObject({ carrying: 400, nursing: 300 });
    expect(at('2027-03')).toMatchObject({ carrying: 0, nursing: 700 });
    expect(at('2027-04').nursing).toBe(700);
    expect(at('2027-05').nursing).toBe(400);
    expect(at('2027-06').nursing).toBe(0);
  });

  it('a farm with no pregnancies just stays as it is', () => {
    const flat = projectHerd({ months, head: 50, ewesDue: {}, assumptions: OUTLOOK_ASSUMPTIONS });
    expect(flat.every((row) => row.head === 50 && row.lambsBorn === 0)).toBe(true);
  });
});

describe('feedCoverage', () => {
  const needs = [
    { month: '2027-01', kg: 100 },
    { month: '2027-02', kg: 100 },
    { month: '2027-03', kg: 100 },
    { month: '2027-04', kg: 100 },
  ];

  it('stops at the next harvest', () => {
    expect(feedCoverage(250, needs, '2027-03')).toEqual({ needKg: 200, surplusKg: 50, runsOutMonth: null });
  });

  it('names the first month it cannot cover', () => {
    expect(feedCoverage(250, needs, null)).toEqual({ needKg: 400, surplusKg: -150, runsOutMonth: '2027-03' });
  });

  it('with no need there is nothing to run out', () => {
    expect(feedCoverage(0, [], null)).toEqual({ needKg: 0, surplusKg: 0, runsOutMonth: null });
  });
});
