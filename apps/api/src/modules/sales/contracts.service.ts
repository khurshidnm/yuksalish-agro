/** Contracts with counterparties (spec 13.1): term, amount, payment terms, scan, expiry reminders. */
import { and, asc, count, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { CURRENCIES, addDays, diffDays } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, searchAny, sortBy } from '../../core/query';
import { signedFileUrl } from '../files';
import { CONTRACT_STATUSES, EXPIRY_WARNING_DAYS, MAX_MONEY } from './constants';
import { assertCounterparty, assertFile } from './refs';

const { contracts, counterparties } = schema;

const contractFields = z.object({
  id: clientId,
  counterpartyId: z.uuid(),
  number: z.string().trim().min(1).max(60),
  title: z.string().trim().max(200).nullish(),
  startDate: isoDate.nullish(),
  endDate: isoDate.nullish(),
  amount: z.number().min(0).max(MAX_MONEY).nullish(),
  currency: z.enum(CURRENCIES),
  terms: z.string().max(2000).nullish(),
  fileId: z.uuid().nullish(),
  status: z.enum(CONTRACT_STATUSES),
});

export const contractInput = contractFields.extend({
  currency: contractFields.shape.currency.default('UZS'),
  status: contractFields.shape.status.default('active'),
});
export const contractPatch = contractFields.partial();
export type ContractInput = z.infer<typeof contractInput>;

export const contractListQuery = listQuery.extend({
  counterpartyId: z.uuid().optional(),
  status: z.enum(CONTRACT_STATUSES).optional(),
  /** Active contracts ending within this many days from today. */
  expiringWithin: z.coerce.number().int().min(0).max(365).optional(),
});

async function present(row: typeof contracts.$inferSelect & { counterpartyName: string }) {
  const daysLeft = row.endDate ? diffDays(today(), row.endDate) : null;
  return {
    ...row,
    daysLeft,
    expired: row.status === 'active' && daysLeft !== null && daysLeft < 0,
    expiringSoon: row.status === 'active' && daysLeft !== null && daysLeft >= 0 && daysLeft <= EXPIRY_WARNING_DAYS,
    fileUrl: row.fileId ? await signedFileUrl(row.fileId) : null,
  };
}

function selectContracts() {
  return tx()
    .select({ contract: contracts, counterpartyName: counterparties.name })
    .from(contracts)
    .innerJoin(counterparties, eq(counterparties.id, contracts.counterpartyId));
}

export async function list(q: z.infer<typeof contractListQuery>) {
  const expiring = q.expiringWithin !== undefined;
  const where = and(
    eq(contracts.farmId, ctx().farmId),
    q.counterpartyId ? eq(contracts.counterpartyId, q.counterpartyId) : undefined,
    expiring ? eq(contracts.status, 'active') : q.status ? eq(contracts.status, q.status) : undefined,
    expiring ? gte(contracts.endDate, today()) : undefined,
    expiring ? lte(contracts.endDate, addDays(today(), q.expiringWithin!)) : undefined,
    searchAny(q.search, [contracts.number, contracts.title, counterparties.name]),
  );
  const rows = await selectContracts()
    .where(where)
    .orderBy(
      ...sortBy(
        q.sort,
        { endDate: contracts.endDate, number: contracts.number, amount: contracts.amount },
        asc(contracts.endDate),
        contracts.id,
      ),
    )
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [{ total }] = await tx()
    .select({ total: count() })
    .from(contracts)
    .innerJoin(counterparties, eq(counterparties.id, contracts.counterpartyId))
    .where(where);
  const data = await Promise.all(rows.map((r) => present({ ...r.contract, counterpartyName: r.counterpartyName })));
  return { data: hideMoney(data, ['amount']), meta: { page: q.page, pageSize: q.pageSize, total } };
}

export async function get(id: string) {
  const [row] = await selectContracts().where(and(eq(contracts.id, id), eq(contracts.farmId, ctx().farmId)));
  if (!row) throw notFound('Contract');
  return hideMoney([await present({ ...row.contract, counterpartyName: row.counterpartyName })], ['amount'])[0];
}

export async function create(input: ContractInput) {
  await assertCounterparty(input.counterpartyId);
  await assertFile(input.fileId);
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(contracts)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({
    type: 'contract.created',
    entityType: 'contract',
    entityId: row.id,
    data: { number: row.number, counterpartyId: row.counterpartyId },
  });
  return get(row.id);
}

export async function update(id: string, input: z.infer<typeof contractPatch>) {
  await assertCounterparty(input.counterpartyId);
  await assertFile(input.fileId);
  const { id: _ignored, ...values } = input;
  const [row] = await tx()
    .update(contracts)
    .set(values)
    .where(and(eq(contracts.id, id), eq(contracts.farmId, ctx().farmId)))
    .returning({ id: contracts.id });
  if (!row) throw notFound('Contract');
  return get(id);
}

export async function remove(id: string) {
  const [row] = await tx()
    .delete(contracts)
    .where(and(eq(contracts.id, id), eq(contracts.farmId, ctx().farmId)))
    .returning({ id: contracts.id });
  if (!row) throw notFound('Contract');
  return row;
}
