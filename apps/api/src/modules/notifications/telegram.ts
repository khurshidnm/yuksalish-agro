/**
 * Telegram Bot API over fetch (spec 17.3, 19). With no TELEGRAM_BOT_TOKEN the channel reports
 * itself as not configured and messages go to the log, so nothing else has to care.
 */
import type { Severity } from '@yap/shared';
import { config } from '../../config';

const API = 'https://api.telegram.org';
const SEND_ATTEMPTS = 3;
/** Longer than this and the caller hears about it, rather than sit holding a person's queue. */
const MAX_RETRY_WAIT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Longer than the 25 s long poll, so a dead connection cannot stop the bot for good. */
const POLL_TIMEOUT_MS = 40_000;

/** Telegram's limit on one message, counted after entities are parsed. */
export const MESSAGE_LIMIT = 4096;

/** Read at call time so that tests and operators can change it without a rebuild of `config`. */
function token(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN || undefined;
}

export const telegramConfigured = (): boolean => Boolean(token());

export class TelegramError extends Error {
  constructor(
    message: string,
    /** Worth another attempt: rate limit, server or network trouble. */
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    /** Telegram's own wording, which is the only way it says why a request was refused. */
    readonly description?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface BotResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

async function call<T>(method: string, payload: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}/bot${token()}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new TelegramError(`Telegram ${method} failed: ${(err as Error).message}`, true);
  }
  const body = (await response.json().catch(() => ({ ok: false }))) as BotResponse<T>;
  if (response.ok && body.ok) return body.result as T;

  const retryable = response.status === 429 || response.status >= 500;
  const retryAfter = body.parameters?.retry_after;
  throw new TelegramError(
    `Telegram ${method} returned ${response.status}: ${body.description ?? 'unknown error'}`,
    retryable,
    retryAfter ? retryAfter * 1000 : undefined,
    body.description,
    response.status,
  );
}

/** A short in-process retry. The outbox retries over a longer horizon. */
async function callWithRetry<T>(method: string, payload: unknown, maxRateLimitWaitMs = MAX_RETRY_WAIT_MS): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call<T>(method, payload);
    } catch (err) {
      const retry = err instanceof TelegramError && err.retryable && attempt < SEND_ATTEMPTS;
      if (!retry || (err.retryAfterMs ?? 0) > maxRateLimitWaitMs) throw err;
      await wait(err.retryAfterMs ?? 200 * 2 ** attempt);
    }
  }
}

export async function sendRaw(chatId: string, text: string): Promise<void> {
  await callWithRetry('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const HTML_TAG = /<\/?[a-z]+>/g;

/** What a person would read, for when Telegram refuses the markup. */
export function stripHtml(html: string): string {
  return html.replace(HTML_TAG, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** A tag, an entity or one whole character: the pieces a split must not cut through. */
const HTML_TOKEN = /<\/?[a-z]+>|&(?:amp|lt|gt);|[\s\S]/gu;

const isTag = (token: string) => token.length > 2 && token.startsWith('<');
const visibleLength = (token: string) => (isTag(token) ? 0 : token.startsWith('&') ? 1 : token.length);

function tagsOpenAfter(tokens: string[], open: string[]): string[] {
  const stack = [...open];
  for (const token of tokens) {
    if (!isTag(token)) continue;
    if (token.startsWith('</')) stack.pop();
    else stack.push(token);
  }
  return stack;
}

/**
 * Cut escaped HTML into messages Telegram accepts, at a line or word break where one is near. Tags
 * still open at a cut are closed there and reopened in the next part, so each part stands alone.
 */
export function splitHtml(html: string, limit = MESSAGE_LIMIT): string[] {
  const parts: string[] = [];
  let tokens: string[] = html.match(HTML_TOKEN) ?? [];
  let open: string[] = [];
  while (tokens.length > 0) {
    let visible = 0;
    let end = 0;
    let lineBreak = 0;
    let wordBreak = 0;
    for (; end < tokens.length; end++) {
      visible += visibleLength(tokens[end]);
      if (visible > limit) break;
      if (tokens[end] === '\n') lineBreak = end + 1;
      else if (tokens[end] === ' ') wordBreak = end + 1;
    }
    // A break early in the part would leave it mostly empty, so only a late one counts.
    const late = (index: number) => index > end / 2;
    const cut = end === tokens.length ? end : late(lineBreak) ? lineBreak : late(wordBreak) ? wordBreak : end;

    const piece = tokens.slice(0, cut);
    const stillOpen = tagsOpenAfter(piece, open);
    const closing = [...stillOpen].reverse().map((tag) => tag.replace('<', '</'));
    const text = [...open, ...piece, ...closing].join('');
    if (stripHtml(text).trim()) parts.push(text);
    open = stillOpen;
    tokens = tokens.slice(cut);
  }
  return parts;
}

const SEVERITY_MARK: Record<Severity, string> = { urgent: '🔴', attention: '🟠', info: '🔵' };

export interface FormattedMessage {
  severity: Severity;
  title: string;
  body?: string | null;
  link?: string | null;
  /** For someone on several farms, which one this is about. */
  farm?: string | null;
  /** Says when it really happened, if it reached them late. */
  note?: string | null;
}

export function formatMessage(m: FormattedMessage): string {
  const lines = [`${SEVERITY_MARK[m.severity]} <b>${escapeHtml(m.title)}</b>`];
  if (m.farm) lines.push(`📍 ${escapeHtml(m.farm)}`);
  if (m.body) lines.push(escapeHtml(m.body));
  if (m.note) lines.push(`<i>${escapeHtml(m.note)}</i>`);
  if (m.link) lines.push(escapeHtml(`${config.WEB_ORIGIN}${m.link}`));
  return lines.join('\n');
}

/** For the outbox, which keeps a rate-limited message for later: the next person's must not wait for it. */
export async function sendTelegram(chatId: string, message: FormattedMessage): Promise<void> {
  await sendHtml(chatId, formatMessage(message), undefined, (method, payload) => callWithRetry(method, payload, 0));
}

export type InlineKeyboard = { text: string; callback_data: string }[][];

/**
 * Inline buttons call back to the bot. A reply keyboard instead sends the button's text as the
 * person's own message, and remove_keyboard takes one away.
 */
export type ReplyMarkup =
  | { inline_keyboard: InlineKeyboard }
  | { keyboard: { text: string }[][]; one_time_keyboard: true; resize_keyboard: true }
  | { remove_keyboard: true };

/** Try with markup, and repeat as plain text when Telegram cannot parse it. */
async function withPlainFallback<T>(html: string, send: (fields: { text: string; parse_mode?: 'HTML' }) => Promise<T>): Promise<T> {
  try {
    return await send({ text: html, parse_mode: 'HTML' });
  } catch (err) {
    if (!(err instanceof TelegramError && /parse entities/i.test(err.description ?? ''))) throw err;
    return send({ text: stripHtml(html) });
  }
}

/** Send escaped HTML, split as needed. Only the last part carries the buttons, and its id comes back. */
export async function sendHtml(
  chatId: string,
  html: string,
  markup?: ReplyMarkup,
  send: <T>(method: string, payload: unknown) => Promise<T> = callWithRetry,
): Promise<number | undefined> {
  const parts = splitHtml(html);
  let messageId: number | undefined;
  for (const [index, part] of parts.entries()) {
    const last = markup && index === parts.length - 1 ? { reply_markup: markup } : {};
    const sent = await withPlainFallback(part, (fields) =>
      send<{ message_id: number }>('sendMessage', { chat_id: chatId, ...fields, disable_web_page_preview: true, ...last }),
    );
    messageId = sent?.message_id;
  }
  return messageId;
}

/** A repeated press shows what is already there, which Telegram reports as an error. */
async function ignoringNoChange(edit: () => Promise<unknown>): Promise<void> {
  try {
    await edit();
  } catch (err) {
    if (!(err instanceof TelegramError && /not modified/i.test(err.description ?? ''))) throw err;
  }
}

/** Replace a message in place. Leaving out the keyboard removes its buttons. */
export async function editHtml(chatId: string, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<void> {
  await ignoringNoChange(() =>
    withPlainFallback(splitHtml(html)[0] ?? '', (fields) =>
      callWithRetry('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        ...fields,
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      }),
    ),
  );
}

/** Take the buttons off a message and leave its text alone. */
export async function clearButtons(chatId: string, messageId: number): Promise<void> {
  await ignoringNoChange(() => callWithRetry('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId }));
}

/** Stops the spinner on the button. Without this the client keeps it for a minute. */
export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) });
}

/** Lasts about five seconds, so anything longer has to repeat it. */
export async function sendTyping(chatId: string): Promise<void> {
  await call('sendChatAction', { chat_id: chatId, action: 'typing' });
}

export async function setCommands(commands: { command: string; description: string }[], languageCode?: string): Promise<void> {
  await call('setMyCommands', {
    commands,
    scope: { type: 'all_private_chats' },
    ...(languageCode ? { language_code: languageCode } : {}),
  });
}

/** A file over the size the caller accepts. */
export class FileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super('file too large');
  }
}

/** Fetch a file a person sent, stopping as soon as it passes `maxBytes`. */
export async function downloadFile(fileId: string, maxBytes: number): Promise<Buffer> {
  let file: { file_path?: string };
  try {
    file = await callWithRetry('getFile', { file_id: fileId });
  } catch (err) {
    if (err instanceof TelegramError && /too big/i.test(err.description ?? '')) throw new FileTooLargeError(maxBytes);
    throw err;
  }
  if (!file.file_path) throw new TelegramError('Telegram getFile returned no path', false);

  const response = await fetch(`${API}/file/bot${token()}/${file.file_path}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new TelegramError(`Telegram file download returned ${response.status}`, response.status >= 500);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new FileTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
}

/** A voice note, audio file, photo size or document. */
export interface TelegramFile {
  file_id: string;
  file_size?: number;
  mime_type?: string;
  duration?: number;
}

export interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  /** "private", "group", "supergroup" or "channel". */
  chat: { id: number; type?: string };
  /** When the person sent it, in Unix seconds. Telegram can hold a message for a day. */
  date?: number;
  from?: TelegramUser;
  /** Present on anything passed on from someone else. Its date is when they wrote it. */
  forward_origin?: { type?: string; date?: number };
  /** The message this one answers, with the buttons it carries now. */
  reply_to_message?: { reply_markup?: { inline_keyboard?: InlineKeyboard } };
  /** Shared by the photos of one album, which arrive as separate updates. */
  media_group_id?: string;
  /** Every page, once the album's updates have been gathered into one. */
  album?: TelegramMessage[];
  text?: string;
  caption?: string;
  voice?: TelegramFile;
  audio?: TelegramFile;
  /** One file in several sizes, smallest first. */
  photo?: TelegramFile[];
  document?: TelegramFile;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  /** Missing when the message is too old for Telegram to send. */
  message?: TelegramMessage;
  /** Ours, not Telegram's: a press takes one answer, and one that waits in a lane gets it early. */
  answered?: boolean;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query'];

async function fetchUpdates(fields: object, signal: AbortSignal): Promise<TelegramUpdate[]> {
  const response = await fetch(`${API}/bot${token()}/getUpdates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...fields, allowed_updates: ALLOWED_UPDATES }),
    signal,
  });
  const body = (await response.json()) as BotResponse<TelegramUpdate[]>;
  if (body.ok) return body.result ?? [];
  const retryAfter = body.parameters?.retry_after;
  throw new TelegramError(body.description ?? 'getUpdates failed', true, retryAfter ? retryAfter * 1000 : undefined);
}

/** Telegram forgets an update once a call asks for what comes after it, and not before. */
export const getUpdates = (offset: number, signal: AbortSignal): Promise<TelegramUpdate[]> =>
  fetchUpdates({ offset, timeout: 25 }, AbortSignal.any([signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]));

/** For a last word on the way down, when no further poll will say which updates were handled. */
export const confirmUpdates = (offset: number): Promise<TelegramUpdate[]> =>
  fetchUpdates({ offset, timeout: 0, limit: 1 }, AbortSignal.timeout(REQUEST_TIMEOUT_MS));

let botUsername: string | null | undefined;

/** @username for the t.me deep link. Cached; null when it cannot be determined. */
export async function getBotUsername(): Promise<string | null> {
  if (!telegramConfigured()) return null;
  if (botUsername) return botUsername;
  try {
    const me = await call<{ username?: string }>('getMe', {});
    botUsername = me.username ?? null;
  } catch {
    return null;
  }
  return botUsername;
}
