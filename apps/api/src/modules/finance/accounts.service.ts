import { and, asc, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ACCOUNT_TYPES, CURRENCIES, addDays, round } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate, searchAny } from '../../core/query';

const { accounts: a, fxRates, transactions: t } = schema;

export const accountInput = z.object({
  id: clientId,
  name: z.string().trim().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  currency: z.enum(CURRENCIES).optional(),
  openingBalance: z.number().min(-1e14).max(1e14).optional(),
  openingDate: isoDate.nullish(),
  bankName: z.string().trim().max(120).nullish(),
  accountNumber: z.string().trim().max(40).nullish(),
});
export type AccountInput = z.infer<typeof accountInput>;

/** Which transactions move money: approved, and neither on credit nor non-cash. */
const movesMoney = sql`${t.status} = 'approved' and ${t.paymentMethod} not in ('debt', 'non_cash')`;
/** Transactions before the opening date are already inside the opening balance. */
const afterOpening = sql`${t.date} >= coalesce(${a.openingDate}, ${t.date})`;
/** A transaction in another currency hits a base-currency account at its base amount. */
const nativeAmount = sql`case when ${t.currency} = ${a.currency} then ${t.amount} else ${t.amountBase} end`;
const outSign = sql`case when ${t.type} in ('income', 'debt_receipt') then 1 else -1 end`;

interface Flow {
  native: number;
  base: number;
}

/** Net flow per account, optionally up to and including a date. */
async function accountFlows(until?: string): Promise<Map<string, Flow>> {
  const farm = ctx().farmId;
  const limit = until ? sql`and ${t.date} <= ${until}` : sql``;
  const out = await tx()
    .select({
      accountId: a.id,
      native: sql`coalesce(sum(${outSign} * ${nativeAmount}), 0)`.mapWith(Number),
      base: sql`coalesce(sum(${outSign} * ${t.amountBase}), 0)`.mapWith(Number),
    })
    .from(t)
    .innerJoin(a, eq(a.id, t.accountId))
    .where(sql`${t.farmId} = ${farm} and ${movesMoney} and ${afterOpening} ${limit}`)
    .groupBy(a.id);
  const incoming = await tx()
    .select({
      accountId: a.id,
      native: sql`coalesce(sum(${nativeAmount}), 0)`.mapWith(Number),
      base: sql`coalesce(sum(${t.amountBase}), 0)`.mapWith(Number),
    })
    .from(t)
    .innerJoin(a, eq(a.id, t.toAccountId))
    .where(sql`${t.farmId} = ${farm} and ${t.type} = 'transfer' and ${movesMoney} and ${afterOpening} ${limit}`)
    .groupBy(a.id);

  const flows = new Map<string, Flow>();
  for (const row of [...out, ...incoming]) {
    const current = flows.get(row.accountId) ?? { native: 0, base: 0 };
    flows.set(row.accountId, { native: current.native + row.native, base: current.base + row.base });
  }
  return flows;
}

/** Latest rate per currency, used to value a foreign account's opening balance. */
async function latestRates(): Promise<Map<string, number>> {
  const rows = await tx()
    .selectDistinctOn([fxRates.currency], { currency: fxRates.currency, rate: fxRates.rate })
    .from(fxRates)
    .where(eq(fxRates.tenantId, ctx().tenantId))
    .orderBy(fxRates.currency, sql`${fxRates.date} desc`);
  return new Map(rows.map((r) => [r.currency, r.rate]));
}

export interface AccountBalance {
  id: string;
  name: string;
  type: string;
  currency: string;
  bankName: string | null;
  accountNumber: string | null;
  openingBalance: number;
  openingDate: string | null;
  active: boolean;
  /** In the account's own currency. */
  balance: number;
  /** In the tenant's base currency. */
  balanceBase: number;
}

/** Accounts with balances. `until` gives the balance at the end of that day. */
export async function listWithBalances(until?: string): Promise<AccountBalance[]> {
  const c = ctx();
  const [rows, flows, rates] = [
    await tx()
      .select()
      .from(a)
      .where(and(eq(a.farmId, c.farmId), eq(a.active, true)))
      .orderBy(asc(a.name)),
    await accountFlows(until),
    await latestRates(),
  ];
  return rows.map((row) => {
    const flow = flows.get(row.id) ?? { native: 0, base: 0 };
    const rate = row.currency === c.currency ? 1 : (rates.get(row.currency) ?? 1);
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      currency: row.currency,
      bankName: row.bankName,
      accountNumber: row.accountNumber,
      openingBalance: row.openingBalance,
      openingDate: row.openingDate,
      active: row.active,
      balance: round(row.openingBalance + flow.native, 2),
      balanceBase: round(row.openingBalance * rate + flow.base, 2),
    };
  });
}

/** No balances, so it is safe for any role's dropdown. */
export async function lookup(search: string | undefined) {
  return tx()
    .select({ id: a.id, name: a.name, type: a.type, currency: a.currency })
    .from(a)
    .where(and(eq(a.farmId, ctx().farmId), eq(a.active, true), searchAny(search, [a.name])))
    .orderBy(asc(a.name))
    .limit(50);
}

export async function get(id: string, opts: { lock?: boolean } = {}) {
  const query = tx().select().from(a).where(and(eq(a.id, id), eq(a.farmId, ctx().farmId)));
  const [row] = await (opts.lock ? query.for('update') : query);
  if (!row) throw notFound('Account');
  return row;
}

export async function create(input: AccountInput) {
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(a)
    .values({
      ...(id ? { id } : {}),
      ...values,
      currency: input.currency ?? c.currency,
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
    })
    .returning();
  await recordEvent({ type: 'account.created', entityType: 'account', entityId: row.id, data: { name: row.name } });
  return row;
}

export async function update(id: string, input: Partial<AccountInput>) {
  const account = await get(id, { lock: true });
  // Its balance is a number in this currency: a new label would change what the money is.
  if (input.currency && input.currency !== account.currency) {
    const [used] = await tx()
      .select({ id: t.id })
      .from(t)
      .where(or(eq(t.accountId, id), eq(t.toAccountId, id)))
      .limit(1);
    if (used || Number(account.openingBalance) !== 0) {
      throw conflict('ACCOUNT_CURRENCY_LOCKED', 'This account already holds money, so its currency cannot change');
    }
  }
  const { id: _ignored, ...values } = input;
  const [row] = await tx()
    .update(a)
    .set(values)
    .where(and(eq(a.id, id), eq(a.farmId, ctx().farmId)))
    .returning();
  return row;
}

/** Soft delete. An account holding money cannot be closed. */
export async function remove(id: string) {
  // The lock waits for money on its way in, which then counts in this balance.
  await get(id, { lock: true });
  const [account] = (await listWithBalances()).filter((row) => row.id === id);
  if (account && account.balance !== 0) {
    throw conflict('ACCOUNT_NOT_EMPTY', 'Move the balance out before closing this account', {
      balance: account.balance,
    });
  }
  await tx()
    .update(a)
    .set({ active: false })
    .where(and(eq(a.id, id), eq(a.farmId, ctx().farmId)));
  await recordEvent({ type: 'account.closed', entityType: 'account', entityId: id });
  return { id };
}

export interface DailyBalanceRow {
  date: string;
  inflow: number;
  outflow: number;
  closing: number;
}

/** Daily statement of one account over a period (spec 10.3.2). Days without movement are omitted. */
export async function dailyBalance(id: string, from: string, to: string) {
  const account = await get(id);
  const before = (await accountFlows(addDays(from, -1))).get(id)?.native ?? 0;
  const opening = round(account.openingBalance + before, 2);

  const rows = await tx()
    .select({
      date: t.date,
      inflow: sql`coalesce(sum(case
        when ${t.toAccountId} = ${id} then ${nativeAmount}
        when ${t.type} in ('income', 'debt_receipt') then ${nativeAmount}
        else 0 end), 0)`.mapWith(Number),
      outflow: sql`coalesce(sum(case
        when ${t.type} in ('expense', 'debt_payment') then ${nativeAmount}
        when ${t.type} = 'transfer' and ${t.accountId} = ${id} then ${nativeAmount}
        else 0 end), 0)`.mapWith(Number),
    })
    .from(t)
    .innerJoin(a, eq(a.id, id))
    .where(
      sql`${t.farmId} = ${ctx().farmId} and ${movesMoney} and ${afterOpening}
          and (${t.accountId} = ${id} or ${t.toAccountId} = ${id})
          and ${t.date} between ${from} and ${to}`,
    )
    .groupBy(t.date)
    .orderBy(asc(t.date));

  let closing = opening;
  const days: DailyBalanceRow[] = rows.map((row) => {
    closing = round(closing + row.inflow - row.outflow, 2);
    return { date: row.date, inflow: row.inflow, outflow: row.outflow, closing };
  });
  return { accountId: id, currency: account.currency, opening, closing, days };
}
