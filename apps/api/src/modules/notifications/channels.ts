/**
 * Outbound channels (spec 17.3). In-app is the notifications table itself. The rest share this
 * interface, so adding SMS or push means implementing `send` here and nothing else.
 */
import { sendTelegram, telegramConfigured, TelegramError, type FormattedMessage } from './telegram';

export type OutboundMessage = FormattedMessage;

export interface Recipient {
  userId: string;
  telegramChatId?: string | null;
  phone?: string | null;
  email?: string | null;
}

/** Thrown when a message can never be delivered, so retrying is pointless. */
export class PermanentDeliveryError extends Error {}

/** Thrown when the provider asks for a pause. Not a failure: the message simply goes out after it. */
export class RetryLaterError extends Error {
  constructor(readonly afterMs: number) {
    super(`Retry after ${afterMs} ms`);
  }
}

export interface Channel {
  key: ExternalChannel;
  configured(): boolean;
  send(to: Recipient, message: OutboundMessage): Promise<void>;
}

export const EXTERNAL_CHANNELS = ['telegram', 'push', 'sms', 'email'] as const;
export type ExternalChannel = (typeof EXTERNAL_CHANNELS)[number];

/** A channel with no provider yet: it records the attempt in the log and reports itself unconfigured. */
function notConfigured(key: ExternalChannel): Channel {
  return {
    key,
    configured: () => false,
    async send(to, message) {
      console.info(`[${key}:not-configured] to ${to.userId}: ${message.title}`);
    },
  };
}

const telegram: Channel = {
  key: 'telegram',
  configured: telegramConfigured,
  async send(to, message) {
    if (!telegramConfigured()) {
      console.info(`[telegram:not-configured] to ${to.userId}: ${message.title}`);
      return;
    }
    if (!to.telegramChatId) throw new PermanentDeliveryError('Telegram is not linked for this user');
    try {
      await sendTelegram(to.telegramChatId, message);
    } catch (err) {
      if (!(err instanceof TelegramError)) throw err;
      if (err.retryAfterMs) throw new RetryLaterError(err.retryAfterMs);
      // Blocked the bot, or the chat is gone. A bad token is 401 and still counts as an outage.
      if (err.status === 400 || err.status === 403) throw new PermanentDeliveryError(err.message);
      throw err;
    }
  },
};

export const CHANNELS: Record<ExternalChannel, Channel> = {
  telegram,
  push: notConfigured('push'),
  sms: notConfigured('sms'),
  email: notConfigured('email'),
};
