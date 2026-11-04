/**
 * Calendar of reports due to state bodies (spec 13.4). Submitting a repeating report schedules
 * the next one, so the calendar never runs out.
 */
import { and, asc, count, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate, listQuery, searchAny, sortBy } from '../../core/query';
import { signedFileUrl } from '../files';
import { REPORT_AUTHORITIES, REPORT_PERIODS, REPORT_STATUSES } from './constants';
import { assertFile } from './refs';

const { stateReports: t } = schema;

const reportFields = z.object({
  id: clientId,
  title: z.string().trim().min(1).max(200),
  authority: z.enum(REPORT_AUTHORITIES),
  period: z.enum(REPORT_PERIODS),
  dueDate: isoDate,
  fileId: z.uuid().nullish(),
  notes: z.string().max(1000).nullish(),
});

export const stateReportInput = reportFields.extend({ period: reportFields.shape.period.default('once') });
export const stateReportPatch = reportFields.partial();
export type StateReportInput = z.infer<typeof stateReportInput>;

export const stateReportListQuery = listQuery.extend({
  status: z.enum(REPORT_STATUSES).optional(),
  authority: z.enum(REPORT_AUTHORITIES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const MONTHS_BY_PERIOD: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 };

/** Same day of a later month, clamped to that month's length. */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

async function present(row: typeof t.$inferSelect) {
  return {
    ...row,
    overdue: row.status === 'planned' && row.dueDate < today(),
    fileUrl: row.fileId ? await signedFileUrl(row.fileId) : null,
  };
}

export async function list(q: z.infer<typeof stateReportListQuery>) {
  const where = and(
    eq(t.farmId, ctx().farmId),
    q.status ? eq(t.status, q.status) : undefined,
    q.authority ? eq(t.authority, q.authority) : undefined,
    q.from ? gte(t.dueDate, q.from) : undefined,
    q.to ? lte(t.dueDate, q.to) : undefined,
    searchAny(q.search, [t.title]),
  );
  const rows = await tx()
    .select()
    .from(t)
    .where(where)
    .orderBy(...sortBy(q.sort, { dueDate: t.dueDate, title: t.title }, asc(t.dueDate), t.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [{ total }] = await tx().select({ total: count() }).from(t).where(where);
  return { data: await Promise.all(rows.map(present)), meta: { page: q.page, pageSize: q.pageSize, total } };
}

async function existing(id: string) {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Report');
  return row;
}

export async function create(input: StateReportInput) {
  await assertFile(input.fileId);
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  return present(row);
}

export async function update(id: string, input: z.infer<typeof stateReportPatch>) {
  await existing(id);
  await assertFile(input.fileId);
  const { id: _ignored, ...values } = input;
  const [row] = await tx().update(t).set(values).where(eq(t.id, id)).returning();
  return present(row);
}

export async function remove(id: string) {
  await existing(id);
  await tx().delete(t).where(eq(t.id, id));
  return { id };
}

export async function submit(id: string, input: { fileId?: string | null; submittedOn?: string | null }) {
  const report = await existing(id);
  if (report.status === 'submitted') throw conflict('REPORT_ALREADY_SUBMITTED', 'This report is already submitted');
  await assertFile(input.fileId);
  const submittedOn = input.submittedOn ?? today();
  const [row] = await tx()
    .update(t)
    .set({ status: 'submitted', submittedOn, fileId: input.fileId ?? report.fileId })
    .where(eq(t.id, id))
    .returning();
  await recordEvent({
    type: 'state_report.submitted',
    entityType: 'state_report',
    entityId: id,
    occurredAt: submittedOn,
    data: { title: report.title, authority: report.authority },
  });

  const months = MONTHS_BY_PERIOD[report.period];
  let next: Awaited<ReturnType<typeof present>> | null = null;
  if (months) {
    const c = ctx();
    const [created] = await tx()
      .insert(t)
      .values({
        tenantId: c.tenantId,
        farmId: c.farmId,
        createdBy: c.userId,
        title: report.title,
        authority: report.authority,
        period: report.period,
        dueDate: addMonths(report.dueDate, months),
        notes: report.notes,
      })
      .returning();
    next = await present(created);
  }
  return { report: await present(row), next };
}
