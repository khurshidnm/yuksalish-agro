/**
 * Payroll (spec 11.5–11.7). How it reaches the ledger:
 *
 *   approve   gross labour cost is posted as expenses on credit against one "payroll" counterparty,
 *             one transaction per cost center. This creates the cost and a payable.
 *   advance   a debt payment during the month: money leaves, the payable shrinks.
 *   pay       a debt payment of the total net: money leaves, the payable is settled.
 *
 * Posting payments as debt settlements keeps labour cost from being counted twice. Amounts withheld
 * as deductions stay in the payable until they are paid on, as withheld amounts should.
 */
import { and, asc, count, desc, eq, getTableColumns, gt, gte, inArray, lte, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { addDays, diffDays, monthOf, monthRange, round, PII_VIEW } from '@yap/shared';
import {
  KPI_METRICS,
  KPI_REWARD_TYPES,
  allocateLabour,
  basePay,
  kpiBonus,
  payrollGross,
  payrollNet,
  pieceworkPay,
  shepherdSurvival,
  type KpiMetric,
  type KpiRewardType,
  type PayType,
} from '@yap/shared/formulas/payroll';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { PAYROLL_COUNTERPARTY } from '../../core/defaults';
import { generalCostCenterId } from '../../core/costCenters';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { postTransaction } from '../../core/ledger';
import { clientId, isoDate, isoMonth, listQuery, paged, sortBy, sumOf } from '../../core/query';
import { create as createCounterparty } from '../finance/counterparties.service';
import { tr } from '../notifications/i18n';
import { notifyRole, notifyUser } from '../notifications/notify.service';
import { employedDuring, getRow, type Employee } from './employees.service';
import { herdCostCenterId, noWork, workByEmployee, workDaysByCostCenter, type WorkDone } from './workdone.service';

const {
  accounts,
  animals,
  costCenters,
  counterparties,
  employees,
  financeCategories,
  kpiRules,
  lambingRecords,
  payrollAdvances: advances,
  payrollLines: lines,
  payrollRuns: runs,
  timesheets,
  transactions,
} = schema;

type Run = typeof runs.$inferSelect;
type Line = typeof lines.$inferSelect;
type LineValues = Pick<Line, 'daysWorked' | 'base' | 'piecework' | 'bonus' | 'advance' | 'deductions' | 'net' | 'allocation' | 'basis'>;

/** Everyone's wages sit on one counterparty, so unpaid wages show up among payables. */

const runLink = (id: string) => `/hr/payroll?run=${id}`;

/** A lamb is weaned by about 120 days, so a month's KPI looks at lambs born in that window. */
const WEANING_WINDOW_DAYS = 120;

const amount = z.number().min(0).max(1_000_000_000_000);

export const runListQuery = listQuery;
export const runInput = z.object({ id: clientId, month: isoMonth, notes: z.string().max(500).nullish() });
export const lineParams = z.object({ id: z.uuid(), lineId: z.uuid() });
export const lineInput = z
  .object({ base: amount, piecework: amount, bonus: amount, advance: amount, deductions: amount })
  .partial();
export const returnInput = z.object({ reason: z.string().trim().min(1).max(500) });
export const payInput = z.object({ accountId: z.uuid(), date: isoDate });

export const advanceInput = z.object({
  id: clientId,
  employeeId: z.uuid(),
  date: isoDate,
  amount: z.number().positive().max(1_000_000_000_000),
  accountId: z.uuid(),
  /** The payroll month it comes off. Defaults to the month of `date`. */
  month: isoMonth.optional(),
  notes: z.string().max(300).nullish(),
});
export const advanceQuery = z.object({ month: isoMonth.optional(), employeeId: z.uuid().optional() });

export const kpiRuleInput = z.object({
  id: clientId,
  name: z.string().trim().min(1).max(120),
  metric: z.enum(KPI_METRICS),
  position: z.string().trim().max(120).nullish(),
  threshold: z.number().min(0),
  rewardType: z.enum(KPI_REWARD_TYPES),
  amount,
  active: z.boolean().optional(),
});

// ─── Calculation ────────────────────────────────────────────────────────────

/** Lamb survival for a herd, or the whole farm when no herd is given (spec 11.7, 8.6). */
async function survivalFor(herdId: string | null, monthEnd: string): Promise<number | null> {
  const { farmId } = ctx();
  const from = addDays(monthEnd, -WEANING_WINDOW_DAYS);
  const [{ born }] = await tx()
    .select({ born: sumOf(lambingRecords.lambsBorn) })
    .from(lambingRecords)
    .innerJoin(animals, eq(animals.id, lambingRecords.eweId))
    .where(
      and(
        eq(lambingRecords.farmId, farmId),
        gte(lambingRecords.date, from),
        lte(lambingRecords.date, monthEnd),
        herdId ? eq(animals.herdId, herdId) : undefined,
      ),
    );
  const dam = alias(animals, 'dam');
  const [{ alive }] = await tx()
    .select({ alive: count() })
    .from(animals)
    .innerJoin(dam, eq(dam.id, animals.damId))
    .where(
      and(
        eq(animals.farmId, farmId),
        eq(animals.origin, 'born'),
        gte(animals.birthDate, from),
        lte(animals.birthDate, monthEnd),
        herdId ? eq(dam.herdId, herdId) : undefined,
        // Lambs lost after this month still counted as alive in it.
        or(notInArray(animals.status, ['dead', 'lost']), gt(animals.exitDate, monthEnd)),
      ),
    );
  return shepherdSurvival(alive, born);
}

interface StatusCounts {
  present: number;
  sick: number;
  vacation: number;
  dayOff: number;
}

async function timesheetCounts(from: string, to: string): Promise<Map<string, StatusCounts>> {
  const rows = await tx()
    .select({ employeeId: timesheets.employeeId, status: timesheets.status, days: count() })
    .from(timesheets)
    .where(and(eq(timesheets.farmId, ctx().farmId), gte(timesheets.date, from), lte(timesheets.date, to)))
    .groupBy(timesheets.employeeId, timesheets.status);
  const result = new Map<string, StatusCounts>();
  for (const row of rows) {
    const c = result.get(row.employeeId) ?? { present: 0, sick: 0, vacation: 0, dayOff: 0 };
    if (row.status === 'present') c.present = row.days;
    else if (row.status === 'sick') c.sick = row.days;
    else if (row.status === 'vacation') c.vacation = row.days;
    else if (row.status === 'day_off') c.dayOff = row.days;
    result.set(row.employeeId, c);
  }
  return result;
}

/** Advances that really left an account: a pending or rejected one has not been paid. */
async function advancesByEmployee(month: string): Promise<Map<string, number>> {
  const rows = await tx()
    .select({ employeeId: advances.employeeId, total: sumOf(advances.amount) })
    .from(advances)
    .innerJoin(transactions, eq(transactions.id, advances.transactionId))
    .where(and(eq(advances.farmId, ctx().farmId), eq(advances.month, month), eq(transactions.status, 'approved')))
    .groupBy(advances.employeeId);
  return new Map(rows.map((r) => [r.employeeId, r.total]));
}

function kpiValue(metric: KpiMetric, work: WorkDone, survival: number | null): number | null {
  return metric === 'hectares' ? work.hectares : survival;
}

function employmentDays(e: Employee, from: string, to: string) {
  const start = e.hireDate > from ? e.hireDate : from;
  const end = e.terminationDate && e.terminationDate < to ? e.terminationDate : to;
  return diffDays(start, end) + 1;
}

/** Fresh figures for everyone employed in the month. `deductions` is always entered by hand. */
async function computeLines(month: string): Promise<Map<string, LineValues>> {
  const { farmId } = ctx();
  const { from, to } = monthRange(month);
  const daysInMonth = diffDays(from, to) + 1;

  const staff = await tx()
    .select()
    .from(employees)
    .where(and(eq(employees.farmId, farmId), employedDuring(from, to)));
  const counts = await timesheetCounts(from, to);
  const work = await workByEmployee(from, to);
  const paidAdvances = await advancesByEmployee(month);
  const workDays = await workDaysByCostCenter(from, to);
  const rules = await tx()
    .select()
    .from(kpiRules)
    .where(and(eq(kpiRules.farmId, farmId), eq(kpiRules.active, true)));
  const usesSurvival = rules.some((r) => r.metric === 'survival_percent');
  const general = await generalCostCenterId();

  const survivalByHerd = new Map<string | null, number | null>();
  const result = new Map<string, LineValues>();

  for (const e of staff) {
    const c = counts.get(e.id) ?? { present: 0, sick: 0, vacation: 0, dayOff: 0 };
    const done = work.get(e.id) ?? noWork();
    const employedDays = employmentDays(e, from, to);
    const paidDays = c.present + c.sick + c.vacation;
    const expectedDays = Math.max(0, employedDays - c.dayOff);

    const base = basePay({
      payType: e.payType as PayType,
      baseRate: e.baseRate,
      presentDays: c.present,
      paidDays,
      expectedDays,
      employedDays,
      daysInMonth,
      seasonDays: e.contractEndDate ? diffDays(e.hireDate, e.contractEndDate) + 1 : null,
    });
    const piecework = pieceworkPay(
      { ha: done.hectares, head: done.headTreated, headDay: done.headDays, t: done.tons },
      e.pieceRates,
    );

    let survival: number | null = null;
    if (usesSurvival) {
      if (!survivalByHerd.has(e.herdId)) survivalByHerd.set(e.herdId, await survivalFor(e.herdId, to));
      survival = survivalByHerd.get(e.herdId) ?? null;
    }
    const kpi = rules
      .filter((rule) => rule.position === null || rule.position === e.position)
      .map((rule) => {
        const value = kpiValue(rule.metric as KpiMetric, done, survival);
        return {
          ruleId: rule.id,
          name: rule.name,
          metric: rule.metric,
          value,
          threshold: rule.threshold,
          bonus: kpiBonus({ ...rule, rewardType: rule.rewardType as KpiRewardType }, value),
        };
      });
    const bonus = round(kpi.reduce((sum, k) => sum + k.bonus, 0), 2);

    const fallback = (e.herdId && (await herdCostCenterId(e.herdId))) || general;
    const costCenterDays = workDays.get(e.id) ?? {};
    const advance = paidAdvances.get(e.id) ?? 0;

    result.set(e.id, {
      daysWorked: c.present,
      base,
      piecework,
      bonus,
      advance,
      deductions: 0,
      net: payrollNet({ base, piecework, bonus, advance, deductions: 0 }),
      allocation: allocateLabour(payrollGross({ base, piecework, bonus }), costCenterDays, fallback),
      basis: {
        presentDays: c.present,
        paidDays,
        // The paid days that were not worked, so the slip can say why two people with different attendance get the same.
        sickDays: c.sick,
        vacationDays: c.vacation,
        expectedDays,
        employedDays,
        daysInMonth,
        work: done,
        kpi,
        costCenterDays,
        fallbackCostCenterId: fallback,
      },
    });
  }
  return result;
}

// ─── Runs ───────────────────────────────────────────────────────────────────

async function lockRun(id: string): Promise<Run> {
  const [run] = await tx()
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.farmId, ctx().farmId)))
    .for('update');
  if (!run) throw notFound('Payroll run');
  return run;
}

function assertDraft(run: Run): void {
  if (run.status !== 'draft') throw conflict('PAYROLL_NOT_DRAFT', 'Only a draft payroll can be changed');
}

async function loadLines(runId: string): Promise<Line[]> {
  return tx().select().from(lines).where(eq(lines.runId, runId));
}

/** Refresh totals and record who last touched the figures: that person is the maker. */
async function touchRun(runId: string): Promise<void> {
  const rows = await loadLines(runId);
  await tx()
    .update(runs)
    .set({
      totalGross: round(rows.reduce((sum, l) => sum + payrollGross(l), 0), 2),
      totalNet: round(rows.reduce((sum, l) => sum + l.net, 0), 2),
      preparedBy: ctx().userId,
    })
    .where(eq(runs.id, runId));
}

export async function listRuns(q: z.infer<typeof runListQuery>) {
  const where = eq(runs.farmId, ctx().farmId);
  return paged(q, runs, where, (limit, offset) =>
    tx()
      .select()
      .from(runs)
      .where(where)
      .orderBy(...sortBy(q.sort, { month: runs.month, status: runs.status }, desc(runs.month), runs.id))
      .limit(limit)
      .offset(offset),
  );
}

export async function getRun(id: string) {
  const [run] = await tx()
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.farmId, ctx().farmId)));
  if (!run) throw notFound('Payroll run');

  const rows = await tx()
    .select({
      ...getTableColumns(lines),
      fullName: employees.fullName,
      position: employees.position,
      payType: employees.payType,
    })
    .from(lines)
    .innerJoin(employees, eq(employees.id, lines.employeeId))
    .where(eq(lines.runId, id))
    .orderBy(asc(employees.position), asc(employees.fullName));

  const totals = new Map<string, number>();
  for (const line of rows) {
    for (const [costCenterId, share] of Object.entries(line.allocation)) {
      totals.set(costCenterId, (totals.get(costCenterId) ?? 0) + share);
    }
  }
  const names = totals.size
    ? await tx()
        .select({ id: costCenters.id, name: costCenters.name, type: costCenters.type })
        .from(costCenters)
        .where(inArray(costCenters.id, [...totals.keys()]))
    : [];

  const canSeeNames = hasPermission(PII_VIEW);
  return {
    ...run,
    lines: rows.map((line) => ({
      ...line,
      fullName: canSeeNames ? line.fullName : null,
      gross: payrollGross(line),
    })),
    allocation: names
      .map((cc) => ({ costCenterId: cc.id, name: cc.name, type: cc.type, amount: round(totals.get(cc.id)!, 2) }))
      .sort((a, b) => b.amount - a.amount),
  };
}

export async function createRun(input: z.infer<typeof runInput>) {
  const c = ctx();
  if (input.month > monthOf(today())) throw badRequest('FUTURE_MONTH', 'Payroll cannot be run for a future month');
  // One run per month (the unique index stays the guard against a race). Naming the run lets the app open it.
  const [existing] = await tx()
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.farmId, c.farmId), eq(runs.month, input.month)));
  if (existing) throw conflict('ALREADY_EXISTS', 'Payroll for this month has already been calculated', { month: input.month, runId: existing.id });

  const computed = await computeLines(input.month);
  const [run] = await tx()
    .insert(runs)
    .values({
      ...(input.id ? { id: input.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      preparedBy: c.userId,
      month: input.month,
      notes: input.notes,
    })
    .returning();
  if (computed.size > 0) {
    await tx()
      .insert(lines)
      .values(
        [...computed].map(([employeeId, values]) => ({
          ...values,
          tenantId: c.tenantId,
          farmId: c.farmId,
          createdBy: c.userId,
          runId: run.id,
          employeeId,
        })),
      );
  }
  await touchRun(run.id);
  await recordEvent({ type: 'payroll.created', entityType: 'payroll_run', entityId: run.id, data: { month: input.month } });
  return getRun(run.id);
}

const EDITABLE = ['base', 'piecework', 'bonus', 'advance', 'deductions'] as const;

/** Pick the hand-edited figure over the computed one, for each field the user has overridden. */
function mergeOverrides(existing: Line, fresh: LineValues): LineValues {
  const merged: LineValues = { ...fresh, deductions: existing.deductions };
  for (const field of EDITABLE) {
    if (existing.overrides.includes(field)) merged[field] = existing[field];
  }
  const basis = fresh.basis as { costCenterDays: Record<string, number>; fallbackCostCenterId: string };
  merged.net = payrollNet(merged);
  merged.allocation = allocateLabour(payrollGross(merged), basis.costCenterDays, basis.fallbackCostCenterId);
  return merged;
}

/** Pick up timesheet and work changes. Figures edited by hand stay as they are. */
export async function recalculate(id: string) {
  const c = ctx();
  const run = await lockRun(id);
  assertDraft(run);

  const computed = await computeLines(run.month);
  const existing = await loadLines(id);
  for (const line of existing) {
    const fresh = computed.get(line.employeeId);
    if (fresh) {
      await tx().update(lines).set(mergeOverrides(line, fresh)).where(eq(lines.id, line.id));
      computed.delete(line.employeeId);
    } else {
      await tx().delete(lines).where(eq(lines.id, line.id));
    }
  }
  if (computed.size > 0) {
    await tx()
      .insert(lines)
      .values(
        [...computed].map(([employeeId, values]) => ({
          ...values,
          tenantId: c.tenantId,
          farmId: c.farmId,
          createdBy: c.userId,
          runId: id,
          employeeId,
        })),
      );
  }
  await touchRun(id);
  return getRun(id);
}

export async function editLine(runId: string, lineId: string, input: z.infer<typeof lineInput>) {
  const run = await lockRun(runId);
  assertDraft(run);
  const [line] = await tx()
    .select()
    .from(lines)
    .where(and(eq(lines.id, lineId), eq(lines.runId, runId)));
  if (!line) throw notFound('Payroll line');

  const changed = EDITABLE.filter((field) => input[field] !== undefined && input[field] !== line[field]);
  // Saving without a change must not make this person the maker.
  if (changed.length === 0) return getRun(runId);
  const merged = { ...line, ...input };
  const basis = line.basis as { costCenterDays?: Record<string, number>; fallbackCostCenterId?: string };
  const fallback = basis.fallbackCostCenterId ?? (await generalCostCenterId());
  await tx()
    .update(lines)
    .set({
      ...input,
      net: payrollNet(merged),
      allocation: allocateLabour(payrollGross(merged), basis.costCenterDays ?? {}, fallback),
      overrides: [...new Set([...line.overrides, ...changed])],
    })
    .where(eq(lines.id, lineId));
  await touchRun(runId);
  return getRun(runId);
}

export async function deleteRun(id: string) {
  const run = await lockRun(id);
  assertDraft(run);
  await tx().delete(runs).where(eq(runs.id, id));
  return { id };
}

export async function submitRun(id: string) {
  const run = await lockRun(id);
  assertDraft(run);
  await tx().update(runs).set({ status: 'pending', returnedReason: null }).where(eq(runs.id, id));
  await recordEvent({ type: 'payroll.submitted', entityType: 'payroll_run', entityId: id, data: { month: run.month } });
  await notifyRole(
    ['owner', 'director', 'accountant'],
    { severity: 'attention', title: (locale) => tr(locale, 'hr', 'payroll.notify.submitted', { month: run.month }), link: runLink(id) },
    { permission: 'payroll.approve', exclude: run.preparedBy ? [run.preparedBy] : [] },
  );
  return getRun(id);
}

export async function returnRun(id: string, reason: string) {
  const run = await lockRun(id);
  if (run.status !== 'pending') throw conflict('PAYROLL_NOT_PENDING', 'This payroll is not waiting for approval');
  await tx().update(runs).set({ status: 'draft', returnedReason: reason }).where(eq(runs.id, id));
  await recordEvent({ type: 'payroll.returned', entityType: 'payroll_run', entityId: id, data: { reason } });
  if (run.preparedBy) {
    await notifyUser(run.preparedBy, { severity: 'attention', title: (locale) => tr(locale, 'hr', 'payroll.notify.returned', { month: run.month }), body: reason, link: runLink(id) });
  }
  return getRun(id);
}

async function salaryCategoryId(): Promise<string> {
  const [category] = await tx()
    .select({ id: financeCategories.id })
    .from(financeCategories)
    .where(and(eq(financeCategories.tenantId, ctx().tenantId), eq(financeCategories.key, 'salary')));
  if (!category) throw notFound('Salary category');
  return category.id;
}

/** Takes turns, because two first postings would each create one and split the debt between them. */
async function payrollCounterpartyId(): Promise<string> {
  await tx().execute(sql`select pg_advisory_xact_lock(hashtext(${`payroll-counterparty:${ctx().farmId}`}))`);
  const [existing] = await tx()
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(and(eq(counterparties.farmId, ctx().farmId), eq(counterparties.name, PAYROLL_COUNTERPARTY)));
  if (existing) return existing.id;
  const created = await createCounterparty({ name: PAYROLL_COUNTERPARTY, type: 'other' });
  return created.id;
}

/** Costs are dated inside the month they belong to, and never in the future. */
function postingDate(month: string): string {
  const { to } = monthRange(month);
  const now = today();
  return to < now ? to : now;
}

/** One expense per cost center. The amounts add up exactly to the run's gross. */
async function postLabourCost(run: Run, rows: Line[]): Promise<void> {
  const [posted] = await tx()
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.sourceType, 'payroll_run'), eq(transactions.sourceId, run.id)))
    .limit(1);
  if (posted) return;

  const byCenter = new Map<string, number>();
  for (const line of rows) {
    for (const [costCenterId, share] of Object.entries(line.allocation)) {
      byCenter.set(costCenterId, (byCenter.get(costCenterId) ?? 0) + share);
    }
  }
  const categoryId = await salaryCategoryId();
  const counterpartyId = await payrollCounterpartyId();
  const date = postingDate(run.month);
  for (const [costCenterId, total] of byCenter) {
    const value = round(total, 2);
    if (value <= 0) continue;
    await postTransaction({
      date,
      type: 'expense',
      amount: value,
      categoryId,
      paymentMethod: 'debt',
      counterpartyId,
      costCenterId,
      costTreatment: 'expense',
      description: `Ish haqi ${run.month}`,
      sourceType: 'payroll_run',
      sourceId: run.id,
      // The run itself went through maker-checker.
      autoApprove: true,
    });
  }
}

/**
 * Paying an advance and approving that month's payroll take turns, also before the month has a run,
 * so the approval sees every advance paid before it and no advance comes after it.
 */
async function lockPayrollMonth(month: string): Promise<void> {
  await tx().execute(sql`select pg_advisory_xact_lock(hashtext(${`payroll:${ctx().farmId}:${month}`}))`);
}

/**
 * A run's advances were read when it was worked out, and approving fixes what each person is paid.
 * An advance paid since would not come off, and one still waiting would be paid on top when approved.
 * A figure typed into a line is that person's decision, so it stays.
 */
async function assertAdvancesCounted(run: Run, rows: Line[]): Promise<void> {
  const [waiting] = await tx()
    .select({ id: advances.id })
    .from(advances)
    .innerJoin(transactions, eq(transactions.id, advances.transactionId))
    .where(and(eq(advances.farmId, run.farmId), eq(advances.month, run.month), eq(transactions.status, 'pending')))
    .limit(1);
  if (waiting) throw conflict('PAYROLL_ADVANCES_WAITING', 'An advance for this month is waiting for approval');

  const paid = await advancesByEmployee(run.month);
  const changed = rows.some((row) => !row.overrides.includes('advance') && (paid.get(row.employeeId) ?? 0) !== row.advance);
  if (changed) throw conflict('PAYROLL_ADVANCES_CHANGED', 'An advance was paid after this payroll was worked out. Recalculate it');
}

/** Maker-checker: the person who last changed the figures cannot approve them (spec 5.1). */
export async function approveRun(id: string) {
  const c = ctx();
  const run = await lockRun(id);
  if (run.status === 'approved' || run.status === 'paid') {
    throw conflict('ALREADY_APPROVED', 'This payroll has already been approved');
  }
  if (c.settings.finance.makerChecker && run.preparedBy === c.userId) {
    throw forbidden('The person who prepared the payroll cannot approve it', 'SAME_MAKER_CHECKER');
  }
  await lockPayrollMonth(run.month);
  const rows = await loadLines(id);
  if (rows.length === 0) throw conflict('PAYROLL_EMPTY', 'This payroll has no lines');
  await assertAdvancesCounted(run, rows);

  await postLabourCost(run, rows);
  await tx()
    .update(runs)
    .set({ status: 'approved', approvedBy: c.userId, approvedAt: new Date(), returnedReason: null })
    .where(eq(runs.id, id));
  await recordEvent({
    type: 'payroll.approved',
    entityType: 'payroll_run',
    entityId: id,
    data: { month: run.month, totalGross: run.totalGross, totalNet: run.totalNet },
  });
  return getRun(id);
}

async function getAccount(accountId: string) {
  const [account] = await tx()
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.farmId, ctx().farmId)));
  if (!account) throw notFound('Account');
  return account;
}

/** Pay out the net. Someone who is owed nothing is skipped. */
export async function payRun(id: string, input: z.infer<typeof payInput>) {
  const run = await lockRun(id);
  if (run.status === 'paid') throw conflict('ALREADY_PAID', 'This payroll has already been paid');
  if (run.status !== 'approved') throw conflict('PAYROLL_NOT_APPROVED', 'Approve the payroll first');

  const account = await getAccount(input.accountId);
  const rows = await loadLines(id);
  const toPay = round(rows.reduce((sum, l) => sum + Math.max(0, l.net), 0), 2);

  let paymentTransactionId: string | null = null;
  if (toPay > 0) {
    const payment = await postTransaction({
      date: input.date,
      type: 'debt_payment',
      amount: toPay,
      paymentMethod: account.type as 'cash' | 'bank' | 'card',
      accountId: account.id,
      counterpartyId: await payrollCounterpartyId(),
      description: `Ish haqi to'lovi ${run.month}`,
      sourceType: 'payroll_payment',
      sourceId: run.id,
      autoApprove: true,
    });
    paymentTransactionId = payment.id;
  }
  await tx().update(runs).set({ status: 'paid', paidAt: new Date(), paymentTransactionId }).where(eq(runs.id, id));
  await recordEvent({ type: 'payroll.paid', entityType: 'payroll_run', entityId: id, occurredAt: input.date, data: { amount: toPay } });
  return getRun(id);
}

// ─── Advances ───────────────────────────────────────────────────────────────

export async function listAdvances(q: z.infer<typeof advanceQuery>) {
  const rows = await tx()
    .select({
      ...getTableColumns(advances),
      fullName: employees.fullName,
      accountName: accounts.name,
      transactionStatus: transactions.status,
    })
    .from(advances)
    .innerJoin(employees, eq(employees.id, advances.employeeId))
    .leftJoin(accounts, eq(accounts.id, advances.accountId))
    .leftJoin(transactions, eq(transactions.id, advances.transactionId))
    .where(
      and(
        eq(advances.farmId, ctx().farmId),
        q.month ? eq(advances.month, q.month) : undefined,
        q.employeeId ? eq(advances.employeeId, q.employeeId) : undefined,
      ),
    )
    .orderBy(desc(advances.date))
    .limit(500);
  // A name beside an amount is personal data (rule 8).
  return hasPermission(PII_VIEW) ? rows : rows.map((row) => ({ ...row, fullName: null }));
}

/** The ledger applies the usual approval rule, so a large advance waits for a second person. */
export async function createAdvance(input: z.infer<typeof advanceInput>) {
  const c = ctx();
  const employee = await getRow(input.employeeId);
  const account = await getAccount(input.accountId);
  const month = input.month ?? monthOf(input.date);

  // Waits for an approval running now, then sees how it ended. No row lock on the run as well:
  // approval takes that one first, so the two would deadlock.
  await lockPayrollMonth(month);
  const [closed] = await tx()
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.farmId, c.farmId), eq(runs.month, month), inArray(runs.status, ['approved', 'paid'])));
  if (closed) throw conflict('PAYROLL_CLOSED', `Payroll for ${month} is already approved`, { month });

  const transaction = await postTransaction({
    date: input.date,
    type: 'debt_payment',
    amount: input.amount,
    paymentMethod: account.type as 'cash' | 'bank' | 'card',
    accountId: account.id,
    counterpartyId: await payrollCounterpartyId(),
    description: `Avans: ${employee.fullName}`,
    sourceType: 'payroll_advance',
    sourceId: input.employeeId,
  });
  const [row] = await tx()
    .insert(advances)
    .values({
      ...(input.id ? { id: input.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      employeeId: input.employeeId,
      date: input.date,
      month,
      amount: input.amount,
      accountId: account.id,
      transactionId: transaction.id,
      notes: input.notes,
    })
    .returning();
  return { ...row, transactionStatus: transaction.status };
}

// ─── KPI rules ──────────────────────────────────────────────────────────────

export function listKpiRules() {
  return tx()
    .select()
    .from(kpiRules)
    .where(eq(kpiRules.farmId, ctx().farmId))
    .orderBy(asc(kpiRules.name));
}

export async function createKpiRule(input: z.infer<typeof kpiRuleInput>) {
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(kpiRules)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  return row;
}

export async function updateKpiRule(id: string, input: Partial<z.infer<typeof kpiRuleInput>>) {
  const { id: _ignored, ...values } = input;
  const [row] = await tx()
    .update(kpiRules)
    .set(values)
    .where(and(eq(kpiRules.id, id), eq(kpiRules.farmId, ctx().farmId)))
    .returning();
  if (!row) throw notFound('KPI rule');
  return row;
}

export async function deleteKpiRule(id: string) {
  const [row] = await tx()
    .delete(kpiRules)
    .where(and(eq(kpiRules.id, id), eq(kpiRules.farmId, ctx().farmId)))
    .returning({ id: kpiRules.id });
  if (!row) throw notFound('KPI rule');
  return { id };
}
