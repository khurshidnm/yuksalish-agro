import { and, asc, desc, eq, gte, isNotNull, lte, max, ne } from 'drizzle-orm';
import { z } from 'zod';
import { addDays, diffDays } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate } from '../../core/query';
import { getRow } from './employees.service';

const { employees, safetyInstructions: t, timesheets } = schema;

export const safetyInput = z.object({
  id: clientId,
  employeeId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  signedOn: isoDate.nullish(),
  validUntil: isoDate.nullish(),
});
export const safetyPatch = safetyInput.omit({ id: true, employeeId: true }).partial();
export const safetyQuery = z.object({ employeeId: z.uuid().optional() });

export function listSafety(employeeId?: string) {
  return tx()
    .select({
      id: t.id,
      employeeId: t.employeeId,
      fullName: employees.fullName,
      title: t.title,
      signedOn: t.signedOn,
      validUntil: t.validUntil,
    })
    .from(t)
    .innerJoin(employees, eq(employees.id, t.employeeId))
    .where(and(eq(t.farmId, ctx().farmId), employeeId ? eq(t.employeeId, employeeId) : undefined))
    .orderBy(desc(t.signedOn), asc(employees.fullName))
    .limit(500);
}

function assertDates(signedOn: string | null | undefined, validUntil: string | null | undefined): void {
  if (signedOn && validUntil && validUntil < signedOn) {
    throw badRequest('INVALID_RANGE', 'The end date is before the start date');
  }
}

export async function createSafety(input: z.infer<typeof safetyInput>) {
  const c = ctx();
  await getRow(input.employeeId);
  assertDates(input.signedOn, input.validUntil);
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({
    type: 'employee.safety_signed',
    entityType: 'employee',
    entityId: input.employeeId,
    occurredAt: input.signedOn ?? undefined,
    data: { title: input.title },
  });
  return row;
}

export async function updateSafety(id: string, input: z.infer<typeof safetyPatch>) {
  assertDates(input.signedOn, input.validUntil);
  const [row] = await tx()
    .update(t)
    .set(input)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)))
    .returning();
  if (!row) throw notFound('Safety instruction');
  return row;
}

export async function deleteSafety(id: string) {
  const [row] = await tx()
    .delete(t)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)))
    .returning({ id: t.id });
  if (!row) throw notFound('Safety instruction');
  return { id };
}

export type ReminderType = 'contract_end' | 'medical_check' | 'vacation_due' | 'safety_expiry';

export interface Reminder {
  type: ReminderType;
  employeeId: string;
  fullName: string;
  date: string;
  /** Negative when overdue. */
  daysLeft: number;
  detail?: string;
}

/** A person is due annual leave after 11 months without any. */
const VACATION_AFTER_DAYS = 335;

/** Everything HR must act on soon (spec 11.8, 11.9), overdue items included. Soonest first. */
export async function reminders(days: number): Promise<Reminder[]> {
  const { farmId } = ctx();
  const now = today();
  const horizon = addDays(now, days);
  const active = and(eq(employees.farmId, farmId), ne(employees.status, 'terminated'));
  const items: Reminder[] = [];
  const push = (type: ReminderType, row: { id: string; fullName: string }, date: string, detail?: string) =>
    items.push({ type, employeeId: row.id, fullName: row.fullName, date, daysLeft: diffDays(now, date), detail });

  const contracts = await tx()
    .select({ id: employees.id, fullName: employees.fullName, date: employees.contractEndDate })
    .from(employees)
    .where(and(active, isNotNull(employees.contractEndDate), lte(employees.contractEndDate, horizon)));
  for (const row of contracts) push('contract_end', row, row.date!);

  const medical = await tx()
    .select({ id: employees.id, fullName: employees.fullName, date: employees.medicalCheckDate })
    .from(employees)
    .where(and(active, isNotNull(employees.medicalCheckDate), lte(employees.medicalCheckDate, horizon)));
  for (const row of medical) push('medical_check', row, row.date!);

  const safety = await tx()
    .select({ id: employees.id, fullName: employees.fullName, date: t.validUntil, title: t.title })
    .from(t)
    .innerJoin(employees, eq(employees.id, t.employeeId))
    .where(and(active, isNotNull(t.validUntil), lte(t.validUntil, horizon)));
  for (const row of safety) push('safety_expiry', row, row.date!, row.title);

  const leave = await tx()
    .select({ id: employees.id, fullName: employees.fullName, hireDate: employees.hireDate, lastLeave: max(timesheets.date) })
    .from(employees)
    .leftJoin(
      timesheets,
      and(
        eq(timesheets.employeeId, employees.id),
        eq(timesheets.status, 'vacation'),
        gte(timesheets.date, addDays(now, -VACATION_AFTER_DAYS - days)),
      ),
    )
    .where(active)
    .groupBy(employees.id, employees.fullName, employees.hireDate);
  for (const row of leave) {
    const due = addDays(row.lastLeave ?? row.hireDate, VACATION_AFTER_DAYS);
    if (due <= horizon) push('vacation_due', row, due);
  }

  return items.sort((a, b) => a.date.localeCompare(b.date));
}
