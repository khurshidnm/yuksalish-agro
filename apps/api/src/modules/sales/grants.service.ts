/** Subsidy, grant, compensation and preferential credit applications (spec 13.4). */
import { and, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, searchAny, sortBy } from '../../core/query';
import { GRANT_KINDS, GRANT_STATUSES, MAX_MONEY } from './constants';

const { grantApplications: t } = schema;

const grantFields = z.object({
  id: clientId,
  title: z.string().trim().min(1).max(200),
  program: z.string().trim().max(200).nullish(),
  kind: z.enum(GRANT_KINDS),
  amount: z.number().min(0).max(MAX_MONEY).nullish(),
  status: z.enum(GRANT_STATUSES),
  submittedOn: isoDate.nullish(),
  decisionOn: isoDate.nullish(),
  notes: z.string().max(1000).nullish(),
});

export const grantInput = grantFields.extend({
  kind: grantFields.shape.kind.default('subsidy'),
  status: grantFields.shape.status.default('draft'),
});
export const grantPatch = grantFields.partial();
export type GrantInput = z.infer<typeof grantInput>;

export const grantListQuery = listQuery.extend({ status: z.enum(GRANT_STATUSES).optional() });

const SUBMITTED: readonly string[] = ['submitted', 'in_review', 'approved', 'rejected', 'received'];
const DECIDED: readonly string[] = ['approved', 'rejected', 'received'];

/** The dates follow the status, unless the user entered them. */
function withStatusDates<T extends { status?: string; submittedOn?: string | null; decisionOn?: string | null }>(
  input: T,
  existing?: { submittedOn: string | null; decisionOn: string | null },
): T {
  if (!input.status) return input;
  return {
    ...input,
    submittedOn: input.submittedOn ?? existing?.submittedOn ?? (SUBMITTED.includes(input.status) ? today() : null),
    decisionOn: input.decisionOn ?? existing?.decisionOn ?? (DECIDED.includes(input.status) ? today() : null),
  };
}

export async function list(q: z.infer<typeof grantListQuery>) {
  const where = and(
    eq(t.farmId, ctx().farmId),
    q.status ? eq(t.status, q.status) : undefined,
    searchAny(q.search, [t.title, t.program]),
  );
  const rows = await tx()
    .select()
    .from(t)
    .where(where)
    .orderBy(...sortBy(q.sort, { title: t.title, amount: t.amount, status: t.status, submittedOn: t.submittedOn }, desc(t.createdAt), t.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [{ total }] = await tx().select({ total: count() }).from(t).where(where);
  return { data: hideMoney(rows, ['amount']), meta: { page: q.page, pageSize: q.pageSize, total } };
}

async function existing(id: string) {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Application');
  return row;
}

export async function get(id: string) {
  return hideMoney([await existing(id)], ['amount'])[0];
}

export async function create(input: GrantInput) {
  const c = ctx();
  const { id, ...values } = withStatusDates(input);
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({ type: 'grant.created', entityType: 'grant', entityId: row.id, data: { title: row.title, status: row.status } });
  return row;
}

export async function update(id: string, input: z.infer<typeof grantPatch>) {
  const before = await existing(id);
  const { id: _ignored, ...values } = withStatusDates(input, before);
  const [row] = await tx().update(t).set(values).where(eq(t.id, id)).returning();
  if (input.status && input.status !== before.status) {
    await recordEvent({
      type: 'grant.status_changed',
      entityType: 'grant',
      entityId: id,
      data: { from: before.status, to: input.status },
    });
  }
  return row;
}

export async function remove(id: string) {
  await existing(id);
  await tx().delete(t).where(eq(t.id, id));
  return { id };
}
