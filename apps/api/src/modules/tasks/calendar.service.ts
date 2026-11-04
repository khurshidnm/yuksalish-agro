/**
 * The single farm calendar (spec 17.1): manual events plus everything other modules have scheduled.
 * Nothing is copied here: automatic items are read from their source tables on every request, so
 * the calendar cannot show a date that the source has since changed.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, hasPermission, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate } from '../../core/query';
import { assertAssignable, canManage } from './tasks.service';

const { calendarEvents: e, tasks, users } = schema;

export const CALENDAR_KINDS = [
  'lambing',
  'vaccination',
  'field_operation',
  'loan',
  'contract',
  'document',
  'maintenance',
  'state_report',
  'staff_contract',
  'staff_medical',
  'task',
  'manual',
] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

export interface CalendarItem {
  /** Stable key for the UI. */
  id: string;
  kind: CalendarKind;
  date: string;
  endDate: string | null;
  /** Task or event title. Automatic items have none: the UI builds it from kind and params. */
  title: string | null;
  params: Record<string, unknown>;
  link: string | null;
  division: string | null;
  responsibleUserId: string | null;
  responsibleName: string | null;
  status: string | null;
  priority: string | null;
  /** The real row id, when this item can be edited here. */
  editableId: string | null;
}

export const calendarQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    division: z.string().optional(),
    responsibleUserId: z.uuid().optional(),
    kinds: z.string().optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['to'] });

const EVENT_KINDS = ['meeting', 'inspection', 'delivery', 'other'] as const;

const eventFields = z.object({
  title: z.string().trim().min(1).max(200),
  date: isoDate,
  endDate: isoDate.nullish(),
  kind: z.enum(EVENT_KINDS),
  responsibleUserId: z.uuid().nullish(),
  division: z.string().trim().max(50).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});

export const eventInput = eventFields.extend({ id: clientId, kind: z.enum(EVENT_KINDS).default('meeting') });

/** Without defaults, as in taskPatch: a default would overwrite the stored kind on every PATCH. */
export const eventPatch = eventFields.partial();

const blank = {
  endDate: null,
  title: null,
  link: null,
  division: null,
  responsibleUserId: null,
  responsibleName: null,
  status: null,
  priority: null,
  editableId: null,
  params: {},
} satisfies Partial<CalendarItem>;

async function rows<T>(statement: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx().execute(statement)).rows as T[];
}

type Range = { farmId: string; from: string; to: string };

const SOURCES: { kind: CalendarKind; allowed: () => boolean; load: (r: Range) => Promise<CalendarItem[]> }[] = [
  {
    kind: 'lambing',
    allowed: () => hasPermission('livestock.view'),
    load: async ({ farmId, from, to }) =>
      (
        await rows<{ date: string; n: string }>(sql`
          select expected_date::text as date, count(*) as n from breeding_records
          where farm_id = ${farmId} and status = 'pregnant'
            and expected_date between ${from}::date and ${to}::date
          group by expected_date`)
      ).map((r) => ({
        ...blank,
        id: `lambing:${r.date}`,
        kind: 'lambing' as const,
        date: r.date,
        params: { count: Number(r.n) },
        link: '/livestock/breeding',
        division: 'livestock',
      })),
  },
  {
    kind: 'vaccination',
    allowed: () => hasPermission('health.view') || hasPermission('livestock.view'),
    // Only the latest record of each series counts: an already repeated dose is not still due.
    load: async ({ farmId, from, to }) =>
      (
        await rows<{ date: string; name: string | null; type: string; n: string }>(sql`
          select h.next_due_date::text as date, coalesce(p.name, i.name) as name, h.type, count(*) as n
          from health_records h
          left join vaccination_plans p on p.id = h.vaccination_plan_id
          left join items i on i.id = h.item_id
          where h.farm_id = ${farmId} and h.next_due_date between ${from}::date and ${to}::date
            and not exists (
              select 1 from health_records later
              where later.farm_id = h.farm_id and later.date > h.date
                and later.vaccination_plan_id is not distinct from h.vaccination_plan_id
                and later.item_id is not distinct from h.item_id
                and later.animal_id is not distinct from h.animal_id
                and later.herd_id is not distinct from h.herd_id
            )
          group by h.next_due_date, coalesce(p.name, i.name), h.type`)
      ).map((r) => ({
        ...blank,
        id: `vaccination:${r.date}:${r.name ?? r.type}`,
        kind: 'vaccination' as const,
        date: r.date,
        // A record need not name a plan or a drug; the UI then falls back to its type.
        params: { name: r.name, type: r.type, count: Number(r.n) },
        link: '/livestock/health',
        division: 'livestock',
      })),
  },
  {
    kind: 'field_operation',
    allowed: () => hasPermission('crops.view'),
    load: async ({ farmId, from, to }) =>
      (
        await rows<{ id: string; date: string; type: string; field: string }>(sql`
          select o.id, o.date::text as date, o.type, f.number as field
          from field_operations o join fields f on f.id = o.field_id
          where o.farm_id = ${farmId} and o.status = 'planned'
            and o.date between ${from}::date and ${to}::date`)
      ).map((r) => ({
        ...blank,
        id: `field_operation:${r.id}`,
        kind: 'field_operation' as const,
        date: r.date,
        params: { operation: r.type, field: r.field },
        link: '/crops/operations',
        division: 'crops',
      })),
  },
  {
    kind: 'loan',
    allowed: () => hasPermission('finance.view'),
    load: async ({ farmId, from, to }) =>
      (
        await rows<{ id: string; date: string; name: string }>(sql`
          select i.id, i.due_date::text as date, l.name
          from loan_instalments i join loans l on l.id = i.loan_id
          where i.farm_id = ${farmId} and i.paid_date is null
            and i.due_date between ${from}::date and ${to}::date`)
      ).map((r) => ({
        ...blank,
        id: `loan:${r.id}`,
        kind: 'loan' as const,
        date: r.date,
        params: { name: r.name },
        link: '/finance/loans',
        division: 'admin',
      })),
  },
  {
    kind: 'contract',
    allowed: () => hasPermission('finance.view'),
    load: async ({ farmId, from, to }) =>
      (
        await rows<{ id: string; date: string; number: string; counterparty: string }>(sql`
          select c.id, c.end_date::text as date, c.number, p.name as counterparty
          from contracts c join counterparties p on p.id = c.counterparty_id
          where c.farm_id = ${farmId} and c.status = 'active'
            and c.end_date between ${from}::date and ${to}::date`)
      ).map((r) => ({
        ...blank,
        id: `contract:${r.id}`,
        kind: 'contract' as const,
        date: r.date,
        params: { number: r.number, counterparty: r.counterparty },
        link: '/sales',
        division: 'admin',
      })),
  },
  {
    kind: 'document',
    allowed: () => hasPermission('farm.view'),
    load: async ({ farmId, from, to }) =>
      (
        await rows<{ id: string; date: string; title: string }>(sql`
          select id, expiry_date::text as date, title from documents
          where farm_id = ${farmId} and expiry_date between ${from}::date and ${to}::date`)
      ).map((r) => ({
        ...blank,
        id: `document:${r.id}`,
        kind: 'document' as const,
        date: r.date,
        params: { name: r.title },
        link: '/farm/documents',
        division: 'admin',
      })),
  },
  {
    kind: 'maintenance',
    allowed: () => hasPermission('assets.view'),
    load: async ({ farmId, from, to }) =>
      (
        await rows<{ id: string; date: string; name: string; asset_id: string }>(sql`
          select m.id, m.next_due_date::text as date, a.name, m.asset_id
          from maintenance_records m join assets a on a.id = m.asset_id
          where m.farm_id = ${farmId} and m.next_due_date between ${from}::date and ${to}::date
            and not exists (
              select 1 from maintenance_records later
              where later.asset_id = m.asset_id and later.date > m.date
            )`)
      ).map((r) => ({
        ...blank,
        id: `maintenance:${r.id}`,
        kind: 'maintenance' as const,
        date: r.date,
        params: { name: r.name },
        link: `/assets/${r.asset_id}`,
        division: 'machinery',
      })),
  },
  {
    kind: 'state_report',
    allowed: () => hasPermission('sales.view'),
    load: async ({ farmId, from, to }) =>
      (
        await rows<{ id: string; date: string; title: string; authority: string }>(sql`
          select id, due_date::text as date, title, authority from state_reports
          where farm_id = ${farmId} and status = 'planned'
            and due_date between ${from}::date and ${to}::date`)
      ).map((r) => ({
        ...blank,
        id: `state_report:${r.id}`,
        kind: 'state_report' as const,
        date: r.date,
        params: { name: r.title, authority: r.authority },
        link: '/sales',
        division: 'admin',
      })),
  },
  {
    // A staff member's name is personal data, so this needs HR access (CLAUDE.md rule 8).
    kind: 'staff_contract',
    allowed: () => hasPermission('hr.view'),
    load: async ({ farmId, from, to }) =>
      (
        await rows<{ id: string; date: string; name: string }>(sql`
          select id, contract_end_date::text as date, full_name as name from employees
          where farm_id = ${farmId} and status <> 'terminated'
            and contract_end_date between ${from}::date and ${to}::date`)
      ).map((r) => ({
        ...blank,
        id: `staff_contract:${r.id}`,
        kind: 'staff_contract' as const,
        date: r.date,
        params: { name: r.name },
        link: '/hr/employees',
        division: 'admin',
      })),
  },
  {
    kind: 'staff_medical',
    allowed: () => hasPermission('hr.view'),
    load: async ({ farmId, from, to }) =>
      (
        await rows<{ id: string; date: string; name: string }>(sql`
          select id, medical_check_date::text as date, full_name as name from employees
          where farm_id = ${farmId} and status <> 'terminated'
            and medical_check_date between ${from}::date and ${to}::date`)
      ).map((r) => ({
        ...blank,
        id: `staff_medical:${r.id}`,
        kind: 'staff_medical' as const,
        date: r.date,
        params: { name: r.name },
        link: '/hr/employees',
        division: 'admin',
      })),
  },
  {
    kind: 'task',
    allowed: () => true,
    load: async ({ farmId, from, to }) => {
      const list = await tx()
        .select({
          id: tasks.id,
          title: tasks.title,
          date: tasks.dueDate,
          status: tasks.status,
          priority: tasks.priority,
          division: tasks.division,
          responsibleUserId: tasks.assigneeUserId,
          responsibleName: users.fullName,
        })
        .from(tasks)
        .leftJoin(users, eq(users.id, tasks.assigneeUserId))
        .where(
          and(
            eq(tasks.farmId, farmId),
            eq(tasks.recurrence, 'none'),
            sql`${tasks.dueDate} between ${from}::date and ${to}::date`,
            inArray(tasks.status, ['open', 'in_progress', 'done']),
            canManage() ? undefined : eq(tasks.assigneeUserId, ctx().userId ?? ''),
          ),
        );
      return list.map((r) => ({
        ...blank,
        ...r,
        id: `task:${r.id}`,
        kind: 'task' as const,
        date: r.date!,
        link: '/tasks',
      }));
    },
  },
  {
    kind: 'manual',
    allowed: () => true,
    load: async ({ farmId, from, to }) => {
      const list = await tx()
        .select({
          id: e.id,
          title: e.title,
          date: e.date,
          endDate: e.endDate,
          eventKind: e.kind,
          division: e.division,
          notes: e.notes,
          responsibleUserId: e.responsibleUserId,
          responsibleName: users.fullName,
        })
        .from(e)
        .leftJoin(users, eq(users.id, e.responsibleUserId))
        .where(
          and(
            eq(e.farmId, farmId),
            // An event spanning several days overlaps the range if it starts before the range ends.
            sql`${e.date} <= ${to}::date and coalesce(${e.endDate}, ${e.date}) >= ${from}::date`,
          ),
        );
      return list.map(({ eventKind, notes, ...r }) => ({
        ...blank,
        ...r,
        id: `manual:${r.id}`,
        kind: 'manual' as const,
        params: { eventKind, notes },
        editableId: r.id,
      }));
    },
  },
];

export async function calendar(q: z.infer<typeof calendarQuery>): Promise<CalendarItem[]> {
  const range: Range = { farmId: ctx().farmId, from: q.from, to: q.to };
  const kinds = q.kinds?.split(',').filter(Boolean);
  const items: CalendarItem[] = [];
  for (const source of SOURCES) {
    if (kinds && !kinds.includes(source.kind)) continue;
    if (!source.allowed()) continue;
    items.push(...(await source.load(range)));
  }
  return items
    .filter((item) => !q.division || item.division === q.division)
    .filter((item) => !q.responsibleUserId || item.responsibleUserId === q.responsibleUserId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export async function createEvent(input: z.infer<typeof eventInput>) {
  const c = ctx();
  if (input.endDate && input.endDate < input.date) {
    throw badRequest('INVALID_DATE_RANGE', 'The end date is before the start date');
  }
  await assertAssignable(input.responsibleUserId);
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(e)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({ type: 'calendar_event.created', entityType: 'calendar_event', entityId: row.id, data: { title: row.title } });
  return row;
}

export async function updateEvent(id: string, input: z.infer<typeof eventPatch>) {
  await assertAssignable(input.responsibleUserId);
  const [row] = await tx()
    .update(e)
    .set(input)
    .where(and(eq(e.id, id), eq(e.farmId, ctx().farmId)))
    .returning();
  if (!row) throw notFound('Calendar event');
  if (row.endDate && row.endDate < row.date) throw badRequest('INVALID_DATE_RANGE', 'The end date is before the start date');
  return row;
}

export async function removeEvent(id: string) {
  const [row] = await tx()
    .delete(e)
    .where(and(eq(e.id, id), eq(e.farmId, ctx().farmId)))
    .returning({ id: e.id });
  if (!row) throw notFound('Calendar event');
  return row;
}
