import { and, count, eq, ne } from 'drizzle-orm';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';

const { employees, timesheets } = schema;

export { reminders } from './safety.service';

/** People at work today out of those on the staff (spec 14.1). */
export async function attendanceToday(): Promise<{ present: number; total: number }> {
  const { farmId } = ctx();
  const [{ total }] = await tx()
    .select({ total: count() })
    .from(employees)
    .where(and(eq(employees.farmId, farmId), ne(employees.status, 'terminated')));
  const [{ present }] = await tx()
    .select({ present: count() })
    .from(timesheets)
    .where(and(eq(timesheets.farmId, farmId), eq(timesheets.date, today()), eq(timesheets.status, 'present')));
  return { present, total };
}
