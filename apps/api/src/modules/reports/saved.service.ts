/** Report builder (spec 14.2): saved column, filter and grouping choices, with a schedule. */
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, hasPermission, tx } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId } from '../../core/query';
import { assertCanRun, enabledModules, parseFilters } from './engine';
import { REPORTS_BY_KEY } from './registry';
import type { ReportDefinition } from './types';

const { memberships, savedReports: t } = schema;

export const SCHEDULES = ['daily', 'weekly', 'monthly'] as const;

export const savedConfig = z.object({
  columns: z.array(z.string().max(80)).max(60).optional(),
  groupBy: z.string().max(80).nullish(),
  filters: z.record(z.string(), z.string().max(120)).optional(),
});
export type SavedConfig = z.infer<typeof savedConfig>;

const fields = {
  name: z.string().trim().min(1).max(120),
  config: savedConfig,
  schedule: z.enum(SCHEDULES).nullish(),
  channels: z.array(z.enum(['telegram'])).max(1).optional(),
  recipients: z.array(z.uuid()).max(50).optional(),
};
export const savedInput = z.object({ id: clientId, reportKey: z.string().max(80), ...fields });
export const savedPatch = z.object(fields).partial();

export type SavedRow = typeof t.$inferSelect;

function definition(reportKey: string): ReportDefinition {
  const def = REPORTS_BY_KEY.get(reportKey);
  if (!def) throw badRequest('UNKNOWN_REPORT', 'This report does not exist', { reportKey });
  return def;
}

async function validate(def: ReportDefinition, config: SavedConfig): Promise<void> {
  assertCanRun(def, await enabledModules());
  parseFilters(def, config.filters ?? {}, 'uz');
  const known = new Set(def.columns.map((c) => c.key));
  const unknown = (config.columns ?? []).filter((key) => !known.has(key));
  if (unknown.length) throw badRequest('UNKNOWN_COLUMN', 'A chosen column does not exist', { columns: unknown });
  if (config.groupBy && !known.has(config.groupBy)) {
    throw badRequest('INVALID_GROUPING', 'This column cannot be used for grouping', { groupBy: config.groupBy });
  }
}

/** Sending to other people needs reports.update, and they must work on this farm. */
async function validateRecipients(recipients: string[]): Promise<void> {
  const c = ctx();
  const others = recipients.filter((id) => id !== c.userId);
  if (others.length === 0) return;
  if (!hasPermission('reports.update')) {
    throw forbidden('Only you can be the recipient of your report', 'RECIPIENTS_FORBIDDEN');
  }
  const members = await tx()
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.farmId, c.farmId), eq(memberships.status, 'active'), inArray(memberships.userId, others)));
  const known = new Set(members.map((m) => m.userId));
  const missing = others.filter((id) => !known.has(id));
  if (missing.length) throw badRequest('UNKNOWN_RECIPIENT', 'A recipient does not work on this farm', { recipients: missing });
}

/**
 * Your own reports and those sent to you, since a delivered message links here.
 * reports.update also sees everyone's, to manage what the farm receives.
 */
function visibleTo() {
  const c = ctx();
  if (hasPermission('reports.update')) return eq(t.farmId, c.farmId);
  return and(
    eq(t.farmId, c.farmId),
    or(eq(t.createdBy, c.userId!), sql`${t.recipients} @> ${JSON.stringify([c.userId])}::jsonb`),
  );
}

export function listSaved() {
  return tx().select().from(t).where(visibleTo()).orderBy(desc(t.createdAt));
}

export async function getSaved(id: string): Promise<SavedRow> {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), visibleTo()));
  if (!row) throw notFound('Saved report');
  return row;
}

/** Receiving a report does not make it yours to change. */
export async function getManaged(id: string): Promise<SavedRow> {
  const row = await getSaved(id);
  if (row.createdBy !== ctx().userId && !hasPermission('reports.update')) {
    throw forbidden('Only the owner can change this report', 'NOT_REPORT_OWNER');
  }
  return row;
}

export async function createSaved(input: z.infer<typeof savedInput>) {
  const c = ctx();
  const def = definition(input.reportKey);
  await validate(def, input.config);
  const recipients = input.recipients?.length ? input.recipients : [c.userId!];
  await validateRecipients(recipients);
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({
      ...(id ? { id } : {}),
      ...values,
      config: input.config,
      schedule: input.schedule ?? null,
      channels: input.channels ?? [],
      recipients,
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
    })
    .returning();
  await recordEvent({ type: 'report.saved', entityType: 'saved_report', entityId: row.id, data: { reportKey: row.reportKey } });
  return row;
}

export async function updateSaved(id: string, input: z.infer<typeof savedPatch>) {
  const current = await getManaged(id);
  if (input.config) await validate(definition(current.reportKey), input.config);
  if (input.recipients) await validateRecipients(input.recipients);
  const [row] = await tx()
    .update(t)
    .set({ ...input, schedule: input.schedule === undefined ? current.schedule : input.schedule })
    .where(eq(t.id, id))
    .returning();
  return row;
}

export async function removeSaved(id: string) {
  await getManaged(id);
  await tx().delete(t).where(eq(t.id, id));
  return { id };
}
