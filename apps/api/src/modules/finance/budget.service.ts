import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { budgetExecutionPercent, monthRange, round } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { isoMonth, sumOf } from '../../core/query';

const { budgets: b, costCenters, financeCategories: cat, transactions: t } = schema;

export const budgetQuery = z.object({
  from: isoMonth,
  to: isoMonth,
  costCenterId: z.uuid().optional(),
});

export const budgetBulkInput = z.object({
  entries: z
    .array(
      z.object({
        month: isoMonth,
        categoryId: z.uuid(),
        costCenterId: z.uuid().nullish(),
        /** Zero removes the plan line. */
        amount: z.number().min(0).max(1e14),
        notes: z.string().trim().max(300).nullish(),
      }),
    )
    .min(1)
    .max(2000),
});

export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  let [year, month] = from.split('-').map(Number);
  const [endYear, endMonth] = to.split('-').map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

export interface BudgetCell {
  planned: number;
  actual: number;
}

export interface BudgetRow {
  categoryId: string;
  key: string;
  kind: string;
  group: string;
  name: { uz: string; ru: string; en: string };
  cells: Record<string, BudgetCell>;
  planned: number;
  actual: number;
  deviation: number;
  percent: number | null;
}

/**
 * Plan vs fact by category and month. The fact is the money side of the journal: every approved
 * transaction of that kind in that category, whatever its cost treatment, because a budget
 * controls spending. A feed purchase counts here when bought, and in cost reports when issued.
 */
export async function grid(q: z.infer<typeof budgetQuery>) {
  if (q.from > q.to) throw badRequest('INVALID_PERIOD', 'The start of the period is after its end');
  const months = monthsBetween(q.from, q.to);
  if (months.length > 36) throw badRequest('INVALID_PERIOD', 'The period is too long');
  const c = ctx();
  const fromDate = monthRange(q.from).from;
  const toDate = monthRange(q.to).to;

  const categories = await tx()
    .select()
    .from(cat)
    .where(and(eq(cat.tenantId, c.tenantId), eq(cat.active, true)))
    .orderBy(asc(cat.kind), asc(cat.group), asc(cat.key));

  const plans = await tx()
    .select({ month: b.month, categoryId: b.categoryId, amount: sumOf(b.amount) })
    .from(b)
    .where(
      and(
        eq(b.farmId, c.farmId),
        gte(b.month, q.from),
        lte(b.month, q.to),
        q.costCenterId ? eq(b.costCenterId, q.costCenterId) : undefined,
      ),
    )
    .groupBy(b.month, b.categoryId);

  const month = sql<string>`to_char(${t.date}, 'YYYY-MM')`;
  const facts = await tx()
    .select({ month, categoryId: t.categoryId, kind: t.type, amount: sumOf(t.amountBase) })
    .from(t)
    .where(
      and(
        eq(t.farmId, c.farmId),
        eq(t.status, 'approved'),
        inArray(t.type, ['expense', 'income']),
        gte(t.date, fromDate),
        lte(t.date, toDate),
        q.costCenterId ? eq(t.costCenterId, q.costCenterId) : undefined,
      ),
    )
    .groupBy(month, t.categoryId, t.type);

  const rows = new Map<string, BudgetRow>();
  for (const category of categories) {
    rows.set(category.id, {
      categoryId: category.id,
      key: category.key,
      kind: category.kind,
      group: category.group,
      name: category.name,
      cells: Object.fromEntries(months.map((m) => [m, { planned: 0, actual: 0 }])),
      planned: 0,
      actual: 0,
      deviation: 0,
      percent: null,
    });
  }
  for (const plan of plans) {
    const row = rows.get(plan.categoryId);
    if (row?.cells[plan.month]) row.cells[plan.month].planned = plan.amount;
  }
  for (const fact of facts) {
    const row = fact.categoryId ? rows.get(fact.categoryId) : undefined;
    if (row?.cells[fact.month]) row.cells[fact.month].actual = fact.amount;
  }

  const result = [...rows.values()]
    .map((row) => {
      row.planned = round(months.reduce((sum, m) => sum + row.cells[m].planned, 0), 2);
      row.actual = round(months.reduce((sum, m) => sum + row.cells[m].actual, 0), 2);
      row.deviation = round(row.actual - row.planned, 2);
      row.percent = budgetExecutionPercent(row.actual, row.planned);
      return row;
    })
    .filter((row) => row.planned !== 0 || row.actual !== 0);

  const total = (kind: string) => {
    const matching = result.filter((row) => row.kind === kind);
    const planned = round(matching.reduce((sum, row) => sum + row.planned, 0), 2);
    const actual = round(matching.reduce((sum, row) => sum + row.actual, 0), 2);
    const byMonth = Object.fromEntries(
      months.map((m) => [
        m,
        {
          planned: round(matching.reduce((sum, row) => sum + row.cells[m].planned, 0), 2),
          actual: round(matching.reduce((sum, row) => sum + row.cells[m].actual, 0), 2),
        },
      ]),
    );
    return { planned, actual, deviation: round(actual - planned, 2), percent: budgetExecutionPercent(actual, planned), byMonth };
  };

  return { months, rows: result, totals: { expense: total('expense'), income: total('income') } };
}

/** Upsert plan lines in one call. The grid saves everything the user changed at once. */
export async function saveEntries(input: z.infer<typeof budgetBulkInput>) {
  const c = ctx();
  const categoryIds = [...new Set(input.entries.map((e) => e.categoryId))];
  const known = await tx().select({ id: cat.id }).from(cat).where(inArray(cat.id, categoryIds));
  if (known.length !== categoryIds.length) throw notFound('Category');

  const centerIds = [...new Set(input.entries.map((e) => e.costCenterId).filter((id): id is string => !!id))];
  if (centerIds.length) {
    const centers = await tx()
      .select({ id: costCenters.id })
      .from(costCenters)
      .where(and(eq(costCenters.farmId, c.farmId), inArray(costCenters.id, centerIds)));
    if (centers.length !== centerIds.length) throw notFound('Cost center');
  }

  let saved = 0;
  let removed = 0;
  for (const entry of input.entries) {
    const costCenterId = entry.costCenterId ?? null;
    const sameLine = and(
      eq(b.farmId, c.farmId),
      eq(b.month, entry.month),
      eq(b.categoryId, entry.categoryId),
      costCenterId ? eq(b.costCenterId, costCenterId) : sql`${b.costCenterId} is null`,
    );
    if (entry.amount === 0) {
      await tx().delete(b).where(sameLine);
      removed += 1;
      continue;
    }
    await tx()
      .insert(b)
      .values({
        tenantId: c.tenantId,
        farmId: c.farmId,
        createdBy: c.userId,
        month: entry.month,
        categoryId: entry.categoryId,
        costCenterId,
        amount: entry.amount,
        notes: entry.notes,
      })
      .onConflictDoUpdate({
        target: [b.farmId, b.month, b.categoryId, b.costCenterId],
        set: { amount: entry.amount, notes: entry.notes },
      });
    saved += 1;
  }
  await recordEvent({ type: 'budget.saved', entityType: 'budget', data: { saved, removed } });
  return { saved, removed };
}
