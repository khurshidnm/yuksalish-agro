import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@yap/shared';
import { schema } from '../src/db/client';
import { tx, withPlatform } from '../src/core/context';
import { generalCostCenterId, ensureCostCenter } from '../src/core/costCenters';
import { receiveStock, stockOnHand } from '../src/core/inventory';
import { postTransaction } from '../src/core/ledger';
import { incomeCategoryKey } from '../src/modules/sales/orders.service';
import { balanceEffect } from '../src/modules/sales/settlement.service';
import { addMonths } from '../src/modules/sales/state-reports.service';
import { createFixture, type Client, type Fixture } from './helpers';

const { accounts, animalExits, animals, counterparties, financeCategories, healthRecords, herds, items, species, transactions, warehouses } = schema;

interface World {
  warehouseId: string;
  woolId: string;
  alfalfaId: string;
  accountId: string;
  buyerId: string;
  supplierId: string;
  herdId: string;
  herdCostCenterId: string;
  speciesId: string;
}

/**
 * Wool stock in two batches: 100 kg at 10 000, then 100 kg at 20 000. FIFO cost is easy to check by hand.
 * Alfalfa: 50 t at 1 000 000.
 */
async function arrange(f: Fixture): Promise<World> {
  return f.run(async () => {
    const base = { tenantId: f.tenantId, farmId: f.farmId };
    const [warehouse] = await tx().insert(warehouses).values({ ...base, name: 'Mahsulot', type: 'finished_goods' }).returning();
    const [wool] = await tx().insert(items).values({ ...base, name: 'Jun', category: 'product', unit: 'kg' }).returning();
    const [alfalfa] = await tx().insert(items).values({ ...base, name: 'Beda (pichan)', category: 'feed', unit: 't' }).returning();
    await receiveStock({ itemId: wool.id, warehouseId: warehouse.id, qty: 100, unitCost: 10_000, date: '2026-10-01', source: 'opening' });
    await receiveStock({ itemId: wool.id, warehouseId: warehouse.id, qty: 100, unitCost: 20_000, date: '2026-10-02', source: 'opening' });
    await receiveStock({ itemId: alfalfa.id, warehouseId: warehouse.id, qty: 50, unitCost: 1_000_000, date: '2026-10-01', source: 'opening' });

    const [account] = await tx().insert(accounts).values({ ...base, name: 'Kassa', type: 'cash' }).returning();
    const [buyer] = await tx().insert(counterparties).values({ ...base, name: 'Xaridor MChJ', type: 'buyer' }).returning();
    const [supplier] = await tx().insert(counterparties).values({ ...base, name: 'Yem Savdo', type: 'supplier' }).returning();

    const [sheep] = await tx().select().from(species).where(eq(species.tenantId, f.tenantId)).limit(1);
    const [herd] = await tx().insert(herds).values({ ...base, name: 'Sovliqlar' }).returning();
    const herdCostCenterId = await ensureCostCenter('herd', herd.id, herd.name);
    await tx().update(herds).set({ costCenterId: herdCostCenterId }).where(eq(herds.id, herd.id));

    return {
      warehouseId: warehouse.id,
      woolId: wool.id,
      alfalfaId: alfalfa.id,
      accountId: account.id,
      buyerId: buyer.id,
      supplierId: supplier.id,
      herdId: herd.id,
      herdCostCenterId,
      speciesId: sheep.id,
    };
  });
}

let tagCounter = 0;
async function addAnimal(f: Fixture, w: World, over: Partial<typeof animals.$inferInsert> = {}) {
  return f.run(async () => {
    const [row] = await tx()
      .insert(animals)
      .values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        tag: `T-${++tagCounter}`,
        speciesId: w.speciesId,
        sex: 'female',
        category: 'ewe',
        origin: 'purchased',
        purchasePrice: 1_500_000,
        herdId: w.herdId,
        status: 'active',
        currentWeightKg: 55,
        ...over,
      })
      .returning();
    return row;
  });
}

const woolLine = (w: World, qty: number, price: number) => ({ itemId: w.woolId, warehouseId: w.warehouseId, qty, price });

/** A date safely in the past: a sale cannot be confirmed with a future date. */
const SALE_DATE = '2026-11-03';

const saleBody = (w: World, lines: object[], over: object = {}) => ({
  date: SALE_DATE,
  counterpartyId: w.buyerId,
  paymentMethod: 'cash',
  accountId: w.accountId,
  lines,
  ...over,
});

const saleTransactions = (f: Fixture, saleId: string, sourceType = 'sale') =>
  f.run(() =>
    tx()
      .select()
      .from(transactions)
      .where(and(eq(transactions.sourceId, saleId), eq(transactions.sourceType, sourceType))),
  );

const categoryOf = (f: Fixture, id: string | null) =>
  f.run(async () => {
    const [row] = await tx().select().from(financeCategories).where(eq(financeCategories.id, id!));
    return row.key;
  });

describe('sale documents', () => {
  let f: Fixture;
  let w: World;
  let accountant: Client;

  beforeAll(async () => {
    f = await createFixture();
    w = await arrange(f);
    accountant = await f.as('accountant');
  });

  it('a draft moves nothing and gets a yearly number', async () => {
    const before = await f.run(() => stockOnHand(w.woolId));
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 50_000)]));
    expect(sale.status).toBe(201);
    expect(sale.data.status).toBe('draft');
    expect(sale.data.number).toMatch(/^S-2026-\d{4}$/);
    expect(sale.data.totalAmount).toBe(50_000);
    expect(await f.run(() => stockOnHand(w.woolId))).toBe(before);
    expect(await saleTransactions(f, sale.data.id)).toEqual([]);
  });

  it('confirming issues stock FIFO, records cost and posts income', async () => {
    const g = await createFixture();
    const world = await arrange(g);
    const user = await g.as('accountant');

    // 150 kg crosses both batches: 100 × 10 000 + 50 × 20 000 = 2 000 000.
    const sale = await user.post('/sales/orders', saleBody(world, [woolLine(world, 150, 30_000)]));
    expect(sale.data.totalAmount).toBe(4_500_000);

    const confirmed = await user.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.data.status).toBe('confirmed');
    expect(confirmed.data.lines[0].costAmount).toBe(2_000_000);
    expect(confirmed.data.confirmedBy).toBe(user.userId);

    expect(await g.run(() => stockOnHand(world.woolId))).toBe(50);

    const posted = await saleTransactions(g, sale.data.id);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'income', status: 'approved', amountBase: 4_500_000, paymentMethod: 'cash', counterpartyId: world.buyerId });
    expect(await categoryOf(g, posted[0].categoryId)).toBe('wool_sales');
    expect(confirmed.data.transactionId).toBe(posted[0].id);
  });

  it('posts one income per product type', async () => {
    const sale = await accountant.post(
      '/sales/orders',
      saleBody(w, [woolLine(w, 2, 50_000), { itemId: w.alfalfaId, warehouseId: w.warehouseId, qty: 1, price: 2_000_000 }]),
    );
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    const posted = await saleTransactions(f, sale.data.id);
    const byCategory = Object.fromEntries(
      await Promise.all(posted.map(async (t) => [await categoryOf(f, t.categoryId), t.amountBase])),
    );
    expect(byCategory).toEqual({ wool_sales: 100_000, alfalfa_sales: 2_000_000 });
  });

  it('a future-dated sale can be saved but not confirmed', async () => {
    const { addDays, todayIso } = await import('@yap/shared');
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 1000)], { date: addDays(todayIso(), 5) }));
    expect(sale.status).toBe(201);
    const result = await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('SALE_DATE_IN_FUTURE');
  });

  it('short stock refuses the whole sale and changes nothing', async () => {
    const before = await f.run(() => stockOnHand(w.woolId));
    const sale = await accountant.post(
      '/sales/orders',
      saleBody(w, [woolLine(w, 1, 1000), { itemId: w.alfalfaId, warehouseId: w.warehouseId, qty: 9999, price: 10 }]),
    );
    const result = await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await f.run(() => stockOnHand(w.woolId))).toBe(before);
    expect((await accountant.get(`/sales/orders/${sale.data.id}`)).data.status).toBe('draft');
    expect(await saleTransactions(f, sale.data.id)).toEqual([]);
  });

  it('a sale on credit needs a buyer and creates a debt, not cash', async () => {
    const sale = await accountant.post(
      '/sales/orders',
      saleBody(w, [woolLine(w, 1, 40_000)], { paymentMethod: 'debt', accountId: null, dueDate: '2026-12-01' }),
    );
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    const [posted] = await saleTransactions(f, sale.data.id);
    expect(posted.paymentMethod).toBe('debt');
    expect(posted.accountId).toBeNull();
    expect(posted.dueDate).toBe('2026-12-01');
  });

  it('a cash sale without an account is refused by the ledger, and nothing moves', async () => {
    const before = await f.run(() => stockOnHand(w.woolId));
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 40_000)], { accountId: null }));
    const result = await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('ACCOUNT_REQUIRED');
    expect(await f.run(() => stockOnHand(w.woolId))).toBe(before);
  });

  it('only an unconfirmed sale can be edited or deleted', async () => {
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 1000)]));
    const edited = await accountant.patch(`/sales/orders/${sale.data.id}`, { lines: [woolLine(w, 3, 1000)] });
    expect(edited.status).toBe(200);
    expect(edited.data.totalAmount).toBe(3000);
    expect(edited.data.lines).toHaveLength(1);

    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    expect((await accountant.patch(`/sales/orders/${sale.data.id}`, { notes: 'x' })).body.error.code).toBe('SALE_NOT_EDITABLE');
    expect((await accountant.delete(`/sales/orders/${sale.data.id}`)).body.error.code).toBe('SALE_NOT_EDITABLE');
    expect((await accountant.post(`/sales/orders/${sale.data.id}/confirm`)).body.error.code).toBe('SALE_NOT_CONFIRMABLE');
  });

  it('a draft can be deleted', async () => {
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 1000)]));
    expect((await accountant.delete(`/sales/orders/${sale.data.id}`)).status).toBe(200);
    expect((await accountant.get(`/sales/orders/${sale.data.id}`)).status).toBe(404);
  });

  it('validates that a line is an item or an animal, with a warehouse for items', async () => {
    const neither = await accountant.post('/sales/orders', saleBody(w, [{ qty: 1, price: 1 }]));
    expect(neither.status).toBe(400);
    const noWarehouse = await accountant.post('/sales/orders', saleBody(w, [{ itemId: w.woolId, qty: 1, price: 1 }]));
    expect(noWarehouse.status).toBe(400);
    expect(Object.keys(noWarehouse.body.error.details.fieldErrors)).toContain('lines.0.warehouseId');
  });

  it('numbers keep rising after a draft is deleted', async () => {
    const g = await createFixture();
    const world = await arrange(g);
    const user = await g.as('accountant');
    const one = await user.post('/sales/orders', saleBody(world, [woolLine(world, 1, 1)]));
    const two = await user.post('/sales/orders', saleBody(world, [woolLine(world, 1, 1)]));
    await user.delete(`/sales/orders/${one.data.id}`);
    const three = await user.post('/sales/orders', saleBody(world, [woolLine(world, 1, 1)]));
    expect(two.data.number).toBe('S-2026-0002');
    expect(three.data.number).toBe('S-2026-0003');
  });

  it('lists with filters and search', async () => {
    const g = await createFixture();
    const world = await arrange(g);
    const user = await g.as('accountant');
    await user.post('/sales/orders', saleBody(world, [woolLine(world, 1, 100), woolLine(world, 2, 100)]));
    const list = await user.get('/sales/orders', { status: 'draft', search: 'Xaridor' });
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ counterpartyName: 'Xaridor MChJ', lineCount: 2, totalAmount: 300 });
    expect((await user.get('/sales/orders', { status: 'confirmed' })).body.meta.total).toBe(0);
    expect((await user.get('/sales/orders', { search: 'nobody' })).body.meta.total).toBe(0);
  });

  it('keeps a foreign currency sale in base currency for the ledger', async () => {
    const g = await createFixture();
    const world = await arrange(g);
    const user = await g.as('accountant');
    await g.run(() => tx().insert(schema.fxRates).values({ tenantId: g.tenantId, date: '2026-10-01', currency: 'USD', rate: 12_500 }));
    const sale = await user.post('/sales/orders', saleBody(world, [woolLine(world, 2, 100)], { currency: 'USD' }));
    const confirmed = await user.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(confirmed.data.fxRate).toBe(12_500);
    const [posted] = await saleTransactions(g, sale.data.id);
    expect(posted).toMatchObject({ amount: 200, currency: 'USD', amountBase: 2_500_000 });
  });

  it('attaches a document to a sale', async () => {
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 1)]));
    const doc = await accountant.post(`/sales/orders/${sale.data.id}/documents`, { type: 'vet_certificate', title: 'Vet guvohnoma №12' });
    expect(doc.status).toBe(201);
    const detail = await accountant.get(`/sales/orders/${sale.data.id}`);
    expect(detail.data.documents.map((d: any) => d.title)).toEqual(['Vet guvohnoma №12']);
  });
});

describe('selling animals', () => {
  let f: Fixture;
  let w: World;
  let accountant: Client;

  beforeAll(async () => {
    f = await createFixture();
    w = await arrange(f);
    accountant = await f.as('accountant');
  });

  it('a sold animal leaves the herd, with an exit record tied to the income', async () => {
    const animal = await addAnimal(f, w);
    // 40 kg live weight × 60 000 = 2 400 000
    const sale = await accountant.post('/sales/orders', saleBody(w, [{ animalId: animal.id, qty: 40, unit: 'kg', price: 60_000 }]));
    expect(sale.data.totalAmount).toBe(2_400_000);
    const confirmed = await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(confirmed.status).toBe(200);

    const after = await f.run(async () => {
      const [row] = await tx().select().from(animals).where(eq(animals.id, animal.id));
      const [exit] = await tx().select().from(animalExits).where(eq(animalExits.animalId, animal.id));
      return { row, exit };
    });
    expect(after.row.status).toBe('sold');
    expect(after.row.exitDate).toBe(SALE_DATE);
    expect(after.exit).toMatchObject({ type: 'sale', liveWeightKg: 40, pricePerKg: 60_000, amount: 2_400_000, counterpartyId: w.buyerId });

    const [posted] = await saleTransactions(f, sale.data.id);
    expect(after.exit.transactionId).toBe(posted.id);
    expect(posted.costCenterId).toBe(w.herdCostCenterId);
    expect(await categoryOf(f, posted.categoryId)).toBe('sheep_sales');
    // Book value: the purchase price. Herd costs add to it once the finance engine reports them.
    expect(confirmed.data.lines[0].costAmount).toBeGreaterThanOrEqual(1_500_000);
  });

  it('sells by head, taking the weight from the animal, and files a lamb under lamb sales', async () => {
    const lamb = await addAnimal(f, w, { category: 'lamb_male', sex: 'male', origin: 'born', purchasePrice: null, currentWeightKg: 30 });
    const sale = await accountant.post('/sales/orders', saleBody(w, [{ animalId: lamb.id, qty: 1, unit: 'head', price: 1_800_000 }]));
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    const [posted] = await saleTransactions(f, sale.data.id);
    expect(await categoryOf(f, posted.categoryId)).toBe('lamb_sales');
    const [exit] = await f.run(() => tx().select().from(animalExits).where(eq(animalExits.animalId, lamb.id)));
    expect(exit).toMatchObject({ liveWeightKg: 30, pricePerKg: null, amount: 1_800_000 });
  });

  it('an animal that left the farm cannot be sold', async () => {
    const dead = await addAnimal(f, w, { status: 'dead' });
    const sale = await accountant.post('/sales/orders', saleBody(w, [{ animalId: dead.id, qty: 40, unit: 'kg', price: 1 }]));
    expect(sale.status).toBe(409);
    expect(sale.body.error.code).toBe('ANIMAL_NOT_ON_FARM');
  });

  it('the same animal cannot be sold twice from two drafts', async () => {
    const animal = await addAnimal(f, w);
    const line = [{ animalId: animal.id, qty: 40, unit: 'kg', price: 10_000 }];
    const first = await accountant.post('/sales/orders', saleBody(w, line));
    const second = await accountant.post('/sales/orders', saleBody(w, line));
    expect((await accountant.post(`/sales/orders/${first.data.id}/confirm`)).status).toBe(200);
    const result = await accountant.post(`/sales/orders/${second.data.id}/confirm`);
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('ANIMAL_NOT_ON_FARM');
  });

  it('refuses an animal listed twice in one sale', async () => {
    const animal = await addAnimal(f, w);
    const line = { animalId: animal.id, qty: 40, unit: 'kg', price: 10_000 };
    const sale = await accountant.post('/sales/orders', saleBody(w, [line, line]));
    expect(sale.status).toBe(400);
    expect(sale.body.error.code).toBe('DUPLICATE_ANIMAL');
  });

  describe('withdrawal period', () => {
    const treat = (over: Partial<typeof healthRecords.$inferInsert>) =>
      f.run(() =>
        tx()
          .insert(healthRecords)
          .values({ tenantId: f.tenantId, farmId: f.farmId, type: 'treatment', date: '2026-10-27', withdrawalDays: 14, withdrawalUntil: '2026-11-10', ...over }),
      );

    it('refuses to sell an animal under withdrawal, naming it and the date', async () => {
      const animal = await addAnimal(f, w);
      await treat({ animalId: animal.id });
      const sale = await accountant.post('/sales/orders', saleBody(w, [{ animalId: animal.id, qty: 40, unit: 'kg', price: 10_000 }]));
      const result = await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
      expect(result.status).toBe(409);
      expect(result.body.error.code).toBe('ANIMAL_UNDER_WITHDRAWAL');
      expect(result.body.error.details.animals).toEqual([{ animalId: animal.id, tag: animal.tag, until: '2026-11-10' }]);
      expect((await accountant.get(`/sales/orders/${sale.data.id}`)).data.status).toBe('draft');
      const [row] = await f.run(() => tx().select().from(animals).where(eq(animals.id, animal.id)));
      expect(row.status).toBe('active');
    });

    it('shows the withdrawal date on the draft line', async () => {
      const animal = await addAnimal(f, w);
      await f.run(() =>
        tx().insert(healthRecords).values({ tenantId: f.tenantId, farmId: f.farmId, type: 'treatment', date: '2030-01-01', animalId: animal.id, withdrawalUntil: '2030-01-15' }),
      );
      const sale = await accountant.post('/sales/orders', saleBody(w, [{ animalId: animal.id, qty: 40, unit: 'kg', price: 10_000 }]));
      expect(sale.data.lines[0].withdrawalUntil).toBe('2030-01-15');
    });

    it('a treatment of the whole herd blocks its animals too', async () => {
      const g = await createFixture();
      const world = await arrange(g);
      const user = await g.as('accountant');
      const animal = await addAnimal(g, world);
      await g.run(() =>
        tx().insert(healthRecords).values({ tenantId: g.tenantId, farmId: g.farmId, type: 'treatment', date: '2026-10-27', herdId: world.herdId, withdrawalUntil: '2026-11-20' }),
      );
      const sale = await user.post('/sales/orders', saleBody(world, [{ animalId: animal.id, qty: 40, unit: 'kg', price: 10_000 }]));
      const result = await user.post(`/sales/orders/${sale.data.id}/confirm`);
      expect(result.body.error.code).toBe('ANIMAL_UNDER_WITHDRAWAL');
    });

    it('an animal moved out of the herd after a herd treatment is still refused', async () => {
      const g = await createFixture();
      const world = await arrange(g);
      const user = await g.as('accountant');
      const animal = await addAnimal(g, world);

      // Treated with the herd on 25 Oct, moved to another herd two days later.
      const base = { tenantId: g.tenantId, farmId: g.farmId };
      const [elsewhere] = await g.run(() => tx().insert(herds).values({ ...base, name: 'Boshqa poda' }).returning());
      await g.run(async () => {
        await tx()
          .insert(healthRecords)
          .values({ ...base, type: 'treatment', date: '2026-10-25', herdId: world.herdId, withdrawalUntil: '2026-11-20' });
        await tx()
          .insert(schema.herdTransfers)
          .values({ ...base, animalId: animal.id, fromHerdId: world.herdId, toHerdId: elsewhere.id, date: '2026-10-27' });
        await tx().update(animals).set({ herdId: elsewhere.id }).where(eq(animals.id, animal.id));
      });

      const sale = await user.post('/sales/orders', saleBody(world, [{ animalId: animal.id, qty: 40, unit: 'kg', price: 10_000 }]));
      expect(sale.data.lines[0].withdrawalUntil).toBe('2026-11-20');
      const result = await user.post(`/sales/orders/${sale.data.id}/confirm`);
      expect(result.status).toBe(409);
      expect(result.body.error.code).toBe('ANIMAL_UNDER_WITHDRAWAL');
      expect(result.body.error.details.animals).toEqual([{ animalId: animal.id, tag: animal.tag, until: '2026-11-20' }]);
    });

    it('a moved animal may be sold from the first allowed day, and not the day before', async () => {
      const g = await createFixture();
      const world = await arrange(g);
      const user = await g.as('accountant');
      const animal = await addAnimal(g, world);
      const base = { tenantId: g.tenantId, farmId: g.farmId };
      const [elsewhere] = await g.run(() => tx().insert(herds).values({ ...base, name: 'Boshqa poda' }).returning());
      await g.run(async () => {
        await tx()
          .insert(healthRecords)
          .values({ ...base, type: 'treatment', date: '2026-10-20', herdId: world.herdId, withdrawalUntil: SALE_DATE });
        await tx()
          .insert(schema.herdTransfers)
          .values({ ...base, animalId: animal.id, fromHerdId: world.herdId, toHerdId: elsewhere.id, date: '2026-10-22' });
        await tx().update(animals).set({ herdId: elsewhere.id }).where(eq(animals.id, animal.id));
      });
      const line = [{ animalId: animal.id, qty: 40, unit: 'kg', price: 10_000 }];

      const early = await user.post('/sales/orders', saleBody(world, line, { date: '2026-11-02' }));
      expect((await user.post(`/sales/orders/${early.data.id}/confirm`)).body.error.code).toBe('ANIMAL_UNDER_WITHDRAWAL');

      const onTheDay = await user.post('/sales/orders', saleBody(world, line));
      expect((await user.post(`/sales/orders/${onTheDay.data.id}/confirm`)).status).toBe(200);
    });

    it('the warning on a line predicts the refusal, because both use the sale date', async () => {
      const animal = await addAnimal(f, w);
      // Over by today, but still running on the date of this backdated sale.
      await treat({ animalId: animal.id, date: '2026-10-01', withdrawalUntil: '2026-11-04' });
      const sale = await accountant.post('/sales/orders', saleBody(w, [{ animalId: animal.id, qty: 40, unit: 'kg', price: 10_000 }]));
      expect(sale.data.lines[0].withdrawalUntil).toBe('2026-11-04');
      expect((await accountant.post(`/sales/orders/${sale.data.id}/confirm`)).body.error.code).toBe('ANIMAL_UNDER_WITHDRAWAL');
    });

    it('the withdrawal end date itself is the first day a sale is allowed', async () => {
      const animal = await addAnimal(f, w);
      await treat({ animalId: animal.id, withdrawalUntil: SALE_DATE });
      const sale = await accountant.post('/sales/orders', saleBody(w, [{ animalId: animal.id, qty: 40, unit: 'kg', price: 10_000 }]));
      expect((await accountant.post(`/sales/orders/${sale.data.id}/confirm`)).status).toBe(200);
    });
  });
});

describe('approval of large sales', () => {
  // 5 000 000 is the default threshold.
  const large = (w: World) => saleBody(w, [woolLine(w, 10, 500_000)]);

  it('a large sale waits for a second person, and nothing moves until then', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const director = await f.as('director');

    const sale = await accountant.post('/sales/orders', large(w));
    const submitted = await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(submitted.data.status).toBe('pending');
    expect(await f.run(() => stockOnHand(w.woolId))).toBe(200);
    expect(await saleTransactions(f, sale.data.id)).toEqual([]);

    const again = await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('SAME_MAKER_CHECKER');

    const confirmed = await director.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(confirmed.data.status).toBe('confirmed');
    expect(confirmed.data.confirmedBy).toBe(director.userId);
    expect(await f.run(() => stockOnHand(w.woolId))).toBe(190);
    const [posted] = await saleTransactions(f, sale.data.id);
    expect(posted).toMatchObject({ status: 'approved', amountBase: 5_000_000 });
  });

  it('the creator cannot approve their own large sale, whatever their role', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const owner = await f.as('owner');
    const sale = await owner.post('/sales/orders', large(w));
    expect((await owner.post(`/sales/orders/${sale.data.id}/confirm`)).data.status).toBe('pending');
    expect((await owner.post(`/sales/orders/${sale.data.id}/confirm`)).body.error.code).toBe('SAME_MAKER_CHECKER');
  });

  it('a sale just below the threshold needs no second person', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 4_999_999)]));
    expect((await accountant.post(`/sales/orders/${sale.data.id}/confirm`)).data.status).toBe('confirmed');
  });

  it('with maker-checker off, a large sale confirms directly', async () => {
    const f = await createFixture({ settings: { finance: { makerChecker: false } } });
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const sale = await accountant.post('/sales/orders', large(w));
    expect((await accountant.post(`/sales/orders/${sale.data.id}/confirm`)).data.status).toBe('confirmed');
  });

  it('an approver can send a pending sale back, with the reason', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const director = await f.as('director');
    const sale = await accountant.post('/sales/orders', large(w));
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);

    expect((await accountant.post(`/sales/orders/${sale.data.id}/reject`, { reason: 'x' })).status).toBe(403);
    const rejected = await director.post(`/sales/orders/${sale.data.id}/reject`, { reason: 'Narx past' });
    expect(rejected.data).toMatchObject({ status: 'draft', rejectedReason: 'Narx past' });
    expect((await director.post(`/sales/orders/${sale.data.id}/reject`, { reason: 'x' })).body.error.code).toBe('SALE_NOT_PENDING');
  });

  it('editing a pending sale returns it to draft, so the approver sees the new version', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const sale = await accountant.post('/sales/orders', large(w));
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    const edited = await accountant.patch(`/sales/orders/${sale.data.id}`, { notes: 'Yangilandi' });
    expect(edited.data.status).toBe('draft');
  });
});

describe('cancelling a sale', () => {
  const income = (f: Fixture, saleId: string) => saleTransactions(f, saleId);

  it('reverses stock and animals, voids the income, and nothing counts any more', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const director = await f.as('director');
    const animal = await addAnimal(f, w, { status: 'active' });

    const sale = await accountant.post(
      '/sales/orders',
      saleBody(w, [woolLine(w, 10, 50_000), { animalId: animal.id, qty: 40, unit: 'kg', price: 60_000 }]),
    );
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(await f.run(() => stockOnHand(w.woolId))).toBe(190);
    const position = (await import('../src/modules/finance/summary')).cashPosition;
    expect((await f.run(() => position())).total).toBe(2_900_000);

    const cancelled = await director.post(`/sales/orders/${sale.data.id}/cancel`, { reason: 'Xaridor rad etdi' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.data).toMatchObject({ status: 'cancelled', cancelReason: 'Xaridor rad etdi', cancelledBy: director.userId });

    expect(await f.run(() => stockOnHand(w.woolId))).toBe(200);

    const restored = await f.run(async () => {
      const [row] = await tx().select().from(animals).where(eq(animals.id, animal.id));
      const exits = await tx().select().from(animalExits).where(eq(animalExits.animalId, animal.id));
      return { row, exits };
    });
    expect(restored.row).toMatchObject({ status: 'active', exitDate: null, herdId: w.herdId });
    expect(restored.exits).toEqual([]);

    const postings = await income(f, sale.data.id);
    expect(postings).toHaveLength(2);
    expect(postings.every((t) => t.status === 'rejected' && t.rejectedReason === 'Xaridor rad etdi')).toBe(true);
    expect(cancelled.data.postings.every((p: any) => p.status === 'rejected')).toBe(true);
    expect((await f.run(() => position())).total).toBe(0);
  });

  it('a cancelled credit sale leaves no debt on the finance side', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const director = await f.as('director');
    const { debtSummary } = await import('../src/modules/finance/summary');

    const sale = await accountant.post(
      '/sales/orders',
      saleBody(w, [woolLine(w, 20, 50_000)], { paymentMethod: 'debt', accountId: null }),
    );
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(await f.run(() => debtSummary())).toMatchObject({ receivable: 1_000_000, payable: 0 });

    await director.post(`/sales/orders/${sale.data.id}/cancel`, { reason: 'Xato' });
    expect(await f.run(() => debtSummary())).toMatchObject({ receivable: 0, payable: 0 });
  });

  it('a pregnant ewe comes back pregnant, with her pregnancy reopened', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const director = await f.as('director');
    const ewe = await addAnimal(f, w, { status: 'pregnant' });
    const [record] = await f.run(() =>
      tx()
        .insert(schema.breedingRecords)
        .values({
          tenantId: f.tenantId,
          farmId: f.farmId,
          eweId: ewe.id,
          matingDate: '2026-10-01',
          expectedDate: '2027-02-28',
          expectedEarliest: '2027-02-23',
          expectedLatest: '2027-03-02',
        })
        .returning(),
    );
    const statusOf = async () => {
      const [row] = await f.run(() => tx().select().from(schema.breedingRecords).where(eq(schema.breedingRecords.id, record.id)));
      return row.status;
    };

    const sale = await accountant.post('/sales/orders', saleBody(w, [{ animalId: ewe.id, qty: 50, unit: 'kg', price: 60_000 }]));
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(await statusOf()).toBe('failed');

    await director.post(`/sales/orders/${sale.data.id}/cancel`, { reason: 'Xato' });
    expect(await statusOf()).toBe('pregnant');
    const [row] = await f.run(() => tx().select().from(animals).where(eq(animals.id, ewe.id)));
    expect(row.status).toBe('pregnant');
  });

  it('a sick animal comes back sick', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const director = await f.as('director');
    const animal = await addAnimal(f, w, { status: 'sick' });
    const sale = await accountant.post('/sales/orders', saleBody(w, [{ animalId: animal.id, qty: 50, unit: 'kg', price: 1000 }]));
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    await director.post(`/sales/orders/${sale.data.id}/cancel`, { reason: 'Xato' });
    const [row] = await f.run(() => tx().select().from(animals).where(eq(animals.id, animal.id)));
    expect(row.status).toBe('sick');
  });

  it('a cancelled animal can be sold again', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const director = await f.as('director');
    const animal = await addAnimal(f, w);
    const body = saleBody(w, [{ animalId: animal.id, qty: 40, unit: 'kg', price: 10_000 }]);
    const first = await accountant.post('/sales/orders', body);
    await accountant.post(`/sales/orders/${first.data.id}/confirm`);
    await director.post(`/sales/orders/${first.data.id}/cancel`, { reason: 'Xato' });

    const second = await accountant.post('/sales/orders', body);
    expect((await accountant.post(`/sales/orders/${second.data.id}/confirm`)).status).toBe(200);
  });

  it('reversing a confirmed sale needs sales.approve; a draft does not', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 1000)]));
    const draft = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 1000)]));
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);

    const refused = await accountant.post(`/sales/orders/${sale.data.id}/cancel`, { reason: 'x' });
    expect(refused.status).toBe(403);
    expect(await f.run(() => stockOnHand(w.woolId))).toBe(199);

    expect((await accountant.post(`/sales/orders/${draft.data.id}/cancel`, { reason: 'x' })).data.status).toBe('cancelled');
  });

  it('cannot cancel twice, or confirm a cancelled sale', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 1000)]));
    await accountant.post(`/sales/orders/${sale.data.id}/cancel`, { reason: 'x' });
    expect((await accountant.post(`/sales/orders/${sale.data.id}/cancel`, { reason: 'x' })).body.error.code).toBe('SALE_ALREADY_CANCELLED');
    expect((await accountant.post(`/sales/orders/${sale.data.id}/confirm`)).body.error.code).toBe('SALE_NOT_CONFIRMABLE');
  });

  it('whoever confirmed a large sale cannot also undo it', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const director = await f.as('director');
    const owner = await f.as('owner');
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 10, 600_000)]));
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    await director.post(`/sales/orders/${sale.data.id}/confirm`);

    const own = await director.post(`/sales/orders/${sale.data.id}/cancel`, { reason: 'Xato' });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('SAME_CONFIRMER');
    expect(await f.run(() => stockOnHand(w.woolId))).toBe(190);

    expect((await owner.post(`/sales/orders/${sale.data.id}/cancel`, { reason: 'Xato' })).data.status).toBe('cancelled');
  });

  it('finance cannot void a sale posting behind the sale\'s back', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const director = await f.as('director');
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 1000)]));
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    const [posting] = await income(f, sale.data.id);
    const { voidTransaction } = await import('../src/modules/finance/transactions.service');
    await expect(f.run(() => voidTransaction(posting.id, 'x'), { userId: director.userId })).rejects.toMatchObject({
      code: 'TRANSACTION_HAS_SOURCE',
    });
  });
});

describe('editing keeps what was not sent', () => {
  it('a PATCH does not reset fields that have defaults', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');

    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 100)], { paymentMethod: 'cash' }));
    const editedSale = await accountant.patch(`/sales/orders/${sale.data.id}`, { notes: 'Yangi' });
    expect(editedSale.data).toMatchObject({ paymentMethod: 'cash', notes: 'Yangi' });

    const grant = await accountant.post('/sales/grants', { title: 'G', kind: 'compensation', status: 'in_review' });
    const editedGrant = await accountant.patch(`/sales/grants/${grant.data.id}`, { amount: 5 });
    expect(editedGrant.data).toMatchObject({ kind: 'compensation', status: 'in_review', amount: 5 });

    const contract = await accountant.post('/sales/contracts', { counterpartyId: w.buyerId, number: 'C', currency: 'USD', status: 'closed' });
    const editedContract = await accountant.patch(`/sales/contracts/${contract.data.id}`, { title: 'T' });
    expect(editedContract.data).toMatchObject({ currency: 'USD', status: 'closed', title: 'T' });

    const price = await accountant.post('/sales/prices', { itemId: w.woolId, date: '2026-11-01', price: 100, kind: 'market' });
    const editedPrice = await accountant.patch(`/sales/prices/${price.data.id}`, { price: 110 });
    expect(editedPrice.data).toMatchObject({ kind: 'market', price: 110 });

    const report = await accountant.post('/sales/state-reports', { title: 'R', authority: 'tax', period: 'monthly', dueDate: '2030-01-01' });
    const editedReport = await accountant.patch(`/sales/state-reports/${report.data.id}`, { notes: 'N' });
    expect(editedReport.data).toMatchObject({ period: 'monthly', notes: 'N' });
  });
});

describe('absurd numbers', () => {
  it('are a field error, not a database overflow', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const storekeeper = await f.as('storekeeper');
    const director = await f.as('director');
    const huge = 2e20;
    const field = (r: { status: number; body: any }) => {
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
      return Object.keys(r.body.error.details.fieldErrors);
    };

    expect(field(await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, huge)])))).toEqual(['lines.0.price']);
    expect(field(await accountant.post('/sales/orders', saleBody(w, [woolLine(w, huge, 1)])))).toEqual(['lines.0.qty']);
    expect(field(await accountant.post('/sales/prices', { itemId: w.woolId, date: SALE_DATE, price: huge }))).toEqual(['price']);
    expect(field(await accountant.post('/sales/contracts', { counterpartyId: w.buyerId, number: 'H', amount: huge }))).toEqual(['amount']);
    expect(field(await accountant.post('/sales/grants', { title: 'H', amount: huge }))).toEqual(['amount']);
    expect(field(await storekeeper.post('/sales/purchases', { itemId: w.woolId, qty: huge }))).toEqual(['qty']);

    const { data } = await storekeeper.post('/sales/purchases', { itemId: w.woolId, qty: 1 });
    await director.post(`/sales/purchases/${data.id}/approve`);
    const pay = { date: SALE_DATE, amount: huge, paymentMethod: 'bank', accountId: w.accountId };
    expect(field(await accountant.post(`/sales/purchases/${data.id}/pay`, pay))).toEqual(['amount']);
  });
});

describe('an empty PATCH', () => {
  it('is refused everywhere, and leaves a pending sale waiting', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const storekeeper = await f.as('storekeeper');

    const large = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 10, 600_000)]));
    await accountant.post(`/sales/orders/${large.data.id}/confirm`);
    const sale = await accountant.patch(`/sales/orders/${large.data.id}`, {});
    expect(sale.status).toBe(400);
    expect(sale.body.error.code).toBe('NOTHING_TO_UPDATE');
    expect((await accountant.get(`/sales/orders/${large.data.id}`)).data.status).toBe('pending');

    const purchase = await storekeeper.post('/sales/purchases', { itemId: w.alfalfaId, qty: 1 });
    const price = await accountant.post('/sales/prices', { itemId: w.woolId, date: '2026-11-01', price: 1 });
    const contract = await accountant.post('/sales/contracts', { counterpartyId: w.buyerId, number: 'E-1' });
    const grant = await accountant.post('/sales/grants', { title: 'G' });
    const report = await accountant.post('/sales/state-reports', { title: 'R', authority: 'tax', dueDate: '2030-01-01' });
    for (const url of [
      `/sales/prices/${price.data.id}`,
      `/sales/contracts/${contract.data.id}`,
      `/sales/grants/${grant.data.id}`,
      `/sales/state-reports/${report.data.id}`,
    ]) {
      expect((await accountant.patch(url, {})).body.error?.code).toBe('NOTHING_TO_UPDATE');
    }
    expect((await storekeeper.patch(`/sales/purchases/${purchase.data.id}`, {})).body.error?.code).toBe('NOTHING_TO_UPDATE');
  });
});

describe('references to another farm of the same tenant', () => {
  // Composite foreign keys stop at the tenant. Only the farm check stops this.
  it('are refused on sales and along the purchase flow', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const storekeeper = await f.as('storekeeper');
    const director = await f.as('director');

    const secondFarm = await withPlatform(async (trx) => {
      const [row] = await trx.insert(schema.farms).values({ tenantId: f.tenantId, name: 'Ikkinchi ferma' }).returning();
      return row.id;
    });
    const theirs = await f.run(async () => {
      const base = { tenantId: f.tenantId, farmId: secondFarm };
      const [account] = await tx().insert(accounts).values({ ...base, name: 'Boshqa kassa', type: 'cash' }).returning();
      const [warehouse] = await tx().insert(warehouses).values({ ...base, name: 'Boshqa ombor', type: 'feed' }).returning();
      const [party] = await tx().insert(counterparties).values({ ...base, name: 'Boshqa xaridor', type: 'buyer' }).returning();
      return { accountId: account.id, warehouseId: warehouse.id, buyerId: party.id };
    });

    const sale = (over: object, line: object = {}) =>
      accountant.post('/sales/orders', saleBody(w, [{ ...woolLine(w, 1, 100), ...line }], over));
    expect((await sale({ accountId: theirs.accountId })).status).toBe(404);
    expect((await sale({ counterpartyId: theirs.buyerId })).status).toBe(404);
    expect((await sale({}, { warehouseId: theirs.warehouseId })).status).toBe(404);

    const { data } = await storekeeper.post('/sales/purchases', { itemId: w.alfalfaId, qty: 1, expectedPrice: 1000 });
    await director.post(`/sales/purchases/${data.id}/approve`);
    const payment = { date: SALE_DATE, amount: 1000, paymentMethod: 'bank', accountId: theirs.accountId };
    expect((await accountant.post(`/sales/purchases/${data.id}/pay`, payment)).status).toBe(404);
  });
});

describe('references to another tenant', () => {
  it('are refused on sales, whichever field carries them', async () => {
    const f = await createFixture();
    const other = await createFixture();
    const w = await arrange(f);
    const theirs = await arrange(other);
    const accountant = await f.as('accountant');

    const attempt = (over: object, line: object = {}) =>
      accountant.post('/sales/orders', saleBody(w, [{ ...woolLine(w, 1, 100), ...line }], over));

    expect((await attempt({ accountId: theirs.accountId })).status).toBe(404);
    expect((await attempt({ counterpartyId: theirs.buyerId })).status).toBe(404);
    expect((await attempt({}, { warehouseId: theirs.warehouseId })).status).toBe(404);
    expect((await attempt({}, { costCenterId: theirs.herdCostCenterId })).status).toBe(404);
    const theirCategory = await other.run(async () => {
      const [row] = await tx().select().from(financeCategories).limit(1);
      return row.id;
    });
    expect((await attempt({}, { categoryId: theirCategory })).status).toBe(404);
    expect((await accountant.get('/sales/orders')).body.meta.total).toBe(0);
  });

  it('are refused along the purchase flow', async () => {
    const f = await createFixture();
    const other = await createFixture();
    const w = await arrange(f);
    const theirs = await arrange(other);
    const storekeeper = await f.as('storekeeper');
    const director = await f.as('director');
    const accountant = await f.as('accountant');

    const body = { itemId: w.alfalfaId, qty: 1, expectedPrice: 1000 };
    expect((await storekeeper.post('/sales/purchases', { ...body, counterpartyId: theirs.supplierId })).status).toBe(404);

    const { data } = await storekeeper.post('/sales/purchases', body);
    await director.post(`/sales/purchases/${data.id}/approve`);
    const payment = { date: '2026-11-05', amount: 1000, paymentMethod: 'bank' };
    expect((await accountant.post(`/sales/purchases/${data.id}/pay`, { ...payment, accountId: theirs.accountId })).status).toBe(404);
    await accountant.post(`/sales/purchases/${data.id}/pay`, { ...payment, accountId: w.accountId });
    const received = await storekeeper.post(`/sales/purchases/${data.id}/receive`, { date: '2026-11-06', qty: 1, warehouseId: theirs.warehouseId });
    expect(received.status).toBe(404);
  });

  it('are refused on contracts', async () => {
    const f = await createFixture();
    const other = await createFixture();
    const w = await arrange(f);
    const theirs = await arrange(other);
    const owner = await f.as('owner');
    const { data } = await owner.post('/sales/contracts', { counterpartyId: w.buyerId, number: 'C-1' });
    expect((await owner.patch(`/sales/contracts/${data.id}`, { counterpartyId: theirs.buyerId })).status).toBe(404);
    expect((await owner.get(`/sales/contracts/${data.id}`)).data.counterpartyId).toBe(w.buyerId);
  });
});

describe('income category', () => {
  it.each([
    [{ animalCategory: 'lamb_female' }, 'lamb_sales'],
    [{ animalCategory: 'ewe' }, 'sheep_sales'],
    [{ itemName: 'Jun' }, 'wool_sales'],
    [{ itemName: "Qo'y go'shti" }, 'meat_sales'],
    [{ itemName: 'Beda (pichan)' }, 'alfalfa_sales'],
    [{ itemName: "Bug'doy (yem)" }, 'grain_sales'],
    [{ itemName: 'Arpa' }, 'grain_sales'],
    [{ itemName: 'Sholi' }, 'grain_sales'],
    [{ itemName: "Qo'zi (tirik vazn)" }, 'lamb_sales'],
    [{ itemName: 'Boshqa narsa' }, 'other'],
  ])('%j → %s', (line, key) => {
    expect(incomeCategoryKey(line)).toBe(key);
  });
});

describe('prices', () => {
  it('keeps history and reports the current price with the change', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    await accountant.post('/sales/prices', { itemId: w.woolId, date: '2026-09-01', price: 40_000, kind: 'sale' });
    await accountant.post('/sales/prices', { itemId: w.woolId, date: '2026-10-01', price: 50_000, kind: 'sale' });
    await accountant.post('/sales/prices', { itemId: w.woolId, date: '2026-11-01', price: 55_000, kind: 'sale' });
    await accountant.post('/sales/prices', { itemId: w.woolId, date: '2026-11-01', price: 60_000, kind: 'market', source: 'Bozor' });

    const current = await accountant.get('/sales/prices/current');
    const sale = current.data.find((p: any) => p.kind === 'sale');
    const market = current.data.find((p: any) => p.kind === 'market');
    expect(sale).toMatchObject({ price: 55_000, previousPrice: 50_000, changePercent: 10, date: '2026-11-01', itemName: 'Jun' });
    expect(market).toMatchObject({ price: 60_000, previousPrice: null, changePercent: null, source: 'Bozor' });

    const history = await accountant.get('/sales/prices', { itemId: w.woolId, kind: 'sale', sort: 'date' });
    expect(history.body.data.map((p: any) => p.price)).toEqual([40_000, 50_000, 55_000]);
    expect(history.body.meta.total).toBe(3);
  });

  it('an unknown item is a 404, and a price can be edited and removed', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const director = await f.as('director');
    const bad = await accountant.post('/sales/prices', { itemId: '0190a7e2-7b1c-7c3d-8e4f-1234567890ab', date: '2026-11-01', price: 1 });
    expect(bad.status).toBe(404);
    const price = await accountant.post('/sales/prices', { itemId: w.woolId, date: '2026-11-01', price: 100 });
    expect((await accountant.patch(`/sales/prices/${price.data.id}`, { price: 120 })).data.price).toBe(120);
    expect((await director.delete(`/sales/prices/${price.data.id}`)).status).toBe(200);
    expect((await director.delete(`/sales/prices/${price.data.id}`)).status).toBe(404);
  });
});

describe('sales analysis', () => {
  it('matches hand-computed totals, by product, buyer and month, and ignores unconfirmed sales', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const animal = await addAnimal(f, w, { purchasePrice: 1_000_000 });

    const october = await accountant.post(
      '/sales/orders',
      saleBody(w, [woolLine(w, 10, 30_000)], { date: '2026-10-20' }),
    );
    await accountant.post(`/sales/orders/${october.data.id}/confirm`);
    const november = await accountant.post(
      '/sales/orders',
      saleBody(w, [woolLine(w, 10, 40_000), { animalId: animal.id, qty: 40, unit: 'kg', price: 50_000 }]),
    );
    await accountant.post(`/sales/orders/${november.data.id}/confirm`);
    await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 999_999)]));

    const { data } = await accountant.get('/sales/analysis');
    // Wool: 300 000 + 400 000 = 700 000 for 20 kg, avg 35 000, cost 20 × 10 000 = 200 000.
    const wool = data.byProduct.find((p: any) => p.itemName === 'Jun');
    expect(wool).toMatchObject({ qty: 20, unit: 'kg', amount: 700_000, avgPrice: 35_000, cost: 200_000, margin: 500_000, marginPercent: 250 });

    const ewe = data.byProduct.find((p: any) => p.animalCategory === 'ewe');
    expect(ewe).toMatchObject({ qty: 40, amount: 2_000_000, avgPrice: 50_000 });

    expect(data.byBuyer).toHaveLength(1);
    expect(data.byBuyer[0]).toMatchObject({ name: 'Xaridor MChJ', documents: 2, amount: 2_700_000 });
    expect(data.byMonth.map((m: any) => [m.month, m.amount])).toEqual([
      ['2026-10', 300_000],
      ['2026-11', 2_400_000],
    ]);
    expect(data.totals.amount).toBe(2_700_000);
  });

  it('filters by period, and has no margin to report without cost', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 1000)], { date: '2026-10-20' }));
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    const none = await accountant.get('/sales/analysis', { from: '2026-11-01', to: '2026-11-30' });
    expect(none.data.byProduct).toEqual([]);
    expect(none.data.totals.amount).toBe(0);
    expect(none.data.totals.marginPercent).toBeNull();
  });

  it('counts a foreign currency sale in base currency', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 2, 100)], { currency: 'USD', fxRate: 12_000 }));
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    expect((await accountant.get('/sales/analysis')).data.totals.amount).toBe(2_400_000);
  });
});

describe('purchase flow', () => {
  const request = (w: World, over: object = {}) => ({
    itemId: w.alfalfaId,
    qty: 10,
    expectedPrice: 300_000,
    counterpartyId: w.supplierId,
    ...over,
  });
  const pay = (w: World, amount: number, over: object = {}) => ({
    date: '2026-11-05',
    amount,
    paymentMethod: 'bank',
    accountId: w.accountId,
    ...over,
  });
  const receive = (w: World, qty: number, over: object = {}) => ({ date: '2026-11-06', qty, warehouseId: w.warehouseId, ...over });

  it('runs end to end: request, approve, pay, receive with a difference act', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const storekeeper = await f.as('storekeeper');
    const director = await f.as('director');
    const accountant = await f.as('accountant');

    const created = await storekeeper.post('/sales/purchases', request(w));
    expect(created.status).toBe(201);
    expect(created.data.status).toBe('requested');
    const id = created.data.id;

    const approved = await director.post(`/sales/purchases/${id}/approve`);
    expect(approved.data).toMatchObject({ status: 'approved', approvedBy: director.userId });

    // 10 t × 300 000 = 3 000 000
    const paid = await accountant.post(`/sales/purchases/${id}/pay`, pay(w, 3_000_000));
    expect(paid.data).toMatchObject({ status: 'paid', paidAmount: 3_000_000, unitCost: 300_000 });
    const [posting] = await f.run(() => tx().select().from(transactions).where(eq(transactions.id, paid.data.transactionId)));
    expect(posting).toMatchObject({
      type: 'expense',
      costTreatment: 'inventory',
      status: 'approved',
      sourceType: 'purchase_request',
      sourceId: id,
      counterpartyId: w.supplierId,
    });
    expect(await categoryOf(f, posting.categoryId)).toBe('feed');

    // 9.5 t arrive: 0.5 t short, worth 150 000.
    const before = await f.run(() => stockOnHand(w.alfalfaId));
    const received = await storekeeper.post(`/sales/purchases/${id}/receive`, receive(w, 9.5, { quality: 'Yaxshi' }));
    expect(received.status).toBe(200);
    expect(await f.run(() => stockOnHand(w.alfalfaId))).toBe(before + 9.5);

    const full = await accountant.get(`/sales/purchases/${id}`);
    expect(full.data).toMatchObject({ status: 'received', receivedQty: 9.5, diffQty: -0.5, diffAmount: -150_000, quality: 'Yaxshi' });

    const [batch] = await f.run(() => tx().select().from(schema.stockBatches).where(eq(schema.stockBatches.id, full.data.batchId)));
    expect(batch).toMatchObject({ unitCost: 300_000, source: 'purchase', counterpartyId: w.supplierId, qtyReceived: 9.5 });
  });

  it('enforces the order of the steps', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const storekeeper = await f.as('storekeeper');
    const director = await f.as('director');
    const accountant = await f.as('accountant');
    const { data } = await storekeeper.post('/sales/purchases', request(w));

    const early = await accountant.post(`/sales/purchases/${data.id}/pay`, pay(w, 1));
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('PURCHASE_WRONG_STATE');
    expect((await storekeeper.post(`/sales/purchases/${data.id}/receive`, receive(w, 1))).body.error.code).toBe('PURCHASE_WRONG_STATE');

    await director.post(`/sales/purchases/${data.id}/approve`);
    expect((await storekeeper.post(`/sales/purchases/${data.id}/receive`, receive(w, 1))).body.error.code).toBe('PURCHASE_WRONG_STATE');
    expect((await director.post(`/sales/purchases/${data.id}/approve`)).body.error.code).toBe('PURCHASE_WRONG_STATE');
    expect((await storekeeper.patch(`/sales/purchases/${data.id}`, { qty: 1 })).body.error.code).toBe('PURCHASE_WRONG_STATE');
    expect((await storekeeper.delete(`/sales/purchases/${data.id}`)).body.error.code).toBe('PURCHASE_WRONG_STATE');

    await accountant.post(`/sales/purchases/${data.id}/pay`, pay(w, 3_000_000));
    expect((await accountant.post(`/sales/purchases/${data.id}/pay`, pay(w, 1))).body.error.code).toBe('PURCHASE_WRONG_STATE');
  });

  it('the requester cannot approve their own request, even as owner', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const owner = await f.as('owner');
    const director = await f.as('director');
    const { data } = await owner.post('/sales/purchases', request(w));
    const own = await owner.post(`/sales/purchases/${data.id}/approve`);
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('SAME_MAKER_CHECKER');
    expect((await owner.post(`/sales/purchases/${data.id}/reject`, { reason: 'x' })).status).toBe(403);
    expect((await director.post(`/sales/purchases/${data.id}/approve`)).status).toBe(200);
  });

  it('a rejected request stays rejected, with the reason', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const storekeeper = await f.as('storekeeper');
    const director = await f.as('director');
    const { data } = await storekeeper.post('/sales/purchases', request(w));
    const rejected = await director.post(`/sales/purchases/${data.id}/reject`, { reason: 'Zaxira yetarli' });
    expect(rejected.data).toMatchObject({ status: 'rejected', rejectedReason: 'Zaxira yetarli' });
    expect((await director.post(`/sales/purchases/${data.id}/approve`)).body.error.code).toBe('PURCHASE_WRONG_STATE');
  });

  it('within the estimate the payment is already approved; above it, finance must approve', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const storekeeper = await f.as('storekeeper');
    const director = await f.as('director');
    const accountant = await f.as('accountant');

    const statusFor = async (expectedPrice: number | null, amount: number) => {
      const { data } = await storekeeper.post('/sales/purchases', request(w, { expectedPrice }));
      await director.post(`/sales/purchases/${data.id}/approve`);
      const paid = await accountant.post(`/sales/purchases/${data.id}/pay`, pay(w, amount));
      const [t] = await f.run(() => tx().select().from(transactions).where(eq(transactions.id, paid.data.transactionId)));
      return t.status;
    };

    // Estimate 10 × 600 000 = 6 000 000, above the 5 000 000 threshold.
    expect(await statusFor(600_000, 6_000_000)).toBe('approved');
    expect(await statusFor(600_000, 6_000_001)).toBe('pending');
    expect(await statusFor(null, 6_000_000)).toBe('pending');
    // Small amounts stay below the threshold regardless.
    expect(await statusFor(null, 100_000)).toBe('approved');
  });

  it('a purchase on credit needs a supplier', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const storekeeper = await f.as('storekeeper');
    const director = await f.as('director');
    const accountant = await f.as('accountant');
    const { data } = await storekeeper.post('/sales/purchases', request(w, { counterpartyId: null }));
    await director.post(`/sales/purchases/${data.id}/approve`);
    const refused = await accountant.post(`/sales/purchases/${data.id}/pay`, pay(w, 100, { paymentMethod: 'debt', accountId: null }));
    expect(refused.body.error.code).toBe('COUNTERPARTY_REQUIRED');
    const ok = await accountant.post(
      `/sales/purchases/${data.id}/pay`,
      pay(w, 100, { paymentMethod: 'debt', accountId: null, counterpartyId: w.supplierId, dueDate: '2026-12-01' }),
    );
    expect(ok.data).toMatchObject({ status: 'paid', counterpartyId: w.supplierId });
  });

  it('roles only do their own step (spec 13.3)', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const storekeeper = await f.as('storekeeper');
    const director = await f.as('director');
    const accountant = await f.as('accountant');
    const zootechnician = await f.as('zootechnician');
    const shepherd = await f.as('shepherd');

    expect((await shepherd.post('/sales/purchases', request(w))).status).toBe(403);
    expect((await shepherd.get('/sales/purchases')).status).toBe(403);
    expect((await zootechnician.post('/sales/purchases', request(w))).status).toBe(201);

    const { data } = await storekeeper.post('/sales/purchases', request(w));
    expect((await storekeeper.post(`/sales/purchases/${data.id}/approve`)).status).toBe(403);
    expect((await accountant.post(`/sales/purchases/${data.id}/approve`)).status).toBe(403);
    await director.post(`/sales/purchases/${data.id}/approve`);
    expect((await storekeeper.post(`/sales/purchases/${data.id}/pay`, pay(w, 1))).status).toBe(403);
    await accountant.post(`/sales/purchases/${data.id}/pay`, pay(w, 3_000_000));
    expect((await accountant.post(`/sales/purchases/${data.id}/receive`, receive(w, 1))).status).toBe(403);
  });

  it('a storekeeper sees the request but no money (rule 7)', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const storekeeper = await f.as('storekeeper');
    const director = await f.as('director');
    const accountant = await f.as('accountant');
    const { data } = await storekeeper.post('/sales/purchases', request(w));
    await director.post(`/sales/purchases/${data.id}/approve`);
    await accountant.post(`/sales/purchases/${data.id}/pay`, pay(w, 3_000_000));
    await storekeeper.post(`/sales/purchases/${data.id}/receive`, receive(w, 9));

    const seen = await storekeeper.get(`/sales/purchases/${data.id}`);
    expect(seen.data).toMatchObject({ status: 'received', receivedQty: 9, expectedPrice: null, paidAmount: null, unitCost: null, diffAmount: null });
    const listed = await storekeeper.get('/sales/purchases');
    expect(listed.body.data[0].paidAmount).toBeNull();
    const asAccountant = await accountant.get(`/sales/purchases/${data.id}`);
    expect(asAccountant.data.paidAmount).toBe(3_000_000);
  });

  it('compares suppliers from what was really bought', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const storekeeper = await f.as('storekeeper');
    const other = await f.run(async () => {
      const [row] = await tx()
        .insert(counterparties)
        .values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Arzon Yem', type: 'supplier' })
        .returning();
      await receiveStock({ itemId: w.woolId, warehouseId: w.warehouseId, qty: 100, unitCost: 10, date: '2026-09-01', source: 'purchase', counterpartyId: w.supplierId });
      await receiveStock({ itemId: w.woolId, warehouseId: w.warehouseId, qty: 300, unitCost: 20, date: '2026-10-01', source: 'purchase', counterpartyId: w.supplierId });
      await receiveStock({ itemId: w.woolId, warehouseId: w.warehouseId, qty: 50, unitCost: 12, date: '2026-10-15', source: 'purchase', counterpartyId: row.id });
      return row;
    });

    const { data } = await accountant.get('/sales/purchases/supplier-prices', { itemId: w.woolId });
    // Yem Savdo: (100 × 10 + 300 × 20) / 400 = 17.5. Arzon Yem: 12, so it comes first.
    expect(data.suppliers.map((s: any) => s.name)).toEqual(['Arzon Yem', 'Yem Savdo']);
    expect(data.suppliers[1]).toMatchObject({ purchases: 2, totalQty: 400, avgPrice: 17.5, lastPrice: 20, lastDate: '2026-10-01', minPrice: 10, maxPrice: 20 });
    expect(data.suppliers[0]).toMatchObject({ counterpartyId: other.id, avgPrice: 12 });
    expect(data.history).toHaveLength(3);

    const hidden = await storekeeper.get('/sales/purchases/supplier-prices', { itemId: w.woolId });
    expect(hidden.data.suppliers[0].avgPrice).toBeNull();
    expect(hidden.data.history[0].unitCost).toBeNull();
  });
});

describe('contracts', () => {
  it('flags what is expiring and what has expired, and filters to those ending soon', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const { addDays, todayIso } = await import('@yap/shared');
    const today = todayIso();
    const contract = (number: string, endDate: string | null, status = 'active') =>
      accountant.post('/sales/contracts', { counterpartyId: w.supplierId, number, endDate, amount: 1000, status });

    const soon = await contract('A-1', addDays(today, 20));
    expect(soon.status).toBe(201);
    expect(soon.data).toMatchObject({ daysLeft: 20, expiringSoon: true, expired: false, counterpartyName: 'Yem Savdo' });
    await contract('A-2', addDays(today, 200));
    const past = await contract('A-3', addDays(today, -1));
    expect(past.data).toMatchObject({ expired: true, expiringSoon: false, daysLeft: -1 });
    await contract('A-4', addDays(today, 10), 'closed');
    await contract('A-5', null);

    const expiring = await accountant.get('/sales/contracts', { expiringWithin: 30 });
    expect(expiring.body.data.map((c: any) => c.number)).toEqual(['A-1']);
    expect((await accountant.get('/sales/contracts')).body.meta.total).toBe(5);
    expect((await accountant.get('/sales/contracts', { search: 'A-3' })).body.meta.total).toBe(1);
  });

  it('updates, deletes, and belongs to one tenant', async () => {
    const f = await createFixture();
    const other = await createFixture();
    const w = await arrange(f);
    const owner = await f.as('owner');
    const stranger = await other.as('owner');
    const { data } = await owner.post('/sales/contracts', { counterpartyId: w.supplierId, number: 'B-1' });
    expect((await owner.patch(`/sales/contracts/${data.id}`, { title: 'Yem' })).data.title).toBe('Yem');
    expect((await stranger.get(`/sales/contracts/${data.id}`)).status).toBe(404);
    expect((await stranger.delete(`/sales/contracts/${data.id}`)).status).toBe(404);
    expect((await owner.delete(`/sales/contracts/${data.id}`)).status).toBe(200);
    expect((await owner.get(`/sales/contracts/${data.id}`)).status).toBe(404);
  });

  it('rejects a counterparty from another tenant', async () => {
    const f = await createFixture();
    const other = await createFixture();
    const theirs = await arrange(other);
    const owner = await f.as('owner');
    const result = await owner.post('/sales/contracts', { counterpartyId: theirs.supplierId, number: 'X' });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect((await owner.get('/sales/contracts')).body.meta.total).toBe(0);
  });
});

describe('grants', () => {
  it('fills in the dates as the application moves on', async () => {
    const f = await createFixture();
    const accountant = await f.as('accountant');
    const { todayIso } = await import('@yap/shared');
    const { data } = await accountant.post('/sales/grants', { title: 'Chorva subsidiyasi', amount: 50_000_000 });
    expect(data).toMatchObject({ status: 'draft', kind: 'subsidy', submittedOn: null, decisionOn: null });

    const submitted = await accountant.patch(`/sales/grants/${data.id}`, { status: 'in_review' });
    expect(submitted.data).toMatchObject({ status: 'in_review', submittedOn: todayIso(), decisionOn: null });

    const decided = await accountant.patch(`/sales/grants/${data.id}`, { status: 'approved', decisionOn: '2026-12-01' });
    expect(decided.data).toMatchObject({ status: 'approved', submittedOn: todayIso(), decisionOn: '2026-12-01' });

    expect((await accountant.get('/sales/grants', { status: 'approved' })).body.meta.total).toBe(1);
    expect((await accountant.get('/sales/grants', { status: 'draft' })).body.meta.total).toBe(0);
  });

  it('can be removed, and is denied to a shepherd', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    const { data } = await owner.post('/sales/grants', { title: 'Kredit', kind: 'preferential_loan' });
    expect((await shepherd.get('/sales/grants')).status).toBe(403);
    expect((await owner.delete(`/sales/grants/${data.id}`)).status).toBe(200);
    expect((await owner.get(`/sales/grants/${data.id}`)).status).toBe(404);
  });
});

describe('state reports', () => {
  it('clamps the next due date to the length of the month', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonths('2026-11-15', 12)).toBe('2027-11-15');
    expect(addMonths('2026-12-31', 1)).toBe('2027-01-31');
  });

  it('submitting a repeating report schedules the next one; a one-off does not', async () => {
    const f = await createFixture();
    const accountant = await f.as('accountant');
    const { data } = await accountant.post('/sales/state-reports', {
      title: 'Statistika 1-qx',
      authority: 'statistics',
      period: 'quarterly',
      dueDate: '2026-10-20',
    });
    expect(data).toMatchObject({ status: 'planned', overdue: true });

    const done = await accountant.post(`/sales/state-reports/${data.id}/submit`, {});
    expect(done.data.report).toMatchObject({ status: 'submitted', overdue: false });
    expect(done.data.next).toMatchObject({ status: 'planned', dueDate: '2027-01-20', period: 'quarterly', title: 'Statistika 1-qx' });

    const repeat = await accountant.post(`/sales/state-reports/${data.id}/submit`, {});
    expect(repeat.status).toBe(409);
    expect(repeat.body.error.code).toBe('REPORT_ALREADY_SUBMITTED');

    const once = await accountant.post('/sales/state-reports', { title: 'Bir martalik', authority: 'tax', dueDate: '2030-01-01' });
    expect(once.data.overdue).toBe(false);
    const finished = await accountant.post(`/sales/state-reports/${once.data.id}/submit`, { submittedOn: '2029-12-30' });
    expect(finished.data.next).toBeNull();
    expect(finished.data.report.submittedOn).toBe('2029-12-30');

    const planned = await accountant.get('/sales/state-reports', { status: 'planned' });
    expect(planned.body.data.map((r: any) => r.dueDate)).toEqual(['2027-01-20']);
    expect((await accountant.get('/sales/state-reports', { authority: 'tax' })).body.meta.total).toBe(1);
  });
});

describe('counterparty settlement', () => {
  it('computes the balance from credit only', () => {
    const t = (type: string, paymentMethod: string, amountBase: number) => ({ type, paymentMethod, amountBase });
    expect(balanceEffect(t('income', 'debt', 100))).toBe(100);
    expect(balanceEffect(t('income', 'cash', 100))).toBe(0);
    expect(balanceEffect(t('expense', 'debt', 100))).toBe(-100);
    expect(balanceEffect(t('expense', 'bank', 100))).toBe(0);
    expect(balanceEffect(t('debt_receipt', 'cash', 100))).toBe(-100);
    expect(balanceEffect(t('debt_payment', 'bank', 100))).toBe(100);
  });

  it('matches hand-computed numbers and lists the documents', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');

    // Sold on credit: +1 000 000. They pay 400 000. We buy from them on credit: −250 000. Balance 350 000.
    const sale = await accountant.post(
      '/sales/orders',
      saleBody(w, [woolLine(w, 20, 50_000)], { paymentMethod: 'debt', accountId: null }),
    );
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    await f.run(async () => {
      const costCenterId = await generalCostCenterId();
      const [category] = await tx().select().from(financeCategories).where(sql`key = 'feed' and tenant_id = ${f.tenantId}`);
      await postTransaction({ date: '2026-11-06', type: 'debt_receipt', amount: 400_000, paymentMethod: 'cash', accountId: w.accountId, counterpartyId: w.buyerId });
      await postTransaction({ date: '2026-11-07', type: 'expense', amount: 250_000, paymentMethod: 'debt', counterpartyId: w.buyerId, categoryId: category.id, costCenterId });
      // Paid on the spot: no effect. Pending: has not happened yet.
      await postTransaction({ date: '2026-11-07', type: 'expense', amount: 90_000, paymentMethod: 'cash', accountId: w.accountId, counterpartyId: w.buyerId, categoryId: category.id, costCenterId });
      await postTransaction({ date: '2026-11-07', type: 'expense', amount: 9_000_000, paymentMethod: 'debt', counterpartyId: w.buyerId, categoryId: category.id, costCenterId });
    });

    const { data } = await accountant.get(`/sales/counterparties/${w.buyerId}/settlement`);
    expect(data.counterparty.name).toBe('Xaridor MChJ');
    expect(data.totals).toMatchObject({ sold: 1_000_000, received: 400_000, bought: 340_000, balance: 350_000, receivable: 350_000, payable: 0 });
    expect(data.sales.map((s: any) => s.number)).toEqual([sale.data.number]);
    expect(data.transactions).toHaveLength(5);
  });

  it('a cancelled credit sale clears the balance, and a payment already made shows as owed back', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const accountant = await f.as('accountant');
    const director = await f.as('director');
    const sale = await accountant.post(
      '/sales/orders',
      saleBody(w, [woolLine(w, 20, 50_000)], { paymentMethod: 'debt', accountId: null }),
    );
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    await director.post(`/sales/orders/${sale.data.id}/cancel`, { reason: 'Xato' });
    const { data } = await accountant.get(`/sales/counterparties/${w.buyerId}/settlement`);
    expect(data.totals).toMatchObject({ balance: 0, receivable: 0, payable: 0 });

    await f.run(() =>
      postTransaction({ date: SALE_DATE, type: 'debt_receipt', amount: 300_000, paymentMethod: 'cash', accountId: w.accountId, counterpartyId: w.buyerId }),
    );
    const after = await accountant.get(`/sales/counterparties/${w.buyerId}/settlement`);
    expect(after.data.totals).toMatchObject({ balance: -300_000, receivable: 0, payable: 300_000 });
  });

  it('unknown counterparty is a 404', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    expect((await owner.get('/sales/counterparties/0190a7e2-7b1c-7c3d-8e4f-1234567890ab/settlement')).status).toBe(404);
  });
});

describe('notifications', () => {
  const inbox = (f: Fixture, userId: string) =>
    f.run(() => tx().select().from(schema.notifications).where(eq(schema.notifications.userId, userId)));

  it('each step tells the next person, without mentioning money', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const storekeeper = await f.as('storekeeper');
    const director = await f.as('director');
    const accountant = await f.as('accountant');

    const { data } = await storekeeper.post('/sales/purchases', { itemId: w.alfalfaId, qty: 1, expectedPrice: 123_456 });
    const forDirector = await inbox(f, director.userId);
    expect(forDirector).toHaveLength(1);
    expect(forDirector[0]).toMatchObject({ severity: 'attention', link: '/sales/purchases' });
    expect(forDirector[0].title).toContain('Beda');
    expect(`${forDirector[0].title} ${forDirector[0].body}`).not.toContain('123');

    await director.post(`/sales/purchases/${data.id}/approve`);
    expect(await inbox(f, accountant.userId)).toHaveLength(1);

    await accountant.post(`/sales/purchases/${data.id}/pay`, { date: SALE_DATE, amount: 100, paymentMethod: 'cash', accountId: w.accountId });
    expect(await inbox(f, storekeeper.userId)).toHaveLength(1);
  });

  it('a large sale tells the approvers, but not the person who submitted it', async () => {
    const f = await createFixture();
    const w = await arrange(f);
    const director = await f.as('director');
    const owner = await f.as('owner');
    const sale = await director.post('/sales/orders', saleBody(w, [woolLine(w, 10, 600_000)]));
    await director.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(await inbox(f, owner.userId)).toHaveLength(1);
    expect(await inbox(f, director.userId)).toHaveLength(0);
  });
});

describe('seed', () => {
  it('builds the pilot sales data once the steps before it have run', async () => {
    const { SEED } = await import('../src/seed/names');
    const { seedSales } = await import('../src/seed/sales');
    const f = await createFixture();
    const roles = ['owner', 'accountant', 'storekeeper', 'director'] as const;
    const users = Object.fromEntries(await Promise.all(roles.map(async (r) => [r, (await f.as(r)).userId])));

    await f.run(async () => {
      const base = { tenantId: f.tenantId, farmId: f.farmId };
      const whNames = [SEED.warehouse.feed, SEED.warehouse.products];
      const [feed] = await tx().insert(warehouses).values(whNames.map((name) => ({ ...base, name, type: 'feed' }))).returning();
      const names = [SEED.item.wool, SEED.item.alfalfa, SEED.item.bran, SEED.item.premix, SEED.item.salt];
      await tx().insert(items).values(names.map((name) => ({ ...base, name, category: 'feed', unit: 'kg' })));
      const [grain] = await tx().insert(items).values({ ...base, name: SEED.item.wheatGrain, category: 'feed', unit: 't' }).returning();
      await receiveStock({ itemId: grain.id, warehouseId: feed.id, qty: 10, unitCost: 3_000_000, date: '2026-10-01', source: 'opening' });
      await tx().insert(accounts).values({ ...base, name: SEED.account.bank, type: 'bank' });
      const parties = [SEED.counterparty.grainBuyer, SEED.counterparty.feedSupplier, SEED.counterparty.sheepSeller, SEED.counterparty.buyer];
      await tx().insert(counterparties).values(parties.map((name) => ({ ...base, name, type: 'supplier' })));
    });

    await seedSales({
      tenantId: f.tenantId,
      farmId: f.farmId,
      users: users as never,
      run: (fn, as = 'owner') => f.run(fn, { userId: users[as] }),
    });

    const { data: orders } = await f.as('director').then((d) => d.get('/sales/orders', { sort: 'date' }).then((r) => r.body));
    expect(orders.map((o: any) => o.status).sort()).toEqual(['confirmed', 'pending']);
    const director = await f.as('director');
    expect((await director.get('/sales/purchases')).body.data.map((p: any) => p.status).sort()).toEqual(['approved', 'received', 'requested']);
    expect((await director.get('/sales/contracts', { expiringWithin: 30 })).body.data.map((c: any) => c.number)).toEqual(['YS-2026/14']);
    expect((await director.get('/sales/grants', { status: 'in_review' })).body.meta.total).toBe(1);
    expect((await director.get('/sales/prices/current')).data.length).toBe(8);
    const received = (await director.get('/sales/purchases', { status: 'received' })).body.data[0];
    expect(received).toMatchObject({ receivedQty: 980, diffQty: -20, diffAmount: -30_000 });
  });

  it('leaves the sale as a draft when no stock is there to sell', async () => {
    const { SEED } = await import('../src/seed/names');
    const { seedSales } = await import('../src/seed/sales');
    const f = await createFixture();
    const roles = ['owner', 'accountant', 'storekeeper', 'director'] as const;
    const users = Object.fromEntries(await Promise.all(roles.map(async (r) => [r, (await f.as(r)).userId])));
    await f.run(async () => {
      const base = { tenantId: f.tenantId, farmId: f.farmId };
      await tx().insert(warehouses).values([SEED.warehouse.feed, SEED.warehouse.products].map((name) => ({ ...base, name, type: 'feed' })));
      const names = [SEED.item.wool, SEED.item.alfalfa, SEED.item.bran, SEED.item.premix, SEED.item.salt, SEED.item.wheatGrain];
      await tx().insert(items).values(names.map((name) => ({ ...base, name, category: 'feed', unit: 'kg' })));
      await tx().insert(accounts).values({ ...base, name: SEED.account.bank, type: 'bank' });
      const parties = [SEED.counterparty.grainBuyer, SEED.counterparty.feedSupplier, SEED.counterparty.sheepSeller, SEED.counterparty.buyer];
      await tx().insert(counterparties).values(parties.map((name) => ({ ...base, name, type: 'supplier' })));
    });
    await seedSales({
      tenantId: f.tenantId,
      farmId: f.farmId,
      users: users as never,
      run: (fn, as = 'owner') => f.run(fn, { userId: users[as] }),
    });
    const director = await f.as('director');
    expect((await director.get('/sales/orders')).body.data.map((o: any) => o.status).sort()).toEqual(['draft', 'pending']);
  });
});

describe('access', () => {
  let f: Fixture;
  let w: World;
  let saleId: string;

  beforeAll(async () => {
    f = await createFixture();
    w = await arrange(f);
    const accountant = await f.as('accountant');
    const sale = await accountant.post('/sales/orders', saleBody(w, [woolLine(w, 1, 50_000)]));
    saleId = sale.data.id;
    await accountant.post(`/sales/orders/${saleId}/confirm`);
  });

  it.each(['shepherd', 'veterinarian', 'mechanic', 'agronomist', 'investor'] as const)('%s cannot read sales', async (role) => {
    const client = await f.as(role);
    expect((await client.get('/sales/orders')).status).toBe(403);
    expect((await client.get(`/sales/orders/${saleId}`)).status).toBe(403);
    expect((await client.get('/sales/prices/current')).status).toBe(403);
    expect((await client.get('/sales/analysis')).status).toBe(403);
    expect((await client.post('/sales/orders', saleBody(w, [woolLine(w, 1, 1)]))).status).toBe(403);
  });

  it('an auditor reads but cannot write or confirm', async () => {
    const auditor = await f.as('auditor');
    expect((await auditor.get('/sales/orders')).status).toBe(200);
    expect((await auditor.post('/sales/orders', saleBody(w, [woolLine(w, 1, 1)]))).status).toBe(403);
    expect((await auditor.post(`/sales/orders/${saleId}/cancel`, { reason: 'x' })).status).toBe(403);
  });

  it('a role with sales.view but no finance.view gets no money anywhere (rule 7)', async () => {
    const g = await createFixture();
    const world = await arrange(g);
    const accountant = await g.as('accountant');
    const sale = await accountant.post('/sales/orders', saleBody(world, [woolLine(world, 1, 50_000)]));
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    await accountant.post('/sales/prices', { itemId: world.woolId, date: '2026-11-01', price: 100 });
    await accountant.post('/sales/contracts', { counterpartyId: world.buyerId, number: 'C-1', amount: 1000 });
    await accountant.post('/sales/grants', { title: 'G', amount: 1000 });

    const viewer = await g.as('storekeeper');
    await g.run(() =>
      tx()
        .update(schema.roles)
        .set({ permissions: [...DEFAULT_ROLE_PERMISSIONS.storekeeper, 'sales.view'] })
        .where(and(eq(schema.roles.tenantId, g.tenantId), eq(schema.roles.key, 'storekeeper'))),
    );

    const list = await viewer.get('/sales/orders');
    expect(list.body.data[0].totalAmount).toBeNull();
    const detail = await viewer.get(`/sales/orders/${sale.data.id}`);
    expect(detail.data).toMatchObject({ totalAmount: null });
    expect(detail.data.lines[0]).toMatchObject({ qty: 1, price: null, amount: null, costAmount: null });
    expect(detail.data.postings[0].amountBase).toBeNull();

    expect((await viewer.get('/sales/prices/current')).data[0].price).toBeNull();
    expect((await viewer.get('/sales/prices')).body.data[0].price).toBeNull();

    const analysis = await viewer.get('/sales/analysis');
    expect(analysis.data.totals).toMatchObject({ amount: null, cost: null, margin: null });
    expect(analysis.data.byProduct[0]).toMatchObject({ qty: 1, amount: null, avgPrice: null, cost: null });
    expect(analysis.data.byMonth[0].amount).toBeNull();

    expect((await viewer.get('/sales/contracts')).body.data[0].amount).toBeNull();
    expect((await viewer.get('/sales/grants')).body.data[0].amount).toBeNull();

    const settlement = await viewer.get(`/sales/counterparties/${world.buyerId}/settlement`);
    expect(settlement.data.totals.balance).toBeNull();
    expect(settlement.data.transactions[0].amountBase).toBeNull();
    expect(settlement.data.sales[0].totalAmount).toBeNull();
  });

  it('another tenant sees none of it', async () => {
    const other = await createFixture();
    const stranger = await other.as('owner');
    expect((await stranger.get('/sales/orders')).body.data).toEqual([]);
    expect((await stranger.get(`/sales/orders/${saleId}`)).status).toBe(404);
    expect((await stranger.post(`/sales/orders/${saleId}/confirm`)).status).toBe(404);
    expect((await stranger.post(`/sales/orders/${saleId}/cancel`, { reason: 'x' })).status).toBe(404);
  });

  it('a sale cannot reference another tenant\'s item or animal', async () => {
    const other = await createFixture();
    const world = await arrange(other);
    const stranger = await other.as('owner');
    const mine = await addAnimal(f, w);
    const body = saleBody(world, [{ animalId: mine.id, qty: 1, unit: 'kg', price: 1 }]);
    expect((await stranger.post('/sales/orders', body)).status).toBe(404);
    const item = saleBody(world, [{ itemId: w.woolId, warehouseId: world.warehouseId, qty: 1, price: 1 }]);
    expect((await stranger.post('/sales/orders', item)).status).toBe(404);
  });

  it('a repeated create with the same Idempotency-Key makes one sale', async () => {
    const g = await createFixture();
    const world = await arrange(g);
    const accountant = await g.as('accountant');
    const body = saleBody(world, [woolLine(world, 1, 1000)]);
    const headers = { 'idempotency-key': 'sale-1' };
    const first = await accountant.post('/sales/orders', body, headers);
    const second = await accountant.post('/sales/orders', body, headers);
    expect(second.data.id).toBe(first.data.id);
    expect((await accountant.get('/sales/orders')).body.meta.total).toBe(1);
  });

  it('writes journal events for each step', async () => {
    const g = await createFixture();
    const world = await arrange(g);
    const accountant = await g.as('accountant');
    const director = await g.as('director');
    const sale = await accountant.post('/sales/orders', saleBody(world, [woolLine(world, 1, 1000)]));
    await accountant.post(`/sales/orders/${sale.data.id}/confirm`);
    await director.post(`/sales/orders/${sale.data.id}/cancel`, { reason: 'Xato' });
    const events = await g.run(() =>
      tx().select().from(schema.events).where(and(eq(schema.events.entityType, 'sale'), eq(schema.events.entityId, sale.data.id))),
    );
    expect(events.map((e) => e.type).sort()).toEqual(['sale.cancelled', 'sale.confirmed', 'sale.created']);
  });
});
