import { and, asc, eq, sql } from 'drizzle-orm';
import { EMPLOYEE_STATUSES, round } from '@yap/shared';
import { schema } from '../../../db/client';
import { ctx, tx } from '../../../core/context';
import { workDone } from '../../hr/workdone.service';
import { monthGrid } from '../../hr/timesheets.service';
import { herdSummary } from '../../livestock/summary';
import type { ReportDefinition } from '../types';
import { MONEY_PII, PII, col, filter } from './_helpers';

const { employees, fields, payrollLines, payrollRuns } = schema;

export const hrReports: ReportDefinition[] = [
  {
    key: 'hr.timesheet',
    module: 'hr',
    requires: ['hr.view'],
    filters: [filter.month('current')],
    columns: [
      col.text('employee', { sensitive: PII }),
      col.text('position'),
      col.int('present', { sum: true }),
      col.int('absent', { sum: true }),
      col.int('sick', { sum: true }),
      col.int('vacation', { sum: true }),
      col.int('dayOff', { sum: true }),
      col.num('hours', 2, { sum: true }),
      col.pct('attendancePercent'),
    ],
    async run({ month }) {
      const grid = await monthGrid(month);
      return {
        rows: grid.employees.map((e) => ({
          employee: e.fullName,
          position: e.position,
          ...e.totals,
          attendancePercent: e.attendancePercent === null ? null : round(e.attendancePercent, 1),
        })),
        totals: { ...grid.totals, attendancePercent: grid.totals.attendancePercent === null ? null : round(grid.totals.attendancePercent, 1) },
      };
    },
  },
  {
    key: 'hr.payroll',
    module: 'hr',
    money: true,
    requires: ['payroll.view'],
    filters: [filter.month('previous')],
    columns: [
      col.text('employee', { sensitive: PII }),
      col.text('position'),
      col.num('daysWorked', 2, { sum: true }),
      col.money('base', { sum: true, sensitive: MONEY_PII }),
      col.money('piecework', { sum: true, sensitive: MONEY_PII }),
      col.money('bonus', { sum: true, sensitive: MONEY_PII }),
      col.money('advance', { sum: true, sensitive: MONEY_PII }),
      col.money('deductions', { sum: true, sensitive: MONEY_PII }),
      col.money('net', { sum: true, sensitive: MONEY_PII }),
      col.enum('status', 'payrollStatus'),
    ],
    async run({ month }) {
      const rows = await tx()
        .select({
          employee: employees.fullName,
          position: employees.position,
          daysWorked: payrollLines.daysWorked,
          base: payrollLines.base,
          piecework: payrollLines.piecework,
          bonus: payrollLines.bonus,
          advance: payrollLines.advance,
          deductions: payrollLines.deductions,
          net: payrollLines.net,
          status: payrollRuns.status,
        })
        .from(payrollLines)
        .innerJoin(payrollRuns, eq(payrollRuns.id, payrollLines.runId))
        .innerJoin(employees, eq(employees.id, payrollLines.employeeId))
        .where(and(eq(payrollRuns.farmId, ctx().farmId), eq(payrollRuns.month, month)))
        .orderBy(asc(employees.fullName));
      return { rows };
    },
  },
  {
    key: 'hr.work_done',
    module: 'hr',
    requires: ['hr.view'],
    filters: [filter.period('this_month')],
    columns: [
      col.text('employee', { sensitive: PII }),
      col.text('position'),
      col.num('hectares', 2, { sum: true }),
      col.num('tons', 3, { sum: true }),
      col.int('headTreated', { sum: true }),
      col.int('headDays', { sum: true }),
      col.int('operations', { sum: true }),
      col.int('treatments', { sum: true }),
      col.int('dailyLogs', { sum: true }),
      col.int('tasksOnTime', { sum: true }),
      col.int('tasksDue', { sum: true }),
      col.pct('tasksOnTimePercent'),
    ],
    async run({ from, to }) {
      const rows = await workDone(from, to);
      return { rows: rows.map((r) => ({ ...r, employee: r.fullName })) };
    },
  },
  {
    key: 'hr.staff',
    module: 'hr',
    requires: ['hr.view'],
    filters: [filter.select('status', EMPLOYEE_STATUSES, 'employeeStatus')],
    columns: [
      col.text('employee', { sensitive: PII }),
      col.text('position'),
      col.enum('division', 'reports:division'),
      col.text('phone', { sensitive: PII }),
      col.date('hireDate'),
      col.enum('status', 'employeeStatus'),
      col.enum('payType', 'payType'),
      col.money('baseRate', { sensitive: MONEY_PII }),
    ],
    async run({ status }) {
      const rows = await tx()
        .select({
          employee: employees.fullName,
          position: employees.position,
          division: employees.division,
          phone: employees.phone,
          hireDate: employees.hireDate,
          status: employees.status,
          payType: employees.payType,
          baseRate: employees.baseRate,
        })
        .from(employees)
        .where(and(eq(employees.farmId, ctx().farmId), status ? eq(employees.status, status) : undefined))
        .orderBy(asc(employees.position), asc(employees.fullName));
      return { rows };
    },
  },
  {
    key: 'hr.productivity',
    module: 'hr',
    filters: [],
    columns: [col.enum('indicator', 'reports:kpi'), col.num('value', 2), col.enum('unit', 'reports:kpiUnit')],
    async run() {
      const farm = ctx().farmId;
      const [staff] = await tx()
        .select({ total: sql<number>`count(*)`.mapWith(Number) })
        .from(employees)
        .where(and(eq(employees.farmId, farm), eq(employees.status, 'active')));
      const [land] = await tx()
        .select({ ha: sql<number>`coalesce(sum(${fields.areaHa}), 0)`.mapWith(Number) })
        .from(fields)
        .where(and(eq(fields.farmId, farm), eq(fields.landUse, 'arable'), eq(fields.status, 'active')));
      const { total: head } = await herdSummary();
      const per = (value: number) => (staff.total > 0 ? round(value / staff.total, 2) : null);
      return {
        rows: [
          { indicator: 'staff', value: staff.total, unit: 'people' },
          { indicator: 'head_per_employee', value: per(head), unit: 'head' },
          { indicator: 'ha_per_employee', value: per(land.ha), unit: 'ha' },
        ],
      };
    },
  },
];
