import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { day, pk, ts } from './_helpers';
import { tenantColumns } from './_tenant';
import { files } from './core';
import { farms, tenants, users } from './platform';

export const tasks = pgTable(
  'tasks',
  {
    id: pk(),
    ...tenantColumns(),
    title: text().notNull(),
    description: text(),
    assigneeUserId: uuid().references(() => users.id),
    dueDate: day(),
    priority: text().notNull().default('normal'),
    status: text().notNull().default('open'),
    division: text(),
    /** Linked object: 'field', 'herd', 'asset'... */
    entityType: text(),
    entityId: uuid(),
    recurrence: text().notNull().default('none'),
    /** Completed copies of a recurring task point at the template. */
    templateId: uuid(),
    requiresPhoto: boolean().notNull().default(false),
    /** Task closes only with a record of this type, e.g. 'health_record' (spec 17.2). */
    requiresRecord: text(),
    completedAt: ts(),
    completedBy: uuid().references(() => users.id),
    completionNote: text(),
    completionPhotoFileId: uuid().references(() => files.id),
    /** The record that closed the task, when `requiresRecord` is set. */
    completionRecordId: uuid(),
  },
  (t) => [
    index().on(t.farmId, t.status, t.dueDate),
    index().on(t.assigneeUserId, t.status),
    // A recurring task has at most one instance per date, so the job can run any number of times.
    uniqueIndex('tasks_template_due_idx').on(t.templateId, t.dueDate).where(sql`template_id IS NOT NULL`),
  ],
);

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: pk(),
    ...tenantColumns(),
    title: text().notNull(),
    date: day().notNull(),
    endDate: day(),
    kind: text().notNull().default('meeting'),
    responsibleUserId: uuid().references(() => users.id),
    division: text(),
    entityType: text(),
    entityId: uuid(),
    notes: text(),
  },
  (t) => [index().on(t.farmId, t.date)],
);

/** Alert: one open problem. `dedupKey` keeps a re-evaluated rule from creating duplicates. */
export const alerts = pgTable(
  'alerts',
  {
    id: pk(),
    ...tenantColumns(),
    /** 'rule', 'ai' or 'device'. */
    source: text().notNull().default('rule'),
    ruleKey: text().notNull(),
    dedupKey: text().notNull(),
    severity: text().notNull(),
    status: text().notNull().default('open'),
    title: text().notNull(),
    body: text(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    link: text(),
    entityType: text(),
    entityId: uuid(),
    lastSeenAt: ts().notNull().defaultNow(),
    acknowledgedBy: uuid().references(() => users.id),
    acknowledgedAt: ts(),
    resolvedAt: ts(),
    /** Urgent alerts repeat until acknowledged (spec 17.3). */
    notifyCount: integer().notNull().default(0),
    nextNotifyAt: ts(),
    /** Role keys that are told about this alert and may see it without dashboard access. */
    notifyRoles: jsonb().$type<string[]>().notNull().default([]),
    /** Only holders of this permission may see the alert, e.g. 'finance.view' when it shows money. */
    permission: text(),
  },
  (t) => [
    index().on(t.farmId, t.status, t.severity),
    index().on(t.farmId, t.dedupKey),
    // At most one unresolved alert per problem.
    uniqueIndex('alerts_open_dedup_idx').on(t.farmId, t.dedupKey).where(sql`status <> 'resolved'`),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    tenantId: uuid().notNull().references(() => tenants.id),
    farmId: uuid().references(() => farms.id),
    userId: uuid().notNull().references(() => users.id),
    /** Selects the user's channel preferences, e.g. 'alert_urgent', 'daily_summary'. */
    eventType: text(),
    severity: text().notNull().default('info'),
    title: text().notNull(),
    body: text(),
    link: text(),
    alertId: uuid(),
    /** The reader must still hold this when it goes out or is read, e.g. 'finance.view' when the text shows money. */
    permission: text(),
    /** Delivery state per external channel, e.g. { telegram: 'sent' }. */
    deliveries: jsonb().$type<Record<string, string>>().notNull().default({}),
    readAt: ts(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.readAt), index().on(t.tenantId, t.createdAt.desc())],
);

/** Per-user channel choice per event type (spec 17.3). */
export const notificationPrefs = pgTable(
  'notification_prefs',
  {
    id: pk(),
    tenantId: uuid().notNull().references(() => tenants.id),
    userId: uuid().notNull().references(() => users.id),
    eventType: text().notNull(),
    channels: jsonb().$type<string[]>().notNull(),
  },
  (t) => [unique().on(t.userId, t.tenantId, t.eventType)],
);

/** One-time codes for linking a Telegram chat: /start <code>. */
export const telegramLinkCodes = pgTable('telegram_link_codes', {
  code: text().primaryKey(),
  userId: uuid().notNull().references(() => users.id),
  expiresAt: ts().notNull(),
  usedAt: ts(),
});
