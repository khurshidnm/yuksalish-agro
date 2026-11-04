/**
 * Outbound channels (spec 17.3). In-app is the notifications table itself. The rest share this
 * interface, so adding SMS or push means implementing `send` here and nothing else.
 */
import type { Severity } from '@yap/shared';
import { sendTelegram, telegramConfigured } from './telegram';

export interface OutboundMessage {
  severity: Severity;
  title: string;
  body?: string | null;
  link?: string | null;
}

export interface Recipient {
  userId: string;
  telegramChatId?: string | null;
  phone?: string | null;
  email?: string | null;
}

/** Thrown when a message can never be delivered, so retrying is pointless. */
export class PermanentDeliveryError extends Error {}

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
      console.info(`[telegram:not-configured] to ${to.userId}: ${message.title}${message.body ? ` — ${message.body}` : ''}`);
      return;
    }
    if (!to.telegramChatId) throw new PermanentDeliveryError('Telegram is not linked for this user');
    await sendTelegram(to.telegramChatId, message);
  },
};

export const CHANNELS: Record<ExternalChannel, Channel> = {
  telegram,
  push: notConfigured('push'),
  sms: notConfigured('sms'),
  email: notConfigured('email'),
};
