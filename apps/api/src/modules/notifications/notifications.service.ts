import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { schema, db } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { listQuery, paged } from '../../core/query';
import { CHANNELS, EXTERNAL_CHANNELS, type ExternalChannel } from './channels';
import { DEFAULT_CHANNELS, EVENT_TYPES, type EventType } from './notify.service';
import { getBotUsername, telegramConfigured } from './telegram';

const { notificationPrefs, notifications, telegramLinkCodes, users } = schema;

export const notificationListQuery = listQuery.extend({ unread: z.stringbool().optional() });

const mine = () => {
  const c = ctx();
  return and(eq(notifications.tenantId, c.tenantId), eq(notifications.userId, c.userId!));
};

export async function list(q: z.infer<typeof notificationListQuery>) {
  const where = and(mine(), q.unread ? isNull(notifications.readAt) : undefined);
  return paged(q, notifications, where, (limit, offset) =>
    tx()
      .select({
        id: notifications.id,
        eventType: notifications.eventType,
        severity: notifications.severity,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit)
      .offset(offset),
  );
}

export async function unreadCount() {
  const [row] = await tx().select({ count: count() }).from(notifications).where(and(mine(), isNull(notifications.readAt)));
  return { count: row.count };
}

export async function markRead(id: string) {
  const [row] = await tx()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(mine(), eq(notifications.id, id)))
    .returning({ id: notifications.id, readAt: notifications.readAt });
  if (!row) throw notFound('Notification');
  return row;
}

export async function markAllRead() {
  const rows = await tx()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(mine(), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return { updated: rows.length };
}

export async function getPreferences() {
  const c = ctx();
  const rows = await tx()
    .select()
    .from(notificationPrefs)
    .where(and(eq(notificationPrefs.tenantId, c.tenantId), eq(notificationPrefs.userId, c.userId!)));
  const chosen = new Map(rows.map((r) => [r.eventType, r.channels]));
  return {
    channels: EXTERNAL_CHANNELS.map((key) => ({ key, configured: CHANNELS[key].configured() })),
    events: EVENT_TYPES.map((eventType) => ({
      eventType,
      channels: chosen.get(eventType) ?? DEFAULT_CHANNELS[eventType],
      isDefault: !chosen.has(eventType),
    })),
  };
}

export const preferenceInput = z.object({
  eventType: z.enum(EVENT_TYPES),
  channels: z.array(z.enum(EXTERNAL_CHANNELS)),
});

export async function setPreference(eventType: EventType, channels: ExternalChannel[]) {
  const c = ctx();
  await tx()
    .insert(notificationPrefs)
    .values({ tenantId: c.tenantId, userId: c.userId!, eventType, channels })
    .onConflictDoUpdate({
      target: [notificationPrefs.userId, notificationPrefs.tenantId, notificationPrefs.eventType],
      set: { channels },
    });
  return getPreferences();
}

// ─── Telegram linking ──────────────────────────────────────────────────────

const LINK_CODE_TTL_MINUTES = 15;

export async function telegramStatus() {
  const [user] = await tx().select({ chatId: users.telegramChatId }).from(users).where(eq(users.id, ctx().userId!));
  return { configured: telegramConfigured(), linked: Boolean(user?.chatId), botUsername: await getBotUsername() };
}

/** The user sends this code to the bot as /start <code>; the bot then knows the chat is theirs. */
export async function createTelegramLink() {
  if (!telegramConfigured()) throw badRequest('TELEGRAM_NOT_CONFIGURED', 'Telegram bot is not configured');
  const code = randomBytes(6).toString('hex');
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);
  await tx().insert(telegramLinkCodes).values({ code, userId: ctx().userId!, expiresAt });
  const botUsername = await getBotUsername();
  return {
    code,
    expiresAt,
    botUsername,
    deepLink: botUsername ? `https://t.me/${botUsername}?start=${code}` : null,
  };
}

export async function unlinkTelegram() {
  await tx().update(users).set({ telegramChatId: null }).where(eq(users.id, ctx().userId!));
  return { linked: false };
}

/** Claim a link code from the bot. Runs outside a request, so it uses `db` on global tables. */
export async function consumeLinkCode(code: string, chatId: string): Promise<boolean> {
  return db.transaction(async (trx) => {
    const [row] = await trx.select().from(telegramLinkCodes).where(eq(telegramLinkCodes.code, code)).for('update');
    if (!row || row.usedAt || row.expiresAt < new Date()) return false;
    await trx.update(telegramLinkCodes).set({ usedAt: new Date() }).where(eq(telegramLinkCodes.code, code));
    // One chat belongs to one person: a chat re-linked to a new account leaves the old one.
    await trx.update(users).set({ telegramChatId: null }).where(eq(users.telegramChatId, chatId));
    await trx.update(users).set({ telegramChatId: chatId }).where(eq(users.id, row.userId));
    return true;
  });
}
