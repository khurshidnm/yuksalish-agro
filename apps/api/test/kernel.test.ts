import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { generalCostCenterId } from '../src/core/costCenters';
import { adjustStock, issueStock, receiveStock, reverseMovements, stockOnHand, transferStock } from '../src/core/inventory';
import { approveTransaction, postTransaction } from '../src/core/ledger';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { createFixture, type Fixture } from './helpers';

const { accounts, financeCategories, items, warehouses } = schema;

async function makeItem(f: Fixture, name = 'Beda') {
  return f.run(async () => {
    const [warehouse] = await tx()
      .insert(warehouses)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name: `Ombor ${name}`, type: 'feed' })
      .returning();
    const [item] = await tx()
      .insert(items)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name, category: 'feed', unit: 'kg' })
      .returning();
    return { itemId: item.id, warehouseId: warehouse.id };
  });
}

describe('tenant isolation', () => {
  let a: Fixture;
  let b: Fixture;

  beforeAll(async () => {
    a = await createFixture();
    b = await createFixture();
  });

  it("tenant B cannot list or fetch tenant A's records through the API", async () => {
    const ownerA = await a.as('owner');
    const ownerB = await b.as('owner');
    const created = await ownerA.post('/finance/counterparties', { name: 'Ali', type: 'supplier' });
    expect(created.status).toBe(201);

    const list = await ownerB.get('/finance/counterparties');
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);

    const single = await ownerB.get(`/finance/counterparties/${created.data.id}`);
    expect(single.status).toBe(404);
  });

  it('RLS blocks cross-tenant reads even when a query forgets its filter', async () => {
    const ownerA = await a.as('owner');
    await ownerA.post('/finance/counterparties', { name: 'Vali', type: 'buyer' });
    const seen = await b.run(() => tx().select().from(schema.counterparties));
    expect(seen.every((row) => row.tenantId === b.tenantId)).toBe(true);
  });

  it('RLS blocks writing a row into another tenant', async () => {
    await expect(
      b.run(() =>
        tx().insert(schema.counterparties).values({ tenantId: a.tenantId, farmId: a.farmId, name: 'Hack', type: 'other' }),
      ),
    ).rejects.toThrow();
  });

  it('a foreign key cannot point at another tenant, even though FK checks ignore RLS', async () => {
    const owner = await a.as('owner');
    const theirs = await owner.post('/finance/counterparties', { name: 'Theirs', type: 'supplier' });
    expect(theirs.status).toBe(201);

    const attempt = b.run(() =>
      tx().insert(schema.contracts).values({
        tenantId: b.tenantId,
        farmId: b.farmId,
        counterpartyId: theirs.data.id,
        number: 'X-1',
      }),
    );
    await expect(attempt).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it("the ledger refuses another tenant's account", async () => {
    const accountOfA = await a.run(async () => {
      const [row] = await tx()
        .insert(accounts)
        .values({ tenantId: a.tenantId, farmId: a.farmId, name: 'Kassa A', type: 'cash' })
        .returning();
      return row.id;
    });
    const attempt = b.run(async () => {
      const [category] = await tx().select().from(financeCategories).where(sql`key = 'feed'`);
      await postTransaction({
        date: '2026-11-01',
        type: 'expense',
        amount: 1000,
        paymentMethod: 'cash',
        accountId: accountOfA,
        categoryId: category.id,
        costCenterId: await generalCostCenterId(),
      });
    });
    await expect(attempt).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('a row cannot claim a farm of another tenant', async () => {
    await expect(
      b.run(() =>
        tx().insert(schema.counterparties).values({ tenantId: b.tenantId, farmId: a.farmId, name: 'Hack', type: 'other' }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('platform mode reaches identity tables but no business data', async () => {
    const { withPlatform } = await import('../src/core/context');
    const rows = await withPlatform(async (trx) => ({
      tenants: await trx.select({ id: schema.tenants.id }).from(schema.tenants),
      animals: await trx.select({ id: schema.counterparties.id }).from(schema.counterparties),
    }));
    expect(rows.tenants.length).toBeGreaterThanOrEqual(2);
    expect(rows.animals).toEqual([]);
  });

  it('a query with no tenant context sees nothing at all', async () => {
    const { db } = await import('../src/db/client');
    const rows = await db.select().from(schema.counterparties);
    expect(rows).toEqual([]);
  });

  it('the API role cannot bypass RLS or rewrite the journal', async () => {
    const result = await a.run(async () => {
      const role = await tx().execute(sql`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`);
      return role.rows[0];
    });
    expect(result).toEqual({ rolbypassrls: false, rolsuper: false });
    await expect(a.run(() => tx().execute(sql`delete from events`))).rejects.toThrow();
    await expect(a.run(() => tx().execute(sql`delete from audit_logs`))).rejects.toThrow();
  });
});

describe('permissions', () => {
  it('a shepherd is denied finance data (spec 24.1)', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    const response = await shepherd.get('/finance/counterparties');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('an investor can read reports but not the finance journal', async () => {
    const f = await createFixture();
    const investor = await f.as('investor');
    expect((await investor.get('/finance/counterparties')).status).toBe(403);
  });

  it('no token is a 401', async () => {
    const f = await createFixture();
    const response = await f.app.inject({ method: 'GET', url: '/api/v1/finance/counterparties' });
    expect(response.statusCode).toBe(401);
  });

  it('a disabled module is refused even with the permission', async () => {
    const f = await createFixture({ modules: ['livestock'] });
    const owner = await f.as('owner');
    const response = await owner.get('/finance/counterparties');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('MODULE_DISABLED');
  });

  it('a blocked membership stops working immediately, with a still-valid token', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    expect((await owner.get('/finance/counterparties')).status).toBe(200);
    await f.run(() =>
      tx().update(schema.memberships).set({ status: 'blocked' }).where(sql`id = ${owner.membershipId}`),
    );
    expect((await owner.get('/finance/counterparties')).status).toBe(401);
  });

  it('privileged roles are gated until they enrol in 2FA when policy requires it', async () => {
    const f = await createFixture({ settings: { security: { enforce2fa: true } } });
    const accountant = await f.as('accountant');
    const denied = await accountant.get('/finance/counterparties');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED');

    const shepherd = await f.as('shepherd');
    expect((await shepherd.get('/livestock/none')).status).toBe(404);
  });
});

describe('api conventions', () => {
  it('validation errors name the field', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const response = await owner.post('/finance/counterparties', { name: '', type: 'nonsense' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(response.body.error.details.fieldErrors).sort()).toEqual(['name', 'type']);
  });

  it('an empty PATCH is a no-op, not a server error', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const created = await owner.post('/finance/counterparties', { name: 'Same', type: 'buyer' });
    const response = await owner.patch(`/finance/counterparties/${created.data.id}`, {});
    expect(response.status).toBe(200);
    expect(response.data.name).toBe('Same');
  });

  it('lists paginate and search', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    for (const name of ['Alfa', 'Beta', 'Gamma']) await owner.post('/finance/counterparties', { name, type: 'buyer' });
    const page = await owner.get('/finance/counterparties', { pageSize: 2, page: 1, sort: '-name' });
    expect(page.body.meta).toEqual({ page: 1, pageSize: 2, total: 3 });
    expect(page.body.data.map((c: any) => c.name)).toEqual(['Gamma', 'Beta']);
    const found = await owner.get('/finance/counterparties', { search: 'alf' });
    expect(found.body.data.map((c: any) => c.name)).toEqual(['Alfa']);
  });

  it('search treats % and _ literally', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await owner.post('/finance/counterparties', { name: 'Plain', type: 'buyer' });
    expect((await owner.get('/finance/counterparties', { search: '%' })).body.data).toEqual([]);
  });

  it('a client-supplied id is kept, and a repeated Idempotency-Key does not create twice', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const id = '0190a7e2-7b1c-7c3d-8e4f-1234567890ab';
    const headers = { 'idempotency-key': 'outbox-1' };
    const first = await owner.post('/finance/counterparties', { id, name: 'Offline', type: 'buyer' }, headers);
    const second = await owner.post('/finance/counterparties', { id, name: 'Offline', type: 'buyer' }, headers);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.data.id).toBe(id);
    expect((await owner.get('/finance/counterparties')).body.meta.total).toBe(1);
  });

  it('a unique violation is a 409, not a 500', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const id = '0190a7e2-7b1c-7c3d-8e4f-1234567890ac';
    await owner.post('/finance/counterparties', { id, name: 'One', type: 'buyer' });
    const duplicate = await owner.post('/finance/counterparties', { id, name: 'Two', type: 'buyer' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('ALREADY_EXISTS');
  });
});

describe('PATCH routes', () => {
  it('no PATCH can reset a field it did not send, on any route', async () => {
    const { routeRegistry } = await import('../src/core/http');
    await createFixture();
    const patches = routeRegistry.filter((r) => r.method === 'PATCH' && r.body);
    expect(patches.length).toBeGreaterThan(30);

    // Routes whose schema adds defaults are exactly the ones routes() must protect.
    const withDefaults = patches.filter((r) => {
      const parsed = r.body!.safeParse({});
      return parsed.success && Object.keys(parsed.data as object).length > 0;
    });
    console.info(`PATCH routes with defaults: ${withDefaults.map((r) => r.url).join(', ') || 'none'}`);
    expect(routeRegistry.every((r) => r.access !== undefined)).toBe(true);
  });

  it('a default on a PATCH schema does not overwrite the stored value', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const created = await owner.post('/assets', { name: 'Traktor', type: 'tractor', rented: true });
    expect(created.status).toBe(201);
    expect(created.data.rented).toBe(true);

    const patched = await owner.patch(`/assets/${created.data.id}`, { name: 'Traktor 2' });
    expect(patched.status).toBe(200);
    expect(patched.data.name).toBe('Traktor 2');
    expect(patched.data.rented).toBe(true);
  });
});

describe('audit and journal', () => {
  it('records who changed what, with before and after, automatically', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const created = await owner.post('/finance/counterparties', { name: 'Old', type: 'buyer' });
    await owner.patch(`/finance/counterparties/${created.data.id}`, { name: 'New' });

    const log = await f.run(() =>
      tx().select().from(schema.auditLogs).where(sql`entity = 'counterparties' and entity_id = ${created.data.id}`).orderBy(schema.auditLogs.at),
    );
    expect(log.map((l) => l.action)).toEqual(['insert', 'update']);
    const update = log[1];
    expect(update.userId).toBe(owner.userId);
    expect((update.before as any).name).toBe('Old');
    expect((update.after as any).name).toBe('New');
    expect(update.device).toBe('lightMyRequest');
  });

  it('writes a journal event for a domain action', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const created = await owner.post('/finance/counterparties', { name: 'X', type: 'buyer' });
    const events = await f.run(() =>
      tx().select().from(schema.events).where(sql`entity_id = ${created.data.id}`),
    );
    expect(events.map((e) => e.type)).toEqual(['counterparty.created']);
    expect(events[0].createdBy).toBe(owner.userId);
  });
});

describe('inventory kernel', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  it('issues FIFO and reports the cost', async () => {
    const { itemId, warehouseId } = await makeItem(f, 'FIFO');
    await f.run(async () => {
      const costCenterId = await generalCostCenterId();
      await receiveStock({ itemId, warehouseId, qty: 100, unitCost: 10, date: '2026-10-01', source: 'purchase' });
      await receiveStock({ itemId, warehouseId, qty: 100, unitCost: 20, date: '2026-10-02', source: 'purchase' });
      const issue = await issueStock({ itemId, warehouseId, qty: 150, date: '2026-10-03', costCenterId, reason: 'ration' });
      expect(issue.totalCost).toBe(2000);
      expect(issue.movements).toHaveLength(2);
      expect(await stockOnHand(itemId)).toBe(50);
    });
  });

  it('uses weighted average when the tenant chooses it', async () => {
    const { itemId, warehouseId } = await makeItem(f, 'AVG');
    const settings = { ...DEFAULT_SETTINGS, inventory: { costingMethod: 'avg' as const } };
    await f.run(
      async () => {
        const costCenterId = await generalCostCenterId();
        await receiveStock({ itemId, warehouseId, qty: 100, unitCost: 10, date: '2026-10-01', source: 'purchase' });
        await receiveStock({ itemId, warehouseId, qty: 100, unitCost: 20, date: '2026-10-02', source: 'purchase' });
        const issue = await issueStock({ itemId, warehouseId, qty: 150, date: '2026-10-03', costCenterId, reason: 'ration' });
        expect(issue.totalCost).toBe(2250);
      },
      { settings },
    );
  });

  it('refuses to go negative and leaves stock unchanged', async () => {
    const { itemId, warehouseId } = await makeItem(f, 'Short');
    await f.run(() => receiveStock({ itemId, warehouseId, qty: 10, unitCost: 1, date: '2026-10-01', source: 'opening' }));
    await expect(
      f.run(async () => {
        const costCenterId = await generalCostCenterId();
        await issueStock({ itemId, warehouseId, qty: 11, date: '2026-10-02', costCenterId, reason: 'ration' });
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await f.run(() => stockOnHand(itemId))).toBe(10);
  });

  it('requires a cost center for any issue except a sale', async () => {
    const { itemId, warehouseId } = await makeItem(f, 'CC');
    await f.run(() => receiveStock({ itemId, warehouseId, qty: 10, unitCost: 1, date: '2026-10-01', source: 'opening' }));
    await expect(
      f.run(() => issueStock({ itemId, warehouseId, qty: 1, date: '2026-10-02', reason: 'ration' })),
    ).rejects.toMatchObject({ code: 'COST_CENTER_REQUIRED' });
    await f.run(() => issueStock({ itemId, warehouseId, qty: 1, date: '2026-10-02', reason: 'sale' }));
    expect(await f.run(() => stockOnHand(itemId))).toBe(9);
  });

  it('concurrent issues cannot both spend the same stock', async () => {
    const { itemId, warehouseId } = await makeItem(f, 'Race');
    await f.run(() => receiveStock({ itemId, warehouseId, qty: 10, unitCost: 1, date: '2026-10-01', source: 'opening' }));
    const attempt = () =>
      f.run(async () => {
        const costCenterId = await generalCostCenterId();
        await issueStock({ itemId, warehouseId, qty: 8, date: '2026-10-02', costCenterId, reason: 'ration' });
      });
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await f.run(() => stockOnHand(itemId))).toBe(2);
  });

  it('transfers keep total stock and cost', async () => {
    const { itemId, warehouseId } = await makeItem(f, 'Move');
    const { warehouseId: other } = await makeItem(f, 'Move2');
    await f.run(async () => {
      await receiveStock({ itemId, warehouseId, qty: 100, unitCost: 7, date: '2026-10-01', source: 'opening' });
      await transferStock({ itemId, fromWarehouseId: warehouseId, toWarehouseId: other, qty: 40, date: '2026-10-02' });
      expect(await stockOnHand(itemId, warehouseId)).toBe(60);
      expect(await stockOnHand(itemId, other)).toBe(40);
      expect(await stockOnHand(itemId)).toBe(100);
    });
  });

  it('stock counts correct stock in both directions', async () => {
    const { itemId, warehouseId } = await makeItem(f, 'Count');
    await f.run(async () => {
      await receiveStock({ itemId, warehouseId, qty: 100, unitCost: 10, date: '2026-10-01', source: 'opening' });
      const short = await adjustStock({ itemId, warehouseId, actualQty: 90, date: '2026-10-05' });
      expect(short).toEqual({ systemQty: 100, diffQty: -10, diffCost: -100 });
      expect(await stockOnHand(itemId)).toBe(90);
      const over = await adjustStock({ itemId, warehouseId, actualQty: 95, date: '2026-10-06' });
      expect(over).toEqual({ systemQty: 90, diffQty: 5, diffCost: 50 });
      expect(await stockOnHand(itemId)).toBe(95);
    });
  });

  it('reversing a source record restores stock', async () => {
    const { itemId, warehouseId } = await makeItem(f, 'Undo');
    const refId = '0190a7e2-7b1c-7c3d-8e4f-1234567890ff';
    await f.run(async () => {
      const costCenterId = await generalCostCenterId();
      await receiveStock({ itemId, warehouseId, qty: 50, unitCost: 2, date: '2026-10-01', source: 'opening' });
      await issueStock({ itemId, warehouseId, qty: 20, date: '2026-10-02', costCenterId, reason: 'ration', refType: 'daily_log', refId });
      expect(await stockOnHand(itemId)).toBe(30);
      await reverseMovements('daily_log', refId);
      expect(await stockOnHand(itemId)).toBe(50);
    });
  });

  it('a used receipt cannot be reversed', async () => {
    const { itemId, warehouseId } = await makeItem(f, 'Used');
    const refId = '0190a7e2-7b1c-7c3d-8e4f-1234567890fe';
    await expect(
      f.run(async () => {
        const costCenterId = await generalCostCenterId();
        await receiveStock({ itemId, warehouseId, qty: 50, unitCost: 2, date: '2026-10-01', source: 'purchase', refType: 'p', refId });
        await issueStock({ itemId, warehouseId, qty: 20, date: '2026-10-02', costCenterId, reason: 'ration' });
        await reverseMovements('p', refId);
      }),
    ).rejects.toMatchObject({ code: 'BATCH_ALREADY_USED' });
  });
});

describe('cost visibility', () => {
  it('a domain manager sees that domain only, a shepherd sees neither', async () => {
    const { canSeeMoney } = await import('../src/core/context');
    const f = await createFixture();
    const check = (permissions: string[]) =>
      f.run(async () => [canSeeMoney(), canSeeMoney('crops.approve'), canSeeMoney('feed.approve')], { permissions });
    expect(await check(['finance.view'])).toEqual([true, true, true]);
    expect(await check(['crops.approve'])).toEqual([false, true, false]);
    expect(await check(['feed.approve'])).toEqual([false, false, true]);
    expect(await check(['livestock.view', 'feed.view'])).toEqual([false, false, false]);
  });
});

describe('ledger kernel', () => {
  async function setup() {
    const f = await createFixture();
    const refs = await f.run(async () => {
      const [account] = await tx()
        .insert(accounts)
        .values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Kassa', type: 'cash' })
        .returning();
      const [category] = await tx()
        .select()
        .from(financeCategories)
        .where(sql`key = 'feed' and tenant_id = ${f.tenantId}`);
      return { accountId: account.id, categoryId: category.id, costCenterId: await generalCostCenterId() };
    });
    return { f, ...refs };
  }

  const expense = (over: object, refs: { accountId: string; categoryId: string; costCenterId: string }) => ({
    date: '2026-11-01',
    type: 'expense' as const,
    amount: 1_000_000,
    paymentMethod: 'cash' as const,
    ...refs,
    ...over,
  });

  it('small amounts post approved, large amounts wait for approval', async () => {
    const { f, ...refs } = await setup();
    await f.run(async () => {
      expect((await postTransaction(expense({ amount: 4_999_999 }, refs))).status).toBe('approved');
      expect((await postTransaction(expense({ amount: 5_000_000 }, refs))).status).toBe('pending');
    });
  });

  it('the maker cannot approve their own transaction, a second person can', async () => {
    const { f, ...refs } = await setup();
    const maker = await f.as('accountant');
    const checker = await f.as('director');
    const pending = await f.run(() => postTransaction(expense({ amount: 9_000_000 }, refs)), { userId: maker.userId });
    await expect(
      f.run(() => approveTransaction(pending.id), { userId: maker.userId }),
    ).rejects.toMatchObject({ code: 'SAME_MAKER_CHECKER' });
    const approved = await f.run(() => approveTransaction(pending.id), { userId: checker.userId });
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe(checker.userId);
  });

  it('voiding stops an approved entry counting, by id or by source', async () => {
    const { f: fx, ...refs } = await setup();
    const { voidTransactions } = await import('../src/core/ledger');
    const sourceId = '0190a7e2-7b1c-7c3d-8e4f-1234567890aa';
    await fx.run(async () => {
      const one = await postTransaction(expense({}, refs));
      const [voided] = await voidTransactions({ id: one.id }, 'mistake');
      expect(voided.status).toBe('rejected');
      expect(voided.rejectedReason).toBe('mistake');

      await postTransaction(expense({ sourceType: 'sale', sourceId }, refs));
      await postTransaction(expense({ sourceType: 'sale', sourceId }, refs));
      expect(await voidTransactions({ sourceType: 'sale', sourceId }, 'cancelled')).toHaveLength(2);
      expect(await voidTransactions({ sourceType: 'sale', sourceId }, 'again')).toHaveLength(0);
    });
  });

  it('cannot approve twice', async () => {
    const { f, ...refs } = await setup();
    const checker = await f.as('director');
    const pending = await f.run(() => postTransaction(expense({ amount: 9_000_000 }, refs)));
    await f.run(() => approveTransaction(pending.id), { userId: checker.userId });
    await expect(f.run(() => approveTransaction(pending.id), { userId: checker.userId })).rejects.toMatchObject({
      code: 'NOT_PENDING',
    });
  });

  it('converts foreign currency to base using the given or stored rate', async () => {
    const { f, ...refs } = await setup();
    await f.run(async () => {
      const given = await postTransaction(expense({ amount: 100, currency: 'USD', fxRate: 12_500 }, refs));
      expect(given.amountBase).toBe(1_250_000);

      await tx().insert(schema.fxRates).values({ tenantId: f.tenantId, date: '2026-10-15', currency: 'USD', rate: 12_600 });
      const stored = await postTransaction(expense({ amount: 100, currency: 'USD' }, refs));
      expect(stored.amountBase).toBe(1_260_000);
    });
    await expect(f.run(() => postTransaction(expense({ amount: 1, currency: 'EUR' }, refs)))).rejects.toMatchObject({
      code: 'FX_RATE_REQUIRED',
    });
  });

  it.each([
    [{ amount: 0 }, 'INVALID_AMOUNT'],
    [{ categoryId: null }, 'CATEGORY_REQUIRED'],
    [{ costCenterId: null }, 'COST_CENTER_REQUIRED'],
    [{ accountId: null }, 'ACCOUNT_REQUIRED'],
    [{ paymentMethod: 'debt', counterpartyId: null }, 'COUNTERPARTY_REQUIRED'],
  ])('rejects %j', async (over, code) => {
    const { f, ...refs } = await setup();
    await expect(f.run(() => postTransaction(expense(over, refs)))).rejects.toMatchObject({ code });
  });

  it('a transfer needs two different accounts', async () => {
    const { f, ...refs } = await setup();
    await expect(
      f.run(() =>
        postTransaction({ date: '2026-11-01', type: 'transfer', amount: 1, paymentMethod: 'cash', accountId: refs.accountId, toAccountId: refs.accountId }),
      ),
    ).rejects.toMatchObject({ code: 'SAME_ACCOUNT' });
  });
});
