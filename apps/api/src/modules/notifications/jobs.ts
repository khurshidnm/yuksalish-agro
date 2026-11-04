import { and, eq, inArray } from 'drizzle-orm';
import { ctx, tx } from '../../core/context';
import { schema } from '../../db/client';
import type { FarmJob } from '../../jobs/types';
import { digestFacts, renderDigest } from './digest';
import { dispatchPending, notifyUser } from './notify.service';

const { memberships, roles } = schema;

/** Owner and director, each getting cash only if their role may see it. */
export async function sendDailySummary(): Promise<number> {
  const members = await tx()
    .select({ userId: memberships.userId, permissions: roles.permissions })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(
      and(
        eq(memberships.farmId, ctx().farmId),
        eq(memberships.status, 'active'),
        inArray(roles.key, ['owner', 'director']),
      ),
    );
  for (const member of members) {
    const facts = await digestFacts(member.permissions.includes('finance.view'));
    await notifyUser(member.userId, {
      eventType: 'daily_summary',
      severity: 'info',
      title: (locale) => renderDigest(facts, locale).title,
      body: (locale) => renderDigest(facts, locale).body,
      link: '/',
    });
  }
  return members.length;
}

export const jobs: FarmJob[] = [
  {
    name: 'notifications.dispatch',
    cron: '* * * * *',
    run: async () => {
      await dispatchPending();
    },
  },
  {
    name: 'notifications.daily-summary',
    cron: '0 7 * * *',
    run: async () => {
      await sendDailySummary();
    },
  },
];
