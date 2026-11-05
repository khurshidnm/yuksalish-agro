/**
 * Cost engine and financial summaries. Dashboards, reports and AI read money through this file,
 * so a number cannot differ between two screens.
 *
 * Two different questions, answered from two different sources:
 *
 * 1. How much money moved? Farm-level figures come from `transactions` only.
 * 2. What did this field or herd cost? Per-center figures add up:
 *      direct    approved expenses with costTreatment 'expense'
 *      materials stock issued to the center, net of count corrections
 *      machinery cost of assets, charged to the fields they worked on
 *      overhead  the general center, shared out on the tenant's chosen base
 *    'inventory', 'capex' and 'animal' expenses never reach a center directly. They arrive later
 *    as issues, depreciation and the animal's own purchase price, so nothing is counted twice.
 *
 * Moving a cost between centers conserves the total: the sum of `total` over all centers always
 * equals the sum of direct plus materials. Sending machinery to fields is negative on the asset
 * row and positive on the field row, and overhead works the same way on the general row.
 *
 * Own produce fed to own animals (spec 7.3): hay costs the field to grow, then costs the herd
 * again at transfer price when issued. So the sum over centers exceeds farm-level cash cost by
 * the internal transfers. That is by design: each center is judged as if it traded with the
 * others. Farm-level results must therefore use question 1, never a sum of centers.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, notInArray, sql, type AnyColumn } from 'drizzle-orm';
import {
  ANIMAL_ON_FARM_STATUSES,
  PII_VIEW,
  allocateOverhead,
  costPerKgLiveWeight,
  costPerTon,
  cropCostTotal,
  monthOf,
  monthRange,
  profitabilityPercent,
  round,
  scaleGainToHerd,
  type AllocationTarget,
  type CropCostInput,
} from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { COST_CREDIT_MOVEMENT_TYPES, COST_MOVEMENT_TYPES } from '../../core/inventory';
import { sumOf } from '../../core/query';
import { listWithBalances } from './accounts.service';
import { grid, monthsBetween } from './budget.service';
import { listDebts } from './debts.service';
import { addMonths, outstandingTotal } from './loans.service';

const {
  animals,
  assetUsageLogs,
  breedingRecords,
  budgets,
  costCenters,
  cropPlans,
  crops,
  employees,
  fieldOperations,
  fields,
  financeCategories: cat,
  harvests,
  items,
  loanInstalments,
  prices,
  sales,
  seasons,
  stockBatches,
  stockMovements: m,
  timesheets,
  transactions: t,
  weightRecords,
} = schema;

// ─── Money position ────────────────────────────────────────────────────────

export async function cashPosition() {
  const accounts = await listWithBalances();
  return {
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      currency: a.currency,
      balance: a.balance,
      balanceBase: a.balanceBase,
    })),
    total: round(accounts.reduce((sum, a) => sum + a.balanceBase, 0), 2),
  };
}

/** Stock used in a period, less stock found. */
async function stockCost(from: string, to: string): Promise<number> {
  const credits = sql.join(
    COST_CREDIT_MOVEMENT_TYPES.map((type) => sql`${type}`),
    sql`, `,
  );
  const [row] = await tx()
    .select({
      amount: sql`coalesce(sum(case when ${m.type} in (${credits}) then -${m.totalCost} else ${m.totalCost} end), 0)`.mapWith(Number),
    })
    .from(m)
    .where(
      and(
        eq(m.farmId, ctx().farmId),
        inArray(m.type, [...COST_MOVEMENT_TYPES, ...COST_CREDIT_MOVEMENT_TYPES]),
        gte(m.date, from),
        lte(m.date, to),
      ),
    );
  return row?.amount ?? 0;
}

/**
 * Income and expense this month. `expense` is money paid. `operatingExpense` is the cost of running
 * the farm: direct expenses plus stock used, so stock still in the warehouse is not a cost yet, and
 * neither are assets or animals bought (CLAUDE.md rule 3).
 */
export async function monthToDate(month: string = monthOf(today())) {
  const { from, to } = monthRange(month);
  const rows = await tx()
    .select({ type: t.type, treatment: t.costTreatment, total: sumOf(t.amountBase) })
    .from(t)
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        eq(t.status, 'approved'),
        inArray(t.type, ['income', 'expense']),
        gte(t.date, from),
        lte(t.date, to),
      ),
    )
    .groupBy(t.type, t.costTreatment);
  const sum = (filter: (row: (typeof rows)[number]) => boolean) =>
    round(rows.filter(filter).reduce((total, row) => total + row.total, 0), 2);
  return {
    month,
    income: sum((r) => r.type === 'income'),
    expense: sum((r) => r.type === 'expense'),
    operatingExpense: round(sum((r) => r.type === 'expense' && r.treatment === 'expense') + (await stockCost(from, to)), 2),
  };
}

export async function debtSummary() {
  const debts = await listDebts();
  const total = (direction: string, field: 'outstanding' | 'overdue') =>
    round(debts.filter((d) => d.direction === direction).reduce((sum, d) => sum + d[field], 0), 2);
  const overduePayable = total('payable', 'overdue');
  const overdueReceivable = total('receivable', 'overdue');
  return {
    receivable: total('receivable', 'outstanding'),
    payable: total('payable', 'outstanding'),
    overdue: round(overduePayable + overdueReceivable, 2),
    overduePayable,
    overdueReceivable,
    loansOutstanding: await outstandingTotal(),
  };
}

/** Expense plan vs fact for dashboards. Accepts months or dates, always covers whole months. */
export async function budgetExecution(from: string, to: string) {
  const result = await grid({ from: from.slice(0, 7), to: to.slice(0, 7) });
  const { expense, income } = result.totals;
  return {
    planned: expense.planned,
    actual: expense.actual,
    deviation: expense.deviation,
    percent: expense.percent,
    income: { planned: income.planned, actual: income.actual, percent: income.percent },
    rows: result.rows
      .filter((row) => row.kind === 'expense')
      .map((row) => ({
        categoryId: row.categoryId,
        key: row.key,
        group: row.group,
        name: row.name,
        planned: row.planned,
        actual: row.actual,
        deviation: row.deviation,
        percent: row.percent,
      })),
  };
}

/** Income and expense by category over a period (spec 10.4). */
export async function incomeExpenseByCategory(from?: string, to?: string) {
  const rows = await tx()
    .select({
      categoryId: cat.id,
      key: cat.key,
      group: cat.group,
      kind: cat.kind,
      name: cat.name,
      amount: sumOf(t.amountBase),
    })
    .from(t)
    .innerJoin(cat, eq(cat.id, t.categoryId))
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        eq(t.status, 'approved'),
        inArray(t.type, ['income', 'expense']),
        from ? gte(t.date, from) : undefined,
        to ? lte(t.date, to) : undefined,
      ),
    )
    .groupBy(cat.id, cat.key, cat.group, cat.kind, cat.name)
    .orderBy(desc(sumOf(t.amountBase)));
  const total = (kind: string) => round(rows.filter((r) => r.kind === kind).reduce((sum, r) => sum + r.amount, 0), 2);
  const income = total('income');
  const expense = total('expense');
  return { rows, income, expense, net: round(income - expense, 2) };
}

// ─── Cost engine ───────────────────────────────────────────────────────────

export type Bucket = 'feed' | 'vet' | 'labor' | 'seed' | 'fertilizer' | 'protection' | 'water' | 'machinery' | 'other';
type Buckets = Record<Bucket, number>;

const emptyBuckets = (): Buckets => ({
  feed: 0,
  vet: 0,
  labor: 0,
  seed: 0,
  fertilizer: 0,
  protection: 0,
  water: 0,
  machinery: 0,
  other: 0,
});

function directBucket(key: string | null, group: string | null): Bucket {
  if (group === 'labor') return 'labor';
  switch (key) {
    case 'feed':
      return 'feed';
    case 'veterinary':
      return 'vet';
    case 'seed':
      return 'seed';
    case 'fertilizer':
      return 'fertilizer';
    case 'crop_protection':
      return 'protection';
    case 'water':
    case 'utility_water':
      return 'water';
    case 'mechanization_service':
      return 'machinery';
    default:
      return group === 'machinery' ? 'machinery' : 'other';
  }
}

function materialBucket(itemCategory: string): Bucket {
  switch (itemCategory) {
    case 'feed':
      return 'feed';
    case 'vet_drug':
    case 'vaccine':
      return 'vet';
    case 'seed':
      return 'seed';
    case 'fertilizer':
      return 'fertilizer';
    case 'chemical':
      return 'protection';
    case 'fuel':
    case 'lubricant':
    case 'spare_part':
      return 'machinery';
    default:
      return 'other';
  }
}

type CenterRow = typeof costCenters.$inferSelect;

interface CenterState {
  center: CenterRow;
  direct: number;
  materials: number;
  machinery: number;
  overhead: number;
  income: number;
  buckets: Buckets;
}

interface Engine {
  states: CenterState[];
  byId: Map<string, CenterState>;
  /** key is `${type}:${refId}` */
  byRef: Map<string, CenterState>;
}

const ownCost = (s: CenterState) => s.direct + s.materials;

/** Allocation target for machine work that belongs to no field. */
const STAYS_ON_MACHINE = 'none';

const ON_FARM = sql.join(
  ANIMAL_ON_FARM_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

function range(column: AnyColumn, from?: string, to?: string) {
  return and(from ? gte(column, from) : undefined, to ? lte(column, to) : undefined);
}

/** Animals on the farm at the end of a given day, per herd. */
async function headByHerd(at: string): Promise<Map<string, number>> {
  const rows = await tx()
    .select({ herdId: animals.herdId, head: sql<number>`count(*)`.mapWith(Number) })
    .from(animals)
    .where(
      and(
        eq(animals.farmId, ctx().farmId),
        isNotNull(animals.herdId),
        sql`(${animals.purchaseDate} is null or ${animals.purchaseDate} <= ${at})`,
        sql`(${animals.exitDate} > ${at} or (${animals.exitDate} is null and ${animals.status} in (${ON_FARM})))`,
      ),
    )
    .groupBy(animals.herdId);
  return new Map(rows.map((r) => [r.herdId!, r.head]));
}

/**
 * Stage 1: an asset's cost follows its work, so the fields it worked carry fuel, repairs and
 * depreciation (X_texnika in spec 25.1). Hours off any field, such as a run to the fuel depot,
 * stay on the machine. modules/assets machineryCostByField shares by the same rule and a test
 * holds the two equal; do not add its result to this, or the same fuel is counted twice.
 */
async function chargeMachinery(engine: Engine, from?: string, to?: string) {
  const farm = ctx().farmId;
  const logRange = range(assetUsageLogs.date, from, to);
  const opRange = range(fieldOperations.date, from, to);
  const logs = await tx()
    .select({
      assetId: assetUsageLogs.assetId,
      fieldId: assetUsageLogs.fieldId,
      hours: sumOf(assetUsageLogs.motoHours),
      hectares: sumOf(assetUsageLogs.volumeHa),
    })
    .from(assetUsageLogs)
    .where(and(eq(assetUsageLogs.farmId, farm), logRange))
    .groupBy(assetUsageLogs.assetId, assetUsageLogs.fieldId);
  // Operations that have no usage log of their own, so the same work is not counted twice.
  const operations = await tx()
    .select({
      assetId: fieldOperations.assetId,
      fieldId: fieldOperations.fieldId,
      hours: sumOf(fieldOperations.durationH),
      hectares: sumOf(fieldOperations.areaDoneHa),
    })
    .from(fieldOperations)
    .where(
      and(
        eq(fieldOperations.farmId, farm),
        eq(fieldOperations.status, 'done'),
        isNotNull(fieldOperations.assetId),
        opRange,
        sql`not exists (select 1 from ${assetUsageLogs} l where l.operation_id = ${fieldOperations.id})`,
      ),
    )
    .groupBy(fieldOperations.assetId, fieldOperations.fieldId);

  const usage = new Map<string, { fieldId: string | null; hours: number; hectares: number }[]>();
  for (const row of [...logs, ...operations]) {
    const list = usage.get(row.assetId!) ?? [];
    const same = list.find((u) => u.fieldId === row.fieldId);
    if (same) {
      same.hours += row.hours;
      same.hectares += row.hectares;
    } else {
      list.push({ fieldId: row.fieldId, hours: row.hours, hectares: row.hectares });
    }
    usage.set(row.assetId!, list);
  }

  for (const [assetId, list] of usage) {
    const asset = engine.byRef.get(`asset:${assetId}`);
    if (!asset) continue;
    const cost = ownCost(asset);
    if (cost <= 0) continue;
    const useHours = list.some((u) => u.hours > 0);
    const weight = (u: (typeof list)[number]) => (useHours ? u.hours : u.hectares);
    const targets: AllocationTarget[] = list.map((u) => {
      const field = u.fieldId ? engine.byRef.get(`field:${u.fieldId}`) : undefined;
      return { id: field?.center.id ?? STAYS_ON_MACHINE, weight: weight(u) };
    });
    for (const [centerId, share] of Object.entries(allocateOverhead(round(cost, 2), targets))) {
      if (centerId === STAYS_ON_MACHINE) continue;
      const field = engine.byId.get(centerId)!;
      field.machinery += share;
      field.buckets.machinery += share;
      asset.machinery -= share;
    }
  }
}

/**
 * Hours base: field work is known exactly from operations. Livestock staff work the whole flock,
 * so their timesheet hours are shared between herds by head count.
 */
async function hoursTargets(engine: Engine, heads: Map<string, number>, from?: string, to?: string) {
  const farm = ctx().farmId;
  const fieldHours = await tx()
    .select({ fieldId: fieldOperations.fieldId, hours: sumOf(fieldOperations.durationH) })
    .from(fieldOperations)
    .where(and(eq(fieldOperations.farmId, farm), eq(fieldOperations.status, 'done'), range(fieldOperations.date, from, to)))
    .groupBy(fieldOperations.fieldId);
  const [herdHours] = await tx()
    .select({ hours: sumOf(sql`case when ${timesheets.status} = 'present' then coalesce(${timesheets.hours}, 8) else 0 end`) })
    .from(timesheets)
    .innerJoin(employees, eq(employees.id, timesheets.employeeId))
    .where(
      and(
        eq(timesheets.farmId, farm),
        range(timesheets.date, from, to),
        sql`lower(${employees.division}) in ('livestock', 'qo''ychilik', 'chorvachilik')`,
      ),
    );

  const targets: AllocationTarget[] = [];
  for (const row of fieldHours) {
    const center = engine.byRef.get(`field:${row.fieldId}`);
    if (center && row.hours > 0) targets.push({ id: center.center.id, weight: row.hours });
  }
  const totalHead = [...heads.values()].reduce((sum, n) => sum + n, 0);
  if (totalHead > 0) {
    for (const [herdId, head] of heads) {
      const center = engine.byRef.get(`herd:${herdId}`);
      if (center) targets.push({ id: center.center.id, weight: (herdHours.hours * head) / totalHead });
    }
  }
  return targets;
}

/** Stage 2: the general center is shared out on the tenant's chosen base (spec 25.1). */
async function allocateGeneral(engine: Engine, from?: string, to?: string) {
  const general = engine.states.find((s) => s.center.type === 'general');
  if (!general) return;
  const cost = ownCost(general);
  if (cost <= 0) return;

  const base = ctx().settings.finance.overheadBase;
  const heads = await headByHerd(to ?? today());
  let targets: AllocationTarget[] = [];

  if (base === 'head') {
    for (const [herdId, head] of heads) {
      const center = engine.byRef.get(`herd:${herdId}`);
      if (center) targets.push({ id: center.center.id, weight: head });
    }
  } else if (base === 'area') {
    const rows = await tx()
      .select({ id: fields.id, areaHa: fields.areaHa })
      .from(fields)
      .where(and(eq(fields.farmId, ctx().farmId), eq(fields.landUse, 'arable'), eq(fields.status, 'active')));
    for (const row of rows) {
      const center = engine.byRef.get(`field:${row.id}`);
      if (center) targets.push({ id: center.center.id, weight: row.areaHa });
    }
  } else if (base === 'direct_cost') {
    targets = engine.states
      .filter((s) => s.center.type === 'herd' || s.center.type === 'field')
      .map((s) => ({ id: s.center.id, weight: Math.max(0, ownCost(s) + s.machinery) }));
  } else {
    targets = await hoursTargets(engine, heads, from, to);
  }

  for (const [centerId, share] of Object.entries(allocateOverhead(round(cost, 2), targets))) {
    engine.byId.get(centerId)!.overhead += share;
    general.overhead -= share;
  }
}

async function runEngine(from?: string, to?: string): Promise<Engine> {
  const farm = ctx().farmId;
  const centers = await tx().select().from(costCenters).where(eq(costCenters.farmId, farm));
  const states = centers.map((center): CenterState => ({
    center,
    direct: 0,
    materials: 0,
    machinery: 0,
    overhead: 0,
    income: 0,
    buckets: emptyBuckets(),
  }));
  const engine: Engine = {
    states,
    byId: new Map(states.map((s) => [s.center.id, s])),
    byRef: new Map(states.filter((s) => s.center.refId).map((s) => [`${s.center.type}:${s.center.refId}`, s])),
  };

  const direct = await tx()
    .select({ costCenterId: t.costCenterId, key: cat.key, group: cat.group, amount: sumOf(t.amountBase) })
    .from(t)
    .leftJoin(cat, eq(cat.id, t.categoryId))
    .where(
      and(
        eq(t.farmId, farm),
        eq(t.status, 'approved'),
        eq(t.type, 'expense'),
        eq(t.costTreatment, 'expense'),
        range(t.date, from, to),
      ),
    )
    .groupBy(t.costCenterId, cat.key, cat.group);
  for (const row of direct) {
    const state = row.costCenterId ? engine.byId.get(row.costCenterId) : undefined;
    if (!state) continue;
    state.direct += row.amount;
    state.buckets[directBucket(row.key, row.group)] += row.amount;
  }

  const credits = sql.join(
    COST_CREDIT_MOVEMENT_TYPES.map((type) => sql`${type}`),
    sql`, `,
  );
  const materials = await tx()
    .select({
      costCenterId: m.costCenterId,
      category: items.category,
      amount: sql`coalesce(sum(case when ${m.type} in (${credits}) then -${m.totalCost} else ${m.totalCost} end), 0)`.mapWith(Number),
    })
    .from(m)
    .innerJoin(items, eq(items.id, m.itemId))
    .where(
      and(
        eq(m.farmId, farm),
        inArray(m.type, [...COST_MOVEMENT_TYPES, ...COST_CREDIT_MOVEMENT_TYPES]),
        isNotNull(m.costCenterId),
        range(m.date, from, to),
      ),
    )
    .groupBy(m.costCenterId, items.category);
  for (const row of materials) {
    const state = engine.byId.get(row.costCenterId!);
    if (!state) continue;
    state.materials += row.amount;
    state.buckets[materialBucket(row.category)] += row.amount;
  }

  const income = await tx()
    .select({ costCenterId: t.costCenterId, amount: sumOf(t.amountBase) })
    .from(t)
    .where(and(eq(t.farmId, farm), eq(t.status, 'approved'), eq(t.type, 'income'), range(t.date, from, to)))
    .groupBy(t.costCenterId);
  for (const row of income) {
    const state = row.costCenterId ? engine.byId.get(row.costCenterId) : undefined;
    if (state) state.income += row.amount;
  }

  await chargeMachinery(engine, from, to);
  await allocateGeneral(engine, from, to);
  return engine;
}

const centerTotal = (s: CenterState) => round(s.direct + s.materials + s.machinery + s.overhead, 2);

export async function costCenterCosts(from?: string, to?: string) {
  const engine = await runEngine(from, to);
  const seesPeople = hasPermission(PII_VIEW);
  return engine.states
    .map((s) => {
      const total = centerTotal(s);
      return {
        costCenterId: s.center.id,
        type: s.center.type,
        refId: s.center.refId,
        name: s.center.type === 'employee' && !seesPeople ? null : s.center.name,
        direct: round(s.direct, 2),
        materials: round(s.materials, 2),
        machinery: round(s.machinery, 2),
        overhead: round(s.overhead, 2),
        total,
        income: round(s.income, 2),
        profit: round(s.income - total, 2),
        profitabilityPercent: profitabilityPercent(s.income, total),
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** Each herd judged with its own income and cost, including its share of overhead. */
export async function herdResult(from?: string, to?: string) {
  const centers = (await costCenterCosts(from, to)).filter((c) => c.type === 'herd' || c.type === 'animal');
  return {
    income: centers.reduce((sum, c) => sum + c.income, 0),
    expense: centers.reduce((sum, c) => sum + c.total, 0),
  };
}

// ─── Herds ─────────────────────────────────────────────────────────────────

interface HerdCostRow {
  herdId: string;
  name: string;
  head: number;
  purchaseCost: number;
  accumulated: number;
  costPerHead: number | null;
  breakdown: { feed: number; vet: number; labor: number; overhead: number; other: number };
  /** Measured gain of the animals weighed at least twice. */
  weightGainKg: number;
  weighedHead: number;
  /** Cost of 1 kg of live weight gained. Null until enough of the herd has been weighed. */
  costPerKg: number | null;
}

/** Sum of (last weight − first weight) per animal on the farm, for animals weighed at least twice. */
async function weightGainByHerd(): Promise<Map<string, { kg: number; animals: number }>> {
  const result = await tx().execute(sql`
    select herd_id, sum(gain) as gain, count(*) as animals from (
      select a.herd_id,
             (array_agg(w.weight_kg order by w.date desc))[1] - (array_agg(w.weight_kg order by w.date asc))[1] as gain
      from ${weightRecords} w
      join ${animals} a on a.id = w.animal_id
      where w.farm_id = ${ctx().farmId} and a.herd_id is not null and a.status in (${ON_FARM})
      group by a.herd_id, w.animal_id
      having count(*) >= 2
    ) per_animal
    group by herd_id`);
  return new Map(result.rows.map((row) => [row.herd_id as string, { kg: Number(row.gain), animals: Number(row.animals) }]));
}

/** Costs cover the whole herd, so the gain must too. A sample too small to scale gives null. */
function costPerKgOf(
  { feed, vet, labor, overhead }: { feed: number; vet: number; labor: number; overhead: number },
  measuredGainKg: number,
  weighedHead: number,
  head: number,
): number | null {
  const weightGainKg = scaleGainToHerd(measuredGainKg, weighedHead, head);
  if (weightGainKg === null) return null;
  return nullableRound(costPerKgLiveWeight({ feed, vet, labor, overhead, weightGainKg }));
}

async function herdRows(): Promise<HerdCostRow[]> {
  const farm = ctx().farmId;
  const engine = await runEngine();
  const herdList = await tx()
    .select({ id: schema.herds.id, name: schema.herds.name })
    .from(schema.herds)
    .where(eq(schema.herds.farmId, farm));

  const animalRows = await tx()
    .select({
      herdId: animals.herdId,
      head: sql<number>`count(*)`.mapWith(Number),
      purchaseCost: sumOf(animals.purchasePrice),
    })
    .from(animals)
    .where(and(eq(animals.farmId, farm), isNotNull(animals.herdId), sql`${animals.status} in (${ON_FARM})`))
    .groupBy(animals.herdId);
  const herdAnimals = new Map(animalRows.map((row) => [row.herdId!, row]));

  // Costs booked on one animal roll up into the herd it belongs to.
  const animalCenters = engine.states.filter((s) => s.center.type === 'animal' && s.center.refId);
  const animalHerd = new Map<string, string>();
  if (animalCenters.length) {
    const rows = await tx()
      .select({ id: animals.id, herdId: animals.herdId })
      .from(animals)
      .where(inArray(animals.id, animalCenters.map((s) => s.center.refId!)));
    for (const row of rows) if (row.herdId) animalHerd.set(row.id, row.herdId);
  }

  const gains = await weightGainByHerd();

  return herdList.map((herd) => {
    const own = engine.byRef.get(`herd:${herd.id}`);
    const states = [
      ...(own ? [own] : []),
      ...animalCenters.filter((s) => animalHerd.get(s.center.refId!) === herd.id),
    ];
    const add = (pick: (s: CenterState) => number) => round(states.reduce((sum, s) => sum + pick(s), 0), 2);
    const feed = add((s) => s.buckets.feed);
    const vet = add((s) => s.buckets.vet);
    const labor = add((s) => s.buckets.labor);
    const overhead = add((s) => s.overhead);
    const accumulated = add(centerTotal);
    const animalsHere = herdAnimals.get(herd.id);
    const head = animalsHere?.head ?? 0;
    const purchaseCost = round(animalsHere?.purchaseCost ?? 0, 2);
    const gain = gains.get(herd.id);
    const weightGainKg = round(gain?.kg ?? 0, 2);
    const weighedHead = gain?.animals ?? 0;
    return {
      herdId: herd.id,
      name: herd.name,
      head,
      purchaseCost,
      accumulated,
      costPerHead: head > 0 ? round((purchaseCost + accumulated) / head, 2) : null,
      breakdown: { feed, vet, labor, overhead, other: round(accumulated - feed - vet - labor - overhead, 2) },
      weightGainKg,
      weighedHead,
      costPerKg: costPerKgOf({ feed, vet, labor, overhead }, weightGainKg, weighedHead, head),
    };
  });
}

function nullableRound(value: number | null, digits = 2): number | null {
  return value === null ? null : round(value, digits);
}

export const herdCosts = herdRows;

/** Cost of animals: one herd, or all together. Answers "1 bosh sovliqning joriy tannarxi" (24.1). */
export async function herdCost(herdId?: string) {
  return sumHerds((await herdRows()).filter((row) => !herdId || row.herdId === herdId));
}

/** Add herd rows together into one result. */
export function sumHerds(rows: HerdCostRow[]) {
  const sum = (pick: (row: HerdCostRow) => number) => round(rows.reduce((total, row) => total + pick(row), 0), 2);
  const head = sum((r) => r.head);
  const purchaseCost = sum((r) => r.purchaseCost);
  const accumulated = sum((r) => r.accumulated);
  const breakdown = {
    feed: sum((r) => r.breakdown.feed),
    vet: sum((r) => r.breakdown.vet),
    labor: sum((r) => r.breakdown.labor),
    overhead: sum((r) => r.breakdown.overhead),
    other: sum((r) => r.breakdown.other),
  };
  const weightGainKg = sum((r) => r.weightGainKg);
  const weighedHead = sum((r) => r.weighedHead);
  return {
    head,
    purchaseCost,
    accumulated,
    costPerHead: head > 0 ? round((purchaseCost + accumulated) / head, 2) : null,
    breakdown,
    weightGainKg,
    weighedHead,
    costPerKg: costPerKgOf(breakdown, weightGainKg, weighedHead, head),
  };
}

// ─── Fields ────────────────────────────────────────────────────────────────

async function pickSeason(seasonId?: string) {
  const farm = ctx().farmId;
  if (seasonId) {
    const [row] = await tx().select().from(seasons).where(and(eq(seasons.id, seasonId), eq(seasons.farmId, farm)));
    return row ?? null;
  }
  const [row] = await tx()
    .select()
    .from(seasons)
    .where(eq(seasons.farmId, farm))
    .orderBy(desc(seasons.isCurrent), desc(seasons.startDate))
    .limit(1);
  return row ?? null;
}

export interface FieldCostRow {
  seasonId: string;
  cropPlanId: string;
  fieldId: string;
  number: string;
  areaHa: number;
  crop: { uz: string; ru: string; en: string };
  cropKey: string;
  planned: number | null;
  actual: number;
  deviation: number | null;
  harvestT: number;
  yieldTHa: number | null;
  costPerTon: number | null;
  breakdown: CropCostInput & { protection: number; other: number };
  income: number;
  /** Own produce issued to other centers, valued at transfer cost (spec 7.3). */
  internalRevenue: number;
  profit: number;
  profitabilityPercent: number | null;
}

/** Plan vs fact per crop plan in a season. Defaults to the current season. */
export async function fieldCosts(seasonId?: string): Promise<FieldCostRow[]> {
  const season = await pickSeason(seasonId);
  if (!season) return [];
  const farm = ctx().farmId;
  const engine = await runEngine(season.startDate, season.endDate);

  const plans = await tx()
    .select({
      plan: cropPlans,
      number: fields.number,
      cropName: crops.name,
      cropKey: crops.key,
    })
    .from(cropPlans)
    .innerJoin(fields, eq(fields.id, cropPlans.fieldId))
    .innerJoin(crops, eq(crops.id, cropPlans.cropId))
    .where(and(eq(cropPlans.farmId, farm), eq(cropPlans.seasonId, season.id), ne(cropPlans.status, 'cancelled')))
    .orderBy(asc(fields.number));

  const harvestRows = await tx()
    .select({ cropPlanId: harvests.cropPlanId, fieldId: harvests.fieldId, tons: sumOf(harvests.grossT) })
    .from(harvests)
    .where(and(eq(harvests.farmId, farm), range(harvests.date, season.startDate, season.endDate)))
    .groupBy(harvests.cropPlanId, harvests.fieldId);

  const internal = await tx()
    .select({ fieldId: stockBatches.fieldId, amount: sumOf(m.totalCost) })
    .from(m)
    .innerJoin(stockBatches, eq(stockBatches.id, m.batchId))
    .where(
      and(
        eq(m.farmId, farm),
        eq(m.type, 'issue'),
        ne(m.reason, 'sale'),
        isNotNull(stockBatches.fieldId),
        range(m.date, season.startDate, season.endDate),
      ),
    )
    .groupBy(stockBatches.fieldId);
  const internalByField = new Map(internal.map((row) => [row.fieldId!, row.amount]));

  // A field split between two crops shares its costs by the planned area of each.
  const areaByField = new Map<string, number>();
  for (const { plan } of plans) areaByField.set(plan.fieldId, (areaByField.get(plan.fieldId) ?? 0) + plan.areaHa);

  return plans.map(({ plan, number, cropName, cropKey }) => {
    const state = engine.byRef.get(`field:${plan.fieldId}`);
    const share = plan.areaHa / (areaByField.get(plan.fieldId) || plan.areaHa || 1);
    const part = (value: number) => round(value * share, 2);
    const b = state?.buckets ?? emptyBuckets();
    const input: CropCostInput = {
      seed: part(b.seed),
      fertilizer: part(b.fertilizer),
      water: part(b.water),
      machinery: part(b.machinery),
      labor: part(b.labor),
      // Formula 25.1 has no line for crop protection or sundries, so they sit in the shared part.
      overheadShare: part((state?.overhead ?? 0) + b.protection + b.other + b.feed + b.vet),
    };
    const harvestT = round(
      harvestRows
        .filter((h) => h.cropPlanId === plan.id || (!h.cropPlanId && h.fieldId === plan.fieldId))
        .reduce((sum, h) => sum + h.tons, 0),
      3,
    );
    const actual = round(cropCostTotal(input), 2);
    const income = part(state?.income ?? 0);
    const internalRevenue = part(internalByField.get(plan.fieldId) ?? 0);
    const revenue = round(income + internalRevenue, 2);
    return {
      seasonId: season.id,
      cropPlanId: plan.id,
      fieldId: plan.fieldId,
      number,
      areaHa: plan.areaHa,
      crop: cropName,
      cropKey,
      planned: plan.plannedCost,
      actual,
      deviation: plan.plannedCost === null ? null : round(actual - plan.plannedCost, 2),
      harvestT,
      yieldTHa: harvestT > 0 && plan.areaHa > 0 ? round(harvestT / plan.areaHa, 3) : null,
      costPerTon: nullableRound(costPerTon(input, harvestT)),
      breakdown: { ...input, protection: part(b.protection), other: part(b.other) },
      income,
      internalRevenue,
      profit: round(revenue - actual, 2),
      profitabilityPercent: nullableRound(profitabilityPercent(revenue, actual)),
    };
  });
}

// ─── Cash flow ─────────────────────────────────────────────────────────────

const monthExpr = sql<string>`to_char(${t.date}, 'YYYY-MM')`;

/** Actual money in and out per month (spec 10.4). Transfers between own accounts are neither. */
export async function cashflowActual(from?: string, to?: string) {
  const rows = await tx()
    .select({
      month: monthExpr,
      inflow: sql`coalesce(sum(case when ${t.type} in ('income', 'debt_receipt') then ${t.amountBase} else 0 end), 0)`.mapWith(Number),
      outflow: sql`coalesce(sum(case when ${t.type} in ('expense', 'debt_payment') then ${t.amountBase} else 0 end), 0)`.mapWith(Number),
    })
    .from(t)
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        eq(t.status, 'approved'),
        notInArray(t.paymentMethod, ['debt', 'non_cash']),
        ne(t.type, 'transfer'),
        range(t.date, from, to),
      ),
    )
    .groupBy(monthExpr)
    .orderBy(monthExpr);
  return rows.map((row) => ({ ...row, net: round(row.inflow - row.outflow, 2) }));
}

/** Stated openly in the response: these drive the lamb income estimate. */
const LAMB_ASSUMPTIONS = { lambsPerEwe: 1.2, survival: 0.9, monthsToSale: 6 };
/** A moving average needs at least this many months with spending in a category. */
const MIN_RECURRING_MONTHS = 2;
const LOOKBACK_MONTHS = 6;

type EstimateSource = 'budget' | 'seasonal' | 'average';

/** A type alias, not an interface: report rows need its implicit index signature. */
export type ForecastMonth = {
  month: string;
  inflow: number;
  outflow: number;
  net: number;
  closing: number;
  negative: boolean;
  parts: {
    budgetIncome: number;
    recurringIncome: number;
    receivables: number;
    plannedSales: number;
    plannedHarvest: number;
    plannedLambs: number;
    budgetExpense: number;
    recurringExpense: number;
    payables: number;
    loans: number;
  };
};

function monthAdd(month: string, n: number): string {
  return addMonths(`${month}-01`, n).slice(0, 7);
}

/**
 * Statistical forecast, not a promise (spec 10.3.5, 15.2). For each category and month, the first
 * of these that exists: the budget; the same month last year, once 12 months of history exist;
 * the moving average of recent months, if the category really recurs. Scheduled items are added
 * on top: loan instalments and debts by due date. Expected income from plans (open sales, planned
 * harvest, expected lambs) is used only for months without an income budget, since a budget
 * already contains that income and using both would count it twice.
 */
export async function cashflowForecastDetail(months = 12) {
  const c = ctx();
  const asOf = today();
  const current = monthOf(asOf);
  const horizon = monthsBetween(current, monthAdd(current, months - 1));
  const last = horizon[horizon.length - 1];
  const position = await cashPosition();

  const budgetRows = await tx()
    .select({ month: budgets.month, categoryId: budgets.categoryId, kind: cat.kind, key: cat.key, amount: sumOf(budgets.amount) })
    .from(budgets)
    .innerJoin(cat, eq(cat.id, budgets.categoryId))
    .where(and(eq(budgets.farmId, c.farmId), gte(budgets.month, current), lte(budgets.month, last)))
    .groupBy(budgets.month, budgets.categoryId, cat.kind, cat.key);

  // One-off and scheduled items are not a habit: they must not feed the average.
  const history = await tx()
    .select({ month: monthExpr, categoryId: t.categoryId, type: t.type, key: cat.key, amount: sumOf(t.amountBase) })
    .from(t)
    .innerJoin(cat, eq(cat.id, t.categoryId))
    .where(
      and(
        eq(t.farmId, c.farmId),
        eq(t.status, 'approved'),
        inArray(t.type, ['expense', 'income']),
        ne(t.paymentMethod, 'non_cash'),
        notInArray(t.costTreatment, ['capex', 'animal']),
        ne(cat.group, 'investment'),
        ne(cat.key, 'loan_interest'),
      ),
    )
    .groupBy(monthExpr, t.categoryId, t.type, cat.key);

  // All of this month's money, one-offs included: a budgeted purchase already made must not repeat.
  const { from: monthStart } = monthRange(current);
  const spentThisMonth = new Map(
    (
      await tx()
        .select({ categoryId: t.categoryId, amount: sumOf(t.amountBase) })
        .from(t)
        .where(
          and(
            eq(t.farmId, c.farmId),
            eq(t.status, 'approved'),
            inArray(t.type, ['expense', 'income']),
            gte(t.date, monthStart),
            lte(t.date, monthRange(current).to),
          ),
        )
        .groupBy(t.categoryId)
    ).map((row) => [row.categoryId, row.amount]),
  );

  const unpaidInstalments = await tx()
    .select({ dueDate: loanInstalments.dueDate, payment: loanInstalments.payment })
    .from(loanInstalments)
    .where(and(eq(loanInstalments.farmId, c.farmId), sql`${loanInstalments.paidDate} is null`));
  const hasLoans = unpaidInstalments.length > 0;

  const completed = [...new Set(history.map((h) => h.month))].filter((m) => m < current).sort();
  const historyMonths = completed.length ? monthsBetween(completed[0], monthAdd(current, -1)).length : 0;
  const lookback = monthsBetween(monthAdd(current, -LOOKBACK_MONTHS), monthAdd(current, -1));

  const byCategory = new Map<string, Map<string, number>>();
  const kindOf = new Map<string, 'expense' | 'income'>();
  for (const row of history) {
    const values = byCategory.get(row.categoryId!) ?? new Map<string, number>();
    values.set(row.month, (values.get(row.month) ?? 0) + row.amount);
    byCategory.set(row.categoryId!, values);
    kindOf.set(row.categoryId!, row.type as 'expense' | 'income');
  }

  const budgetIndex = new Map<string, number>();
  const incomeBudgetMonths = new Set<string>();
  for (const row of budgetRows) {
    // Loan interest is scheduled exactly, so a budget line for it would be counted twice.
    if (row.key === 'loan_interest' && hasLoans) continue;
    budgetIndex.set(`${row.month}:${row.categoryId}`, row.amount);
    kindOf.set(row.categoryId, row.kind as 'expense' | 'income');
    if (row.kind === 'income') incomeBudgetMonths.add(row.month);
  }

  function estimate(categoryId: string, month: string): { amount: number; source: EstimateSource } | null {
    const budget = budgetIndex.get(`${month}:${categoryId}`);
    if (budget !== undefined) return { amount: budget, source: 'budget' };
    const values = byCategory.get(categoryId);
    if (!values) return null;
    if (historyMonths >= 12) {
      const lastYear = values.get(monthAdd(month, -12));
      if (lastYear !== undefined) return { amount: lastYear, source: 'seasonal' };
    }
    const seen = lookback.filter((m) => (values.get(m) ?? 0) > 0);
    if (seen.length < MIN_RECURRING_MONTHS) return null;
    return { amount: seen.reduce((sum, m) => sum + values.get(m)!, 0) / LOOKBACK_MONTHS, source: 'average' };
  }

  const rows = new Map<string, ForecastMonth>(
    horizon.map((month) => [
      month,
      {
        month,
        inflow: 0,
        outflow: 0,
        net: 0,
        closing: 0,
        negative: false,
        parts: {
          budgetIncome: 0,
          recurringIncome: 0,
          receivables: 0,
          plannedSales: 0,
          plannedHarvest: 0,
          plannedLambs: 0,
          budgetExpense: 0,
          recurringExpense: 0,
          payables: 0,
          loans: 0,
        },
      },
    ]),
  );
  /** Anything already due lands in the current month. Anything past the horizon drops out. */
  const place = (month: string) => rows.get(month < current ? current : month);

  for (const categoryId of new Set([...byCategory.keys(), ...budgetRows.map((row) => row.categoryId)])) {
    const kind = kindOf.get(categoryId);
    for (const month of horizon) {
      const found = estimate(categoryId, month);
      if (!found) continue;
      // The current month has already spent part of its estimate.
      const spent = month === current ? (spentThisMonth.get(categoryId) ?? 0) : 0;
      const amount = Math.max(0, found.amount - spent);
      const row = rows.get(month)!;
      if (kind === 'income') {
        if (found.source === 'budget') row.parts.budgetIncome += amount;
        else row.parts.recurringIncome += amount;
      } else if (found.source === 'budget') {
        row.parts.budgetExpense += amount;
      } else {
        row.parts.recurringExpense += amount;
      }
    }
  }

  for (const debt of await listDebts()) {
    for (const doc of debt.documents) {
      const month = doc.dueDate ? monthOf(doc.dueDate) : monthAdd(current, 1);
      const row = place(month);
      if (!row) continue;
      if (debt.direction === 'payable') row.parts.payables += doc.outstanding;
      else row.parts.receivables += doc.outstanding;
    }
  }

  for (const instalment of unpaidInstalments) {
    const row = place(monthOf(instalment.dueDate));
    if (row) row.parts.loans += instalment.payment;
  }

  const salePrices = await tx()
    .selectDistinctOn([items.id], { name: items.name, unit: items.unit, price: prices.price })
    .from(prices)
    .innerJoin(items, eq(items.id, prices.itemId))
    .where(and(eq(prices.farmId, c.farmId), eq(prices.kind, 'sale')))
    .orderBy(items.id, desc(prices.date));

  const addPlanned = (month: string, part: 'plannedSales' | 'plannedHarvest' | 'plannedLambs', amount: number) => {
    if (incomeBudgetMonths.has(month)) return;
    const row = place(month);
    if (row) row.parts[part] += amount;
  };

  const openSales = await tx()
    .select({ date: sales.date, deliveryDate: sales.deliveryDate, total: sales.totalAmount })
    .from(sales)
    .where(and(eq(sales.farmId, c.farmId), inArray(sales.status, ['draft', 'pending'])));
  for (const sale of openSales) addPlanned(monthOf(sale.deliveryDate ?? sale.date), 'plannedSales', sale.total);

  const openPlans = await tx()
    .select({
      areaHa: cropPlans.areaHa,
      yieldTHa: cropPlans.expectedYieldTHa,
      ownUsePct: cropPlans.ownUsePct,
      cropName: crops.name,
      seasonEnd: seasons.endDate,
    })
    .from(cropPlans)
    .innerJoin(crops, eq(crops.id, cropPlans.cropId))
    .innerJoin(seasons, eq(seasons.id, cropPlans.seasonId))
    .where(and(eq(cropPlans.farmId, c.farmId), notInArray(cropPlans.status, ['harvested', 'cancelled'])));
  for (const plan of openPlans) {
    if (!plan.yieldTHa) continue;
    const name = plan.cropName.uz.toLowerCase();
    const priced = salePrices.find((p) => p.name.toLowerCase().includes(name));
    if (!priced) continue;
    const pricePerTon = priced.unit === 'kg' ? priced.price * 1000 : priced.price;
    const tons = plan.areaHa * plan.yieldTHa * (1 - plan.ownUsePct / 100);
    addPlanned(monthOf(plan.seasonEnd), 'plannedHarvest', tons * pricePerTon);
  }

  const lambPrice = salePrices.find((p) => p.unit === 'head' && p.name.toLowerCase().includes("qo'zi"));
  if (lambPrice) {
    const expected = await tx()
      .select({ month: sql<string>`to_char(${breedingRecords.expectedDate}, 'YYYY-MM')`, ewes: sql<number>`count(*)`.mapWith(Number) })
      .from(breedingRecords)
      .where(and(eq(breedingRecords.farmId, c.farmId), eq(breedingRecords.status, 'pregnant')))
      .groupBy(sql`to_char(${breedingRecords.expectedDate}, 'YYYY-MM')`);
    for (const row of expected) {
      const lambs = row.ewes * LAMB_ASSUMPTIONS.lambsPerEwe * LAMB_ASSUMPTIONS.survival;
      addPlanned(monthAdd(row.month, LAMB_ASSUMPTIONS.monthsToSale), 'plannedLambs', lambs * lambPrice.price);
    }
  }

  let closing = position.total;
  const result = horizon.map((month) => {
    const row = rows.get(month)!;
    const p = row.parts;
    for (const key of Object.keys(p) as (keyof typeof p)[]) p[key] = round(p[key], 2);
    row.inflow = round(p.budgetIncome + p.recurringIncome + p.receivables + p.plannedSales + p.plannedHarvest + p.plannedLambs, 2);
    row.outflow = round(p.budgetExpense + p.recurringExpense + p.payables + p.loans, 2);
    row.net = round(row.inflow - row.outflow, 2);
    closing = round(closing + row.net, 2);
    row.closing = closing;
    row.negative = closing < 0;
    return row;
  });

  // Past the last budgeted month only loans and debts are left, so money seems to stop coming in.
  // Those months stay on the page, marked, but they must not raise the shortage warning.
  const plannedThrough = budgetRows.length ? budgetRows.map((row) => row.month).sort().at(-1)! : null;
  const warnable = plannedThrough ? result.filter((row) => row.month <= plannedThrough) : result;

  return {
    method: 'statistical' as const,
    asOf,
    opening: position.total,
    plannedThrough,
    /** Completed months of history behind the averages. Few months means low confidence. */
    historyMonths,
    lowConfidence: historyMonths < 3 && budgetRows.length === 0,
    assumptions: LAMB_ASSUMPTIONS,
    firstNegativeMonth: warnable.find((row) => row.negative)?.month ?? null,
    rows: result,
  };
}

export async function cashflowForecast(months: number) {
  return (await cashflowForecastDetail(months)).rows;
}
