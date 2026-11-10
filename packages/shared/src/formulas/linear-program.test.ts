import { describe, expect, it } from 'vitest';
import { solveLinearProgram } from './linear-program';

describe('solveLinearProgram', () => {
  it('solves a maximisation worked by hand', () => {
    // max 3x + 5y, x ≤ 4, 2y ≤ 12, 3x + 2y ≤ 18.
    // Corners: (0,0)=0, (4,0)=12, (4,3)=27, (2,6)=36, (0,6)=30. Best is (2,6) with 36.
    const result = solveLinearProgram(
      [3, 5],
      [
        { coefficients: [1, 0], relation: '<=', rhs: 4 },
        { coefficients: [0, 2], relation: '<=', rhs: 12 },
        { coefficients: [3, 2], relation: '<=', rhs: 18 },
      ],
      'max',
    );
    expect(result.status).toBe('optimal');
    expect(result.values![0]).toBeCloseTo(2, 9);
    expect(result.values![1]).toBeCloseTo(6, 9);
    expect(result.objective).toBeCloseTo(36, 9);
  });

  it('solves a least-cost problem with "at least" rows worked by hand', () => {
    // min 2x + 3y, x + y ≥ 4, x + 3y ≥ 6, x ≤ 3.
    // Corners of the feasible region: (0,4)=12, (3,1)=9. Along x + y = 4 the cost is 12 − x, so the
    // cheapest point is where x is largest: (3,1) with 9.
    const result = solveLinearProgram(
      [2, 3],
      [
        { coefficients: [1, 1], relation: '>=', rhs: 4 },
        { coefficients: [1, 3], relation: '>=', rhs: 6 },
        { coefficients: [1, 0], relation: '<=', rhs: 3 },
      ],
    );
    expect(result.status).toBe('optimal');
    expect(result.values![0]).toBeCloseTo(3, 9);
    expect(result.values![1]).toBeCloseTo(1, 9);
    expect(result.objective).toBeCloseTo(9, 9);
  });

  it('says when nothing satisfies the constraints', () => {
    // x + y ≤ 2 and x ≥ 3 cannot both hold with y ≥ 0.
    const result = solveLinearProgram(
      [1, 1],
      [
        { coefficients: [1, 1], relation: '<=', rhs: 2 },
        { coefficients: [1, 0], relation: '>=', rhs: 3 },
      ],
    );
    expect(result).toEqual({ status: 'infeasible', values: null, objective: null });
  });

  it('says when the objective has no bound', () => {
    // max x with x − y ≤ 1: raise y and x follows without end.
    const result = solveLinearProgram([1, 0], [{ coefficients: [1, -1], relation: '<=', rhs: 1 }], 'max');
    expect(result.status).toBe('unbounded');
  });

  it('handles an equality and a negative right-hand side', () => {
    // min x + 2y, x + y = 5, −x ≤ −2 (x ≥ 2), y ≥ 1. Cheapest is as much x as possible: (4,1) = 6.
    const result = solveLinearProgram(
      [1, 2],
      [
        { coefficients: [1, 1], relation: '=', rhs: 5 },
        { coefficients: [-1, 0], relation: '<=', rhs: -2 },
        { coefficients: [0, 1], relation: '>=', rhs: 1 },
      ],
    );
    expect(result.status).toBe('optimal');
    expect(result.values![0]).toBeCloseTo(4, 9);
    expect(result.values![1]).toBeCloseTo(1, 9);
    expect(result.objective).toBeCloseTo(6, 9);
  });

  it('does not cycle on a degenerate problem', () => {
    // Beale's example, which cycles under the largest-coefficient rule. Optimum 0.05 at (0.04, 0, 1, 0).
    const result = solveLinearProgram(
      [0.75, -150, 0.02, -6],
      [
        { coefficients: [0.25, -60, -0.04, 9], relation: '<=', rhs: 0 },
        { coefficients: [0.5, -90, -0.02, 3], relation: '<=', rhs: 0 },
        { coefficients: [0, 0, 1, 0], relation: '<=', rhs: 1 },
      ],
      'max',
    );
    expect(result.status).toBe('optimal');
    expect(result.objective).toBeCloseTo(0.05, 9);
  });

  it('treats an empty row by its right-hand side alone', () => {
    expect(solveLinearProgram([1], [{ coefficients: [0], relation: '>=', rhs: 0 }]).status).toBe('optimal');
    expect(solveLinearProgram([1], [{ coefficients: [0], relation: '>=', rhs: 5 }]).status).toBe('infeasible');
  });

  it('copes with coefficients of very different size', () => {
    // min 2500a + 900b (money), 11a + 7b ≥ 16 (MJ), 100a + 160b ≥ 190 (g), 0.87a + 0.89b ≤ 1.8 (kg).
    // b alone: needs 16/7 = 2.2857 kg, over the 1.8/0.89 = 2.0225 it may weigh, so a is needed.
    // On the kg and MJ rows together: a = (16 − 7b)/11 and 0.87a + 0.89b = 1.8
    //   → 0.87(16 − 7b)/11 + 0.89b = 1.8 → 1.26545 − 0.55364b + 0.89b = 1.8 → b = 1.58920, a = 0.44324.
    // Protein there: 44.3 + 254.3 ≥ 190. Cost 2500 × 0.44324 + 900 × 1.58920 = 2538.4.
    const result = solveLinearProgram(
      [2500, 900],
      [
        { coefficients: [11, 7], relation: '>=', rhs: 16 },
        { coefficients: [100, 160], relation: '>=', rhs: 190 },
        { coefficients: [0.87, 0.89], relation: '<=', rhs: 1.8 },
      ],
    );
    expect(result.status).toBe('optimal');
    expect(result.values![0]).toBeCloseTo(0.44324, 4);
    expect(result.values![1]).toBeCloseTo(1.5892, 4);
    expect(result.objective).toBeCloseTo(2538.4, 0);
  });
});
