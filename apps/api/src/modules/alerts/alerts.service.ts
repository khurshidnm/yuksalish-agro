import { and, desc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ALERT_STATUSES, SEVERITIES, addDays, type PRIORITIES, type Permission, type RoleKey, type Severity } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { conflict, forbidden, notFound, safeError } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { idParam, isoDate, listQuery, paged, sortBy } from '../../core/query';
import { interpolate, lookup, tr, type Params } from '../notifications/i18n';
import { notifyRole, usersWithRole } from '../notifications/notify.service';
import * as tasks from '../tasks/tasks.service';
import { takeAlert } from './take.service';

const { alerts } = schema;

type Alert = typeof alerts.$inferSelect;

const RANK: Record<Severity, number> = { info: 0, attention: 1, urgent: 2 };

export const ACKNOWLEDGE_PERMISSION: Permission = 'tasks.update';

/** Who hears about a problem, by the first word of its rule key. Callers may override with `notify`. */
const RESPONSIBLE: Record<string, RoleKey[]> = {
  feed: ['zootechnician', 'storekeeper', 'director'],
  ration: ['zootechnician', 'director'],
  stock: ['storekeeper', 'director'],
  batch: ['storekeeper', 'veterinarian'],
  lambing: ['zootechnician', 'veterinarian', 'shepherd'],
  vaccination: ['veterinarian', 'zootechnician'],
  sick: ['veterinarian', 'zootechnician', 'director'],
  quarantine: ['veterinarian', 'zootechnician'],
  animal: ['veterinarian', 'zootechnician', 'director'],
  mortality: ['veterinarian', 'zootechnician', 'director', 'owner'],
  budget: ['accountant', 'director', 'owner'],
  approvals: ['director', 'owner'],
  loan: ['accountant', 'director', 'owner'],
  tasks: ['director'],
  operations: ['agronomist', 'director'],
  document: ['director', 'owner'],
  contract: ['accountant', 'director'],
  maintenance: ['mechanic', 'director'],
  camera: ['director', 'owner'],
  device: ['director', 'owner'],
  fuel: ['director', 'storekeeper'],
  crop: ['agronomist', 'director'],
  satellite: ['agronomist', 'director'],
  frost: ['agronomist', 'director'],
  spray: ['agronomist'],
  heat: ['zootechnician', 'shepherd', 'director'],
  irrigation: ['agronomist', 'director'],
};

const DEFAULT_RESPONSIBLE: RoleKey[] = ['director', 'owner'];

/**
 * Urgent repeats day and night until someone acknowledges (spec 17.3), so it is kept for what can hurt
 * animals or property now. These wait for the working day, whoever raises them and however far off they
 * are: a bot that wakes people for a budget gets muted, and then the fire alert goes unheard.
 */
const NEVER_URGENT = new Set(['budget_overrun', 'document_expiring', 'batch_expiring', 'loan_payment_due', 'ration_deviation', 'ai.feed_anomaly']);

function responsibleRoles(ruleKey: string): RoleKey[] {
  return RESPONSIBLE[ruleKey.split(/[._]/)[0]] ?? DEFAULT_RESPONSIBLE;
}

export interface RaiseAlertInput {
  ruleKey: string;
  dedupKey: string;
  severity: Severity;
  title: string;
  body?: string;
  link?: string;
  entityType?: string;
  entityId?: string;
  source?: 'rule' | 'ai' | 'device';
  /** Values for the text; `alerts:rules.<ruleKey>` in i18n renders it in the reader's language. */
  data?: Record<string, unknown>;
  /** Roles to notify, instead of the default for this rule key. */
  notify?: RoleKey[];
  /** Required to see the alert at all. Set it when the text reveals money. */
  permission?: Permission;
  /**
   * For a discrete event rather than a state that is evaluated again: after this much silence the next
   * one is a new event, whatever became of the last. Anything sooner belongs to the same burst.
   */
  newAfterMs?: number;
  /** Shown in the app and nowhere else, however urgent: it is about the channels themselves. */
  inAppOnly?: boolean;
}

/** A dictionary template is usable only if the alert carries a value for every placeholder. */
function fill(template: string | null, data: Params, locale: string): string | null {
  if (template === null) return null;
  const complete = [...template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].every(([, name]) => data[name] != null);
  return complete ? interpolate(template, data, locale) : null;
}

/** Device event names live in the cameras dictionary. A type no one has named shows as sent. */
function deviceEventName(eventType: string, locale: string): string {
  return lookup(locale, 'cameras', `eventTypes.${eventType.split('.').pop()}`) ?? eventType;
}

/** The reader's language when i18n has this alert, else the text it was raised with. */
export function renderAlert(alert: Pick<Alert, 'ruleKey' | 'title' | 'body' | 'data'>, locale: string) {
  const data = alert.data as Params;

  // An AI alert is a finding, and the `ai` dictionary already words every finding.
  if (typeof data.insightKey === 'string') {
    const params = (data.i18n ?? {}) as Params;
    return {
      title: fill(lookup(locale, 'ai', `insight.${data.insightKey}.title`), params, locale) ?? alert.title,
      body: fill(lookup(locale, 'ai', `insight.${data.insightKey}.body`), params, locale) ?? alert.body,
    };
  }

  const params = typeof data.eventType === 'string' ? { ...data, eventType: deviceEventName(data.eventType, locale) } : data;
  const text = (data.textKey as string | undefined) ?? alert.ruleKey;
  return {
    title: fill(lookup(locale, 'alerts', `rules.${text}.title`), params, locale) ?? alert.title,
    body: fill(lookup(locale, 'alerts', `rules.${text}.body`), params, locale) ?? alert.body,
  };
}

function nextRepeat(count: number): Date {
  // 15 min, 30 min, 1 h, 2 h, then every 4 h until someone acknowledges.
  const minutes = Math.min(15 * 2 ** Math.max(0, count - 1), 240);
  return new Date(Date.now() + minutes * 60_000);
}

async function notifyAlert(alert: Alert, options: { roles?: RoleKey[]; escalated?: boolean; inAppOnly?: boolean } = {}): Promise<void> {
  const body = (locale: string) => renderAlert(alert, locale).body ?? '';
  await notifyRole(
    options.roles ?? (alert.notifyRoles as RoleKey[]),
    {
      severity: alert.severity as Severity,
      title: (locale) => renderAlert(alert, locale).title,
      body: options.escalated ? (locale) => [body(locale), tr(locale, 'alerts', 'bot.escalated')].filter(Boolean).join('\n') : body,
      link: alert.link ?? undefined,
      alertId: alert.id,
      escalated: options.escalated,
      channels: options.inAppOnly ? [] : undefined,
    },
    { permission: alert.permission as Permission | undefined },
  );
}

const journalRaised = (i: RaiseAlertInput, alertId: string) =>
  recordEvent({
    type: 'alert.raised',
    severity: i.severity,
    entityType: i.entityType ?? 'alert',
    entityId: i.entityId ?? alertId,
    data: { ruleKey: i.ruleKey, alertId },
    source: i.source === 'device' ? 'sensor' : i.source === 'ai' ? 'ai' : 'system',
  });

/**
 * Report a problem. While it stays unresolved, raising it again only refreshes it, so calling this
 * on every evaluation is safe. People are told once, and again only if it becomes more severe, or
 * if it is a new event (`newAfterMs`), which also starts the repeats over.
 */
export async function raiseAlert(input: RaiseAlertInput): Promise<{ id: string; created: boolean; escalated: boolean }> {
  const i = input.severity === 'urgent' && NEVER_URGENT.has(input.ruleKey) ? { ...input, severity: 'attention' as const } : input;
  const c = ctx();
  const now = new Date();
  const urgent = i.severity === 'urgent' && !i.inAppOnly;
  const notifyRoles = i.notify ?? responsibleRoles(i.ruleKey);

  const [created] = await tx()
    .insert(alerts)
    .values({
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      source: i.source ?? 'rule',
      ruleKey: i.ruleKey,
      dedupKey: i.dedupKey,
      severity: i.severity,
      title: i.title,
      body: i.body,
      data: i.data ?? {},
      link: i.link,
      entityType: i.entityType,
      entityId: i.entityId,
      notifyRoles,
      permission: i.permission,
      notifyCount: 1,
      nextNotifyAt: urgent ? nextRepeat(1) : null,
      undeliveredSince: urgent ? now : null,
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    await notifyAlert(created, { inAppOnly: i.inAppOnly });
    await journalRaised(i, created.id);
    await autoTask(created);
    return { id: created.id, created: true, escalated: false };
  }

  const [existing] = await tx()
    .select()
    .from(alerts)
    .where(and(eq(alerts.farmId, c.farmId), eq(alerts.dedupKey, i.dedupKey), ne(alerts.status, 'resolved')))
    // Two frames at once must both see the gap the first one closes.
    .for('update');
  if (!existing) return { id: '', created: false, escalated: false };

  const escalated = RANK[i.severity] > RANK[existing.severity as Severity];
  const anew = i.newAfterMs !== undefined && now.getTime() - existing.lastSeenAt.getTime() > i.newAfterMs;
  const tell = escalated || anew;
  const [updated] = await tx()
    .update(alerts)
    .set({
      severity: i.severity,
      title: i.title,
      body: i.body,
      data: i.data ?? {},
      link: i.link,
      lastSeenAt: now,
      // A worse situation or a new event needs a fresh decision, even if an earlier one was acknowledged.
      ...(tell ? { status: 'open', acknowledgedAt: null, acknowledgedBy: null } : {}),
      notifyCount: anew ? 1 : escalated ? existing.notifyCount + 1 : existing.notifyCount,
      nextNotifyAt: urgent ? (tell ? nextRepeat(1) : existing.nextNotifyAt) : null,
      undeliveredSince: urgent ? (tell ? now : existing.undeliveredSince) : null,
    })
    .where(eq(alerts.id, existing.id))
    .returning();
  if (tell) await notifyAlert(updated, { inAppOnly: i.inAppOnly });
  if (anew) await journalRaised(i, existing.id);
  return { id: existing.id, created: false, escalated };
}

/** Nobody responsible can be reached, so this role hears it too, now and on every repeat. */
export async function escalateAlert(alert: Alert, role: RoleKey): Promise<void> {
  await tx().update(alerts).set({ notifyRoles: [...alert.notifyRoles, role] }).where(eq(alerts.id, alert.id));
  await notifyAlert(alert, { roles: [role], escalated: true });
  await recordEvent({
    type: 'alert.escalated',
    severity: 'urgent',
    entityType: alert.entityType ?? 'alert',
    entityId: alert.entityId ?? alert.id,
    data: { ruleKey: alert.ruleKey, alertId: alert.id, role },
  });
}

/** Close an alert because the problem is gone. */
export async function resolveByDedupKey(dedupKey: string): Promise<boolean> {
  const closed = await tx()
    .update(alerts)
    .set({ status: 'resolved', resolvedAt: new Date(), nextNotifyAt: null })
    .where(and(eq(alerts.farmId, ctx().farmId), eq(alerts.dedupKey, dedupKey), ne(alerts.status, 'resolved')))
    .returning({ id: alerts.id });
  await tasks.completeForResolvedAlerts(closed.map((alert) => alert.id));
  return closed.length > 0;
}

/** Repeat unacknowledged urgent alerts (spec 17.3). */
export async function repeatUrgentAlerts(): Promise<number> {
  const due = await tx()
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.farmId, ctx().farmId),
        eq(alerts.severity, 'urgent'),
        eq(alerts.status, 'open'),
        lte(alerts.nextNotifyAt, new Date()),
      ),
    )
    .for('update', { skipLocked: true });
  for (const alert of due) {
    await notifyAlert(alert);
    const notifyCount = alert.notifyCount + 1;
    await tx().update(alerts).set({ notifyCount, nextNotifyAt: nextRepeat(notifyCount) }).where(eq(alerts.id, alert.id));
  }
  return due.length;
}

/**
 * What this user may see: an alert that reveals money needs its permission (rule 7), and staff
 * without the dashboard see only the alerts addressed to their role.
 */
function visible() {
  const c = ctx();
  return and(
    eq(alerts.farmId, c.farmId),
    or(isNull(alerts.permission), inArray(alerts.permission, [...c.permissions, ''])),
    hasPermission('dashboard.view') ? undefined : sql`jsonb_exists(${alerts.notifyRoles}, ${c.roleKey ?? ''})`,
  );
}

export const alertListQuery = listQuery.extend({
  status: z.enum(ALERT_STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  /** Open and acknowledged, i.e. everything not yet resolved. */
  active: z.stringbool().optional(),
  /** One alert, which is how a task links back to the alert it answers. */
  id: idParam.shape.id.optional(),
});

const SEVERITY_ORDER = sql`case ${alerts.severity} when 'urgent' then 0 when 'attention' then 1 else 2 end`;

export async function list(q: z.infer<typeof alertListQuery>) {
  const where = and(
    visible(),
    q.id ? eq(alerts.id, q.id) : undefined,
    q.status ? eq(alerts.status, q.status) : undefined,
    q.active ? ne(alerts.status, 'resolved') : undefined,
    q.severity ? eq(alerts.severity, q.severity) : undefined,
  );
  const page = await paged(q, alerts, where, (limit, offset) =>
    tx()
      .select()
      .from(alerts)
      .where(where)
      .orderBy(
        ...sortBy(q.sort, { createdAt: alerts.createdAt, lastSeenAt: alerts.lastSeenAt }, [SEVERITY_ORDER, desc(alerts.lastSeenAt)], alerts.id),
      )
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: await withTasks(page.data) };
}

/** Each alert with the task that answers it, or null. */
async function withTasks<T extends { id: string }>(rows: T[]) {
  const linked = await tasks.tasksOfAlerts(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, task: linked.get(row.id) ?? null }));
}

export async function get(id: string) {
  const [alert] = await withTasks([await getVisible(id)]);
  return alert;
}

export async function counts() {
  const rows = await tx()
    .select({ severity: alerts.severity, n: sql<number>`count(*)`.mapWith(Number) })
    .from(alerts)
    .where(and(visible(), ne(alerts.status, 'resolved')))
    .groupBy(alerts.severity);
  const bySeverity = { urgent: 0, attention: 0, info: 0 };
  for (const row of rows) bySeverity[row.severity as Severity] = row.n;
  return { ...bySeverity, total: bySeverity.urgent + bySeverity.attention + bySeverity.info };
}

/** An urgent alert repeats until someone takes it, so stopping it belongs to those it was sent to, and to those who answer for the farm. */
function mayStop(alert: Alert): boolean {
  const role = ctx().roleKey ?? '';
  return alert.severity !== 'urgent' || role === 'owner' || role === 'director' || alert.notifyRoles.includes(role);
}

function assertMayStop(alert: Alert): void {
  if (!mayStop(alert)) throw forbidden('Only the people responsible, the owner or the director can stop this urgent alert', 'ALERT_NOT_YOURS');
}

async function getVisible(id: string): Promise<Alert> {
  const [alert] = await tx().select().from(alerts).where(and(eq(alerts.id, id), visible()));
  if (!alert) throw notFound('Alert');
  return alert;
}

/** Whoever comes second, from the app or the bot, finds it taken. */
const take = (alert: Alert): Promise<Alert | undefined> => takeAlert(alert.id);

export async function acknowledge(id: string) {
  const alert = await getVisible(id);
  assertMayStop(alert);
  const row = await take(alert);
  if (!row) throw conflict('ALERT_NOT_OPEN', 'This alert is not open');
  return row;
}

export type ButtonOutcome = 'acknowledged' | 'taken' | 'no_right';

/** The button on a Telegram message, by the rules of the route. Null when this farm shows them no such alert. */
export async function acknowledgeByButton(id: string): Promise<ButtonOutcome | null> {
  const [alert] = await tx().select().from(alerts).where(and(eq(alerts.id, id), visible()));
  if (!alert) return null;
  if (!hasPermission(ACKNOWLEDGE_PERMISSION) || !mayStop(alert)) return 'no_right';
  return (await take(alert)) ? 'acknowledged' : 'taken';
}

export async function resolve(id: string) {
  const alert = await getVisible(id);
  assertMayStop(alert);
  if (alert.status === 'resolved') throw conflict('ALERT_ALREADY_RESOLVED', 'This alert is already resolved');
  const [row] = await tx()
    .update(alerts)
    .set({ status: 'resolved', resolvedAt: new Date(), nextNotifyAt: null })
    .where(eq(alerts.id, id))
    .returning();
  await recordEvent({ type: 'alert.resolved', entityType: 'alert', entityId: id, data: { ruleKey: alert.ruleKey } });
  await tasks.completeForResolvedAlerts([id]);
  return row;
}

// ─── Tasks ─────────────────────────────────────────────────────────────────

/** Starting values, not policy from the farm or the spec: how pressing a problem's task is. */
export const ALERT_TASK_PRIORITY: Record<Severity, (typeof PRIORITIES)[number]> = { urgent: 'high', attention: 'normal', info: 'low' };

/** Starting values: days from today until the task is due when nobody chose a date. Urgent is today. */
export const ALERT_TASK_DUE_DAYS: Record<Severity, number> = { urgent: 0, attention: 2, info: 7 };

export const alertTaskInput = z.object({
  assigneeUserId: z.uuid().nullish(),
  dueDate: isoDate.nullish(),
});

/**
 * What the task says. An alert that needs a permission says things not everyone may read, such as
 * an amount, and a task is read by whoever it is given to. So its task names the kind of problem
 * and nothing else: the figures stay on the alert, behind its permission.
 */
function taskText(alert: Alert, locale: string): { title: string; description: string | null } {
  if (alert.permission) {
    const rule = lookup(locale, 'alerts', `ruleNames.${alert.ruleKey}`);
    return {
      title: rule ? tr(locale, 'alerts', 'task.restrictedTitle', { rule }) : tr(locale, 'alerts', 'task.restrictedTitleUnnamed'),
      description: tr(locale, 'alerts', 'task.restrictedDescription'),
    };
  }
  const text = renderAlert(alert, locale);
  return { title: text.title, description: text.body?.slice(0, 2000) || null };
}

/** The one way an alert gets a task, pressed or automatic. */
async function taskFor(alert: Alert, options: { assigneeUserId: string | null; dueDate: string | null; auto: boolean }) {
  const severity = alert.severity as Severity;
  // A task links to a field, herd, animal or asset. An alert about anything else keeps its page link.
  const linkable = alert.entityId !== null && (tasks.ENTITY_TYPES as readonly string[]).includes(alert.entityType ?? '');
  return tasks.createForAlert({
    alertId: alert.id,
    ...taskText(alert, await tasks.workspaceLocale()),
    priority: ALERT_TASK_PRIORITY[severity],
    dueDate: options.dueDate ?? addDays(today(), ALERT_TASK_DUE_DAYS[severity]),
    assigneeUserId: options.assigneeUserId,
    entityType: linkable ? alert.entityType : null,
    entityId: linkable ? alert.entityId : null,
    link: alert.link,
    auto: options.auto,
  });
}

/**
 * Turn an alert into a task. Asking again while that task is open gives the same task back, so a
 * second press, or a second person, changes nothing.
 */
export async function createTask(id: string, input: z.infer<typeof alertTaskInput>) {
  const alert = await getVisible(id);
  if (alert.status === 'resolved') throw conflict('ALERT_ALREADY_RESOLVED', 'This alert is already resolved');
  await tasks.assertAssignable(input.assigneeUserId);
  const { id: taskId, created } = await taskFor(alert, {
    assigneeUserId: input.assigneeUserId ?? null,
    dueDate: input.dueDate ?? null,
    auto: false,
  });
  return { created, task: await tasks.get(taskId) };
}

/** The person a role points at, when it points at exactly one. Two shepherds means nobody is chosen for them. */
async function soleHolder(role: RoleKey): Promise<string | null> {
  const holders = [...new Set(await usersWithRole(role))];
  return holders.length === 1 ? holders[0] : null;
}

/**
 * The farm asked for a task whenever this rule finds a new problem. Inside a savepoint: a task that
 * cannot be created must not take the alert down with it.
 */
async function autoTask(alert: Alert): Promise<void> {
  const rule = ctx().settings.alerts.autoTask[alert.ruleKey];
  if (!rule?.enabled) return;
  try {
    await tx().transaction(async () => {
      const assigneeUserId = rule.assigneeRole ? await soleHolder(rule.assigneeRole) : null;
      await taskFor(alert, { assigneeUserId, dueDate: null, auto: true });
    });
  } catch (error) {
    console.error(`[alerts] task for ${alert.ruleKey} was not created`, safeError(error));
  }
}

/** Every rule a farm can switch a task on for, with what it has chosen. */
export function autoTaskRules(ruleKeys: string[]) {
  const chosen = ctx().settings.alerts.autoTask;
  return ruleKeys.map((ruleKey) => ({
    ruleKey,
    enabled: chosen[ruleKey]?.enabled ?? false,
    assigneeRole: chosen[ruleKey]?.assigneeRole ?? null,
  }));
}

/** Newest and most severe first, for dashboards. */
export async function latest(limit: number) {
  return tx()
    .select()
    .from(alerts)
    .where(and(visible(), ne(alerts.status, 'resolved')))
    .orderBy(SEVERITY_ORDER, desc(alerts.lastSeenAt))
    .limit(limit);
}
