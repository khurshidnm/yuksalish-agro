/**
 * Notifications are written to the database inside the caller's transaction, and external
 * delivery happens afterwards in dispatchPending(). A rolled-back action therefore never sends a
 * message, and a Telegram outage never fails a business action.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Permission, RoleKey, Severity } from '@yap/shared';
import { LANGUAGES } from '@yap/shared/i18n';
import { schema } from '../../db/client';
import { ctx, tx, withPlatform } from '../../core/context';
import { enabledPermissions } from '../../core/http';
import { recordEvent } from '../../core/journal';
import { CHANNELS, EXTERNAL_CHANNELS, PermanentDeliveryError, RetryLaterError, type ExternalChannel, type Recipient } from './channels';
import { tr } from './i18n';

const { alerts, farms, memberships, notificationPrefs, notifications, roles, tenants, users } = schema;

export const EVENT_TYPES = ['alert_urgent', 'alert_attention', 'alert_info', 'task_assigned', 'daily_summary', 'assistant_recap'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** External channels when the user has not chosen. In-app is always on (spec 17.3). */
export const DEFAULT_CHANNELS: Record<EventType, ExternalChannel[]> = {
  alert_urgent: ['telegram'],
  alert_attention: ['telegram'],
  alert_info: [],
  task_assigned: [],
  daily_summary: ['telegram'],
  assistant_recap: ['telegram'],
};

/** What these always show, whoever asked for them, so losing it stops them too (rule 7). */
const EVENT_PERMISSIONS: Partial<Record<EventType, Permission>> = { assistant_recap: 'finance.view' };

/** Plain text, or a function rendering it in the recipient's language. */
export type Text = string | ((locale: string) => string);

export interface NotificationInput {
  severity?: Severity;
  title: Text;
  body?: Text;
  link?: string;
  alertId?: string;
  eventType?: EventType;
  /** Instead of what the person chose, for news about their own account. */
  channels?: ExternalChannel[];
  /** About the person's account, not this farm: it names no farm and is kept even if the account is blocked. */
  account?: boolean;
  /** Told only because those responsible could not be reached, so it stops once someone takes the alert. */
  escalated?: boolean;
}

export interface NotifyOptions {
  /** Only holders of this permission hear it, then and when it leaves, e.g. 'finance.view' for text with money. */
  permission?: Permission;
  /** Do not write these users twice, e.g. the person who just acted. */
  exclude?: string[];
}

const render = (text: Text | undefined, locale: string) => (typeof text === 'function' ? text(locale) : text);

type Words = { title: string; body: string | null };

/** A reader can change language after this is written, so it is kept in all of them. */
function inEveryLanguage(n: NotificationInput): Record<string, Words> {
  return Object.fromEntries(LANGUAGES.map(({ code }) => [code, { title: render(n.title, code)!, body: render(n.body, code) ?? null }]));
}

/** What this reader sees. A row older than `texts` shows the words it was written with. */
export function wordsFor(row: Words & { texts: Record<string, Words> | null }, locale: string | null | undefined): Words {
  return row.texts?.[locale ?? ''] ?? { title: row.title, body: row.body };
}

const eventTypeFor = (n: NotificationInput): EventType =>
  n.eventType ?? (n.severity === 'urgent' ? 'alert_urgent' : n.severity === 'attention' ? 'alert_attention' : 'alert_info');

async function deliver(userIds: string[], n: NotificationInput, permission?: Permission): Promise<void> {
  const c = ctx();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  const eventType = eventTypeFor(n);

  const recipients = await tx()
    .select({ id: users.id, locale: users.locale })
    .from(users)
    .where(and(inArray(users.id, unique), n.account ? undefined : eq(users.status, 'active')));
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
  const texts = inEveryLanguage(n);

  await tx()
    .insert(notifications)
    .values(
      recipients.map((user) => {
        const channels = n.channels ?? chosen.get(user.id) ?? DEFAULT_CHANNELS[eventType];
        const deliveries: Record<string, string> = {};
        for (const key of EXTERNAL_CHANNELS) if (channels.includes(key)) deliveries[key] = 'pending';
        if (n.escalated) deliveries.escalated = 'true';
        return {
          tenantId: c.tenantId,
          farmId: n.account ? null : c.farmId,
          userId: user.id,
          eventType,
          severity: n.severity ?? 'info',
          title: render(n.title, user.locale)!,
          body: render(n.body, user.locale),
          texts,
          link: n.link,
          alertId: n.alertId,
          permission: permission ?? EVENT_PERMISSIONS[eventType],
          deliveries,
        };
      }),
    );
}

export async function notifyUser(userId: string, n: NotificationInput, opts: NotifyOptions = {}): Promise<void> {
  await deliver([userId], n, opts.permission);
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
  await deliver(ids.filter((id) => !opts.exclude?.includes(id)), n, opts.permission);
}

// ─── Outbox ────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 6;
/** Wait after each failed attempt, in minutes. Covers roughly a two-hour outage. */
const RETRY_MINUTES = [1, 5, 15, 30, 60];
/** An urgent message goes out soon after the channel is back, not at the end of a long wait. */
const URGENT_RETRY_MINUTES = 5;
/** Failures in a row that mean the channel is down, so the rest of the run would only sit out timeouts. */
const CHANNEL_DOWN_AFTER = 3;
/** Past this a message reads as happening now unless it says otherwise. */
export const LATE_AFTER_MS = 5 * 60_000;

export interface DispatchResult {
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

/** A row still waiting out its back-off must not use up the batch. */
const isDue = sql`exists (
  select 1 from jsonb_each_text(${notifications.deliveries}) d
  where d.value = 'pending'
    and coalesce((${notifications.deliveries} ->> (d.key || '_next'))::timestamptz, now()) <= now()
)`;

const mostUrgentFirst = sql`case ${notifications.severity} when 'urgent' then 0 when 'attention' then 1 else 2 end`;

/** Two workspaces can both have a "Bosh ferma", so the workspace is named when there are several. */
export function farmLabel<T extends { tenantId: string; tenantName: string; farmName: string }>(place: T, places: T[]): string {
  return places.some((other) => other.tenantId !== place.tenantId) ? `${place.tenantName}: ${place.farmName}` : place.farmName;
}

/** Everywhere each person still works, including workspaces the tenant this runs in cannot see. */
async function workplaces(userIds: string[]) {
  const rows = await withPlatform((trx) =>
    trx
      .select({
        userId: memberships.userId,
        tenantId: memberships.tenantId,
        farmId: memberships.farmId,
        tenantName: tenants.name,
        farmName: farms.name,
        permissions: roles.permissions,
        modules: tenants.modules,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .innerJoin(farms, eq(farms.id, memberships.farmId))
      .where(and(inArray(memberships.userId, userIds), eq(memberships.status, 'active'), eq(users.status, 'active'), eq(tenants.status, 'active'))),
  );
  const byPerson = new Map<string, typeof rows>();
  for (const row of rows) byPerson.set(row.userId, [...(byPerson.get(row.userId) ?? []), row]);
  return byPerson;
}

type Row = typeof notifications.$inferSelect;
type Workplaces = Awaited<ReturnType<typeof workplaces>>;

/** Blocking someone or taking a right away takes effect at once, so what was queued for them stops here too. */
function entitled(row: Row, places: Workplaces): boolean {
  const here = (places.get(row.userId) ?? []).filter((place) => !row.farmId || place.farmId === row.farmId);
  return here.some((place) => !row.permission || enabledPermissions(place.permissions, place.modules).includes(row.permission));
}

/** Someone on several farms must be able to tell which one is burning. */
function farmNamed(row: Row, places: Workplaces): string | undefined {
  const theirs = places.get(row.userId) ?? [];
  const place = theirs.find((candidate) => candidate.farmId === row.farmId);
  return place && theirs.length > 1 ? farmLabel(place, theirs) : undefined;
}

export const clock = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(at);

/**
 * Send what is pending, the most urgent and newest first. Runs in a job; row locks keep two workers
 * from sending the same message, and the run never stops to wait for anyone: a person Telegram
 * limits, or a channel that is down, is left for later so the next person's message goes out now.
 */
export async function dispatchPending(limit = 100): Promise<DispatchResult> {
  const c = ctx();
  const result: DispatchResult = { sent: 0, retried: 0, failed: 0, skipped: 0 };
  const rows = await tx()
    .select()
    .from(notifications)
    .where(and(eq(notifications.tenantId, c.tenantId), isDue))
    .orderBy(mostUrgentFirst, desc(notifications.createdAt))
    .limit(limit)
    .for('update', { skipLocked: true });
  if (rows.length === 0) return result;

  const recipients = [...new Set(rows.map((r) => r.userId))];
  const people = await tx()
    .select({ id: users.id, telegramChatId: users.telegramChatId, phone: users.phone, email: users.email, locale: users.locale })
    .from(users)
    .where(inArray(users.id, recipients));
  const byId = new Map<string, Recipient & { locale: string }>(people.map((p) => [p.id, { ...p, userId: p.id }]));
  const places = await workplaces(recipients);
  const alertIds = rows.flatMap((row) => (row.alertId ? [row.alertId] : []));
  const closed = alertIds.length
    ? await tx().select({ id: alerts.id, status: alerts.status }).from(alerts).where(and(inArray(alerts.id, alertIds), ne(alerts.status, 'open')))
    : [];
  const resolved = new Set(closed.filter((alert) => alert.status === 'resolved').map((alert) => alert.id));
  const taken = new Set(closed.map((alert) => alert.id));
  /** Urgent alerts that reached someone in this run. */
  const reached = new Set<string>();

  const now = Date.now();
  /** Until when each person is rate limited, by channel. */
  const limited = new Map<string, number>();
  const failuresInARow = new Map<ExternalChannel, number>();

  for (const row of rows) {
    const to = byId.get(row.userId);
    const deliveries = { ...row.deliveries };
    const late = now - row.createdAt.getTime() > LATE_AFTER_MS;
    const message = {
      severity: row.severity as Severity,
      ...wordsFor(row, to?.locale),
      link: row.link,
      alertId: row.alertId,
      farm: farmNamed(row, places),
      note: late ? tr(to?.locale, 'alerts', 'bot.sentLate', { time: clock(row.createdAt, c.timezone) }) : null,
    };

    for (const key of EXTERNAL_CHANNELS) {
      if (deliveries[key] !== 'pending') continue;
      const nextAt = deliveries[`${key}_next`];
      if (nextAt && Date.parse(nextAt) > now) continue;
      const overtaken = row.alertId && (resolved.has(row.alertId) || (row.deliveries.escalated && taken.has(row.alertId)));
      if (to && (!entitled(row, places) || overtaken)) {
        deliveries[key] = 'skipped';
        delete deliveries[`${key}_next`];
        result.skipped++;
        continue;
      }
      if ((failuresInARow.get(key) ?? 0) >= CHANNEL_DOWN_AFTER) continue;
      const limitedUntil = limited.get(`${key}:${row.userId}`);
      if (limitedUntil) {
        deliveries[`${key}_next`] = new Date(limitedUntil).toISOString();
        result.retried++;
        continue;
      }

      const channel = CHANNELS[key];
      try {
        if (!to) throw new PermanentDeliveryError('Recipient no longer exists');
        await channel.send(to, message);
        deliveries[key] = channel.configured() ? 'sent' : 'not_configured';
        delete deliveries[`${key}_next`];
        failuresInARow.delete(key);
        if (channel.configured()) {
          result.sent++;
          if (row.alertId) reached.add(row.alertId);
        } else result.skipped++;
      } catch (err) {
        if (err instanceof RetryLaterError) {
          const until = Date.now() + err.afterMs;
          limited.set(`${key}:${row.userId}`, until);
          deliveries[`${key}_next`] = new Date(until).toISOString();
          result.retried++;
          console.warn(`[${key}] rate limited for ${row.userId}, keeping ${row.id} for later`);
          continue;
        }
        if (err instanceof PermanentDeliveryError) {
          deliveries[key] = 'not_linked';
          delete deliveries[`${key}_next`];
          result.skipped++;
          continue;
        }
        failuresInARow.set(key, (failuresInARow.get(key) ?? 0) + 1);
        const attempts = Number(deliveries[`${key}_attempts`] ?? 0) + 1;
        deliveries[`${key}_attempts`] = String(attempts);
        if (attempts >= MAX_ATTEMPTS) {
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
          const planned = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)];
          const minutes = row.severity === 'urgent' ? Math.min(planned, URGENT_RETRY_MINUTES) : planned;
          deliveries[`${key}_next`] = new Date(now + minutes * 60_000).toISOString();
          result.retried++;
          console.warn(`[${key}] attempt ${attempts} for ${row.id} failed: ${(err as Error).message}`);
        }
      }
    }
    await tx().update(notifications).set({ deliveries }).where(eq(notifications.id, row.id));
  }
  if (reached.size > 0) await tx().update(alerts).set({ undeliveredSince: null }).where(inArray(alerts.id, [...reached]));
  return result;
}
