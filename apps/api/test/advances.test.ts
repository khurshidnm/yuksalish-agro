/**
 * Cash handed to people who spend it for the farm (docs/cash-holders.md): the owner gives the manager
 * money, the manager says it arrived, spends it, gives back what is left.
 */
import { eq } from 'drizzle-orm';
import { todayIso, type Permission, type RoleKey } from '@yap/shared';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { ctx, tx } from '../src/core/context';
import { generalCostCenterId } from '../src/core/costCenters';
import { createFixture, type Client, type Fixture } from './helpers';

const { accounts, cashHandovers, employees, financeCategories, roles, transactions } = schema;

interface World {
  f: Fixture;
  owner: Client;
  director: Client;
  accountant: Client;
  shepherd: Client;
  /** Bahodir, the farm manager: a director with a login, so he can hold cash. */
  directorEmp: string;
  shepherdEmp: string;
  noLoginEmp: string;
  ownerEmp: string;
  /** The farm's cash box, 20 000 000 at the start. */
  safeId: string;
  generalId: string;
  category: (key: string) => string;
}

async function world(): Promise<World> {
  const f = await createFixture();
  const owner = await f.as('owner');
  const director = await f.as('director');
  const accountant = await f.as('accountant');
  const shepherd = await f.as('shepherd');
  const refs = await f.run(async () => {
    const c = ctx();
    const base = { tenantId: c.tenantId, farmId: c.farmId };
    const [safe] = await tx().insert(accounts).values({ ...base, name: 'Kassa', type: 'cash', openingBalance: 20_000_000 }).returning();
    const person = async (fullName: string, userId: string | null) =>
      (await tx().insert(employees).values({ ...base, fullName, position: 'Xodim', hireDate: '2026-01-01', userId }).returning())[0].id;
    const categories = await tx().select().from(financeCategories).where(eq(financeCategories.tenantId, c.tenantId));
    return {
      safeId: safe.id,
      directorEmp: await person('Bahodir Karimov', director.userId),
      shepherdEmp: await person("Olim Cho'ponov", shepherd.userId),
      noLoginEmp: await person('Sardor Aliyev', null),
      ownerEmp: await person('Akmal Egamov', owner.userId),
      generalId: await generalCostCenterId(),
      categoryIds: Object.fromEntries(categories.map((row) => [row.key, row.id])) as Record<string, string>,
    };
  });
  const { categoryIds, ...rest } = refs;
  return { f, owner, director, accountant, shepherd, ...rest, category: (key) => categoryIds[key] };
}

/** A role given exactly these rights, for a sender who may record money but not approve it. */
async function grant(w: World, role: RoleKey, permissions: Permission[]) {
  await w.f.run(() => tx().update(roles).set({ permissions }).where(eq(roles.id, w.f.roleIds[role])));
}

const handOver = (w: World, from: Client, body: Record<string, unknown>) =>
  from.post('/finance/cash-handovers', { employeeId: w.directorEmp, ...body });

const press = (client: Client, id: string, button: string, reason?: string) =>
  client.post('/notifications/actions', { kind: 'cash_handover', id, button, ...(reason === undefined ? {} : { reason }) });

/** Own money handed to Bahodir, and his "Received". */
async function given(w: World, amount: number) {
  const sent = await handOver(w, w.owner, { amount, source: 'own_funds' });
  expect(sent.status).toBe(201);
  const accepted = await press(w.director, sent.data.id, 'accept');
  expect(accepted.status).toBe(200);
  return sent.data as { id: string; holderAccountId: string; holderId: string };
}

async function balanceOf(client: Client, accountId: string): Promise<number | undefined> {
  const res = await client.get('/finance/accounts');
  return res.data.find((a: { id: string }) => a.id === accountId)?.balance;
}

const handoverRow = (w: World, id: string) => w.f.run(async () => (await tx().select().from(cashHandovers).where(eq(cashHandovers.id, id)))[0]);
const moneyRow = (w: World, id: string) => w.f.run(async () => (await tx().select().from(transactions).where(eq(transactions.id, id)))[0]);

/** An expense paid from a cash account, as the client enters it. */
const spend = (w: World, client: Client, accountId: string, amount: number, key = 'fuel') =>
  client.post('/finance/transactions', {
    date: todayIso(),
    type: 'expense',
    amount,
    categoryId: w.category(key),
    costCenterId: w.generalId,
    paymentMethod: 'cash',
    accountId,
  });

describe('cash handed to a person', () => {
  it('moves nothing until the holder says it arrived, then counts it approved by the owner who sent it', async () => {
    const w = await world();
    const sent = await handOver(w, w.owner, { amount: 6_000_000, source: 'own_funds', note: 'Haftalik xarajatlar' });
    expect(sent.status).toBe(201);
    expect(sent.data).toMatchObject({ status: 'sent', amount: 6_000_000, currency: 'UZS', source: 'own_funds', transactionId: null });
    expect(await balanceOf(w.owner, sent.data.holderAccountId)).toBe(0);
    expect((await w.owner.get('/finance/transactions', { type: 'contribution' })).data).toHaveLength(0);

    // Bahodir gets the message with his two buttons; nobody else can press them.
    const inbox = await w.director.get('/notifications');
    const message = inbox.data.find((n: { action: { kind: string } | null }) => n.action?.kind === 'cash_handover');
    expect(message.title).toContain('6 000 000');
    expect(message.action.buttons.map((b: { key: string }) => b.key)).toEqual(['accept', 'dispute']);
    expect((await press(w.accountant, sent.data.id, 'accept')).body.error.code).toBe('ACTION_NOT_AVAILABLE');
    expect((await w.owner.post(`/finance/cash-handovers/${sent.data.id}/accept`)).body.error.code).toBe('NOT_THE_HOLDER');

    const accepted = await press(w.director, sent.data.id, 'accept');
    expect(accepted.status).toBe(200);
    expect(accepted.data.message).toBe('finance:cashHolders.actions.accepted');

    // 6 000 000 is above the 5 000 000 threshold, and it still counts at once: entered by Bahodir,
    // approved by the owner, two people as the rule asks.
    const handover = await handoverRow(w, sent.data.id);
    expect(handover.status).toBe('accepted');
    expect(await moneyRow(w, handover.transactionId!)).toMatchObject({
      type: 'contribution',
      status: 'approved',
      amount: 6_000_000,
      accountId: sent.data.holderAccountId,
      createdBy: w.director.userId,
      approvedBy: w.owner.userId,
      sourceType: 'cash_handover',
      sourceId: sent.data.id,
    });
    expect(await balanceOf(w.owner, sent.data.holderAccountId)).toBe(6_000_000);

    // A second press finds nothing to do, and the message has no buttons left.
    expect((await press(w.director, sent.data.id, 'accept')).body.error.code).toBe('ACTION_NOT_AVAILABLE');
    const after = await w.director.get('/notifications');
    expect(after.data.find((n: { id: string }) => n.id === message.id).action.buttons).toEqual([]);
    // The owner hears that it arrived.
    const ownerInbox = await w.owner.get('/notifications');
    expect(ownerInbox.data.some((n: { eventType: string; title: string }) => n.eventType === 'cash_handover' && n.title.includes('6 000 000'))).toBe(true);
  });

  it("keeps the owner's own money out of profit, and shows it in cash flow as financing", async () => {
    const w = await world();
    await given(w, 6_000_000);
    const totals = await w.owner.get('/finance/transactions/totals');
    expect(totals.data).toEqual({ income: 0, expense: 0, net: 0 });
    const flow = await w.owner.get('/finance/cashflow/actual');
    const month = flow.data.find((row: { month: string }) => row.month === todayIso().slice(0, 7));
    expect(month).toMatchObject({ inflow: 6_000_000, outflow: 0, financingIn: 6_000_000, financingOut: 0, net: 6_000_000 });
  });

  it('from a farm account it is a transfer, and a sender who may not approve leaves it waiting for someone who may', async () => {
    const w = await world();
    const storekeeper = await w.f.as('storekeeper');
    await grant(w, 'storekeeper', ['finance.view', 'finance.create']);

    const sent = await handOver(w, storekeeper, { amount: 6_000_000, source: 'account', fromAccountId: w.safeId });
    expect(sent.status).toBe(201);
    const accepted = await press(w.director, sent.data.id, 'accept');
    expect(accepted.data.message).toBe('finance:cashHolders.actions.acceptedPending');

    const handover = await handoverRow(w, sent.data.id);
    const money = await moneyRow(w, handover.transactionId!);
    expect(money).toMatchObject({ type: 'transfer', status: 'pending', accountId: w.safeId, toAccountId: sent.data.holderAccountId, approvedBy: null });
    // Not counted yet, but the cash is in his hands: what he should have says so.
    expect(await balanceOf(w.owner, sent.data.holderAccountId)).toBe(0);
    const summary = await w.owner.get(`/finance/cash-holders/${sent.data.holderId}`);
    expect(summary.data).toMatchObject({ balance: 0, expectedCash: 6_000_000, pending: { count: 1, in: 6_000_000, out: 0 } });

    expect((await w.director.post(`/finance/transactions/${money.id}/approve`)).body.error.code).toBe('SAME_MAKER_CHECKER');
    expect((await storekeeper.post(`/finance/transactions/${money.id}/approve`)).status).toBe(403);
    expect((await w.owner.post(`/finance/transactions/${money.id}/approve`)).status).toBe(200);
    expect(await balanceOf(w.owner, sent.data.holderAccountId)).toBe(6_000_000);
    expect(await balanceOf(w.owner, w.safeId)).toBe(14_000_000);
  });

  it('never lets the person holding the cash approve what is paid from it', async () => {
    const w = await world();
    const { holderAccountId } = await given(w, 8_000_000);
    const repair = await spend(w, w.accountant, holderAccountId, 5_500_000, 'repair');
    expect(repair.status).toBe(201);
    expect(repair.data.status).toBe('pending');
    const refused = await w.director.post(`/finance/transactions/${repair.data.id}/approve`);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('HOLDER_CANNOT_APPROVE');
    expect((await w.owner.post(`/finance/transactions/${repair.data.id}/approve`)).status).toBe(200);
    expect(await balanceOf(w.owner, holderAccountId)).toBe(2_500_000);
  });

  it('takes own money only from the owner, and only to someone who can answer for it', async () => {
    const w = await world();
    const code = async (from: Client, body: Record<string, unknown>) => (await handOver(w, from, body)).body.error?.code;
    expect(await code(w.accountant, { amount: 1_000_000, source: 'own_funds' })).toBe('CAPITAL_NOT_ALLOWED');
    expect(await code(w.owner, { amount: 1_000_000, source: 'own_funds', employeeId: w.noLoginEmp })).toBe('HOLDER_NEEDS_LOGIN');
    expect(await code(w.owner, { amount: 1_000_000, source: 'own_funds', employeeId: w.shepherdEmp })).toBe('HOLDER_NEEDS_FINANCE');
    expect(await code(w.owner, { amount: 1_000_000, source: 'own_funds', employeeId: w.ownerEmp })).toBe('HANDOVER_TO_SELF');
    expect(await code(w.owner, { amount: 1_000_000, source: 'account' })).toBe('FROM_ACCOUNT_REQUIRED');
    expect(await code(w.owner, { amount: 1_000_000, source: 'own_funds', fromAccountId: w.safeId })).toBe('FROM_ACCOUNT_NOT_EXPECTED');
    expect(await code(w.owner, { amount: 1_000_000, source: 'own_funds', date: '2099-01-01' })).toBe('DATE_IN_FUTURE');
    // Dollars from the owner's pocket need a rate to be valued.
    expect(await code(w.owner, { amount: 1_000, currency: 'USD', source: 'own_funds' })).toBe('FX_RATE_REQUIRED');
    expect((await handOver(w, w.shepherd, { amount: 1_000_000, source: 'own_funds' })).status).toBe(403);
    // Nothing was left behind by the refusals: no cash account was opened for anyone.
    expect((await w.owner.get('/finance/cash-holders')).data).toEqual([]);
  });

  it('opens the cash in the currency handed over', async () => {
    const w = await world();
    const sent = await handOver(w, w.owner, { amount: 1_000, currency: 'USD', fxRate: 12_000, source: 'own_funds' });
    expect(sent.status).toBe(201);
    await press(w.director, sent.data.id, 'accept');
    const money = await moneyRow(w, (await handoverRow(w, sent.data.id)).transactionId!);
    expect(money).toMatchObject({ currency: 'USD', amount: 1_000, amountBase: 12_000_000, status: 'approved' });
    const holders = (await w.owner.get('/finance/cash-holders')).data;
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({ currency: 'USD', balance: 1_000 });
  });

  it('records "not received" with a reason, and lets the sender take back one still waiting', async () => {
    const w = await world();
    const first = await handOver(w, w.owner, { amount: 1_000_000, source: 'own_funds' });
    expect((await press(w.director, first.data.id, 'dispute')).body.error.code).toBe('REASON_REQUIRED');
    const disputed = await press(w.director, first.data.id, 'dispute', "Faqat 800 ming keldi");
    expect(disputed.data.message).toBe('finance:cashHolders.actions.disputed');
    expect(await handoverRow(w, first.data.id)).toMatchObject({ status: 'disputed', disputeReason: 'Faqat 800 ming keldi', transactionId: null });
    const ownerInbox = await w.owner.get('/notifications');
    expect(ownerInbox.data.some((n: { body: string | null }) => n.body === 'Faqat 800 ming keldi')).toBe(true);

    const second = await handOver(w, w.owner, { amount: 2_000_000, source: 'own_funds' });
    expect((await w.accountant.post(`/finance/cash-handovers/${second.data.id}/cancel`)).body.error.code).toBe('NOT_THE_SENDER');
    expect((await w.owner.post(`/finance/cash-handovers/${second.data.id}/cancel`)).data.status).toBe('cancelled');
    expect((await w.director.post(`/finance/cash-handovers/${second.data.id}/accept`)).body.error.code).toBe('HANDOVER_DECIDED');
    expect(await balanceOf(w.owner, second.data.holderAccountId)).toBe(0);
  });

  it('reverses a mistaken handover only while its cash is unspent, and never by the holder', async () => {
    const w = await world();
    const first = await given(w, 3_000_000);
    expect((await spend(w, w.director, first.holderAccountId, 1_000_000)).data.status).toBe('approved');
    // He holds 2 000 000 of the 3 000 000: taking all of it off the books would leave spending from nothing.
    const spent = await w.owner.post(`/finance/cash-handovers/${first.id}/reverse`, { reason: 'Xato' });
    expect(spent.status).toBe(409);
    expect(spent.body.error).toMatchObject({ code: 'HOLDER_CASH_SPENT', details: { expectedCash: 2_000_000, amount: 3_000_000 } });

    const second = await given(w, 2_000_000);
    expect((await w.director.post(`/finance/cash-handovers/${second.id}/reverse`, { reason: 'Xato' })).body.error.code).toBe('HOLDER_CANNOT_APPROVE');
    const reversed = await w.owner.post(`/finance/cash-handovers/${second.id}/reverse`, { reason: 'Ikki marta yozilgan' });
    expect(reversed.status).toBe(200);
    expect(reversed.data).toMatchObject({ status: 'reversed', reversedReason: 'Ikki marta yozilgan' });
    expect(await moneyRow(w, reversed.data.transactionId)).toMatchObject({ status: 'rejected', rejectedReason: 'Ikki marta yozilgan' });
    expect(await balanceOf(w.owner, first.holderAccountId)).toBe(2_000_000);
    // It is the handover's money: finance sends people back to the handover to cancel it.
    const handover = await handoverRow(w, first.id);
    expect((await w.owner.post(`/finance/transactions/${handover.transactionId}/void`, { reason: 'x' })).body.error.code).toBe('TRANSACTION_HAS_SOURCE');
  });

  it('marks the handover reversed when finance refuses its waiting money, unless part of it is spent', async () => {
    const w = await world();
    const storekeeper = await w.f.as('storekeeper');
    await grant(w, 'storekeeper', ['finance.view', 'finance.create']);

    const first = await handOver(w, storekeeper, { amount: 6_000_000, source: 'account', fromAccountId: w.safeId });
    await press(w.director, first.data.id, 'accept');
    const firstMoney = (await handoverRow(w, first.data.id)).transactionId!;
    expect((await w.owner.post(`/finance/transactions/${firstMoney}/reject`, { reason: 'Kerak emas' })).status).toBe(200);
    expect(await handoverRow(w, first.data.id)).toMatchObject({ status: 'reversed', reversedReason: 'Kerak emas', reversedBy: w.owner.userId });

    const second = await handOver(w, storekeeper, { amount: 6_000_000, source: 'account', fromAccountId: w.safeId });
    await press(w.director, second.data.id, 'accept');
    expect((await spend(w, w.director, second.data.holderAccountId, 1_500_000)).data.status).toBe('approved');
    const secondMoney = (await handoverRow(w, second.data.id)).transactionId!;
    const refused = await w.owner.post(`/finance/transactions/${secondMoney}/reject`, { reason: 'Kerak emas' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('HOLDER_CASH_SPENT');
    expect((await handoverRow(w, second.data.id)).status).toBe('accepted');
  });

  it('gives cash back to the owner or into the farm cash, never more than is held', async () => {
    const w = await world();
    const { holderId, holderAccountId } = await given(w, 5_000_000);
    const back = (client: Client, body: Record<string, unknown>) => client.post(`/finance/cash-holders/${holderId}/return`, body);

    const tooMuch = await back(w.director, { amount: 6_000_000, to: 'account', toAccountId: w.safeId });
    expect(tooMuch.body.error).toMatchObject({ code: 'HOLDER_CASH_SHORT', details: { expectedCash: 5_000_000 } });
    const toSafe = await back(w.director, { amount: 1_000_000, to: 'account', toAccountId: w.safeId });
    expect(toSafe.status).toBe(201);
    expect(toSafe.data).toMatchObject({ type: 'transfer', status: 'approved', sourceType: null });
    expect((await back(w.director, { amount: 100_000, to: 'owner' })).body.error.code).toBe('CAPITAL_NOT_ALLOWED');
    const toOwner = await back(w.owner, { amount: 500_000, to: 'owner' });
    expect(toOwner.data).toMatchObject({ type: 'withdrawal', status: 'approved' });

    expect(await balanceOf(w.owner, holderAccountId)).toBe(3_500_000);
    expect(await balanceOf(w.owner, w.safeId)).toBe(21_000_000);
    const tiles = await w.owner.get('/finance/capital');
    expect(tiles.data).toMatchObject({ contributed: 5_000_000, withdrawn: 500_000, invested: 4_500_000, cashWithPeople: 3_500_000, holders: 1 });
  });

  /**
   * Control numbers, by hand:
   *   own money handed over          8 000 000   received
   *   fuel, paid from his cash       1 200 000   spent (approved, under the threshold)
   *   repair, paid from his cash     5 000 000   waiting: at the threshold, so not counted
   *   back into the farm cash box      500 000   returned
   *   balance  8 000 000 - 1 200 000 - 500 000 = 6 300 000
   *   in hand  6 300 000 - 5 000 000 waiting   = 1 300 000
   */
  it('sums up what one person received, spent and still holds', async () => {
    const w = await world();
    const { holderId, holderAccountId } = await given(w, 8_000_000);
    expect((await spend(w, w.director, holderAccountId, 1_200_000, 'fuel')).data.status).toBe('approved');
    expect((await spend(w, w.director, holderAccountId, 5_000_000, 'repair')).data.status).toBe('pending');
    expect((await w.director.post(`/finance/cash-holders/${holderId}/return`, { amount: 500_000, to: 'account', toAccountId: w.safeId })).status).toBe(201);

    const summary = await w.owner.get(`/finance/cash-holders/${holderId}`);
    expect(summary.status).toBe(200);
    expect(summary.data).toMatchObject({
      holder: { name: 'Bahodir Karimov', currency: 'UZS', isMe: false, active: true },
      opening: 0,
      received: 8_000_000,
      spent: 1_200_000,
      returned: 500_000,
      closing: 6_300_000,
      balance: 6_300_000,
      pending: { count: 1, in: 0, out: 5_000_000 },
      expectedCash: 1_300_000,
      handoversWaiting: 0,
    });
    expect(summary.data.byCategory).toEqual([expect.objectContaining({ key: 'fuel', amount: 1_200_000 })]);
    expect(summary.data.byCostCenter).toEqual([expect.objectContaining({ costCenterId: w.generalId, amount: 1_200_000 })]);
    // The waiting repair is on his list, the refused nothing: four entries in all.
    expect(summary.data.entries.map((e: { amount: number; status: string }) => [e.amount, e.status])).toEqual([
      [8_000_000, 'approved'],
      [1_200_000, 'approved'],
      [5_000_000, 'pending'],
      [500_000, 'approved'],
    ]);

    const list = await w.owner.get('/finance/cash-holders');
    expect(list.data).toEqual([
      expect.objectContaining({
        id: holderId,
        name: 'Bahodir Karimov',
        balance: 6_300_000,
        expectedCash: 1_300_000,
        week: expect.objectContaining({ received: 8_000_000, spent: 1_200_000 }),
        pendingApproval: 1,
        handoversWaiting: 0,
      }),
    ]);
    const mine = await w.director.get('/finance/cash-holders');
    expect(mine.data[0].isMe).toBe(true);
    // In people's hands, not on the books: the waiting repair already left his pocket.
    const tiles = await w.owner.get('/finance/capital');
    expect(tiles.data).toMatchObject({ invested: 8_000_000, cashWithPeople: 1_300_000, holders: 1 });
  });
});

describe("the owner's own money by hand", () => {
  it('is entered only by the owner, through one account, and never straight into a person\'s cash', async () => {
    const w = await world();
    const entry = (client: Client, body: Record<string, unknown>) =>
      client.post('/finance/transactions', { date: todayIso(), paymentMethod: 'cash', amount: 2_000_000, ...body });

    expect((await entry(w.accountant, { type: 'contribution', accountId: w.safeId })).body.error.code).toBe('CAPITAL_NOT_ALLOWED');
    expect((await entry(w.owner, { type: 'contribution', accountId: w.safeId, categoryId: w.category('other') })).status).toBe(400);
    const put = await entry(w.owner, { type: 'contribution', accountId: w.safeId, description: 'Yer uchun' });
    expect(put.status).toBe(201);
    expect(put.data).toMatchObject({ type: 'contribution', status: 'approved' });
    expect(await balanceOf(w.owner, w.safeId)).toBe(22_000_000);

    const opened = await w.owner.post('/finance/cash-holders', { employeeId: w.directorEmp });
    expect(opened.status).toBe(201);
    const holderAccount = opened.data.accountId;
    expect((await entry(w.accountant, { type: 'transfer', accountId: w.safeId, toAccountId: holderAccount })).body.error.code).toBe('USE_CASH_HANDOVER');
    expect((await entry(w.owner, { type: 'contribution', accountId: holderAccount })).body.error.code).toBe('USE_CASH_HANDOVER');
    // Taking money from the cash box himself is his own word, so it needs no handover.
    expect((await entry(w.director, { type: 'transfer', accountId: w.safeId, toAccountId: holderAccount, amount: 300_000 })).status).toBe(201);
    expect(await balanceOf(w.owner, holderAccount)).toBe(300_000);
  });
});

describe("another person's cash in lists", () => {
  it('is left out for those without finance rights, and unnamed for those without personal data', async () => {
    const w = await world();
    const mechanic = await w.f.as('mechanic');
    const opened = await w.owner.post('/finance/cash-holders', { employeeId: w.directorEmp });
    const holderAccount = opened.data.accountId;
    const ids = (res: { data: { id: string }[] }) => res.data.map((a) => a.id);

    const forShepherd = await w.shepherd.get('/finance/accounts/lookup');
    expect(ids(forShepherd)).toContain(w.safeId);
    expect(ids(forShepherd)).not.toContain(holderAccount);

    const forHolder = await w.director.get('/finance/accounts/lookup');
    expect(forHolder.data.find((a: { id: string }) => a.id === holderAccount)).toMatchObject({ name: 'Bahodir Karimov', holder: { isMe: true } });

    // Finance without personal data: the account shows, but not whose it is, and the name finds nothing.
    await grant(w, 'mechanic', ['finance.view']);
    const forMechanic = await mechanic.get('/finance/accounts/lookup');
    expect(forMechanic.data.find((a: { id: string }) => a.id === holderAccount)).toMatchObject({ name: null, holder: { isMe: false } });
    expect(ids(await mechanic.get('/finance/accounts/lookup', { search: 'Bahodir' }))).not.toContain(holderAccount);
    expect((await mechanic.get('/finance/accounts')).data.find((a: { id: string }) => a.id === holderAccount).name).toBeNull();
    expect((await mechanic.get('/finance/cash-holders')).data[0].name).toBeNull();

    const forOwner = await w.owner.get('/finance/accounts');
    expect(forOwner.data.find((a: { id: string }) => a.id === holderAccount)).toMatchObject({ name: 'Bahodir Karimov', holder: { isMe: false } });
  });

  it('belongs to its own tenant', async () => {
    const w = await world();
    const sent = await handOver(w, w.owner, { amount: 1_000_000, source: 'own_funds' });
    const other = await createFixture();
    const stranger = await other.as('owner');
    expect((await stranger.get('/finance/cash-holders')).data).toEqual([]);
    expect((await stranger.get('/finance/cash-handovers')).data).toEqual([]);
    expect((await stranger.post(`/finance/cash-handovers/${sent.data.id}/accept`)).status).toBe(404);
    expect((await press(stranger, sent.data.id, 'accept')).body.error.code).toBe('ACTION_NOT_AVAILABLE');
    expect((await handoverRow(w, sent.data.id)).status).toBe('sent');
  });
});

describe('a person holding cash', () => {
  it('cannot leave or change login, and the cash account closes only once it is empty', async () => {
    const w = await world();
    const sent = await handOver(w, w.owner, { amount: 1_000_000, source: 'own_funds' });
    const leave = () => w.owner.post(`/hr/employees/${w.directorEmp}/terminate`, { date: todayIso() });
    expect((await leave()).body.error.code).toBe('EMPLOYEE_HOLDS_CASH');

    await press(w.director, sent.data.id, 'accept');
    const holderId = sent.data.holderId;
    expect((await w.owner.post(`/finance/cash-holders/${holderId}/close`)).body.error).toMatchObject({
      code: 'HOLDER_HAS_CASH',
      details: { expectedCash: 1_000_000 },
    });
    expect((await w.owner.delete(`/finance/accounts/${sent.data.holderAccountId}`)).body.error.code).toBe('HOLDER_ACCOUNT');
    expect((await w.owner.patch(`/hr/employees/${w.directorEmp}`, { userId: null })).body.error.code).toBe('EMPLOYEE_HOLDS_CASH');
    // Other edits of the record go through.
    expect((await w.owner.patch(`/hr/employees/${w.directorEmp}`, { position: 'Ferma boshqaruvchisi' })).status).toBe(200);

    expect((await w.owner.post(`/finance/cash-holders/${holderId}/return`, { amount: 1_000_000, to: 'owner' })).status).toBe(201);
    expect((await w.owner.post(`/finance/cash-holders/${holderId}/close`)).data).toEqual({ id: holderId, active: false });
    expect((await w.owner.get('/finance/cash-holders')).data).toEqual([]);
    expect(await balanceOf(w.owner, sent.data.holderAccountId)).toBeUndefined();
    expect((await leave()).status).toBe(200);
  });
});
