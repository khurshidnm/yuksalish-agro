import type { ALERT_STATUSES, SEVERITIES, TASK_COMPLETION_SOURCES, TASK_STATUSES } from '@yap/shared';

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
  /** The task that answers this alert, for those who may see tasks: the open one, else the last one done. */
  task?: AlertTask | null;
}

export interface AlertTask {
  id: string;
  status: (typeof TASK_STATUSES)[number];
  dueDate: string | null;
  assigneeUserId: string | null;
  /** Null without `pii.view`, and when nobody is assigned. */
  assigneeName: string | null;
  completionSource: (typeof TASK_COMPLETION_SOURCES)[number] | null;
}

/** Whether an alert takes its rule's task by itself, and whose it becomes. */
export interface AutoTaskRule {
  ruleKey: string;
  enabled: boolean;
  assigneeRole: string | null;
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

/** A decision the reader can take from the message. The server says which still apply, and decides again. */
export interface NotificationButton {
  key: string;
  /** "namespace:key" in the dictionaries. */
  label: string;
  tone?: 'primary' | 'danger';
  needsReason?: boolean;
}

/** What became of the decision, once no button is left: "Accepted · 09.11 04:29". */
export interface NotificationActionState {
  /** "namespace:key" in the dictionaries. */
  label: string;
  tone?: 'success' | 'danger' | 'neutral';
  at?: string | null;
}

export interface NotificationRow {
  id: string;
  eventType: string | null;
  severity: (typeof SEVERITIES)[number];
  title: string;
  body: string | null;
  link: string | null;
  action: { kind: string; id: string; buttons: NotificationButton[]; state?: NotificationActionState | null } | null;
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
