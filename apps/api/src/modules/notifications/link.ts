/**
 * Linking a Telegram chat to an account. A linked chat can confirm money, so it never changes hands
 * silently: a chat that belongs to someone else moves only on its holder's explicit press, naming
 * both accounts, and whoever loses a chat is told.
 */
import { safeError } from '../../core/errors';
import { answering, COMMANDS, loadPerson, sendRefusal, type BotLog, type Refused, type Person } from './assistant-bot';
import { tr } from './i18n';
import { consumeLinkCode, journalLink, type LinkResult } from './notifications.service';
import { editHtml, escapeHtml, sendHtml, type TelegramCallbackQuery, type TelegramUser } from './telegram';

const LINK_PRESS = /^l:([yn]):([0-9a-f]{12})$/;

type Linked = Extract<LinkResult, { status: 'linked' }>;

const telegramName = (from: TelegramUser | undefined, chatId: string) =>
  from?.username ? `@${from.username}` : (from?.first_name ?? chatId);

/**
 * The link is made by now, so a failure here is logged and must not read as a failed link. The trace
 * comes first: an old chat that cannot be reached may be the very reason for the move.
 */
async function announceMove(chatId: string, linked: Linked, from: TelegramUser | undefined): Promise<void> {
  try {
    await journalLink(linked.userId, 'telegram.linked', { name: telegramName(from, chatId), chatId });
    if (linked.previousHolder) {
      await journalLink(linked.previousHolder.id, 'telegram.unlinked', { name: linked.name, chatId });
    }
  } catch (error) {
    console.error('[telegram] a new link was not announced', safeError(error));
  }
  if (!linked.previousChat) return;
  await sendHtml(linked.previousChat, escapeHtml(tr(linked.locale, 'alerts', 'bot.movedAway'))).catch((error) =>
    console.warn('[telegram] the old chat was not told', safeError(error)),
  );
}

/** Someone on several farms picks one straight away, so nothing they write lands on a guess. */
async function welcome(chatId: string, person: Person | Refused): Promise<string> {
  const text = tr(person.locale, 'alerts', 'bot.linked', COMMANDS);
  if (person.status !== 'choose_farm') return text;
  await sendHtml(chatId, text);
  await sendRefusal(chatId, person);
  return '';
}

/** /start <code>. Returns the reply as HTML, or nothing when it has gone out already. */
export async function startLink(chatId: string, code: string, from?: TelegramUser): Promise<string> {
  const result = await consumeLinkCode(code, chatId);
  const person = await loadPerson(chatId);
  switch (result.status) {
    case 'invalid':
      return tr(person.locale ?? result.locale, 'alerts', 'bot.linkFailed');
    case 'same':
      return tr(person.locale, 'alerts', 'bot.linked', COMMANDS);
    case 'occupied': {
      const names = { current: result.holder, next: result.claimant };
      await sendHtml(chatId, escapeHtml(tr(person.locale, 'alerts', 'bot.moveAsk', names)), {
        inline_keyboard: [
          [{ text: tr(person.locale, 'alerts', 'bot.buttons.moveNo', names), callback_data: `l:n:${code}` }],
          [{ text: tr(person.locale, 'alerts', 'bot.buttons.moveYes', names), callback_data: `l:y:${code}` }],
        ],
      });
      return '';
    }
    case 'linked':
      await announceMove(chatId, result, from);
      return welcome(chatId, person);
  }
}

/** The holder's answer to the question above. Only a press from the chat itself can move it. */
export function handleLinkPress(query: TelegramCallbackQuery, log: BotLog): Promise<void> {
  return answering(query, log, async (person) => {
    const pressed = LINK_PRESS.exec(query.data ?? '');
    const asked = query.message;
    const chatId = String(query.from.id);
    if (!pressed || !asked || asked.chat.type !== 'private' || String(asked.chat.id) !== chatId) {
      return tr(person.locale, 'alerts', 'bot.stale');
    }
    const answer = (text: string) => editHtml(chatId, asked.message_id, escapeHtml(text));
    if (pressed[1] === 'n') {
      await answer(tr(person.locale, 'alerts', 'bot.moveKept'));
      return undefined;
    }
    const result = await consumeLinkCode(pressed[2], chatId, true);
    if (result.status === 'same') return undefined; // a double tap: the first press said it all
    if (result.status !== 'linked') {
      await answer(tr(person.locale, 'alerts', 'bot.linkFailed'));
      return undefined;
    }
    await announceMove(chatId, result, query.from);
    const holder = result.previousHolder?.name ?? '';
    await answer(tr(result.locale, 'alerts', 'bot.moved', { current: holder, next: result.name }));
    const next = await loadPerson(chatId);
    if (next.status === 'choose_farm') await sendRefusal(chatId, next);
    return undefined;
  });
}
