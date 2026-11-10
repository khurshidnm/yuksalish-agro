import { and, eq } from 'drizzle-orm';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { recordEvent } from '../../core/journal';

const { alerts } = schema;

/**
 * Take an open alert: it stops repeating and carries the name of whoever took it. Whoever comes
 * second, from the app, the bot or by closing its task, finds it taken and gets nothing back.
 * The caller decides who may: this only writes.
 */
export async function takeAlert(id: string) {
  const c = ctx();
  const [row] = await tx()
    .update(alerts)
    .set({ status: 'acknowledged', acknowledgedBy: c.userId, acknowledgedAt: new Date(), nextNotifyAt: null })
    .where(and(eq(alerts.id, id), eq(alerts.farmId, c.farmId), eq(alerts.status, 'open')))
    .returning();
  if (row) await recordEvent({ type: 'alert.acknowledged', entityType: 'alert', entityId: id, data: { ruleKey: row.ruleKey } });
  return row;
}
