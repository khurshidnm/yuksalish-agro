/**
 * Telegram Bot API over fetch (spec 17.3, 19). With no TELEGRAM_BOT_TOKEN the channel reports
 * itself as not configured and messages go to the log, so nothing else has to care.
 */
import type { Severity } from '@yap/shared';
import { config } from '../../config';

const API = 'https://api.telegram.org';
const SEND_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

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
  );
}

/** sendMessage with a short in-process retry. The outbox retries over a longer horizon. */
export async function sendRaw(chatId: string, text: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
      return;
    } catch (err) {
      const retry = err instanceof TelegramError && err.retryable && attempt < SEND_ATTEMPTS;
      if (!retry) throw err;
      await wait(err.retryAfterMs ?? 200 * 2 ** attempt);
    }
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SEVERITY_MARK: Record<Severity, string> = { urgent: '🔴', attention: '🟠', info: '🔵' };

export function formatMessage(m: {
  severity: Severity;
  title: string;
  body?: string | null;
  link?: string | null;
}): string {
  const lines = [`${SEVERITY_MARK[m.severity]} <b>${escapeHtml(m.title)}</b>`];
  if (m.body) lines.push(escapeHtml(m.body));
  if (m.link) lines.push(escapeHtml(`${config.WEB_ORIGIN}${m.link}`));
  return lines.join('\n');
}

export function sendTelegram(
  chatId: string,
  message: { severity: Severity; title: string; body?: string | null; link?: string | null },
): Promise<void> {
  return sendRaw(chatId, formatMessage(message));
}

export interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number } };
}

export function getUpdates(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
  return fetch(`${API}/bot${token()}/getUpdates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offset, timeout: 25, allowed_updates: ['message'] }),
    signal,
  }).then(async (response) => {
    const body = (await response.json()) as BotResponse<TelegramUpdate[]>;
    if (!body.ok) throw new TelegramError(body.description ?? 'getUpdates failed', true);
    return body.result ?? [];
  });
}

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
