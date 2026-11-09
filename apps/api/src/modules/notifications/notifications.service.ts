import { and, asc, count, desc, eq, inArray, isNull, like, lt, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { LANGUAGES, type LanguageCode } from '@yap/shared/i18n';
import { schema, db } from '../../db/client';
import { ctx, tx, withPlatform, withTenant } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { listQuery, paged } from '../../core/query';
import { actionView } from './actions.service';
import { CHANNELS, EXTERNAL_CHANNELS, OFFERED_CHANNELS, type ExternalChannel } from './channels';
import { tr } from './i18n';
import { DEFAULT_CHANNELS, EVENT_TYPES, notifyUser, wordsFor, type EventType, type NotificationInput } from './notify.service';
import { escapeHtml, getBotUsername, sendHtml, telegramConfigured } from './telegram';

const { idempotencyKeys, memberships, notificationPrefs, notifications, telegramLinkCodes, users } = schema;

const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as [LanguageCode, ...LanguageCode[]];

export const notificationListQuery = listQuery.extend({
  unread: z.stringbool().optional(),
  /** The language on the reader's screen. */
  lang: z.enum(LANGUAGE_CODES).optional(),
});

/** A text that shows money stays out of sight once its reader loses the right to it (rule 7). */
const mine = () => {
  const c = ctx();
  return and(
    eq(notifications.tenantId, c.tenantId),
    eq(notifications.userId, c.userId!),
    or(isNull(notifications.permission), inArray(notifications.permission, [...c.permissions, ''])),
  );
};

export async function list(q: z.infer<typeof notificationListQuery>) {
  const where = and(mine(), q.unread ? isNull(notifications.readAt) : undefined);
  return paged(q, notifications, where, async (limit, offset) => {
    const rows = await tx()
      .select({
        id: notifications.id,
        eventType: notifications.eventType,
        severity: notifications.severity,
        title: notifications.title,
        body: notifications.body,
        texts: notifications.texts,
        link: notifications.link,
        action: notifications.action,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit)
      .offset(offset);
    // Asked live: a handover accepted in Telegram has no buttons left here.
    return Promise.all(
      rows.map(async ({ texts, action, ...row }) => ({
        ...row,
        ...wordsFor({ ...row, texts }, q.lang),
        action: action ? { ...action, ...(await actionView(action)) } : null,
      })),
    );
  });
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
    // Only channels that exist: a wall of "not configured" push, SMS and email boxes promises what is not built.
    channels: OFFERED_CHANNELS().map((key) => ({ key, configured: CHANNELS[key].configured() })),
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

export const languageInput = z.object({ language: z.enum(LANGUAGE_CODES) });

/** Telegram has no screen to read a language from, so the account keeps the one chosen in the app. */
export async function setLanguage(language: LanguageCode) {
  await tx().update(users).set({ locale: language }).where(eq(users.id, ctx().userId!));
  return { language };
}

// ─── Telegram linking ──────────────────────────────────────────────────────

const LINK_CODE_TTL_MINUTES = 15;

/** Telegram holds an update for a day at most, so nothing older can come back. */
const ANSWERED_KEPT_MS = 3 * 86_400_000;

const answeredKey = (chatId: string, messageId: number) => `telegram:${chatId}:${messageId}`;

/**
 * A crash can leave handled messages unconfirmed, and Telegram then hands them back. Running one
 * again would draft it twice, so what was answered is kept here. Runs inside a tenant.
 */
export async function wasAnswered(chatId: string, messageId: number): Promise<boolean> {
  const [row] = await tx()
    .select({ key: idempotencyKeys.key })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, ctx().tenantId), eq(idempotencyKeys.key, answeredKey(chatId, messageId))));
  return row !== undefined;
}

export async function noteAnswered(chatId: string, messageId: number): Promise<void> {
  const c = ctx();
  await tx()
    .insert(idempotencyKeys)
    .values({ tenantId: c.tenantId, key: answeredKey(chatId, messageId), path: 'telegram', userId: c.userId, statusCode: 200 })
    .onConflictDoNothing();
}

export async function forgetAnswered(): Promise<void> {
  await tx()
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.tenantId, ctx().tenantId),
        like(idempotencyKeys.key, 'telegram:%'),
        lt(idempotencyKeys.createdAt, new Date(Date.now() - ANSWERED_KEPT_MS)),
      ),
    );
}

export async function telegramStatus() {
  const [user] = await tx().select({ chatId: users.telegramChatId }).from(users).where(eq(users.id, ctx().userId!));
  return { configured: telegramConfigured(), linked: Boolean(user?.chatId), botUsername: await getBotUsername() };
}

/** A code nobody redeemed yet must not outlive what it was issued for. Inside the caller's transaction. */
const burnLinkCodes = (userId: string) =>
  tx()
    .update(telegramLinkCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(telegramLinkCodes.userId, userId), isNull(telegramLinkCodes.usedAt)));

/** The user sends this code to the bot as /start <code>; the bot then knows the chat is theirs. */
export async function createTelegramLink() {
  if (!telegramConfigured()) throw badRequest('TELEGRAM_NOT_CONFIGURED', 'Telegram bot is not configured');
  const userId = ctx().userId!;
  const code = randomBytes(6).toString('hex');
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);
  await burnLinkCodes(userId);
  await tx().insert(telegramLinkCodes).values({ code, userId, expiresAt });
  await recordEvent({ type: 'telegram.link_requested', severity: 'attention', entityType: 'user', entityId: userId });
  const botUsername = await getBotUsername();
  return {
    code,
    expiresAt,
    botUsername,
    deepLink: botUsername ? `https://t.me/${botUsername}?start=${code}` : null,
  };
}

/** The message is a courtesy, so it neither waits for Telegram nor can fail the unlink. */
function tellChat(chatId: string, text: string): void {
  if (!telegramConfigured()) return;
  sendHtml(chatId, escapeHtml(text)).catch((err: Error) => console.warn(`[telegram] unlink notice not sent: ${err.message}`));
}

/** Alerts must never stop silently, so losing a chat always leaves this in the app, for when they next look. */
const UNLINK_NOTICE: NotificationInput = {
  account: true,
  channels: [],
  eventType: 'alert_info',
  severity: 'attention',
  title: (locale) => tr(locale, 'alerts', 'bot.unlinkNotice.title'),
  body: (locale) => tr(locale, 'alerts', 'bot.unlinkNotice.body'),
  link: '/notifications',
};

export async function unlinkTelegram() {
  const userId = ctx().userId!;
  const [user] = await tx().select({ chatId: users.telegramChatId, locale: users.locale }).from(users).where(eq(users.id, userId));
  await tx().update(users).set({ telegramChatId: null, telegramMembershipId: null }).where(eq(users.id, userId));
  await burnLinkCodes(userId);
  if (user?.chatId) {
    await recordEvent({ type: 'telegram.unlinked', severity: 'attention', entityType: 'user', entityId: userId });
    await notifyUser(userId, UNLINK_NOTICE);
    tellChat(user.chatId, tr(user.locale, 'alerts', 'bot.unlinked'));
  }
  return { linked: false };
}

/**
 * The account itself is blocked, so its chat goes too. Blocking a membership never comes here: the
 * other farms still need to reach this person, and each update checks the memberships anyway.
 * Runs outside a request, so the journal cannot outlive a rollback.
 */
export async function dropTelegramLink(userId: string): Promise<void> {
  const [user] = await db.select({ chatId: users.telegramChatId, locale: users.locale }).from(users).where(eq(users.id, userId));
  if (!user?.chatId) return;
  await db.update(users).set({ telegramChatId: null, telegramMembershipId: null }).where(eq(users.id, userId));
  await journalLink(userId, 'telegram.unlinked', { reason: 'account_blocked' });
  tellChat(user.chatId, tr(user.locale, 'alerts', 'bot.unlinkedBlocked'));
}

/** Whoever holds the chat can confirm money, so a new password is news there, in case it was not them. */
export const PASSWORD_NOTICE: NotificationInput = {
  account: true,
  channels: ['telegram'],
  eventType: 'alert_attention',
  severity: 'attention',
  title: (locale) => tr(locale, 'alerts', 'bot.passwordNotice.title'),
  body: (locale) => tr(locale, 'alerts', 'bot.passwordNotice.body'),
};

/** Two-factor sign-in was reset, replaced, or got past with a recovery code. */
export const TWO_FACTOR_NOTICE: NotificationInput = {
  account: true,
  channels: ['telegram'],
  eventType: 'alert_attention',
  severity: 'attention',
  title: (locale) => tr(locale, 'alerts', 'bot.twoFactorNotice.title'),
  body: (locale) => tr(locale, 'alerts', 'bot.twoFactorNotice.body'),
};

/** Says only who asked. The person answers in the app, signed in. */
export const inviteNotice = (workspace: string): NotificationInput => ({
  account: true,
  channels: ['telegram'],
  eventType: 'alert_attention',
  severity: 'attention',
  title: (locale) => tr(locale, 'alerts', 'bot.inviteNotice.title'),
  body: (locale) => tr(locale, 'alerts', 'bot.inviteNotice.body', { workspace }),
});

/** For code outside a request, where no farm is at hand. The notice names none, so any of theirs will do. */
export async function notifyAccount(userId: string, notice: NotificationInput): Promise<void> {
  const [home] = await withPlatform((trx) =>
    trx
      .select({ tenantId: memberships.tenantId, farmId: memberships.farmId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
      .orderBy(asc(memberships.createdAt))
      .limit(1),
  );
  if (home) await withTenant({ userId, ...home }, () => notifyUser(userId, notice));
}

export type LinkResult =
  | { status: 'invalid'; locale?: string }
  /** This chat already belongs to the code's account: a redelivered /start, or a second press. */
  | { status: 'same' }
  /** The chat holds someone else, so the code waits for an explicit choice in that chat. */
  | { status: 'occupied'; holder: string; claimant: string }
  | {
      status: 'linked';
      userId: string;
      name: string;
      locale: string;
      /** A chat this account has just left. */
      previousChat: string | null;
      /** Whoever this chat belonged to until now. */
      previousHolder: { id: string; name: string } | null;
    };

/**
 * Claim a link code from the bot. Runs outside a request, so it uses `db` on global tables. A chat
 * that belongs to someone else moves only with `takeOver`, which only their own press may set.
 */
export async function consumeLinkCode(code: string, chatId: string, takeOver = false): Promise<LinkResult> {
  return db.transaction(async (trx) => {
    const [row] = await trx.select().from(telegramLinkCodes).where(eq(telegramLinkCodes.code, code)).for('update');
    const person = { id: users.id, name: users.fullName, chatId: users.telegramChatId, locale: users.locale };
    const [holder] = await trx.select(person).from(users).where(eq(users.telegramChatId, chatId));
    const [claimant] = row ? await trx.select(person).from(users).where(eq(users.id, row.userId)) : [];
    if (!row || !claimant) return { status: 'invalid' };
    if (holder?.id === claimant.id) {
      await trx.update(telegramLinkCodes).set({ usedAt: row.usedAt ?? new Date() }).where(eq(telegramLinkCodes.code, code));
      return { status: 'same' };
    }
    if (row.usedAt || row.expiresAt < new Date()) return { status: 'invalid', locale: claimant.locale };
    if (holder && !takeOver) return { status: 'occupied', holder: holder.name, claimant: claimant.name };

    await trx
      .update(telegramLinkCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(telegramLinkCodes.userId, claimant.id), isNull(telegramLinkCodes.usedAt)));
    // One chat belongs to one person: a chat re-linked to a new account leaves the old one.
    await trx
      .update(users)
      .set({ telegramChatId: null, telegramMembershipId: null })
      .where(and(eq(users.telegramChatId, chatId), ne(users.id, claimant.id)));
    await trx.update(users).set({ telegramChatId: chatId, telegramMembershipId: null }).where(eq(users.id, claimant.id));
    return {
      status: 'linked',
      userId: claimant.id,
      name: claimant.name,
      locale: claimant.locale,
      previousChat: claimant.chatId,
      previousHolder: holder ? { id: holder.id, name: holder.name } : null,
    };
  });
}

/** Who can confirm money from this chat has changed, so every farm of the person keeps a trace. */
export async function journalLink(userId: string, type: 'telegram.linked' | 'telegram.unlinked', data: Record<string, unknown>) {
  const rows = await withPlatform((trx) =>
    trx
      .select({ tenantId: memberships.tenantId, farmId: memberships.farmId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active'))),
  );
  const told = new Set<string>();
  for (const row of rows) {
    await withTenant({ userId, ...row, source: 'mobile', device: 'telegram' }, async () => {
      await recordEvent({ type, severity: 'attention', entityType: 'user', entityId: userId, data });
      // The inbox is per workspace, so each one hears once.
      if (told.has(row.tenantId)) return;
      told.add(row.tenantId);
      if (type === 'telegram.unlinked') return notifyUser(userId, UNLINK_NOTICE);
      // The web is the one place a stranger holding the code cannot quietly answer for the owner.
      await notifyUser(userId, {
        eventType: 'alert_info',
        severity: 'attention',
        title: (locale) => tr(locale, 'alerts', 'bot.linkNotice.title'),
        body: (locale) => tr(locale, 'alerts', 'bot.linkNotice.body', data),
        link: '/notifications',
      });
    });
  }
}
