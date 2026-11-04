/**
 * Telegram bot: account linking and quick status commands (spec 17.3).
 * Replies are built with the sender's own role, so the bot never reveals more than the web app.
 */
import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../../db/client';
import { ctx, withPlatform, withTenant } from '../../core/context';
import { mergeSettings } from '../../core/settings';
import { latest, renderAlert } from '../alerts/alerts.service';
import { digestFacts, renderDigest } from './digest';
import { tr } from './i18n';
import { consumeLinkCode } from './notifications.service';
import { escapeHtml, formatMessage, getUpdates, sendRaw, telegramConfigured } from './telegram';

const { memberships, roles, tenants, users } = schema;

const ALERT_LIST_SIZE = 10;

/** Command names stay as written in any language, so they are parameters rather than dictionary text. */
const COMMANDS = { status: '/holat', alerts: '/ogohlantirishlar' };

interface Sender {
  id: string;
  locale: string;
}

async function findSender(chatId: string): Promise<Sender | null> {
  const [user] = await db
    .select({ id: users.id, locale: users.locale, status: users.status })
    .from(users)
    .where(eq(users.telegramChatId, chatId));
  return user && user.status === 'active' ? user : null;
}

/** Run `fn` as this user on their first farm, with that role's permissions. */
async function asUser<T>(user: Sender, fn: () => Promise<T>): Promise<T | null> {
  const [member] = await withPlatform((trx) =>
    trx
      .select({
        tenantId: memberships.tenantId,
        farmId: memberships.farmId,
        id: memberships.id,
        roleKey: roles.key,
        permissions: roles.permissions,
        settings: tenants.settings,
        currency: tenants.currency,
        timezone: tenants.timezone,
      })
      .from(memberships)
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(eq(memberships.userId, user.id))
      .orderBy(asc(memberships.createdAt))
      .limit(1),
  );
  if (!member) return null;
  return withTenant(
    {
      userId: user.id,
      tenantId: member.tenantId,
      farmId: member.farmId,
      membershipId: member.id,
      roleKey: member.roleKey,
      permissions: member.permissions,
      settings: mergeSettings(member.settings),
      currency: member.currency,
      timezone: member.timezone,
      source: 'mobile',
    },
    fn,
  );
}

async function statusReply(user: Sender): Promise<string> {
  const reply = await asUser(user, async () => {
    const seeMoney = ctx().permissions.has('finance.view');
    const { title, body } = renderDigest(await digestFacts(seeMoney), user.locale);
    return `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`;
  });
  return reply ?? tr(user.locale, 'alerts', 'bot.noFarm');
}

async function alertsReply(user: Sender): Promise<string> {
  const reply = await asUser(user, async () => {
    const rows = await latest(ALERT_LIST_SIZE);
    if (rows.length === 0) return tr(user.locale, 'alerts', 'bot.noAlerts');
    return rows
      .map((alert) => {
        const { title, body } = renderAlert(alert, user.locale);
        return formatMessage({ severity: alert.severity as 'info', title, body });
      })
      .join('\n\n');
  });
  return reply ?? tr(user.locale, 'alerts', 'bot.noFarm');
}

/** Answer one message. Exported for tests; the poller below feeds it. */
export async function handleMessage(chatId: string, text: string): Promise<string> {
  const [command, argument] = text.trim().split(/\s+/, 2);
  const name = command.split('@')[0].toLowerCase();

  if (name === '/start' && argument) {
    const linked = await consumeLinkCode(argument, chatId);
    if (!linked) return tr('uz', 'alerts', 'bot.linkFailed');
    const user = await findSender(chatId);
    return tr(user?.locale, 'alerts', 'bot.linked', COMMANDS);
  }

  const user = await findSender(chatId);
  if (!user) return tr('uz', 'alerts', 'bot.notLinked');

  switch (name) {
    case '/holat':
    case '/status':
      return statusReply(user);
    case '/ogohlantirishlar':
    case '/alerts':
      return alertsReply(user);
    default:
      return tr(user.locale, 'alerts', 'bot.help', COMMANDS);
  }
}

/**
 * Long-poll getUpdates. Does nothing when no token is set. Returns a stop function.
 * Wire into src/index.ts next to startJobs.
 */
export function startTelegramBot(log: { info(msg: string): void; error(obj: unknown, msg: string): void }): () => void {
  if (!telegramConfigured()) {
    log.info('Telegram bot not configured: TELEGRAM_BOT_TOKEN is empty');
    return () => {};
  }

  const controller = new AbortController();
  let offset = 0;

  const loop = async () => {
    while (!controller.signal.aborted) {
      try {
        const updates = await getUpdates(offset, controller.signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          const text = update.message?.text;
          if (!text) continue;
          const chatId = String(update.message!.chat.id);
          try {
            await sendRaw(chatId, await handleMessage(chatId, text));
          } catch (err) {
            log.error({ err, chatId }, 'telegram reply failed');
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        log.error({ err }, 'telegram polling failed');
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  };
  void loop();
  log.info('Telegram bot polling started');
  return () => controller.abort();
}
