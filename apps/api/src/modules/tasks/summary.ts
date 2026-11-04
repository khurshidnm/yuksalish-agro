import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';

const { tasks } = schema;

/** Task counts for dashboards. Recurring series are not tasks; their daily instances are. */
export async function taskSummary(): Promise<{ open: number; overdue: number; doneToday: number }> {
  const c = ctx();
  const on = today();
  const [row] = await tx()
    .select({
      open: sql<number>`count(*) filter (where ${inArray(tasks.status, ['open', 'in_progress'])})`.mapWith(Number),
      overdue: sql<number>`count(*) filter (where ${and(inArray(tasks.status, ['open', 'in_progress']), lt(tasks.dueDate, on))})`.mapWith(Number),
      doneToday: sql<number>`count(*) filter (where ${tasks.status} = 'done'
        and (${tasks.completedAt} at time zone ${c.timezone})::date = ${on}::date)`.mapWith(Number),
    })
    .from(tasks)
    .where(and(eq(tasks.farmId, c.farmId), eq(tasks.recurrence, 'none'), ne(tasks.status, 'cancelled')));
  return row;
}
