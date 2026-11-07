import { and, eq, inArray } from 'drizzle-orm';
import { ctx, tx, withTenant } from '../../core/context';
import { schema } from '../../db/client';
import type { ScheduledJob } from '../../jobs/types';
import { enabledPermissions } from '../../core/http';
import { checkReach } from '../alerts/reach';
import { digestFacts, digestScope, renderDigest } from './digest';
import { forgetAnswered } from './notifications.service';
import { dispatchPending, notifyUser } from './notify.service';

const { memberships, roles, tenants } = schema;

/** Owner and director, each getting cash only if their role may see it. */
export async function sendDailySummary(): Promise<number> {
  const members = await tx()
    .select({ userId: memberships.userId, permissions: roles.permissions, modules: tenants.modules })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(
      and(
        eq(memberships.farmId, ctx().farmId),
        eq(memberships.status, 'active'),
        inArray(roles.key, ['owner', 'director']),
      ),
    );
  for (const member of members) {
    const facts = await digestFacts(digestScope(enabledPermissions(member.permissions, member.modules)));
    await notifyUser(
      member.userId,
      {
        eventType: 'daily_summary',
        severity: 'info',
        title: (locale) => renderDigest(facts, locale).title,
        body: (locale) => renderDigest(facts, locale).body,
        link: '/',
      },
      { permission: facts.cash === null ? undefined : 'finance.view' },
    );
  }
  return members.length;
}

export const jobs: ScheduledJob[] = [
  {
    name: 'notifications.dispatch',
    cron: '* * * * *',
    // Two transactions: what was sent stays recorded even if looking at what was not then fails.
    runDetached: async (farm) => {
      await withTenant(farm, () => dispatchPending());
      await withTenant(farm, () => checkReach());
    },
  },
  {
    name: 'notifications.daily-summary',
    cron: '0 7 * * *',
    run: async () => {
      await sendDailySummary();
    },
  },
  {
    name: 'notifications.forget-answered',
    cron: '30 3 * * *',
    run: forgetAnswered,
  },
];
