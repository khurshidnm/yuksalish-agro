import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PII_VIEW, TIMESHEET_STATUSES, addDays, diffDays, monthOf, monthRange } from '@yap/shared';
import { attendancePercent, hoursBetween } from '@yap/shared/formulas/payroll';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { isoDate, isoMonth, searchAny } from '../../core/query';
import { employedDuring, findSelf, getRow, type Employee } from './employees.service';

const { employees, payrollRuns, timesheets: t } = schema;

const hours = z.number().min(0).max(24);

export const dayInput = z.object({
  status: z.enum(TIMESHEET_STATUSES),
  hours: hours.nullish(),
  notes: z.string().trim().max(300).nullish(),
});

export const bulkInput = z.object({
  from: isoDate,
  to: isoDate,
  /** Everyone when omitted. */
  employeeIds: z.array(z.uuid()).max(500).optional(),
  status: z.enum(TIMESHEET_STATUSES),
  hours: hours.nullish(),
  /** Mark Sundays as days off instead of `status`. */
  sundaysOff: z.boolean().optional(),
  /** Replace days already filled in. Otherwise they stay as they are. */
  overwrite: z.boolean().optional(),
});

export const gridQuery = z.object({ month: isoMonth, search: z.string().trim().optional() });
export const dayParams = z.object({ employeeId: z.uuid(), date: isoDate });
export const locationInput = z.object({
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
});

const MAX_BULK_DAYS = 62;

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  return dates;
}

const isSunday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() === 0;

/** An approved payroll rests on the timesheet, so the month is frozen once approved. */
async function assertMonthsOpen(months: string[]): Promise<void> {
  const [closed] = await tx()
    .select({ month: payrollRuns.month })
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.farmId, ctx().farmId),
        inArray(payrollRuns.month, months),
        inArray(payrollRuns.status, ['approved', 'paid']),
      ),
    );
  if (closed) {
    throw conflict('PAYROLL_CLOSED', `Payroll for ${closed.month} is approved, so its timesheet is closed`, {
      month: closed.month,
    });
  }
}

function assertEmployedOn(employee: Employee, date: string): void {
  if (date < employee.hireDate || (employee.terminationDate && date > employee.terminationDate)) {
    throw badRequest('OUTSIDE_EMPLOYMENT', 'This date is outside the employment period');
  }
}

interface Totals {
  present: number;
  absent: number;
  sick: number;
  vacation: number;
  dayOff: number;
  hours: number;
}

const emptyTotals = (): Totals => ({ present: 0, absent: 0, sick: 0, vacation: 0, dayOff: 0, hours: 0 });

function addToTotals(totals: Totals, status: string, rowHours: number | null): void {
  if (status === 'present') totals.present += 1;
  else if (status === 'absent') totals.absent += 1;
  else if (status === 'sick') totals.sick += 1;
  else if (status === 'vacation') totals.vacation += 1;
  else if (status === 'day_off') totals.dayOff += 1;
  totals.hours += rowHours ?? 0;
}

/** Month grid for everyone employed in the month (spec 11.3). */
export async function monthGrid(month: string, search?: string) {
  const { farmId } = ctx();
  const { from, to } = monthRange(month);
  const staff = await tx()
    .select({
      id: employees.id,
      fullName: employees.fullName,
      position: employees.position,
      division: employees.division,
      status: employees.status,
      hireDate: employees.hireDate,
      terminationDate: employees.terminationDate,
    })
    .from(employees)
    .where(and(eq(employees.farmId, farmId), employedDuring(from, to), searchAny(search, [employees.fullName, employees.position])))
    .orderBy(asc(employees.position), asc(employees.fullName));

  const rows = await tx()
    .select()
    .from(t)
    .where(and(eq(t.farmId, farmId), gte(t.date, from), lte(t.date, to)));

  const byEmployee = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byEmployee.get(row.employeeId) ?? [];
    list.push(row);
    byEmployee.set(row.employeeId, list);
  }

  // Where someone was is personal data (CLAUDE.md rule 8).
  const canSeeLocation = hasPermission(PII_VIEW);
  const farmTotals = emptyTotals();
  const people = staff.map((person) => {
    const totals = emptyTotals();
    const days: Record<string, unknown> = {};
    for (const row of byEmployee.get(person.id) ?? []) {
      days[row.date] = {
        id: row.id,
        status: row.status,
        hours: row.hours,
        checkIn: row.checkIn,
        checkOut: row.checkOut,
        lat: canSeeLocation ? row.lat : null,
        lng: canSeeLocation ? row.lng : null,
        notes: row.notes,
      };
      addToTotals(totals, row.status, row.hours);
      addToTotals(farmTotals, row.status, row.hours);
    }
    return { ...person, days, totals, attendancePercent: attendancePercent(totals.present, totals.absent) };
  });

  const [run] = await tx()
    .select({ status: payrollRuns.status })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.farmId, farmId), eq(payrollRuns.month, month)));

  return {
    month,
    days: datesBetween(from, to),
    employees: people,
    totals: { ...farmTotals, attendancePercent: attendancePercent(farmTotals.present, farmTotals.absent) },
    closed: run?.status === 'approved' || run?.status === 'paid',
  };
}

export async function setDay(employeeId: string, date: string, input: z.infer<typeof dayInput>) {
  const c = ctx();
  const employee = await getRow(employeeId);
  assertEmployedOn(employee, date);
  await assertMonthsOpen([monthOf(date)]);
  if (input.status === 'present' && date > today()) {
    throw badRequest('FUTURE_ATTENDANCE', 'Attendance cannot be marked for a future date');
  }
  const values = {
    status: input.status,
    hours: input.status === 'present' ? (input.hours ?? null) : null,
    notes: input.notes ?? null,
  };
  const [row] = await tx()
    .insert(t)
    .values({ ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId, employeeId, date })
    .onConflictDoUpdate({ target: [t.employeeId, t.date], set: values })
    .returning();
  await recordEvent({
    type: 'timesheet.updated',
    entityType: 'employee',
    entityId: employeeId,
    occurredAt: date,
    data: { status: input.status },
  });
  return row;
}

export async function clearDay(employeeId: string, date: string) {
  await getRow(employeeId);
  await assertMonthsOpen([monthOf(date)]);
  await tx()
    .delete(t)
    .where(and(eq(t.employeeId, employeeId), eq(t.date, date), eq(t.farmId, ctx().farmId)));
  return { employeeId, date };
}

/** Fill a range for many people at once, so the common case takes one action. */
export async function bulkFill(input: z.infer<typeof bulkInput>) {
  const c = ctx();
  if (input.to < input.from) throw badRequest('INVALID_RANGE', 'The end date is before the start date');
  if (diffDays(input.from, input.to) >= MAX_BULK_DAYS) {
    throw badRequest('RANGE_TOO_LONG', `Fill at most ${MAX_BULK_DAYS} days at a time`);
  }
  const months = [...new Set(datesBetween(input.from, input.to).map(monthOf))];
  await assertMonthsOpen(months);

  const staff = await tx()
    .select()
    .from(employees)
    .where(
      and(
        eq(employees.farmId, c.farmId),
        employedDuring(input.from, input.to),
        input.employeeIds ? inArray(employees.id, input.employeeIds) : undefined,
      ),
    );

  const now = today();
  const values: (typeof t.$inferInsert)[] = [];
  for (const person of staff) {
    for (const date of datesBetween(input.from, input.to)) {
      if (date < person.hireDate || (person.terminationDate && date > person.terminationDate)) continue;
      const status = input.sundaysOff && isSunday(date) ? 'day_off' : input.status;
      // Presence is a fact, so a range reaching past today stops at today.
      if (status === 'present' && date > now) continue;
      values.push({
        tenantId: c.tenantId,
        farmId: c.farmId,
        createdBy: c.userId,
        employeeId: person.id,
        date,
        status,
        hours: status === 'present' ? (input.hours ?? null) : null,
      });
    }
  }
  if (values.length === 0) return { written: 0 };

  const insert = tx().insert(t).values(values);
  const written = input.overwrite
    ? await insert
        .onConflictDoUpdate({
          target: [t.employeeId, t.date],
          set: { status: sql`excluded.status`, hours: sql`excluded.hours` },
        })
        .returning({ id: t.id })
    : await insert.onConflictDoNothing().returning({ id: t.id });

  await recordEvent({
    type: 'timesheet.bulk_filled',
    entityType: 'timesheet',
    data: { from: input.from, to: input.to, status: input.status, written: written.length },
  });
  return { written: written.length };
}

async function requireSelf(): Promise<Employee> {
  const self = await findSelf();
  if (!self) throw notFound('Employee record');
  if (self.status === 'terminated') throw conflict('EMPLOYEE_TERMINATED', 'This person has left');
  return self;
}

/** A shift still open: checked in today, or yesterday for someone working through the night. */
async function findOpenShift(employeeId: string) {
  const date = today();
  const [row] = await tx()
    .select()
    .from(t)
    .where(
      and(
        eq(t.employeeId, employeeId),
        inArray(t.date, [date, addDays(date, -1)]),
        isNotNull(t.checkIn),
        isNull(t.checkOut),
      ),
    )
    .orderBy(desc(t.date))
    .limit(1);
  return row;
}

async function todayRow(employeeId: string) {
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.employeeId, employeeId), eq(t.date, today())));
  return row;
}

/** Self check-in with the phone's location (spec 11.3). A repeated tap changes nothing. */
export async function checkIn(input: z.infer<typeof locationInput>) {
  const c = ctx();
  const self = await requireSelf();
  const date = today();
  const existing = await todayRow(self.id);
  if (existing?.checkIn) return existing;

  const values = { status: 'present', checkIn: new Date(), lat: input.lat ?? null, lng: input.lng ?? null };
  const [row] = await tx()
    .insert(t)
    .values({ ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId, employeeId: self.id, date })
    .onConflictDoUpdate({ target: [t.employeeId, t.date], set: values })
    .returning();
  await recordEvent({
    type: 'timesheet.checked_in',
    entityType: 'employee',
    entityId: self.id,
    data: { lat: values.lat, lng: values.lng },
  });
  return row;
}

export async function checkOut(input: z.infer<typeof locationInput>) {
  const self = await requireSelf();
  const open = await findOpenShift(self.id);
  // Leaving later than a first check-out keeps the latest time.
  const row = open ?? (await todayRow(self.id));
  if (!row?.checkIn) throw conflict('NOT_CHECKED_IN', 'Check in first');

  const checkOutAt = new Date();
  const [updated] = await tx()
    .update(t)
    .set({
      checkOut: checkOutAt,
      hours: hoursBetween(row.checkIn, checkOutAt),
      checkOutLat: input.lat ?? null,
      checkOutLng: input.lng ?? null,
    })
    .where(eq(t.id, row.id))
    .returning();
  await recordEvent({
    type: 'timesheet.checked_out',
    entityType: 'employee',
    entityId: self.id,
    data: { hours: updated.hours },
  });
  return updated;
}

/** What the check-in card shows. Contains no pay data, so any signed-in user may read it. */
export async function myDay() {
  const self = await findSelf();
  if (!self) return { employee: null, today: null, openShift: null };
  return {
    employee: { id: self.id, fullName: self.fullName, position: self.position },
    today: (await todayRow(self.id)) ?? null,
    openShift: (await findOpenShift(self.id)) ?? null,
  };
}
