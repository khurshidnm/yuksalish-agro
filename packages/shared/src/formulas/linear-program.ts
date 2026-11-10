/**
 * A small linear-programme solver: the two-phase simplex method on a dense tableau, with Bland's rule
 * (lowest index enters, lowest index leaves on a tie) so that it cannot cycle. It is meant for problems
 * the size of a ration: a dozen variables and as many constraints. Every variable is non-negative.
 *
 * Method as in G. B. Dantzig, "Linear Programming and Extensions" (1963), ch. 5; the anti-cycling rule
 * is R. G. Bland, "New finite pivoting rules for the simplex method", Mathematics of Operations
 * Research 2 (1977).
 */

export type LpRelation = '<=' | '>=' | '=';

export interface LpConstraint {
  /** One coefficient per variable; a missing one counts as 0. */
  coefficients: readonly number[];
  relation: LpRelation;
  rhs: number;
}

export interface LpSolution {
  status: 'optimal' | 'infeasible' | 'unbounded';
  /** One value per variable, or null when there is no optimum. */
  values: number[] | null;
  /** The objective at the optimum, in the caller's own units. */
  objective: number | null;
}

/** Numerical tolerance. Rows and the objective are scaled to a largest coefficient of 1 before use. */
const EPS = 1e-9;
const MAX_PIVOTS = 20_000;

function pivot(tableau: number[][], costs: number[][], basis: number[], row: number, col: number): void {
  const pivotRow = tableau[row];
  const p = pivotRow[col];
  for (let j = 0; j < pivotRow.length; j += 1) pivotRow[j] /= p;
  for (const other of [...tableau, ...costs]) {
    if (other === pivotRow) continue;
    const factor = other[col];
    if (factor === 0) continue;
    for (let j = 0; j < other.length; j += 1) other[j] -= factor * pivotRow[j];
    other[col] = 0;
  }
  basis[row] = col;
}

/** Minimises `cost` (kept in reduced form) over the tableau. `carried` rows are pivoted along with it. */
function simplex(tableau: number[][], cost: number[], carried: number[][], basis: number[], allowed: boolean[]): 'optimal' | 'unbounded' {
  const rhs = cost.length - 1;
  for (let step = 0; step < MAX_PIVOTS; step += 1) {
    let entering = -1;
    for (let j = 0; j < rhs; j += 1) {
      if (allowed[j] && cost[j] < -EPS) {
        entering = j;
        break;
      }
    }
    if (entering === -1) return 'optimal';

    let leaving = -1;
    let best = Infinity;
    for (let i = 0; i < tableau.length; i += 1) {
      const a = tableau[i][entering];
      if (a <= EPS) continue;
      const ratio = tableau[i][rhs] / a;
      if (ratio < best - EPS || (ratio <= best + EPS && (leaving === -1 || basis[i] < basis[leaving]))) {
        best = Math.min(best, ratio);
        leaving = i;
      }
    }
    if (leaving === -1) return 'unbounded';
    pivot(tableau, [cost, ...carried], basis, leaving, entering);
  }
  throw new Error('Simplex did not finish');
}

/**
 * Minimises (or maximises) `objective · x` subject to the constraints and x ≥ 0.
 * "infeasible": no x satisfies every constraint. "unbounded": the objective can improve without end.
 */
export function solveLinearProgram(
  objective: readonly number[],
  constraints: readonly LpConstraint[],
  direction: 'min' | 'max' = 'min',
): LpSolution {
  const n = objective.length;
  const none: LpSolution = { status: 'infeasible', values: null, objective: null };

  const rows: { coef: number[]; relation: LpRelation; rhs: number }[] = [];
  for (const constraint of constraints) {
    let coef = Array.from({ length: n }, (_, j) => constraint.coefficients[j] ?? 0);
    let rhs = constraint.rhs;
    let relation = constraint.relation;
    const scale = Math.max(...coef.map(Math.abs), 0);
    if (scale === 0) {
      // "0 ≥ 5" can never hold; "0 ≤ 5" says nothing.
      const holds = relation === '<=' ? rhs >= 0 : relation === '>=' ? rhs <= 0 : rhs === 0;
      if (!holds) return none;
      continue;
    }
    coef = coef.map((v) => v / scale);
    rhs /= scale;
    if (rhs < 0) {
      coef = coef.map((v) => -v);
      rhs = -rhs;
      relation = relation === '<=' ? '>=' : relation === '>=' ? '<=' : '=';
    }
    rows.push({ coef, relation, rhs });
  }

  const m = rows.length;
  const slackCount = rows.filter((r) => r.relation !== '=').length;
  const artificialCount = rows.filter((r) => r.relation !== '<=').length;
  const total = n + slackCount + artificialCount;
  const firstArtificial = n + slackCount;

  const tableau: number[][] = [];
  const basis: number[] = [];
  let slack = n;
  let artificial = firstArtificial;
  for (const row of rows) {
    const line = new Array<number>(total + 1).fill(0);
    for (let j = 0; j < n; j += 1) line[j] = row.coef[j];
    line[total] = row.rhs;
    if (row.relation === '<=') {
      line[slack] = 1;
      basis.push(slack);
      slack += 1;
    } else {
      if (row.relation === '>=') {
        line[slack] = -1;
        slack += 1;
      }
      line[artificial] = 1;
      basis.push(artificial);
      artificial += 1;
    }
    tableau.push(line);
  }

  // The real objective, scaled, and turned into a minimisation.
  const sign = direction === 'max' ? -1 : 1;
  const objectiveScale = Math.max(...objective.map(Math.abs), 0) || 1;
  const cost = new Array<number>(total + 1).fill(0);
  for (let j = 0; j < n; j += 1) cost[j] = (sign * objective[j]) / objectiveScale;

  const allowed = new Array<boolean>(total).fill(true);

  if (artificialCount > 0) {
    // Phase 1: drive the artificial variables to zero. If they cannot all reach it, nothing is feasible.
    const phase1 = new Array<number>(total + 1).fill(0);
    for (let i = 0; i < m; i += 1) {
      if (basis[i] < firstArtificial) continue;
      for (let j = 0; j <= total; j += 1) {
        if (j < firstArtificial || j === total) phase1[j] -= tableau[i][j];
      }
    }
    simplex(tableau, phase1, [cost], basis, allowed);
    if (-phase1[total] > 1e-7) return none;

    // An artificial variable left in the basis sits at zero: swap it for a real one where the row allows.
    for (let i = 0; i < m; i += 1) {
      if (basis[i] < firstArtificial) continue;
      let col = -1;
      for (let j = 0; j < firstArtificial; j += 1) {
        if (Math.abs(tableau[i][j]) > EPS) {
          col = j;
          break;
        }
      }
      if (col !== -1) pivot(tableau, [cost], basis, i, col);
    }
    for (let j = firstArtificial; j < total; j += 1) allowed[j] = false;
  }

  // Phase 2. `cost` was carried through phase 1, so only the starting basis needs pricing out when
  // there was no phase 1; with slacks alone in the basis their cost is zero and nothing changes.
  if (simplex(tableau, cost, [], basis, allowed) === 'unbounded') return { status: 'unbounded', values: null, objective: null };

  const values = new Array<number>(n).fill(0);
  for (let i = 0; i < m; i += 1) {
    if (basis[i] < n) values[basis[i]] = Math.max(0, tableau[i][total]);
  }
  return { status: 'optimal', values, objective: values.reduce((sum, v, j) => sum + v * objective[j], 0) };
}
