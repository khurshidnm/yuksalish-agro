/**
 * Notifications are written to the database inside the caller's transaction, and external
 * delivery happens afterwards in dispatchPending(). A rolled-back action therefore never sends a
 * message, and a Telegram outage never fails a business action.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Permission, RoleKey, Severity } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { recordEvent } from '../../core/journal';
import { CHANNELS, EXTERNAL_CHANNELS, PermanentDeliveryError, type ExternalChannel, type Recipient } from './channels';

const { memberships, notificationPrefs, notifications, roles, users } = schema;

export const EVENT_TYPES = ['alert_urgent', 'alert_attention', 'alert_info', 'task_assigned', 'daily_summary'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** External channels when the user has not chosen. In-app is always on (spec 17.3). */
export const DEFAULT_CHANNELS: Record<EventType, ExternalChannel[]> = {
  alert_urgent: ['telegram'],
  alert_attention: ['telegram'],
  alert_info: [],
  task_assigned: [],
  daily_summary: ['telegram'],
};

/** Plain text, or a function rendering it in the recipient's language. */
export type Text = string | ((locale: string) => string);

export interface NotificationInput {
  severity?: Severity;
  title: Text;
  body?: Text;
  link?: string;
  alertId?: string;
  eventType?: EventType;
}

export interface NotifyOptions {
  /** Skip recipients whose role lacks this permission, e.g. 'finance.view' for text with money. */
  permission?: Permission;
  /** Do not write these users twice, e.g. the person who just acted. */
  exclude?: string[];
}

const render = (text: Text | undefined, locale: string) => (typeof text === 'function' ? text(locale) : text);

const eventTypeFor = (n: NotificationInput): EventType =>
  n.eventType ?? (n.severity === 'urgent' ? 'alert_urgent' : n.severity === 'attention' ? 'alert_attention' : 'alert_info');

async function deliver(userIds: string[], n: NotificationInput): Promise<void> {
  const c = ctx();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  const eventType = eventTypeFor(n);

  const recipients = await tx()
    .select({ id: users.id, locale: users.locale })
    .from(users)
    .where(and(inArray(users.id, unique), eq(users.status, 'active')));
  if (recipients.length === 0) return;

  const prefs = await tx()
    .select({ userId: notificationPrefs.userId, channels: notificationPrefs.channels })
    .from(notificationPrefs)
    .where(
      and(
        eq(notificationPrefs.tenantId, c.tenantId),
        eq(notificationPrefs.eventType, eventType),
        inArray(notificationPrefs.userId, unique),
      ),
    );
  const chosen = new Map(prefs.map((p) => [p.userId, p.channels]));

  await tx()
    .insert(notifications)
    .values(
      recipients.map((user) => {
        const channels = chosen.get(user.id) ?? DEFAULT_CHANNELS[eventType];
        const deliveries: Record<string, string> = {};
        for (const key of EXTERNAL_CHANNELS) if (channels.includes(key)) deliveries[key] = 'pending';
        return {
          tenantId: c.tenantId,
          farmId: c.farmId,
          userId: user.id,
          eventType,
          severity: n.severity ?? 'info',
          title: render(n.title, user.locale)!,
          body: render(n.body, user.locale),
          link: n.link,
          alertId: n.alertId,
          deliveries,
        };
      }),
    );
}

export async function notifyUser(userId: string, n: NotificationInput): Promise<void> {
  await deliver([userId], n);
}

/** Active users of this farm holding one of the roles. */
export async function usersWithRole(role: RoleKey | RoleKey[], permission?: Permission): Promise<string[]> {
  const keys = Array.isArray(role) ? role : [role];
  if (keys.length === 0) return [];
  const rows = await tx()
    .select({ userId: memberships.userId, permissions: roles.permissions })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.farmId, ctx().farmId), eq(memberships.status, 'active'), inArray(roles.key, keys)));
  return rows.filter((r) => !permission || r.permissions.includes(permission)).map((r) => r.userId);
}

export async function notifyRole(role: RoleKey | RoleKey[], n: NotificationInput, opts: NotifyOptions = {}): Promise<void> {
  const ids = await usersWithRole(role, opts.permission);
  await deliver(ids.filter((id) => !opts.exclude?.includes(id)), n);
}

// ─── Outbox ────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 6;
/** Wait after each failed attempt, in minutes. Covers roughly a two-hour outage. */
const RETRY_MINUTES = [1, 5, 15, 30, 60];

export interface DispatchResult {
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

/** Send what is pending. Runs in a job; row locks keep two workers from sending the same message. */
export async function dispatchPending(limit = 100): Promise<DispatchResult> {
  const c = ctx();
  const result: DispatchResult = { sent: 0, retried: 0, failed: 0, skipped: 0 };
  const rows = await tx()
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.tenantId, c.tenantId),
        sql`exists (select 1 from jsonb_each_text(${notifications.deliveries}) d where d.value = 'pending')`,
      ),
    )
    .limit(limit)
    .for('update', { skipLocked: true });
  if (rows.length === 0) return result;

  const people = await tx()
    .select({ id: users.id, telegramChatId: users.telegramChatId, phone: users.phone, email: users.email })
    .from(users)
    .where(inArray(users.id, [...new Set(rows.map((r) => r.userId))]));
  const byId = new Map<string, Recipient>(people.map((p) => [p.id, { ...p, userId: p.id }]));

  const now = Date.now();
  for (const row of rows) {
    const to = byId.get(row.userId);
    const deliveries = { ...row.deliveries };
    const message = { severity: row.severity as Severity, title: row.title, body: row.body, link: row.link };

    for (const key of EXTERNAL_CHANNELS) {
      if (deliveries[key] !== 'pending') continue;
      const nextAt = deliveries[`${key}_next`];
      if (nextAt && Date.parse(nextAt) > now) continue;

      const channel = CHANNELS[key];
      try {
        if (!to) throw new PermanentDeliveryError('Recipient no longer exists');
        await channel.send(to, message);
        deliveries[key] = channel.configured() ? 'sent' : 'not_configured';
        delete deliveries[`${key}_next`];
        if (channel.configured()) result.sent++;
        else result.skipped++;
      } catch (err) {
        const attempts = Number(deliveries[`${key}_attempts`] ?? 0) + 1;
        deliveries[`${key}_attempts`] = String(attempts);
        if (err instanceof PermanentDeliveryError) {
          deliveries[key] = 'not_linked';
          delete deliveries[`${key}_next`];
          result.skipped++;
        } else if (attempts >= MAX_ATTEMPTS) {
          deliveries[key] = 'failed';
          delete deliveries[`${key}_next`];
          result.failed++;
          console.error(`[${key}] giving up on notification ${row.id}: ${(err as Error).message}`);
          await recordEvent({
            type: 'notification.delivery_failed',
            severity: 'attention',
            entityType: 'notification',
            entityId: row.id,
            data: { channel: key, attempts, error: (err as Error).message },
          });
        } else {
          const minutes = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)];
          deliveries[`${key}_next`] = new Date(now + minutes * 60_000).toISOString();
          result.retried++;
          console.warn(`[${key}] attempt ${attempts} for ${row.id} failed: ${(err as Error).message}`);
        }
      }
    }
    await tx().update(notifications).set({ deliveries }).where(eq(notifications.id, row.id));
  }
  return result;
}
