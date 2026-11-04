import type { ALERT_STATUSES, SEVERITIES } from '@yap/shared';

export interface Alert {
  id: string;
  source: string;
  ruleKey: string;
  severity: (typeof SEVERITIES)[number];
  status: (typeof ALERT_STATUSES)[number];
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  link: string | null;
  lastSeenAt: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

export interface AlertCounts {
  urgent: number;
  attention: number;
  info: number;
  total: number;
}

export interface EvaluationResult {
  raised: number;
  refreshed: number;
  escalated: number;
  resolved: number;
  failedRules: string[];
}

export interface NotificationRow {
  id: string;
  eventType: string | null;
  severity: (typeof SEVERITIES)[number];
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface Preferences {
  channels: { key: string; configured: boolean }[];
  events: { eventType: string; channels: string[]; isDefault: boolean }[];
}

export interface TelegramStatus {
  configured: boolean;
  linked: boolean;
  botUsername: string | null;
}

export interface TelegramLink {
  code: string;
  expiresAt: string;
  botUsername: string | null;
  deepLink: string | null;
}
