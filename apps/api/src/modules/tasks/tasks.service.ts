import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { PRIORITIES, RECURRENCES, TASK_STATUSES, diffDays, addDays, monthOf, monthRange, todayIso, type Permission, type TASK_COMPLETION_SOURCES } from '@yap/shared';
import { tasksOnTime, type AssignedTask, type TasksOnTime } from '@yap/shared/formulas/kpi';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { badRequest, conflict, forbidden, notFound, uniqueViolation } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { hidePii } from '../../core/privacy';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { takeAlert } from '../alerts/take.service';
import { notifyUser } from '../notifications/notify.service';
import { tr } from '../notifications/i18n';

const { animals, assets, dailyLogs, fieldOperations, fields, files, healthRecords, herds, memberships, tasks: t, tenants, users, weightRecords } = schema;

type Task = typeof t.$inferSelect;
type CompletionSource = (typeof TASK_COMPLETION_SOURCES)[number];

/** The index that allows an alert one task that is not closed. */
const OPEN_ALERT_TASK_INDEX = 'tasks_open_alert_idx';

/**
 * Record types a task can demand before it may be closed (spec 17.2). `vaccination_record` is a
 * health record of type vaccination: a routine examination must not close a vaccination task.
 */
export const RECORD_TYPES = ['health_record', 'vaccination_record', 'field_operation', 'daily_log', 'weight_record'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const ENTITY_TYPES = ['field', 'herd', 'animal', 'asset'] as const;

const taskFields = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  assigneeUserId: z.uuid().nullish(),
  dueDate: isoDate.nullish(),
  priority: z.enum(PRIORITIES),
  division: z.string().trim().max(50).nullish(),
  entityType: z.enum(ENTITY_TYPES).nullish(),
  entityId: z.uuid().nullish(),
  requiresPhoto: z.boolean(),
  requiresRecord: z.enum(RECORD_TYPES).nullish(),
});

export const taskInput = taskFields.extend({
  id: clientId,
  priority: z.enum(PRIORITIES).default('normal'),
  requiresPhoto: z.boolean().default(false),
  recurrence: z.enum(RECURRENCES).default('none'),
});
export type TaskInput = z.infer<typeof taskInput>;

/**
 * Built from the fields without defaults: in zod 4 a default survives `.partial()`, so a PATCH of
 * the title alone would otherwise reset the priority.
 */
export const taskPatch = taskFields.partial();

export const completeInput = z.object({
  note: z.string().trim().max(1000).nullish(),
  photoFileId: z.uuid().nullish(),
  recordId: z.uuid().nullish(),
});

export const taskListQuery = listQuery.extend({
  status: z.enum(TASK_STATUSES).optional(),
  /** open + in_progress */
  active: z.stringbool().optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeUserId: z.uuid().optional(),
  mine: z.stringbool().optional(),
  division: z.string().optional(),
  entityType: z.enum(ENTITY_TYPES).optional(),
  entityId: z.uuid().optional(),
  dueFrom: isoDate.optional(),
  dueTo: isoDate.optional(),
  overdue: z.stringbool().optional(),
  /** Recurring series instead of ordinary tasks. */
  recurring: z.stringbool().optional(),
  /** The tasks one alert has had. */
  alertId: z.uuid().optional(),
});

/** Whoever may create tasks runs the board. Everyone else sees and works their own. */
export const canManage = (): boolean => hasPermission('tasks.create' as Permission);

function assertManager(): void {
  if (!canManage()) throw forbidden('Only a manager can change this task');
}

function visible(): SQL | undefined {
  const c = ctx();
  return and(eq(t.farmId, c.farmId), canManage() ? undefined : eq(t.assigneeUserId, c.userId ?? ''));
}

const columns = {
  id: t.id,
  title: t.title,
  description: t.description,
  assigneeUserId: t.assigneeUserId,
  assigneeName: users.fullName,
  dueDate: t.dueDate,
  priority: t.priority,
  status: t.status,
  division: t.division,
  entityType: t.entityType,
  entityId: t.entityId,
  recurrence: t.recurrence,
  templateId: t.templateId,
  requiresPhoto: t.requiresPhoto,
  requiresRecord: t.requiresRecord,
  completedAt: t.completedAt,
  completedBy: t.completedBy,
  completionNote: t.completionNote,
  completionPhotoFileId: t.completionPhotoFileId,
  completionRecordId: t.completionRecordId,
  completionSource: t.completionSource,
  alertId: t.alertId,
  link: t.link,
  createdAt: t.createdAt,
};

const ENTITY_LINKS: Record<string, (id: string) => string> = {
  field: (id) => `/farm/fields/${id}`,
  herd: (id) => `/livestock/herds/${id}`,
  animal: (id) => `/livestock/animals/${id}`,
  asset: (id) => `/assets/${id}`,
};

/** Show "Dala 3" rather than a bare id, for whichever object a task is linked to. */
async function withEntityLabels<T extends { entityType: string | null; entityId: string | null }>(rows: T[]) {
  const ids = (type: string) => rows.filter((r) => r.entityType === type && r.entityId).map((r) => r.entityId!);
  const labels = new Map<string, string>();
  const load = async (type: string, fetch: (ids: string[]) => Promise<{ id: string; label: string | null }[]>) => {
    const wanted = ids(type);
    if (wanted.length === 0) return;
    for (const row of await fetch(wanted)) if (row.label) labels.set(row.id, row.label);
  };
  await load('field', (i) => tx().select({ id: fields.id, label: fields.number }).from(fields).where(inArray(fields.id, i)));
  await load('herd', (i) => tx().select({ id: herds.id, label: herds.name }).from(herds).where(inArray(herds.id, i)));
  await load('animal', (i) => tx().select({ id: animals.id, label: animals.tag }).from(animals).where(inArray(animals.id, i)));
  await load('asset', (i) => tx().select({ id: assets.id, label: assets.name }).from(assets).where(inArray(assets.id, i)));
  return rows.map((row) => ({
    ...row,
    entityLabel: row.entityId ? (labels.get(row.entityId) ?? null) : null,
    entityLink: row.entityId && row.entityType ? (ENTITY_LINKS[row.entityType]?.(row.entityId) ?? null) : null,
  }));
}

export async function list(q: z.infer<typeof taskListQuery>) {
  const c = ctx();
  const now = today();
  const where = and(
    visible(),
    q.recurring ? and(ne(t.recurrence, 'none'), isNull(t.templateId)) : eq(t.recurrence, 'none'),
    q.status ? eq(t.status, q.status) : undefined,
    q.active ? inArray(t.status, ['open', 'in_progress']) : undefined,
    q.priority ? eq(t.priority, q.priority) : undefined,
    q.assigneeUserId ? eq(t.assigneeUserId, q.assigneeUserId) : undefined,
    q.mine ? eq(t.assigneeUserId, c.userId ?? '') : undefined,
    q.division ? eq(t.division, q.division) : undefined,
    q.entityType ? eq(t.entityType, q.entityType) : undefined,
    q.entityId ? eq(t.entityId, q.entityId) : undefined,
    q.alertId ? eq(t.alertId, q.alertId) : undefined,
    q.dueFrom ? sql`${t.dueDate} >= ${q.dueFrom}::date` : undefined,
    q.dueTo ? sql`${t.dueDate} <= ${q.dueTo}::date` : undefined,
    q.overdue ? and(lt(t.dueDate, now), inArray(t.status, ['open', 'in_progress'])) : undefined,
    searchAny(q.search, [t.title, t.description]),
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select(columns)
      .from(t)
      .leftJoin(users, eq(users.id, t.assigneeUserId))
      .where(where)
      .orderBy(
        ...sortBy(
          q.sort,
          { dueDate: t.dueDate, priority: t.priority, status: t.status, title: t.title, createdAt: t.createdAt, completedAt: t.completedAt },
          [sql`${t.dueDate} asc nulls last`, desc(t.createdAt)],
          t.id,
        ),
      )
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: await withEntityLabels(page.data) };
}

async function getRow(id: string): Promise<Task> {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), visible()));
  if (!row) throw notFound('Task');
  return row;
}

export async function get(id: string) {
  const [row] = await tx().select(columns).from(t).leftJoin(users, eq(users.id, t.assigneeUserId)).where(and(eq(t.id, id), visible()));
  if (!row) throw notFound('Task');
  const [labelled] = await withEntityLabels([row]);
  return labelled;
}

export async function assertAssignable(userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  const [member] = await tx()
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.farmId, ctx().farmId), eq(memberships.userId, userId), eq(memberships.status, 'active')));
  if (!member) throw badRequest('ASSIGNEE_NOT_MEMBER', 'This person does not work on this farm');
}

async function announceAssignment(task: Pick<Task, 'id' | 'title' | 'assigneeUserId' | 'dueDate'>): Promise<void> {
  if (!task.assigneeUserId || task.assigneeUserId === ctx().userId) return;
  await notifyUser(task.assigneeUserId, {
    eventType: 'task_assigned',
    severity: 'info',
    title: (locale) => tr(locale, 'tasks', 'notification.assigned'),
    body: task.title,
    link: '/tasks',
  });
}

export async function create(input: TaskInput) {
  const c = ctx();
  await assertAssignable(input.assigneeUserId);
  const { id, ...values } = input;
  const recurring = values.recurrence !== 'none';
  const [row] = await tx()
    .insert(t)
    .values({
      ...(id ? { id } : {}),
      ...values,
      // A series needs a first date.
      dueDate: values.dueDate ?? (recurring ? today() : null),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
    })
    .returning();
  await recordEvent({ type: 'task.created', entityType: 'task', entityId: row.id, data: { title: row.title } });
  if (recurring) await spawnInstance(row, today());
  else await announceAssignment(row);
  return get(row.id);
}

export async function update(id: string, input: z.infer<typeof taskPatch>) {
  assertManager();
  const before = await getRow(id);
  await assertAssignable(input.assigneeUserId);
  const [row] = await tx().update(t).set(input).where(eq(t.id, id)).returning();
  if (input.assigneeUserId && input.assigneeUserId !== before.assigneeUserId) await announceAssignment(row);
  return get(id);
}

export async function start(id: string) {
  const task = await getRow(id);
  if (task.status !== 'open') throw conflict('TASK_NOT_OPEN', 'Only an open task can be started');
  await tx().update(t).set({ status: 'in_progress' }).where(eq(t.id, id));
  return get(id);
}

async function fileBelongsToFarm(fileId: string): Promise<boolean> {
  const [file] = await tx()
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.farmId, ctx().farmId)));
  return Boolean(file);
}

const RECORD_LIMIT = 20;

/**
 * The first day a record can close this task: the business day the task was set. Work recorded
 * before the task existed is not the work it asks for, so last month's vaccination cannot close
 * this month's vaccination task. A recurring instance counts from the day it was created.
 */
export function recordsFrom(task: Pick<Task, 'createdAt'>, timeZone: string): string {
  return todayIso(timeZone, task.createdAt);
}

/**
 * Records of the required type, dated on or after the day the task was set, and limited to the
 * task's linked object when it has one. The completion check uses the same query, so the server
 * accepts exactly what the picker offers.
 */
async function findRecords(task: Task, onlyId?: string): Promise<{ id: string; date: string; label: string | null }[]> {
  const c = ctx();
  const farmId = c.farmId;
  const from = recordsFrom(task, c.timezone);
  const linked = (type: string) => (task.entityType === type && task.entityId ? task.entityId : null);

  switch (task.requiresRecord as RecordType) {
    case 'health_record':
    case 'vaccination_record': {
      const herdId = linked('herd');
      const animalId = linked('animal');
      return tx()
        .select({ id: healthRecords.id, date: healthRecords.date, label: healthRecords.type })
        .from(healthRecords)
        .where(
          and(
            eq(healthRecords.farmId, farmId),
            onlyId ? eq(healthRecords.id, onlyId) : undefined,
            gte(healthRecords.date, from),
            task.requiresRecord === 'vaccination_record' ? eq(healthRecords.type, 'vaccination') : undefined,
            herdId
              ? or(
                  eq(healthRecords.herdId, herdId),
                  sql`${healthRecords.animalId} in (select id from animals where herd_id = ${herdId})`,
                )
              : undefined,
            animalId ? eq(healthRecords.animalId, animalId) : undefined,
          ),
        )
        .orderBy(desc(healthRecords.date))
        .limit(RECORD_LIMIT);
    }
    case 'field_operation': {
      const fieldId = linked('field');
      return tx()
        .select({ id: fieldOperations.id, date: fieldOperations.date, label: fieldOperations.type })
        .from(fieldOperations)
        .where(
          and(
            eq(fieldOperations.farmId, farmId),
            onlyId ? eq(fieldOperations.id, onlyId) : undefined,
            gte(fieldOperations.date, from),
            // A planned operation is not yet work done.
            ne(fieldOperations.status, 'planned'),
            fieldId ? eq(fieldOperations.fieldId, fieldId) : undefined,
          ),
        )
        .orderBy(desc(fieldOperations.date))
        .limit(RECORD_LIMIT);
    }
    case 'daily_log': {
      const herdId = linked('herd');
      return tx()
        .select({ id: dailyLogs.id, date: dailyLogs.date, label: dailyLogs.condition })
        .from(dailyLogs)
        .where(
          and(
            eq(dailyLogs.farmId, farmId),
            onlyId ? eq(dailyLogs.id, onlyId) : undefined,
            gte(dailyLogs.date, from),
            herdId ? eq(dailyLogs.herdId, herdId) : undefined,
          ),
        )
        .orderBy(desc(dailyLogs.date))
        .limit(RECORD_LIMIT);
    }
    case 'weight_record': {
      const animalId = linked('animal');
      return tx()
        .select({ id: weightRecords.id, date: weightRecords.date, label: weightRecords.method })
        .from(weightRecords)
        .where(
          and(
            eq(weightRecords.farmId, farmId),
            onlyId ? eq(weightRecords.id, onlyId) : undefined,
            gte(weightRecords.date, from),
            animalId ? eq(weightRecords.animalId, animalId) : undefined,
          ),
        )
        .orderBy(desc(weightRecords.date))
        .limit(RECORD_LIMIT);
    }
  }
}

/** Records that could close this task, for the completion form. */
export async function recordCandidates(id: string) {
  const task = await getRow(id);
  return task.requiresRecord ? findRecords(task) : [];
}

export async function complete(id: string, input: z.infer<typeof completeInput>) {
  const task = await getRow(id);
  if (task.recurrence !== 'none') throw conflict('TASK_IS_SERIES', 'A recurring series cannot be completed');
  if (task.status !== 'open' && task.status !== 'in_progress') {
    throw conflict('TASK_NOT_ACTIVE', 'This task is already closed');
  }
  if (task.requiresPhoto) {
    if (!input.photoFileId) throw badRequest('PHOTO_REQUIRED', 'This task needs a photo');
    if (!(await fileBelongsToFarm(input.photoFileId))) throw badRequest('PHOTO_REQUIRED', 'This task needs a photo');
  }
  if (task.requiresRecord) {
    if (!input.recordId) {
      throw badRequest('RECORD_REQUIRED', 'This task closes only with a linked record', { requires: task.requiresRecord });
    }
    const [match] = await findRecords(task, input.recordId);
    if (!match) {
      throw badRequest('RECORD_REQUIRED', 'This task closes only with a linked record', { requires: task.requiresRecord });
    }
  }

  const c = ctx();
  await tx()
    .update(t)
    .set({
      status: 'done',
      completedAt: new Date(),
      completedBy: c.userId,
      completionSource: 'person' satisfies CompletionSource,
      completionNote: input.note,
      completionPhotoFileId: input.photoFileId,
      completionRecordId: input.recordId,
    })
    .where(eq(t.id, id));
  await recordEvent({
    type: 'task.completed',
    entityType: 'task',
    entityId: id,
    photoFileId: input.photoFileId,
    data: { title: task.title, recordId: input.recordId ?? null },
  });
  // The work is done, so the alert has an owner. Whether the problem is gone is for its rule to say:
  // the alert stays until the rule stops finding it. The person was given this task, so they may take
  // the alert even when it is urgent and was not sent to their role.
  if (task.alertId) await takeAlert(task.alertId);
  return get(id);
}

/** Cancel a task, or stop a recurring series. */
export async function cancel(id: string) {
  assertManager();
  const task = await getRow(id);
  if (task.status === 'done' || task.status === 'cancelled') throw conflict('TASK_NOT_ACTIVE', 'This task is already closed');
  await tx().update(t).set({ status: 'cancelled' }).where(eq(t.id, id));
  await recordEvent({ type: 'task.cancelled', entityType: 'task', entityId: id });
  return get(id);
}

export async function reopen(id: string) {
  assertManager();
  const task = await getRow(id);
  if (task.status !== 'done' && task.status !== 'cancelled') throw conflict('TASK_NOT_CLOSED', 'This task is not closed');
  try {
    await tx()
      .update(t)
      .set({
        status: 'open',
        completedAt: null,
        completedBy: null,
        completionSource: null,
        completionNote: null,
        completionPhotoFileId: null,
        completionRecordId: null,
      })
      .where(eq(t.id, id));
  } catch (error) {
    // Its alert got a new task in the meantime, and an alert has one open task.
    if (uniqueViolation(error) === OPEN_ALERT_TASK_INDEX) {
      throw conflict('ALERT_TASK_EXISTS', 'The alert behind this task already has another open task');
    }
    throw error;
  }
  return get(id);
}

export async function remove(id: string) {
  await getRow(id);
  await tx().delete(t).where(eq(t.id, id));
  return { id };
}

// ─── Tasks from alerts ─────────────────────────────────────────────────────

/** The language the workspace works in: a task is written once and read by everyone. */
export async function workspaceLocale(): Promise<string> {
  const [tenant] = await tx().select({ locale: tenants.locale }).from(tenants).where(eq(tenants.id, ctx().tenantId));
  return tenant?.locale ?? 'uz';
}

export interface AlertTaskInput {
  alertId: string;
  title: string;
  description: string | null;
  priority: (typeof PRIORITIES)[number];
  dueDate: string;
  assigneeUserId: string | null;
  entityType: string | null;
  entityId: string | null;
  link: string | null;
  /** Created by a setting rather than by a person pressing the button. */
  auto: boolean;
}

/**
 * The task of an alert: a new one, or the open one it already has. The unique index decides, so two
 * people pressing the button in the same second both get the same task. The caller has already
 * decided that this person may see the alert and what words may leave it.
 */
export async function createForAlert(input: AlertTaskInput): Promise<{ id: string; created: boolean }> {
  const c = ctx();
  const { auto, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...values, title: values.title.slice(0, 200), tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const [open] = await tx()
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.farmId, c.farmId), eq(t.alertId, input.alertId), inArray(t.status, ['open', 'in_progress'])));
    if (!open) throw conflict('ALERT_TASK_EXISTS', 'This alert already has a task');
    return { id: open.id, created: false };
  }
  await recordEvent({
    type: 'task.created',
    entityType: 'task',
    entityId: row.id,
    data: { title: row.title, alertId: input.alertId, auto },
    ...(auto ? { source: 'system' as const } : {}),
  });
  await announceAssignment(row);
  return { id: row.id, created: true };
}

/**
 * The problem went away, so the tasks that answered it are closed by the system: nobody's name on
 * them, and `completionSource` says why, which keeps them out of anyone's on-time count. A task
 * that demands a record stays open: it closes only with that record (spec 17.2).
 */
export async function completeForResolvedAlerts(alertIds: string[]): Promise<number> {
  if (alertIds.length === 0) return 0;
  const note = tr(await workspaceLocale(), 'tasks', 'alertResolvedNote');
  const closed = await tx()
    .update(t)
    .set({
      status: 'done',
      completedAt: new Date(),
      completedBy: null,
      completionSource: 'alert_resolved' satisfies CompletionSource,
      completionNote: note,
    })
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        inArray(t.alertId, alertIds),
        inArray(t.status, ['open', 'in_progress']),
        isNull(t.requiresRecord),
      ),
    )
    .returning({ id: t.id, title: t.title, alertId: t.alertId });
  for (const task of closed) {
    await recordEvent({
      type: 'task.completed',
      entityType: 'task',
      entityId: task.id,
      data: { title: task.title, alertId: task.alertId, completionSource: 'alert_resolved' },
      source: 'system',
    });
  }
  return closed.length;
}

export interface LinkedTask {
  id: string;
  status: string;
  dueDate: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  completionSource: string | null;
}

/**
 * The task each alert has, for the alert list: the open one, else the last one closed. A cancelled
 * task is as good as none. Only for people who may see tasks, and names follow `pii.view`.
 */
export async function tasksOfAlerts(alertIds: string[]): Promise<Map<string, LinkedTask>> {
  const result = new Map<string, LinkedTask>();
  if (alertIds.length === 0 || !hasPermission('tasks.view' as Permission)) return result;
  const rows = await tx()
    .select({
      id: t.id,
      alertId: t.alertId,
      status: t.status,
      dueDate: t.dueDate,
      assigneeUserId: t.assigneeUserId,
      assigneeName: users.fullName,
      completionSource: t.completionSource,
    })
    .from(t)
    .leftJoin(users, eq(users.id, t.assigneeUserId))
    .where(and(eq(t.farmId, ctx().farmId), inArray(t.alertId, alertIds), ne(t.status, 'cancelled')))
    // Closed ones first, oldest first, so the open task, or failing that the newest, is what remains.
    .orderBy(sql`(${t.status} <> 'done')`, asc(t.createdAt));
  for (const { alertId, ...task } of hidePii(rows, ['assigneeName'])) result.set(alertId!, task);
  return result;
}

// ─── Done on time ──────────────────────────────────────────────────────────

/**
 * Tasks done on time by each person they were given to, for tasks due in the period. The counting
 * rule is `tasksOnTime()` in shared; this only fetches. A recurring series is a template, not work.
 */
export async function onTimeByUser(from: string, to: string, userId?: string): Promise<Map<string, TasksOnTime>> {
  const c = ctx();
  const rows = await tx()
    .select({
      assigneeUserId: t.assigneeUserId,
      dueDate: t.dueDate,
      status: t.status,
      completedAt: t.completedAt,
      completedBy: t.completedBy,
      completionSource: t.completionSource,
    })
    .from(t)
    .where(
      and(
        eq(t.farmId, c.farmId),
        eq(t.recurrence, 'none'),
        gte(t.dueDate, from),
        lte(t.dueDate, to),
        userId ? eq(t.assigneeUserId, userId) : sql`${t.assigneeUserId} is not null`,
      ),
    );
  const byUser = new Map<string, AssignedTask[]>();
  for (const row of rows) {
    const list = byUser.get(row.assigneeUserId!) ?? [];
    byUser.set(row.assigneeUserId!, list);
    list.push({ ...row, completedByAssignee: row.completedBy !== null && row.completedBy === row.assigneeUserId });
  }
  const result = new Map<string, TasksOnTime>();
  for (const [id, list] of byUser) result.set(id, tasksOnTime(list, { from, to }, today(), c.timezone));
  return result;
}

/** The caller's own figure for this month, for their task list. */
export async function myOnTime() {
  const c = ctx();
  const { from, to } = monthRange(monthOf(today()));
  const mine = c.userId ? (await onTimeByUser(from, to, c.userId)).get(c.userId) : undefined;
  return { from, to, ...(mine ?? { onTime: 0, due: 0, percent: null }) };
}

// ─── Recurrence ────────────────────────────────────────────────────────────

function addMonthsClamped(start: string, months: number): string {
  const [y, m, d] = start.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Most recent date of a series on or before `on`, or null if it has not started. Computed from the
 * series start rather than from the last run, so a monthly task on the 31st stays on month ends
 * and missed runs produce today's task only, not a backlog of stale ones.
 */
export function latestOccurrence(start: string, recurrence: string, on: string): string | null {
  if (start > on) return null;
  switch (recurrence) {
    case 'daily':
      return on;
    case 'weekly':
      return addDays(start, Math.floor(diffDays(start, on) / 7) * 7);
    case 'monthly': {
      const [ys, ms] = start.split('-').map(Number);
      const [yo, mo] = on.split('-').map(Number);
      const months = (yo - ys) * 12 + (mo - ms);
      const candidate = addMonthsClamped(start, months);
      return candidate <= on ? candidate : addMonthsClamped(start, months - 1);
    }
    default:
      return null;
  }
}

/** The unique index on (template_id, due_date) makes this safe to repeat. */
async function spawnInstance(template: Task, on: string): Promise<boolean> {
  const occurrence = latestOccurrence(template.dueDate ?? on, template.recurrence, on);
  if (!occurrence) return false;
  const inserted = await tx()
    .insert(t)
    .values({
      tenantId: template.tenantId,
      farmId: template.farmId,
      createdBy: template.createdBy,
      title: template.title,
      description: template.description,
      assigneeUserId: template.assigneeUserId,
      dueDate: occurrence,
      priority: template.priority,
      division: template.division,
      entityType: template.entityType,
      entityId: template.entityId,
      templateId: template.id,
      requiresPhoto: template.requiresPhoto,
      requiresRecord: template.requiresRecord,
    })
    .onConflictDoNothing()
    .returning({ id: t.id });
  return inserted.length > 0;
}

/** Create today's instance of every running series. */
export async function generateRecurringTasks(): Promise<number> {
  const on = today();
  const templates = await tx()
    .select()
    .from(t)
    .where(and(eq(t.farmId, ctx().farmId), ne(t.recurrence, 'none'), isNull(t.templateId), eq(t.status, 'open')))
    .orderBy(asc(t.createdAt));
  let created = 0;
  for (const template of templates) if (await spawnInstance(template, on)) created++;
  return created;
}
