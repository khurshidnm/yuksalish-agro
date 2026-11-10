import { and, count, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { badRequest } from '../../core/errors';
import { isoDate, sumOf } from '../../core/query';
import type { TasksOnTime } from '@yap/shared/formulas/kpi';
import { onTimeByUser } from '../tasks/tasks.service';

const { animals, costCenters, dailyLogs, employees, fieldOperations, fields, healthRecords, herds } = schema;

export const workDoneQuery = z.object({ from: isoDate, to: isoDate, employeeId: z.uuid().optional() });

export interface WorkDone {
  /** Hectares from completed field operations. */
  hectares: number;
  /** Tonnes from harvest operations. */
  tons: number;
  /** Animals treated: a single animal counts 1, a herd treatment counts its head. */
  headTreated: number;
  /** Head × days from daily herd records. */
  headDays: number;
  /** Field operations completed. */
  operations: number;
  /** Veterinary records entered. */
  treatments: number;
  /** Daily herd records entered. */
  dailyLogs: number;
}

export const noWork = (): WorkDone => ({
  hectares: 0,
  tons: 0,
  headTreated: 0,
  headDays: 0,
  operations: 0,
  treatments: 0,
  dailyLogs: 0,
});

/**
 * What each person did, from the journals of the other modules (spec 11.4). Nothing is typed in
 * twice. Daily logs carry no employee, so they count for the employee linked to the user who
 * entered them. Tonnes come from `grossT` in the details of harvest operations.
 */
export async function workByEmployee(from: string, to: string, employeeId?: string): Promise<Map<string, WorkDone>> {
  const { farmId } = ctx();
  const result = new Map<string, WorkDone>();
  const entry = (id: string) => {
    const existing = result.get(id);
    if (existing) return existing;
    const created = noWork();
    result.set(id, created);
    return created;
  };

  const grossT = sql<number>`coalesce(sum(case when ${fieldOperations.type} = 'harvest'
    and ${fieldOperations.details}->>'grossT' ~ '^[0-9]+(\.[0-9]+)?$'
    then (${fieldOperations.details}->>'grossT')::numeric else 0 end), 0)`.mapWith(Number);

  const field = await tx()
    .select({
      employeeId: fieldOperations.employeeId,
      hectares: sumOf(fieldOperations.areaDoneHa),
      tons: grossT,
      operations: count(),
    })
    .from(fieldOperations)
    .where(
      and(
        eq(fieldOperations.farmId, farmId),
        eq(fieldOperations.status, 'done'),
        gte(fieldOperations.date, from),
        lte(fieldOperations.date, to),
        isNotNull(fieldOperations.employeeId),
        employeeId ? eq(fieldOperations.employeeId, employeeId) : undefined,
      ),
    )
    .groupBy(fieldOperations.employeeId);
  for (const row of field) {
    const work = entry(row.employeeId!);
    work.hectares = row.hectares;
    work.tons = row.tons;
    work.operations = row.operations;
  }

  const head = sql<number>`coalesce(sum(case when ${healthRecords.animalId} is not null then 1
    else coalesce(${healthRecords.headCount}, 0) end), 0)`.mapWith(Number);
  const health = await tx()
    .select({ employeeId: healthRecords.vetEmployeeId, head, treatments: count() })
    .from(healthRecords)
    .where(
      and(
        eq(healthRecords.farmId, farmId),
        gte(healthRecords.date, from),
        lte(healthRecords.date, to),
        isNotNull(healthRecords.vetEmployeeId),
        employeeId ? eq(healthRecords.vetEmployeeId, employeeId) : undefined,
      ),
    )
    .groupBy(healthRecords.vetEmployeeId);
  for (const row of health) {
    const work = entry(row.employeeId!);
    work.headTreated = row.head;
    work.treatments = row.treatments;
  }

  const logs = await tx()
    .select({ employeeId: employees.id, headDays: sumOf(dailyLogs.headCount), logs: count() })
    .from(dailyLogs)
    .innerJoin(employees, and(eq(employees.userId, dailyLogs.createdBy), eq(employees.farmId, farmId)))
    .where(
      and(
        eq(dailyLogs.farmId, farmId),
        gte(dailyLogs.date, from),
        lte(dailyLogs.date, to),
        employeeId ? eq(employees.id, employeeId) : undefined,
      ),
    )
    .groupBy(employees.id);
  for (const row of logs) {
    const work = entry(row.employeeId);
    work.headDays = row.headDays;
    work.dailyLogs = row.logs;
  }

  return result;
}

/**
 * Tasks each employee closed on time, of those that fell due in the period. A task belongs to a
 * user, so only an employee with a login can have any. Counting is `tasksOnTime()` in shared.
 */
export async function tasksByEmployee(from: string, to: string, employeeId?: string): Promise<Map<string, TasksOnTime>> {
  const byUser = await onTimeByUser(from, to);
  if (byUser.size === 0) return new Map();
  const people = await tx()
    .select({ id: employees.id, userId: employees.userId })
    .from(employees)
    .where(
      and(
        eq(employees.farmId, ctx().farmId),
        inArray(employees.userId, [...byUser.keys()]),
        employeeId ? eq(employees.id, employeeId) : undefined,
      ),
    );
  return new Map(people.map((p) => [p.id, byUser.get(p.userId!)!]));
}

export async function workDone(from: string, to: string, employeeId?: string) {
  if (to < from) throw badRequest('INVALID_RANGE', 'The end date is before the start date');
  const work = await workByEmployee(from, to, employeeId);
  const tasks = await tasksByEmployee(from, to, employeeId);
  // Someone whose only work in the period was tasks that fell due is listed too.
  const ids = new Set([...work.keys(), ...[...tasks].filter(([, t]) => t.due > 0).map(([id]) => id)]);
  if (ids.size === 0) return [];
  const people = await tx()
    .select({ id: employees.id, fullName: employees.fullName, position: employees.position })
    .from(employees)
    .where(and(eq(employees.farmId, ctx().farmId), inArray(employees.id, [...ids])));
  return people.map((p) => {
    const onTime = tasks.get(p.id);
    return {
      employeeId: p.id,
      fullName: p.fullName,
      position: p.position,
      ...(work.get(p.id) ?? noWork()),
      tasksOnTime: onTime?.onTime ?? 0,
      tasksDue: onTime?.due ?? 0,
      // Null when no task fell due: there is nothing to take a share of.
      tasksOnTimePercent: onTime?.percent ?? null,
    };
  });
}

/**
 * Days each person worked on each field or herd, keyed by cost center id. Days are what makes a
 * mechanic's hectares and a shepherd's head comparable, so one split works for everyone (spec 11.6).
 */
export async function workDaysByCostCenter(from: string, to: string): Promise<Map<string, Record<string, number>>> {
  const { farmId } = ctx();
  const days = new Map<string, Map<string, Set<string>>>();
  const mark = (employeeId: string, costCenterId: string, date: string) => {
    const perCenter = days.get(employeeId) ?? new Map<string, Set<string>>();
    days.set(employeeId, perCenter);
    const dates = perCenter.get(costCenterId) ?? new Set<string>();
    perCenter.set(costCenterId, dates);
    dates.add(date);
  };

  const fieldWork = await tx()
    .select({ employeeId: fieldOperations.employeeId, date: fieldOperations.date, costCenterId: costCenters.id })
    .from(fieldOperations)
    .innerJoin(fields, eq(fields.id, fieldOperations.fieldId))
    .innerJoin(
      costCenters,
      and(eq(costCenters.farmId, farmId), eq(costCenters.type, 'field'), eq(costCenters.refId, fields.id)),
    )
    .where(
      and(
        eq(fieldOperations.farmId, farmId),
        eq(fieldOperations.status, 'done'),
        gte(fieldOperations.date, from),
        lte(fieldOperations.date, to),
        isNotNull(fieldOperations.employeeId),
      ),
    );
  for (const row of fieldWork) mark(row.employeeId!, row.costCenterId, row.date);

  const herdCost = and(eq(costCenters.farmId, farmId), eq(costCenters.type, 'herd'));

  const herdLogs = await tx()
    .select({ employeeId: employees.id, date: dailyLogs.date, costCenterId: costCenters.id })
    .from(dailyLogs)
    .innerJoin(employees, and(eq(employees.userId, dailyLogs.createdBy), eq(employees.farmId, farmId)))
    .innerJoin(costCenters, and(herdCost, eq(costCenters.refId, dailyLogs.herdId)))
    .where(and(eq(dailyLogs.farmId, farmId), gte(dailyLogs.date, from), lte(dailyLogs.date, to)));
  for (const row of herdLogs) mark(row.employeeId, row.costCenterId, row.date);

  const treatments = await tx()
    .select({ employeeId: healthRecords.vetEmployeeId, date: healthRecords.date, costCenterId: costCenters.id })
    .from(healthRecords)
    .leftJoin(animals, eq(animals.id, healthRecords.animalId))
    .innerJoin(
      costCenters,
      and(herdCost, eq(costCenters.refId, sql`coalesce(${healthRecords.herdId}, ${animals.herdId})`)),
    )
    .where(
      and(
        eq(healthRecords.farmId, farmId),
        gte(healthRecords.date, from),
        lte(healthRecords.date, to),
        isNotNull(healthRecords.vetEmployeeId),
      ),
    );
  for (const row of treatments) mark(row.employeeId!, row.costCenterId, row.date);

  const result = new Map<string, Record<string, number>>();
  for (const [employeeId, perCenter] of days) {
    result.set(employeeId, Object.fromEntries([...perCenter].map(([id, dates]) => [id, dates.size])));
  }
  return result;
}

/** Cost center of a person's herd, for labour with no logged work. */
export async function herdCostCenterId(herdId: string): Promise<string | null> {
  const [row] = await tx()
    .select({ id: costCenters.id })
    .from(costCenters)
    .innerJoin(herds, and(eq(herds.id, costCenters.refId), eq(costCenters.type, 'herd')))
    .where(and(eq(herds.id, herdId), eq(costCenters.farmId, ctx().farmId)));
  return row?.id ?? null;
}
