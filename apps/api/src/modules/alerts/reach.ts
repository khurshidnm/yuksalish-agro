/**
 * An urgent alert must reach a person. Telegram is the only channel outside the app, so when it cannot
 * get through to the people responsible, the next role hears, and the owner sees a standing warning in
 * the app. Runs after each dispatch, once per farm.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { RoleKey } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { noteUndelivered, telegramLost } from '../../core/health';
import { recordEvent } from '../../core/journal';
import { hidePii } from '../../core/privacy';
import { CHANNELS } from '../notifications/channels';
import { tr } from '../notifications/i18n';
import { DEFAULT_CHANNELS, dispatchPending, notifyRole } from '../notifications/notify.service';
import { escalateAlert, raiseAlert, resolveByDedupKey } from './alerts.service';

const { alerts, memberships, notificationPrefs, notifications, roles, users } = schema;

type Alert = typeof alerts.$inferSelect;

/** Who hears an urgent alert when nobody it was meant for can be reached, in this order. */
const ESCALATION_ORDER: RoleKey[] = ['director', 'owner', 'zootechnician', 'veterinarian', 'agronomist', 'storekeeper', 'mechanic', 'shepherd', 'accountant'];

/** Sends that keep failing get this long, roughly two attempts, before the next role hears. */
export const ESCALATE_AFTER_MS = 3 * 60_000;

/** An alert stuck for this long means the channel is failing, and the owner should know. */
const WARN_AFTER_MS = 5 * 60_000;

export const UNREACHABLE_RULE = 'urgent_unreachable';

interface LinkedPerson {
  role: string;
  permissions: string[];
}

/** People on this farm who would hear an urgent alert outside the app: linked, and they have not turned it off. */
async function linkedPeople(): Promise<LinkedPerson[]> {
  const c = ctx();
  const rows = await tx()
    .select({ role: roles.key, permissions: roles.permissions, channels: notificationPrefs.channels })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(
      notificationPrefs,
      and(eq(notificationPrefs.userId, users.id), eq(notificationPrefs.tenantId, c.tenantId), eq(notificationPrefs.eventType, 'alert_urgent')),
    )
    .where(and(eq(memberships.farmId, c.farmId), eq(memberships.status, 'active'), eq(users.status, 'active'), isNotNull(users.telegramChatId)));
  return rows.filter((row) => (row.channels ?? DEFAULT_CHANNELS.alert_urgent).includes('telegram'));
}

const mayHear = (person: LinkedPerson, alert: Alert) => !alert.permission || person.permissions.includes(alert.permission);

/** Alerts with a message on its way that has not had its chance yet. */
async function stillTrying(alertIds: string[], now: Date): Promise<Set<string | null>> {
  const rows = await tx()
    .select({ alertId: notifications.alertId })
    .from(notifications)
    .where(
      and(
        eq(notifications.tenantId, ctx().tenantId),
        gt(notifications.createdAt, new Date(now.getTime() - ESCALATE_AFTER_MS)),
        inArray(notifications.alertId, alertIds),
        sql`${notifications.deliveries} ->> 'telegram' = 'pending'`,
      ),
    );
  return new Set(rows.map((row) => row.alertId));
}

async function escalate(undelivered: Alert[], people: LinkedPerson[], now: Date): Promise<void> {
  if (undelivered.length === 0) return;
  const trying = await stillTrying(undelivered.map((alert) => alert.id), now);
  for (const alert of undelivered) {
    if (trying.has(alert.id)) continue;
    const role = ESCALATION_ORDER.find(
      (key) => !alert.notifyRoles.includes(key) && people.some((person) => person.role === key && mayHear(person, alert)),
    );
    if (role) await escalateAlert(alert, role);
  }
}

type Reason = 'not_configured' | 'channel_down' | 'not_linked' | 'undelivered';

/** One standing warning per farm, on the dashboard until the cause is gone. Written only when it changes. */
async function warnOwner(reason: Reason | null): Promise<void> {
  const [open] = await tx()
    .select({ data: alerts.data })
    .from(alerts)
    .where(and(eq(alerts.farmId, ctx().farmId), eq(alerts.dedupKey, UNREACHABLE_RULE), ne(alerts.status, 'resolved')));
  if (!reason) {
    if (open) await resolveByDedupKey(UNREACHABLE_RULE);
    return;
  }
  const textKey = `${UNREACHABLE_RULE}_${reason}`;
  if (open?.data.textKey === textKey) return;
  await raiseAlert({
    ruleKey: UNREACHABLE_RULE,
    dedupKey: UNREACHABLE_RULE,
    severity: 'urgent',
    title: 'Urgent alerts reach nobody outside the app',
    link: '/notifications',
    data: { textKey },
    notify: ['owner'],
    inAppOnly: true,
  });
}

export async function checkReach(now = new Date()): Promise<void> {
  const c = ctx();
  const undelivered = await tx()
    .select()
    .from(alerts)
    .where(and(eq(alerts.farmId, c.farmId), eq(alerts.status, 'open'), eq(alerts.severity, 'urgent'), isNotNull(alerts.undeliveredSince)))
    .orderBy(asc(alerts.undeliveredSince));
  const people = await linkedPeople();
  const configured = CHANNELS.telegram.configured();

  if (configured) await escalate(undelivered, people, now);

  const leaders = people.filter((person) => person.role === 'owner' || person.role === 'director');
  const stuck = undelivered.some((alert) => now.getTime() - alert.undeliveredSince!.getTime() >= WARN_AFTER_MS);
  await warnOwner(!configured ? 'not_configured' : telegramLost(now) ? 'channel_down' : leaders.length === 0 ? 'not_linked' : stuck ? 'undelivered' : null);

  // A farm that has linked nobody is a warning for its owner. It says nothing about the server.
  const staff = people.filter((person) => ESCALATION_ORDER.includes(person.role as RoleKey));
  const reachable = configured ? undelivered.find((alert) => staff.some((person) => mayHear(person, alert))) : undefined;
  noteUndelivered(c.farmId, reachable?.undeliveredSince ?? null);
}

type Miss = 'not_linked' | 'turned_off' | 'failed' | 'not_configured';

const missOf = (telegram: string | undefined): Miss =>
  telegram === undefined ? 'turned_off' : telegram === 'not_linked' || telegram === 'not_configured' ? telegram : 'failed';

/**
 * One labelled message to everyone an urgent alert can go to, down the road a real one takes: their
 * own settings, the outbox, Telegram. It is not an alert, so nothing repeats and nobody can take it.
 * All in one transaction: the dispatch job cannot see these rows, so the answer here is the whole story.
 */
export async function sendTestAlert() {
  const c = ctx();
  await notifyRole(ESCALATION_ORDER, {
    severity: 'urgent',
    title: (locale) => tr(locale, 'alerts', 'testAlert.message.title'),
    body: (locale) => tr(locale, 'alerts', 'testAlert.message.body'),
  });
  await dispatchPending();

  const rows = await tx()
    .select({ userId: users.id, name: users.fullName, role: roles.key, deliveries: notifications.deliveries })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.farmId, c.farmId)))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    // now() stands still inside a transaction, so this is exactly what was written above.
    .where(and(eq(notifications.farmId, c.farmId), eq(notifications.eventType, 'alert_urgent'), isNull(notifications.alertId), sql`${notifications.createdAt} = now()`));

  const people = hidePii(rows, ['name']).map(({ deliveries, ...person }) => ({ person, telegram: deliveries.telegram }));
  const reached = people.filter(({ telegram }) => telegram === 'sent').map(({ person }) => person);
  const unreachable = people.filter(({ telegram }) => telegram !== 'sent').map(({ person, telegram }) => ({ ...person, reason: missOf(telegram) }));
  await recordEvent({ type: 'alert.test_sent', entityType: 'alert', data: { reached: reached.length, unreachable: unreachable.length } });
  return { reached, unreachable };
}
