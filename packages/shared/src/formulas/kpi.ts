/** KPI formulas of spec 14.3 that are not already in index.ts. Null means "not enough data". */
import { DEFAULT_TIMEZONE, todayIso } from '../dates';

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/** Operatsion xarajat / daromad: below 1 means operations pay for themselves. */
export function operatingRatio(operatingExpense: number, income: number): number | null {
  return ratio(operatingExpense, income);
}

/** 1 bosh sovliqqa foyda. Null before any income: a season without sales has no profit yet. */
export function profitPerHead(income: number, cost: number, head: number): number | null {
  if (income <= 0) return null;
  return ratio(income - cost, head);
}

/** Mehnat unumdorligi: head or hectares per employee. */
export function perEmployee(volume: number, employees: number): number | null {
  if (volume <= 0) return null;
  return ratio(volume, employees);
}

/**
 * Tabel intizomi: share of due days actually worked. Sick days, vacation and days off were not
 * due, so they count on neither side.
 */
export function attendancePercent(presentDays: number, absentDays: number): number | null {
  const r = ratio(presentDays, presentDays + absentDays);
  return r === null ? null : r * 100;
}

export const MACHINE_HOURS_PER_DAY = 8;

/** Texnika yuklanishi: motor-hours worked against a working day for every machine. */
export function machineryUtilizationPercent(
  usedHours: number,
  machines: number,
  days: number,
  hoursPerDay = MACHINE_HOURS_PER_DAY,
): number | null {
  const r = ratio(usedHours, machines * days * hoursPerDay);
  return r === null ? null : r * 100;
}

/** Ozuqa yo'qotishlari: value written off at stock counts against value fed plus written off. */
export function feedLossPercent(writtenOff: number, issued: number): number | null {
  const r = ratio(writtenOff, issued + writtenOff);
  return r === null ? null : r * 100;
}

/** 1 bosh kunlik ozuqa xarajati. */
export function feedCostPerHeadDay(costPerDay: number, head: number): number | null {
  return ratio(costPerDay, head);
}

/** One task assigned to the person being measured. */
export interface AssignedTask {
  /** Business date the task is due. A task without one cannot be late and is left out. */
  dueDate: string | null;
  /** TASK_STATUSES */
  status: string;
  completedAt: Date | string | null;
  /** The assignee closed it. A manager closing it for them does not make it theirs. */
  completedByAssignee: boolean;
  /** TASK_COMPLETION_SOURCES. 'alert_resolved' means nobody did it: the problem went away. */
  completionSource: string | null;
}

export interface TasksOnTime {
  /** Closed by the person on or before the due date. */
  onTime: number;
  /** Tasks that fell due in the period and are decided: closed, or still open past the due date. */
  due: number;
  /** onTime / due x 100, one decimal. Null when nothing fell due. */
  percent: number | null;
}

/**
 * Vazifalarni o'z vaqtida bajarish: tasks a person closed themselves on or before the due date, out of
 * the tasks assigned to them that fell due in the period.
 *
 * Counted as due: closed tasks (on time or late, whoever closed them) and tasks still open after their
 * due date. Left out: cancelled tasks, tasks with no due date, tasks closed by the system because the
 * alert behind them resolved, and open tasks whose due date has not passed, which are not late yet.
 *
 * `completedAt` is a moment and `dueDate` a farm date, so the moment is read on the farm's clock:
 * 23:30 in Tashkent on the due date is on time, although it is already 18:30 UTC.
 */
export function tasksOnTime(
  tasks: AssignedTask[],
  period: { from: string; to: string },
  today: string,
  timeZone: string = DEFAULT_TIMEZONE,
): TasksOnTime {
  let onTime = 0;
  let due = 0;
  for (const task of tasks) {
    if (!task.dueDate || task.dueDate < period.from || task.dueDate > period.to) continue;
    if (task.status === 'cancelled' || task.completionSource === 'alert_resolved') continue;
    if (task.status !== 'done') {
      if (task.dueDate < today) due++;
      continue;
    }
    due++;
    if (!task.completedAt || !task.completedByAssignee) continue;
    const completedOn = todayIso(timeZone, new Date(task.completedAt));
    if (completedOn <= task.dueDate) onTime++;
  }
  return { onTime, due, percent: due > 0 ? Math.round((onTime / due) * 1000) / 10 : null };
}
