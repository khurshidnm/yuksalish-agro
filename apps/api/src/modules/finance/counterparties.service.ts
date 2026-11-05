import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { COUNTERPARTY_TYPES } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, listQuery, paged, searchAny, sortBy } from '../../core/query';

const { counterparties: t } = schema;

export const counterpartyInput = z.object({
  id: clientId,
  name: z.string().trim().min(1).max(200),
  tin: z.string().trim().max(20).nullish(),
  type: z.enum(COUNTERPARTY_TYPES),
  phone: z.string().trim().max(30).nullish(),
  address: z.string().trim().max(300).nullish(),
  contactPerson: z.string().trim().max(120).nullish(),
  bankDetails: z
    .object({ bankName: z.string().max(120).nullish(), account: z.string().max(40).nullish(), mfo: z.string().max(10).nullish() })
    .nullish(),
  notes: z.string().max(1000).nullish(),
});
export type CounterpartyInput = z.infer<typeof counterpartyInput>;

export const counterpartyListQuery = listQuery.extend({ type: z.enum(COUNTERPARTY_TYPES).optional() });

export async function list(q: z.infer<typeof counterpartyListQuery>) {
  const where = and(
    eq(t.farmId, ctx().farmId),
    eq(t.active, true),
    q.type ? eq(t.type, q.type) : undefined,
    searchAny(q.search, [t.name, t.tin, t.phone]),
  );
  return paged(q, t, where, (limit, offset) =>
    tx()
      .select()
      .from(t)
      .where(where)
      .orderBy(...sortBy(q.sort, { name: t.name, type: t.type, createdAt: t.createdAt }, asc(t.name), t.id))
      .limit(limit)
      .offset(offset),
  );
}

/** Names only, for dropdowns in other modules. Needs no finance permission. */
export async function lookup(search: string | undefined) {
  return tx()
    .select({ id: t.id, name: t.name, type: t.type })
    .from(t)
    .where(and(eq(t.farmId, ctx().farmId), eq(t.active, true), searchAny(search, [t.name, t.tin])))
    .orderBy(asc(t.name))
    .limit(50);
}

export async function get(id: string) {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Counterparty');
  return row;
}

export async function create(input: CounterpartyInput) {
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({ type: 'counterparty.created', entityType: 'counterparty', entityId: row.id, data: { name: row.name } });
  return row;
}

export async function update(id: string, input: Partial<CounterpartyInput>) {
  const { id: _ignored, ...values } = input;
  if (Object.keys(values).length === 0) return get(id);
  const [row] = await tx()
    .update(t)
    .set(values)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)))
    .returning();
  if (!row) throw notFound('Counterparty');
  return row;
}

/** Soft delete: documents keep pointing at the counterparty. */
export async function remove(id: string) {
  await get(id);
  await tx()
    .update(t)
    .set({ active: false })
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  await recordEvent({ type: 'counterparty.archived', entityType: 'counterparty', entityId: id });
  return { id };
}
