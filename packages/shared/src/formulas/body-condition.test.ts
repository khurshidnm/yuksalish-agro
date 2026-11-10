import { describe, expect, it } from 'vitest';
import { BODY_CONDITION_RULES, BODY_CONDITION_STEPS, herdCondition, herdIsThin, isBodyConditionScore, isThin } from './body-condition';

describe('body condition score', () => {
  it('accepts 1 to 5 in half steps and nothing else', () => {
    expect(BODY_CONDITION_STEPS).toEqual([1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
    for (const score of BODY_CONDITION_STEPS) expect(isBodyConditionScore(score)).toBe(true);
    for (const score of [0, 0.5, 5.5, 6, 2.25, 3.1, NaN, Infinity]) expect(isBodyConditionScore(score)).toBe(false);
  });

  it('calls a score thin at or below the starting value', () => {
    expect(BODY_CONDITION_RULES.thinAtOrBelow).toBe(2);
    expect(isThin(2)).toBe(true);
    expect(isThin(1.5)).toBe(true);
    expect(isThin(2.5)).toBe(false);
  });

  it('averages the latest scores that are recent enough', () => {
    // Four ewes scored within 60 days: 2, 2.5, 3, 3.5 -> mean 11 / 4 = 2.75, one thin of four = 0.25.
    // A fifth scored 61 days ago (1.5) is too old to count.
    const result = herdCondition(
      [
        { score: 2, date: '2026-03-01' },
        { score: 2.5, date: '2026-02-20' },
        { score: 3, date: '2026-01-30' },
        { score: 3.5, date: '2026-01-10' },
        { score: 1.5, date: '2025-12-31' },
      ],
      '2026-03-02',
    );
    expect(result).toEqual({ scored: 4, average: 2.75, thin: 1, thinShare: 0.25 });
  });

  it('gives null, not zero, when no score is recent', () => {
    expect(herdCondition([], '2026-03-02')).toEqual({ scored: 0, average: null, thin: 0, thinShare: null });
    expect(herdCondition([{ score: 3, date: '2025-06-01' }], '2026-03-02').average).toBeNull();
    // A score dated after "today" is a slip of the clock, not a fact about the herd.
    expect(herdCondition([{ score: 3, date: '2026-03-03' }], '2026-03-02').scored).toBe(0);
  });

  it('raises the thin-herd alert only with enough scored animals and a large enough share', () => {
    expect(herdIsThin({ scored: 10, average: 2.4, thin: 3, thinShare: 0.3 })).toBe(true);
    expect(herdIsThin({ scored: 12, average: 2.4, thin: 3, thinShare: 0.25 })).toBe(true);
    // Three thin of four is a large share of too few animals.
    expect(herdIsThin({ scored: 4, average: 2, thin: 3, thinShare: 0.75 })).toBe(false);
    expect(herdIsThin({ scored: 20, average: 3, thin: 4, thinShare: 0.2 })).toBe(false);
    expect(herdIsThin({ scored: 0, average: null, thin: 0, thinShare: null })).toBe(false);
  });
});
