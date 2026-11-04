import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { PRIORITIES, RECURRENCES, TASK_STATUSES, diffDays, addDays, type Permission } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { notifyUser } from '../notifications/notify.service';
import { tr } from '../notifications/i18n';

const { animals, assets, dailyLogs, fieldOperations, fields, files, healthRecords, herds, memberships, tasks: t, users, weightRecords } = schema;

type Task = typeof t.$inferSelect;

/** Record types a task can demand before it may be closed (spec 17.2). */
export const RECORD_TYPES = ['health_record', 'field_operation', 'daily_log', 'weight_record'] as const;
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
          { dueDate: t.dueDate, priority: t.priority, status: t.status, title: t.title, createdAt: t.createdAt },
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

/** Records of the required type, limited to the task's linked object when it has one. */
async function findRecords(task: Task, onlyId?: string): Promise<{ id: string; date: string; label: string | null }[]> {
  const farmId = ctx().farmId;
  const linked = (type: string) => (task.entityType === type && task.entityId ? task.entityId : null);

  switch (task.requiresRecord as RecordType) {
    case 'health_record': {
      const herdId = linked('herd');
      const animalId = linked('animal');
      return tx()
        .select({ id: healthRecords.id, date: healthRecords.date, label: healthRecords.type })
        .from(healthRecords)
        .where(
          and(
            eq(healthRecords.farmId, farmId),
            onlyId ? eq(healthRecords.id, onlyId) : undefined,
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
  await tx()
    .update(t)
    .set({
      status: 'open',
      completedAt: null,
      completedBy: null,
      completionNote: null,
      completionPhotoFileId: null,
      completionRecordId: null,
    })
    .where(eq(t.id, id));
  return get(id);
}

export async function remove(id: string) {
  await getRow(id);
  await tx().delete(t).where(eq(t.id, id));
  return { id };
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
