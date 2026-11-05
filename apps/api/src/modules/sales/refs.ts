/**
 * Composite foreign keys keep every id within the tenant, but a tenant can have several farms, and
 * a sale on one farm must not draw on another farm's account or warehouse. Every id taken from a
 * request is checked against the current farm here.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { notFound } from '../../core/errors';

const { accounts, counterparties, files, financeCategories, warehouses } = schema;

type FarmTable = typeof accounts;

async function assertFarmRows(table: unknown, ids: (string | null | undefined)[], what: string): Promise<void> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return;
  const t = table as FarmTable;
  const rows = await tx()
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.farmId, ctx().farmId), inArray(t.id, unique)));
  if (rows.length !== unique.length) throw notFound(what);
}

export const assertAccount = (id: string | null | undefined) => assertFarmRows(accounts, [id], 'Account');
export const assertCounterparty = (id: string | null | undefined) => assertFarmRows(counterparties, [id], 'Counterparty');
export const assertWarehouses = (ids: (string | null | undefined)[]) => assertFarmRows(warehouses, ids, 'Warehouse');
export const assertFile = (id: string | null | undefined) => assertFarmRows(files, [id], 'File');

/** Categories belong to the tenant, not a farm, so RLS alone limits what this can see. */
export async function assertCategories(ids: (string | null | undefined)[]): Promise<void> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return;
  const rows = await tx()
    .select({ id: financeCategories.id })
    .from(financeCategories)
    .where(inArray(financeCategories.id, unique));
  if (rows.length !== unique.length) throw notFound('Category');
}
