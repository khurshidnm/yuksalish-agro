import { addDays, todayIso } from '@yap/shared';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { generalCostCenterId } from '../src/core/costCenters';
import { tx } from '../src/core/context';
import { issueStock, stockOnHand } from '../src/core/inventory';
import { schema } from '../src/db/client';
import { evaluateRules } from '../src/modules/alerts/rules';
import { countLayout, documentLayout } from '../src/modules/inventory/documents.service';
import { feedBalance, feedConsumption, lowStock } from '../src/modules/inventory/summary';
import { seedInventory } from '../src/seed/inventory';
import { SEED } from '../src/seed/names';
import type { SeedContext } from '../src/seed/types';
import { createFixture, type Client, type Fixture } from './helpers';

const { accounts, animals, crops, financeCategories, herds, notifications, species, transactions } = schema;

const TODAY = todayIso();
const daysAgo = (n: number) => addDays(TODAY, -n);

async function warehouse(owner: Client, name: string, type = 'feed') {
  const res = await owner.post('/inventory/warehouses', { name, type });
  expect(res.status).toBe(201);
  return res.data.id as string;
}

async function item(owner: Client, body: Record<string, unknown>) {
  const res = await owner.post('/inventory/items', { category: 'feed', unit: 'kg', ...body });
  expect(res.status).toBe(201);
  return res.data.id as string;
}

async function supplier(owner: Client) {
  return (await owner.post('/finance/counterparties', { name: 'Yem Savdo', type: 'supplier' })).data.id as string;
}

/** A herd with `head` animals on the farm. */
async function herdWith(f: Fixture, head: number, opts: { rationId?: string | null; name?: string } = {}) {
  return f.run(async () => {
    const [sheep] = await tx().select().from(species).where(sql`key = 'sheep' and tenant_id = ${f.tenantId}`);
    const [herd] = await tx()
      .insert(herds)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name: opts.name ?? 'Sovliqlar', rationId: opts.rationId })
      .returning();
    const tag = () => `T-${Math.random().toString(36).slice(2, 10)}`;
    if (head > 0) {
      await tx()
        .insert(animals)
        .values(
          Array.from({ length: head }, () => ({
            tenantId: f.tenantId,
            farmId: f.farmId,
            tag: tag(),
            speciesId: sheep.id,
            sex: 'female',
            category: 'ewe',
            origin: 'purchased',
            herdId: herd.id,
          })),
        );
    }
    return herd.id;
  });
}

async function rationOf(owner: Client, lines: { itemId: string; kgPerHeadDay: number }[], name = 'Ratsion') {
  const res = await owner.post('/feed/rations', { name, state: 'pregnant', lines });
  expect(res.status).toBe(201);
  return res.data.id as string;
}

describe('warehouses and items', () => {
  let f: Fixture;
  let owner: Client;

  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
  });

  it('refuses a duplicate active item name, ignoring case', async () => {
    await item(owner, { name: 'Beda' });
    const dup = await owner.post('/inventory/items', { name: 'beda', category: 'feed', unit: 'kg' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ITEM_NAME_EXISTS');
  });

  it('an empty update changes nothing and is not a server error', async () => {
    const w = await warehouse(owner, 'Empty patch');
    const i = await item(owner, { name: 'Empty patch item' });
    expect((await owner.patch(`/inventory/warehouses/${w}`, {})).status).toBe(200);
    expect((await owner.patch(`/inventory/items/${i}`, {})).status).toBe(200);
  });

  it('lookups serve any signed-in role and never include money', async () => {
    const shepherd = await f.as('shepherd');
    await item(owner, { name: 'Lookup vaksina', category: 'vaccine', unit: 'dose', transferPrice: 500 });
    await item(owner, { name: 'Lookup dori', category: 'vet_drug', unit: 'vial' });
    await item(owner, { name: 'Lookup somon' });

    const both = await shepherd.get('/inventory/items/lookup', { search: 'Lookup', category: 'vaccine,vet_drug' });
    expect(both.status).toBe(200);
    expect(both.data.map((i: any) => i.name).sort()).toEqual(['Lookup dori', 'Lookup vaksina']);
    expect(Object.keys(both.data[0]).sort()).toEqual(['category', 'defaultWarehouseId', 'id', 'name', 'qtyOnHand', 'unit']);

    expect((await shepherd.get('/inventory/warehouses/lookup')).status).toBe(200);
    expect((await shepherd.get('/inventory/items')).status).toBe(403);
    expect((await shepherd.get('/inventory/stock')).status).toBe(403);
  });

  it('rejects an unknown category instead of silently returning everything', async () => {
    const res = await owner.get('/inventory/items/lookup', { category: 'nonsense' });
    expect(res.status).toBe(400);
  });

  it('cannot archive an item or a warehouse that holds stock', async () => {
    const w = await warehouse(owner, 'Archive test');
    const i = await item(owner, { name: 'Archive item' });
    await owner.post('/inventory/receipts', {
      warehouseId: w,
      date: TODAY,
      source: 'opening',
      lines: [{ itemId: i, qty: 5, unitCost: 1 }],
    });
    const itemDelete = await owner.delete(`/inventory/items/${i}`);
    expect(itemDelete.status).toBe(409);
    expect(itemDelete.body.error.code).toBe('ITEM_HAS_STOCK');
    const warehouseDelete = await owner.delete(`/inventory/warehouses/${w}`);
    expect(warehouseDelete.status).toBe(409);
    expect(warehouseDelete.body.error.code).toBe('WAREHOUSE_HAS_STOCK');
  });

  it('archives an empty item and frees its name', async () => {
    const i = await item(owner, { name: 'Bir martalik' });
    expect((await owner.delete(`/inventory/items/${i}`)).status).toBe(200);
    expect((await owner.get('/inventory/items', { search: 'Bir martalik' })).body.data).toEqual([]);
    await item(owner, { name: 'Bir martalik' });
  });

  it('a storekeeper manages master data but cannot delete it', async () => {
    const storekeeper = await f.as('storekeeper');
    const i = await item(storekeeper, { name: 'Omborchi item' });
    expect((await storekeeper.delete(`/inventory/items/${i}`)).status).toBe(403);
  });

  it('an agronomist can receive stock but not change master data', async () => {
    const agronomist = await f.as('agronomist');
    const res = await agronomist.post('/inventory/items', { name: 'Agronom item', category: 'seed', unit: 'kg' });
    expect(res.status).toBe(403);
  });

  it('saving an item without seeing its price does not erase the price', async () => {
    const storekeeper = await f.as('storekeeper');
    const i = await item(owner, { name: 'Narxli', transferPrice: 7000 });
    const seen = await storekeeper.get(`/inventory/items/${i}`);
    expect(seen.data.transferPrice).toBeNull();
    const saved = await storekeeper.patch(`/inventory/items/${i}`, { notes: 'x', transferPrice: null });
    expect(saved.status).toBe(200);
    expect(saved.data.transferPrice).toBeNull();
    expect((await owner.get(`/inventory/items/${i}`)).data.transferPrice).toBe(7000);
  });
});

describe('receipts', () => {
  let f: Fixture;
  let owner: Client;
  let w: string;
  let vendor: string;
  let cash: string;

  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
    w = await warehouse(owner, 'Ozuqa');
    vendor = await supplier(owner);
    cash = await f.run(async () => {
      const [account] = await tx()
        .insert(accounts)
        .values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Kassa', type: 'cash' })
        .returning();
      return account.id;
    });
  });

  const receipt = (over: object) => ({ warehouseId: w, date: TODAY, counterpartyId: vendor, ...over });

  it('a purchase needs a supplier', async () => {
    const i = await item(owner, { name: 'No supplier' });
    const res = await owner.post('/inventory/receipts', {
      warehouseId: w,
      date: TODAY,
      lines: [{ itemId: i, qty: 1, unitCost: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('COUNTERPARTY_REQUIRED');
  });

  it('numbers documents per year and makes one batch per line', async () => {
    const a = await item(owner, { name: 'Line A' });
    const b = await item(owner, { name: 'Line B' });
    const first = await owner.post(
      '/inventory/receipts',
      receipt({
        invoiceNo: 'HF-77',
        lines: [
          { itemId: a, qty: 100, unitCost: 10, batchNo: 'P1' },
          { itemId: b, qty: 50, unitCost: 20, expiryDate: addDays(TODAY, 90) },
        ],
      }),
    );
    expect(first.status).toBe(201);
    const year = TODAY.slice(0, 4);
    expect(first.data.docNo).toMatch(new RegExp(`^KO-${year}-\\d{4}$`));
    expect(first.data.batches).toHaveLength(2);

    const second = await owner.post('/inventory/receipts', receipt({ lines: [{ itemId: a, qty: 1, unitCost: 10 }] }));
    const number = (doc: string) => Number(doc.split('-')[2]);
    expect(number(second.data.docNo)).toBe(number(first.data.docNo) + 1);

    const batches = await owner.get(`/inventory/stock/${a}/batches`);
    expect(batches.data).toHaveLength(2);
    expect(batches.data[0]).toMatchObject({
      batchNo: 'P1',
      invoiceNo: 'HF-77',
      qtyRemaining: 100,
      unitCost: 10,
      counterpartyName: 'Yem Savdo',
      source: 'purchase',
    });
  });

  it('posts the payment as inventory, so feed is not counted twice', async () => {
    const i = await item(owner, { name: 'Paid feed' });
    const res = await owner.post(
      '/inventory/receipts',
      receipt({ lines: [{ itemId: i, qty: 100, unitCost: 3000 }], payment: { paymentMethod: 'cash', accountId: cash } }),
    );
    expect(res.status).toBe(201);
    const [transaction] = res.data.transactions;
    expect(transaction.status).toBe('approved');

    const [row] = await f.run(() => tx().select().from(transactions).where(eq(transactions.id, transaction.id)));
    expect(row).toMatchObject({
      type: 'expense',
      amountBase: 300_000,
      costTreatment: 'inventory',
      sourceType: 'stock_batch',
      sourceId: res.data.batches[0].id,
      counterpartyId: vendor,
      accountId: cash,
    });
    const [category] = await f.run(() =>
      tx().select().from(financeCategories).where(eq(financeCategories.id, row.categoryId!)),
    );
    expect(category.key).toBe('feed');
  });

  it('a large purchase waits for approval, but the goods are in stock', async () => {
    const i = await item(owner, { name: 'Big order' });
    const res = await owner.post(
      '/inventory/receipts',
      receipt({ lines: [{ itemId: i, qty: 1000, unitCost: 6000 }], payment: { paymentMethod: 'debt', dueDate: addDays(TODAY, 30) } }),
    );
    expect(res.data.transactions[0].status).toBe('pending');
    expect((await owner.get('/inventory/items/lookup', { search: 'Big order' })).data[0].qtyOnHand).toBe(1000);
  });

  it('a mixed invoice lands on one expense line per category', async () => {
    const feed = await item(owner, { name: 'Mix feed' });
    const drug = await item(owner, { name: 'Mix drug', category: 'vet_drug', unit: 'vial' });
    const res = await owner.post(
      '/inventory/receipts',
      receipt({
        lines: [
          { itemId: feed, qty: 10, unitCost: 100 },
          { itemId: drug, qty: 2, unitCost: 500 },
        ],
        payment: { paymentMethod: 'cash', accountId: cash },
      }),
    );
    expect(res.data.transactions).toHaveLength(2);
    const rows = await f.run(() =>
      tx()
        .select({ key: financeCategories.key, amount: transactions.amountBase })
        .from(transactions)
        .innerJoin(financeCategories, eq(financeCategories.id, transactions.categoryId))
        .where(
          sql`${transactions.id} in (${sql.join(
            res.data.transactions.map((t: any) => sql`${t.id}::uuid`),
            sql`, `,
          )})`,
        ),
    );
    expect(rows.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'feed', amount: 1000 },
      { key: 'veterinary', amount: 1000 },
    ]);
  });

  it('an item with no default category needs one chosen', async () => {
    const i = await item(owner, { name: 'Product', category: 'product' });
    const res = await owner.post(
      '/inventory/receipts',
      receipt({ lines: [{ itemId: i, qty: 1, unitCost: 1 }], payment: { paymentMethod: 'cash', accountId: cash } }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CATEGORY_REQUIRED');
  });

  it('converts a foreign currency purchase to base cost', async () => {
    const i = await item(owner, { name: 'Import' });
    const res = await owner.post(
      '/inventory/receipts',
      receipt({
        currency: 'USD',
        fxRate: 12_500,
        lines: [{ itemId: i, qty: 100, unitCost: 2 }],
        payment: { paymentMethod: 'cash', accountId: cash },
      }),
    );
    expect(res.status).toBe(201);
    expect((await owner.get(`/inventory/stock/${i}/batches`)).data[0].unitCost).toBe(25_000);
    const [row] = await f.run(() => tx().select().from(transactions).where(eq(transactions.id, res.data.transactions[0].id)));
    expect(row).toMatchObject({ amount: 200, currency: 'USD', amountBase: 2_500_000 });
  });

  it('a foreign purchase without a rate is refused', async () => {
    const i = await item(owner, { name: 'No rate' });
    const res = await owner.post('/inventory/receipts', receipt({ currency: 'USD', lines: [{ itemId: i, qty: 1, unitCost: 1 }] }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FX_RATE_REQUIRED');
  });

  it('paying needs finance.create, and a refused receipt leaves no stock behind', async () => {
    const storekeeper = await f.as('storekeeper');
    const i = await item(owner, { name: 'Refused' });
    const res = await storekeeper.post(
      '/inventory/receipts',
      receipt({ lines: [{ itemId: i, qty: 5, unitCost: 1 }], payment: { paymentMethod: 'cash', accountId: cash } }),
    );
    expect(res.status).toBe(403);
    expect((await owner.get('/inventory/items/lookup', { search: 'Refused' })).data[0].qtyOnHand).toBe(0);
  });

  it('one bad line rolls the whole receipt back', async () => {
    const i = await item(owner, { name: 'Atomic' });
    const missing = '0190a7e2-7b1c-7c3d-8e4f-000000000001';
    const res = await owner.post(
      '/inventory/receipts',
      receipt({
        lines: [
          { itemId: i, qty: 5, unitCost: 1 },
          { itemId: missing, qty: 5, unitCost: 1 },
        ],
      }),
    );
    expect(res.status).toBe(404);
    expect((await owner.get('/inventory/items/lookup', { search: 'Atomic' })).data[0].qtyOnHand).toBe(0);
  });
});

describe('receipts with no money behind them', () => {
  const LIST = '/finance/debts/unpaid-receipts';
  const OPENING_CASH = 20_000_000;

  let f: Fixture;
  let owner: Client;
  let director: Client;
  let accountant: Client;
  let storekeeper: Client;
  let w: string;
  let vendor: string;
  let cash: string;
  let dollars: string;
  let barley: string;
  let drug: string;
  let general: string;

  let names = 0;
  const unique = (name: string) => `${name} ${++names}`;
  const newSupplier = async (name = 'Buxoro Yem Savdo') =>
    (await owner.post('/finance/counterparties', { name: unique(name), type: 'supplier' })).data.id as string;

  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
    director = await f.as('director');
    accountant = await f.as('accountant');
    storekeeper = await f.as('storekeeper');
    w = await warehouse(owner, 'Asosiy ombor');
    vendor = await newSupplier();
    barley = await item(owner, { name: 'Arpa doni' });
    drug = await item(owner, { name: 'Antibiotik', category: 'vet_drug', unit: 'vial' });
    [cash, dollars, general] = await f.run(async () => {
      const base = { tenantId: f.tenantId, farmId: f.farmId };
      const [till] = await tx().insert(accounts).values({ ...base, name: 'Kassa', type: 'cash', openingBalance: OPENING_CASH }).returning();
      const [safe] = await tx().insert(accounts).values({ ...base, name: 'Dollar seyf', type: 'cash', currency: 'USD' }).returning();
      return [till.id, safe.id, await generalCostCenterId()];
    });
  });

  /** 1 000 kg x 3 300 = 3 300 000: below the threshold, so money for it is approved at once. */
  const small = () => [{ itemId: barley, qty: 1000, unitCost: 3300 }];
  /** 3 000 kg x 3 300 = 9 900 000: the receipt KO-2026-0006 of the first-day check. Needs a second person. */
  const large = () => [{ itemId: barley, qty: 3000, unitCost: 3300 }];
  /** 1 000 kg x 4 000 + 100 x 15 000 = 5 500 000. Neither line reaches 5 000 000, together they do. */
  const mixed = () => [
    { itemId: barley, qty: 1000, unitCost: 4000 },
    { itemId: drug, qty: 100, unitCost: 15_000 },
  ];

  async function received(lines = small(), over: object = {}) {
    const res = await storekeeper.post('/inventory/receipts', { warehouseId: w, date: TODAY, counterpartyId: vendor, lines, ...over });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.data as { docNo: string; refId: string; batches: { id: string }[] };
  }

  const listed = async (refId: string) => (await accountant.get(LIST, { pageSize: 200 })).data.find((row: any) => row.id === refId);
  const total = async () => (await accountant.get(LIST)).body.meta.total as number;
  const record = (refId: string, body: object, who = accountant) => who.post(`${LIST}/${refId}/record`, body);
  const onCredit = { paymentMethod: 'debt' };
  const paidInCash = () => ({ paymentMethod: 'cash', accountId: cash });

  async function recorded(refId: string, body: object = onCredit) {
    const res = await record(refId, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.data as { docNo: string; transactions: { id: string; status: string }[] };
  }

  const moneyOf = (refId: string) => f.run(() => tx().select().from(transactions).where(eq(transactions.sourceId, refId)).orderBy(transactions.id));
  const owed = async (counterpartyId: string): Promise<number> =>
    (await accountant.get('/finance/debts', { direction: 'payable' })).data.find((d: any) => d.counterpartyId === counterpartyId)?.outstanding ?? 0;
  const cashLeft = async (): Promise<number> => (await accountant.get('/finance/accounts')).data.find((a: any) => a.id === cash).balance;
  const onHand = (itemId: string) => f.run(() => stockOnHand(itemId));
  const reject = (id: string) => director.post(`/finance/transactions/${id}/reject`, { reason: 'Xato hisob' });
  const voidEntry = (id: string) => director.post(`/finance/transactions/${id}/void`, { reason: 'Xato hisob' });

  it('shows finance what a storekeeper received: the supplier, the goods and their value', async () => {
    const supplierId = await newSupplier('Qarshi Don');
    const { refId, docNo } = await received(
      [
        { itemId: barley, qty: 3000, unitCost: 3300 },
        { itemId: drug, qty: 40, unitCost: 12_500 },
      ],
      { counterpartyId: supplierId, invoiceNo: 'HF-12' },
    );
    // 9 900 000 + 500 000
    expect(await listed(refId)).toMatchObject({
      id: refId,
      docNo,
      date: TODAY,
      counterpartyId: supplierId,
      supplier: expect.stringContaining('Qarshi Don'),
      invoiceNo: 'HF-12',
      value: 10_400_000,
      goods: 'Arpa doni, Antibiotik',
      lines: [
        { itemName: 'Arpa doni', itemCategory: 'feed', unit: 'kg', qty: 3000, value: 9_900_000 },
        { itemName: 'Antibiotik', itemCategory: 'vet_drug', unit: 'vial', qty: 40, value: 500_000 },
      ],
    });
  });

  it('the first-day story: 2 500 000 + 6 200 000 + 9 900 000 = 18 600 000 really owed', async () => {
    const supplierId = await newSupplier();
    const categories = (await accountant.get('/finance/categories', { kind: 'expense' })).data;
    const feed = categories.find((c: any) => c.key === 'feed').id;
    const earlier = await accountant.post('/finance/transactions', {
      date: TODAY, type: 'expense', amount: 2_500_000, categoryId: feed, costCenterId: general, paymentMethod: 'debt', counterpartyId: supplierId,
    });
    expect(earlier.status).toBe(201);

    const byOwner = await owner.post('/inventory/receipts', {
      warehouseId: w, date: TODAY, counterpartyId: supplierId, lines: [{ itemId: barley, qty: 2000, unitCost: 3100 }], payment: { paymentMethod: 'debt' },
    });
    expect((await accountant.post(`/finance/transactions/${byOwner.data.transactions[0].id}/approve`)).status).toBe(200);
    expect(await listed(byOwner.data.refId)).toBeUndefined();

    const { refId } = await received(large(), { counterpartyId: supplierId });
    expect(await owed(supplierId)).toBe(8_700_000);
    expect((await listed(refId)).value).toBe(9_900_000);

    const { transactions: [money] } = await recorded(refId);
    expect(money.status).toBe('pending');
    expect(await listed(refId)).toBeUndefined();
    expect(await owed(supplierId)).toBe(8_700_000);
    expect((await director.post(`/finance/transactions/${money.id}/approve`)).status).toBe(200);
    expect(await owed(supplierId)).toBe(18_600_000);
  });

  it('recorded as a debt, it opens the debt, links to the receipt and leaves the list', async () => {
    const supplierId = await newSupplier();
    const { refId, docNo } = await received(small(), { counterpartyId: supplierId, invoiceNo: 'HF-7', notes: 'Bahorgi partiya' });
    const stock = await onHand(barley);
    const money = await recorded(refId, { paymentMethod: 'debt', dueDate: addDays(TODAY, 30) });
    expect(money).toMatchObject({ docNo, transactions: [{ status: 'approved' }] });

    const [row] = await moneyOf(refId);
    const [category] = await f.run(() => tx().select().from(financeCategories).where(eq(financeCategories.id, row.categoryId!)));
    expect(category.key).toBe('feed');
    expect(row).toMatchObject({
      type: 'expense',
      date: TODAY,
      amount: 3_300_000,
      amountBase: 3_300_000,
      paymentMethod: 'debt',
      accountId: null,
      counterpartyId: supplierId,
      costCenterId: general,
      costTreatment: 'inventory',
      dueDate: addDays(TODAY, 30),
      sourceType: 'stock_doc',
      sourceId: refId,
      description: `${docNo} / HF-7 / Bahorgi partiya`,
      createdBy: accountant.userId,
    });
    expect(await listed(refId)).toBeUndefined();
    expect(await owed(supplierId)).toBe(3_300_000);
    expect(await onHand(barley)).toBe(stock);
  });

  it('recorded as paid, the money leaves the account and no debt opens', async () => {
    const supplierId = await newSupplier();
    const { refId } = await received(small(), { counterpartyId: supplierId });
    const before = await cashLeft();
    await recorded(refId, paidInCash());
    expect(await cashLeft()).toBe(before - 3_300_000);
    expect(await owed(supplierId)).toBe(0);
    expect(await listed(refId)).toBeUndefined();
    expect((await moneyOf(refId))[0]).toMatchObject({ paymentMethod: 'cash', accountId: cash, costTreatment: 'inventory' });
  });

  it('the cost still reaches a cost center only when the goods are issued', async () => {
    const hay = await item(owner, { name: unique('Pichan') });
    const costs = async (): Promise<number> => (await accountant.get('/finance/costs/centers')).data.find((c: any) => c.costCenterId === general).total;
    const before = await costs();
    const { refId } = await received([{ itemId: hay, qty: 1000, unitCost: 3300 }]);
    await recorded(refId, paidInCash());
    expect(await costs()).toBe(before);
    // 250 kg x 3 300
    await storekeeper.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId: general, lines: [{ itemId: hay, qty: 250 }] });
    expect(await costs()).toBe(before + 825_000);
  });

  it('stays listed while the goods are being used: the supplier is still owed all of it', async () => {
    const hay = await item(owner, { name: unique('Somon') });
    const { refId } = await received([{ itemId: hay, qty: 10, unitCost: 2000 }]);
    await storekeeper.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId: general, lines: [{ itemId: hay, qty: 10 }] });
    expect((await listed(refId)).value).toBe(20_000);
    expect((await moneyOf(refId))).toEqual([]);
    await recorded(refId);
    expect((await moneyOf(refId))[0].amountBase).toBe(20_000);
  });

  it('takes the day of the receipt unless told when the money moved', async () => {
    const debt = await received(small(), { date: daysAgo(5) });
    await recorded(debt.refId);
    expect((await moneyOf(debt.refId))[0].date).toBe(daysAgo(5));

    const paid = await received(small(), { date: daysAgo(5) });
    await recorded(paid.refId, { ...paidInCash(), date: TODAY });
    expect((await moneyOf(paid.refId))[0].date).toBe(TODAY);
  });

  it('leaves out everything that is not a purchase from a supplier waiting for money', async () => {
    const before = await total();
    const take = (body: object) => owner.post('/inventory/receipts', { warehouseId: w, date: TODAY, lines: small(), ...body });

    expect((await take({ source: 'opening' })).status).toBe(201);
    expect((await take({ source: 'return', counterpartyId: vendor })).status).toBe(201);
    expect((await take({ counterpartyId: vendor, payment: paidInCash() })).status).toBe(201);
    expect((await take({ counterpartyId: vendor, payment: { paymentMethod: 'debt' } })).status).toBe(201);
    expect((await take({ payment: paidInCash() })).status).toBe(201);
    expect((await take({ counterpartyId: vendor, lines: [{ itemId: barley, qty: 5, unitCost: 0 }] })).status).toBe(201);
    expect(await total()).toBe(before);
  });

  it('a money row on one batch covers the whole receipt, not only that line', async () => {
    const res = await owner.post('/inventory/receipts', {
      warehouseId: w, date: TODAY, counterpartyId: vendor, lines: small().concat(small()), payment: { paymentMethod: 'debt' },
    });
    expect(res.data.batches).toHaveLength(2);
    expect(res.data.transactions).toHaveLength(1);
    expect(await listed(res.data.refId)).toBeUndefined();
    const again = await record(res.data.refId, onCredit);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('RECEIPT_HAS_MONEY');
  });

  it('goods of a purchase request are paid through the request, so they never show', async () => {
    const before = await total();
    const { data: request } = await owner.post('/sales/purchases', { itemId: barley, qty: 100, expectedPrice: 3000, counterpartyId: vendor });
    expect((await director.post(`/sales/purchases/${request.id}/approve`)).status).toBe(200);
    const paid = await owner.post(`/sales/purchases/${request.id}/pay`, { date: TODAY, amount: 300_000, paymentMethod: 'cash', accountId: cash });
    expect(paid.status).toBe(200);
    const came = await owner.post(`/sales/purchases/${request.id}/receive`, { date: TODAY, qty: 100, warehouseId: w, quality: 'Yaxshi' });
    expect(came.status, JSON.stringify(came.body)).toBe(200);
    expect(await total()).toBe(before);
  });

  describe('goods a paid purchase request is still waiting for', () => {
    async function paidRequest(itemId: string, counterpartyId: string | null) {
      const { data: request } = await owner.post('/sales/purchases', { itemId, qty: 10, expectedPrice: 100, counterpartyId });
      expect((await director.post(`/sales/purchases/${request.id}/approve`)).status).toBe(200);
      const paid = await owner.post(`/sales/purchases/${request.id}/pay`, { date: TODAY, amount: 1000, paymentMethod: 'cash', accountId: cash });
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      return request.id as string;
    }
    const newItem = () => item(owner, { name: unique('Xarid tovari') });

    it('are flagged when entered as a plain receipt, because money here would count twice', async () => {
      const goods = await newItem();
      await paidRequest(goods, vendor);
      const { refId } = await received([{ itemId: barley, qty: 1, unitCost: 100 }, { itemId: goods, qty: 10, unitCost: 100 }]);
      expect((await listed(refId)).paidRequest).toBe(true);
    });

    it('a request that named no supplier could be any delivery of that item', async () => {
      const goods = await newItem();
      await paidRequest(goods, null);
      expect((await listed((await received([{ itemId: goods, qty: 10, unitCost: 100 }])).refId)).paidRequest).toBe(true);
    });

    it('are not flagged for another supplier, another item, or a request already received', async () => {
      const goods = await newItem();
      const id = await paidRequest(goods, vendor);
      const other = await newItem();
      expect((await listed((await received([{ itemId: goods, qty: 1, unitCost: 100 }], { counterpartyId: await newSupplier() })).refId)).paidRequest).toBe(false);
      expect((await listed((await received([{ itemId: other, qty: 1, unitCost: 100 }])).refId)).paidRequest).toBe(false);

      await owner.post(`/sales/purchases/${id}/receive`, { date: TODAY, qty: 10, warehouseId: w, quality: 'Yaxshi' });
      expect((await listed((await received([{ itemId: goods, qty: 1, unitCost: 100 }])).refId)).paidRequest).toBe(false);
    });

    it('still leaves the decision to a person', async () => {
      const goods = await newItem();
      await paidRequest(goods, vendor);
      const { refId } = await received([{ itemId: goods, qty: 10, unitCost: 100 }]);
      expect((await record(refId, onCredit)).status).toBe(201);
    });
  });

  it('a receipt that was reversed leaves the list', async () => {
    const { refId, docNo } = await received();
    expect(await listed(refId)).toBeDefined();
    expect((await owner.post(`/inventory/documents/${docNo}/reverse`)).status).toBe(200);
    expect(await listed(refId)).toBeUndefined();
    expect((await record(refId, onCredit)).status).toBe(404);
  });

  it('reads oldest first, pages, and finds by supplier, number or goods', async () => {
    const supplierId = await newSupplier('Uzoq Savdo');
    const rare = await item(owner, { name: unique('Noyob yem') });
    const later = await received(small(), { counterpartyId: supplierId, date: daysAgo(1) });
    const earlier = await received([{ itemId: rare, qty: 1, unitCost: 100 }], { counterpartyId: supplierId, date: daysAgo(3) });

    const bySupplier = await accountant.get(LIST, { search: 'Uzoq Savdo' });
    expect(bySupplier.data.map((row: any) => row.id)).toEqual([earlier.refId, later.refId]);
    expect(bySupplier.body.meta.total).toBe(2);
    const biggest = await accountant.get(LIST, { search: 'Uzoq Savdo', sort: '-value' });
    expect(biggest.data[0].id).toBe(later.refId);

    const first = await accountant.get(LIST, { search: 'Uzoq Savdo', pageSize: 1 });
    expect(first.data.map((row: any) => row.id)).toEqual([earlier.refId]);
    expect(first.body.meta).toMatchObject({ page: 1, pageSize: 1, total: 2 });

    expect((await accountant.get(LIST, { search: later.docNo })).data.map((row: any) => row.id)).toEqual([later.refId]);
    expect((await accountant.get(LIST, { search: 'Noyob yem' })).data.map((row: any) => row.id)).toEqual([earlier.refId]);
  });

  describe('who may see and record it (rule 7)', () => {
    it('a storekeeper gets no list and cannot record, though they entered the goods', async () => {
      const { refId } = await received();
      const seen = await storekeeper.get(LIST);
      expect(seen.status).toBe(403);
      expect(JSON.stringify(seen.body)).not.toContain('3300000');
      expect((await record(refId, onCredit, storekeeper)).status).toBe(403);
      expect(await moneyOf(refId)).toEqual([]);
    });

    it('neither do other warehouse users, whatever else they manage', async () => {
      for (const role of ['agronomist', 'zootechnician', 'veterinarian', 'investor'] as const) {
        expect((await (await f.as(role)).get(LIST)).status, role).toBe(403);
      }
    });

    it('an auditor reads the list and records nothing', async () => {
      const { refId } = await received();
      const auditor = await f.as('auditor');
      expect((await auditor.get(LIST)).status).toBe(200);
      expect((await record(refId, onCredit, auditor)).status).toBe(403);
    });

    it('another tenant cannot see it or record it', async () => {
      const { refId } = await received();
      const stranger = await (await createFixture()).as('accountant');
      expect((await stranger.get(LIST)).data).toEqual([]);
      expect((await record(refId, onCredit, stranger)).status).toBe(404);
      expect(await moneyOf(refId)).toEqual([]);
    });
  });

  describe('the alert', () => {
    const alertsOf = async (who: Client, refId: string) =>
      (await who.get('/alerts', { active: 'true', pageSize: 200 })).data.filter((alert: any) => alert.entityId === refId);
    const toldUsers = async (refId: string) => {
      const [alert] = await alertsOf(accountant, refId);
      const rows = await f.run(() => tx().select().from(notifications).where(eq(notifications.alertId, alert.id)));
      return rows.map((row) => row.userId);
    };

    it('tells the accountant once, and no one who may not see money', async () => {
      const { refId, docNo } = await received();
      await f.run(() => evaluateRules());
      await f.run(() => evaluateRules());

      const raised = await alertsOf(accountant, refId);
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({ ruleKey: 'receipt_unpaid', severity: 'attention', link: '/finance/debts?tab=receipts' });
      expect(raised[0].title).toContain(docNo);
      expect(raised[0].body).toContain('Buxoro Yem Savdo');
      expect(raised[0].body).toContain('Arpa doni');
      expect(await toldUsers(refId)).toEqual([accountant.userId]);
      expect(await alertsOf(storekeeper, refId)).toEqual([]);
    });

    it('each new delivery raises its own alert, so the second one is heard as well', async () => {
      const first = await received();
      await f.run(() => evaluateRules());
      const second = await received();
      await f.run(() => evaluateRules());
      expect(await alertsOf(accountant, first.refId)).toHaveLength(1);
      expect(await toldUsers(second.refId)).toEqual([accountant.userId]);
    });

    it('resolves once the money is recorded, even while it waits for approval', async () => {
      const { refId } = await received(large());
      await f.run(() => evaluateRules());
      expect(await alertsOf(accountant, refId)).toHaveLength(1);
      await recorded(refId);
      await f.run(() => evaluateRules());
      expect(await alertsOf(accountant, refId)).toEqual([]);
    });

    it('comes back when that money is refused', async () => {
      const { refId } = await received(large());
      const { transactions: [money] } = await recorded(refId);
      expect((await reject(money.id)).status).toBe(200);
      await f.run(() => evaluateRules());
      expect(await alertsOf(accountant, refId)).toHaveLength(1);
    });
  });

  describe('a mixed invoice', () => {
    it('lands on one line per category, and approval looks at the whole receipt', async () => {
      const { refId } = await received(mixed());
      expect((await listed(refId)).value).toBe(5_500_000);
      const money = await recorded(refId);
      expect(money.transactions.map((t) => t.status)).toEqual(['pending', 'pending']);

      const rows = await f.run(() =>
        tx()
          .select({ key: financeCategories.key, amount: transactions.amount })
          .from(transactions)
          .innerJoin(financeCategories, eq(financeCategories.id, transactions.categoryId))
          .where(eq(transactions.sourceId, refId)),
      );
      expect(rows.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
        { key: 'feed', amount: 4_000_000 },
        { key: 'veterinary', amount: 1_500_000 },
      ]);
    });

    it('a category chosen by a person takes the whole receipt, as on the receipt form', async () => {
      const { refId } = await received(mixed());
      const categories = (await accountant.get('/finance/categories', { kind: 'expense' })).data;
      const other = categories.find((c: any) => c.key === 'feed').id;
      await recorded(refId, { ...onCredit, categoryId: other });
      const rows = await moneyOf(refId);
      expect(rows.map((row) => [row.categoryId, row.amount])).toEqual([[other, 5_500_000]]);
    });

    it('refused on one line, the other goes too, and the whole receipt is back', async () => {
      const { refId } = await received(mixed());
      const { transactions: [first] } = await recorded(refId);
      expect((await reject(first.id)).status).toBe(200);

      const rows = await moneyOf(refId);
      expect(rows.map((row) => row.status)).toEqual(['rejected', 'rejected']);
      expect(rows.map((row) => row.rejectedReason)).toEqual(['Xato hisob', 'Xato hisob']);
      expect((await listed(refId)).value).toBe(5_500_000);
    });

    it('takes a line that was already approved with it', async () => {
      const supplierId = await newSupplier();
      const { refId } = await received(mixed(), { counterpartyId: supplierId });
      const { transactions: [first, second] } = await recorded(refId);
      expect((await director.post(`/finance/transactions/${first.id}/approve`)).status).toBe(200);
      expect(await owed(supplierId)).toBeGreaterThan(0);

      expect((await reject(second.id)).status).toBe(200);
      expect((await moneyOf(refId)).map((row) => row.status)).toEqual(['rejected', 'rejected']);
      expect(await owed(supplierId)).toBe(0);
      expect(await listed(refId)).toBeDefined();
    });

    it('a payment standing on an approved line keeps the whole invoice', async () => {
      const supplierId = await newSupplier();
      const { refId } = await received(mixed(), { counterpartyId: supplierId });
      const { transactions: [first, second] } = await recorded(refId);
      expect((await director.post(`/finance/transactions/${first.id}/approve`)).status).toBe(200);
      const settled = await accountant.post('/finance/debts/settle', { counterpartyId: supplierId, direction: 'payable', amount: 1_000_000, date: TODAY, accountId: cash });
      expect(settled.status, JSON.stringify(settled.body)).toBe(201);

      const refused = await reject(second.id);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('DEBT_ALREADY_SETTLED');
      expect((await moneyOf(refId)).filter((row) => row.status === 'rejected')).toEqual([]);
      expect(await listed(refId)).toBeUndefined();
    });
  });

  describe('money entered by mistake', () => {
    it('refused by the second person, the goods stay and the receipt comes back to be entered again', async () => {
      const { refId } = await received(large());
      const stock = await onHand(barley);
      const { transactions: [money] } = await recorded(refId);
      expect(await listed(refId)).toBeUndefined();

      expect((await reject(money.id)).status).toBe(200);
      expect(await onHand(barley)).toBe(stock);
      expect((await listed(refId)).value).toBe(9_900_000);

      const again = await recorded(refId);
      expect(again.transactions[0].status).toBe('pending');
      expect((await moneyOf(refId)).map((row) => row.status)).toEqual(['rejected', 'pending']);
    });

    it('can be refused even after the goods were used, unlike money posted with the receipt', async () => {
      const hay = await item(owner, { name: unique('Beda') });
      const { refId } = await received([{ itemId: hay, qty: 2000, unitCost: 3000 }]);
      const { transactions: [money] } = await recorded(refId);
      await storekeeper.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId: general, lines: [{ itemId: hay, qty: 500 }] });

      expect((await reject(money.id)).status).toBe(200);
      expect(await onHand(hay)).toBe(1500);
      expect((await listed(refId)).value).toBe(6_000_000);
    });

    it('voided after approval, the debt goes, the goods stay and the receipt comes back', async () => {
      const supplierId = await newSupplier();
      const { refId } = await received(small(), { counterpartyId: supplierId });
      const stock = await onHand(barley);
      const { transactions: [money] } = await recorded(refId);
      expect(await owed(supplierId)).toBe(3_300_000);

      expect((await voidEntry(money.id)).status).toBe(200);
      expect(await owed(supplierId)).toBe(0);
      expect(await onHand(barley)).toBe(stock);
      expect((await listed(refId)).value).toBe(3_300_000);
    });

    it('the void stays with a second person', async () => {
      const { refId } = await received();
      const { transactions: [money] } = await recorded(refId);
      const own = await accountant.post(`/finance/transactions/${money.id}/void`, { reason: 'Xato' });
      expect(own.status).toBe(403);
      expect(own.body.error.code).toBe('SAME_MAKER_CHECKER');
      expect(await listed(refId)).toBeUndefined();
    });

    it('cannot be changed in the journal, because its amount is the value of the receipt', async () => {
      const { refId } = await received(large());
      const { transactions: [money] } = await recorded(refId);
      expect((await accountant.patch(`/finance/transactions/${money.id}`, { amount: 1 })).body.error.code).toBe('TRANSACTION_HAS_SOURCE');
      expect((await accountant.delete(`/finance/transactions/${money.id}`)).body.error.code).toBe('TRANSACTION_HAS_SOURCE');
    });
  });

  describe('stock and money stay together', () => {
    it('a receipt with money on it cannot be reversed until the money is cancelled', async () => {
      const { refId, docNo } = await received();
      const { transactions: [money] } = await recorded(refId);

      const refused = await owner.post(`/inventory/documents/${docNo}/reverse`);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('DOCUMENT_HAS_PAYMENT');

      expect((await voidEntry(money.id)).status).toBe(200);
      expect((await owner.post(`/inventory/documents/${docNo}/reverse`)).status).toBe(200);
      expect(await listed(refId)).toBeUndefined();
    });

    it('money waiting for approval holds the receipt too', async () => {
      const { refId, docNo } = await received(large());
      await recorded(refId);
      expect((await owner.post(`/inventory/documents/${docNo}/reverse`)).body.error.code).toBe('DOCUMENT_HAS_PAYMENT');
    });

    it('cannot be recorded twice', async () => {
      const { refId, docNo } = await received();
      await recorded(refId);
      const twice = await record(refId, paidInCash());
      expect(twice.status).toBe(409);
      expect(twice.body.error).toMatchObject({ code: 'RECEIPT_HAS_MONEY', details: { docNo } });
      expect(await moneyOf(refId)).toHaveLength(1);
    });

    it('two people at the same moment record it once', async () => {
      const { refId } = await received();
      const results = await Promise.all([record(refId, onCredit), record(refId, paidInCash(), owner)]);
      expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
      expect(await moneyOf(refId)).toHaveLength(1);
    });

    it('an entry and a reversal at the same moment: goods and money never part', async () => {
      const { refId, docNo } = await received();
      const [entry, reversal] = await Promise.all([record(refId, onCredit), owner.post(`/inventory/documents/${docNo}/reverse`)]);
      expect([entry.status === 201, reversal.status === 200].filter(Boolean)).toHaveLength(1);
      const money = await moneyOf(refId);
      const goods = (await accountant.get('/inventory/movements', { docNo })).data;
      expect(money.length > 0).toBe(goods.length > 0);
    });
  });

  describe('what cannot be recorded', () => {
    it('an item with no default category needs one chosen, and nothing stays behind', async () => {
      const product = await item(owner, { name: unique('Tayyor mahsulot'), category: 'product' });
      const { refId } = await received([{ itemId: product, qty: 1, unitCost: 5000 }]);
      const missing = await record(refId, onCredit);
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe('CATEGORY_REQUIRED');
      expect(await moneyOf(refId)).toEqual([]);

      const categories = (await accountant.get('/finance/categories', { kind: 'expense' })).data;
      await recorded(refId, { ...onCredit, categoryId: categories[0].id });
      expect((await moneyOf(refId))[0].categoryId).toBe(categories[0].id);
    });

    it('an income category is not an answer', async () => {
      const product = await item(owner, { name: unique('Tayyor mahsulot'), category: 'product' });
      const { refId } = await received([{ itemId: product, qty: 1, unitCost: 5000 }]);
      const income = (await accountant.get('/finance/categories', { kind: 'income' })).data[0].id;
      expect((await record(refId, { ...onCredit, categoryId: income })).body.error.code).toBe('CATEGORY_REQUIRED');
    });

    it('a payment needs an account', async () => {
      const { refId } = await received();
      const res = await record(refId, { paymentMethod: 'bank' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ACCOUNT_REQUIRED');
      expect(await moneyOf(refId)).toEqual([]);
    });

    it('a receipt with no value has nothing to record', async () => {
      const { refId } = await received([{ itemId: barley, qty: 1, unitCost: 0 }]);
      const res = await record(refId, onCredit);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_AMOUNT');
    });

    it('an unknown receipt is not found', async () => {
      expect((await record('0190a7e2-7b1c-7c3d-8e4f-000000000001', onCredit)).status).toBe(404);
    });

    it('an issue document is not a receipt', async () => {
      const hay = await item(owner, { name: unique('Yem') });
      await received([{ itemId: hay, qty: 10, unitCost: 100 }]);
      await storekeeper.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId: general, lines: [{ itemId: hay, qty: 1 }] });
      const [{ refId }] = await f.run(() =>
        tx().select({ refId: schema.stockMovements.refId }).from(schema.stockMovements).where(sql`type = 'issue' and item_id = ${hay}`),
      );
      expect((await record(refId!, onCredit)).status).toBe(404);
    });
  });

  describe('a purchase priced in dollars', () => {
    const bought = async () => {
      const res = await owner.post('/inventory/receipts', {
        warehouseId: w, date: TODAY, counterpartyId: vendor, currency: 'USD', fxRate: 12_500, lines: [{ itemId: barley, qty: 100, unitCost: 2 }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.data.refId as string;
    };

    it('is recorded at what it put in stock: 100 x 2 x 12 500 = 2 500 000 in so\'m', async () => {
      const refId = await bought();
      expect((await listed(refId)).value).toBe(2_500_000);
      await recorded(refId);
      expect((await moneyOf(refId))[0]).toMatchObject({ amount: 2_500_000, currency: 'UZS', fxRate: 1, amountBase: 2_500_000 });
    });

    it('cannot come straight from a dollar account, and nothing stays behind', async () => {
      const refId = await bought();
      const res = await record(refId, { paymentMethod: 'cash', accountId: dollars });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ACCOUNT_CURRENCY_MISMATCH');
      expect(await moneyOf(refId)).toEqual([]);
      expect(await listed(refId)).toBeDefined();
    });
  });
});

describe('money stays hidden without finance.view', () => {
  it('a storekeeper sees quantities but no prices, a director sees both', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const storekeeper = await f.as('storekeeper');
    const director = await f.as('director');
    const w = await warehouse(owner, 'Ombor');
    const i = await item(owner, { name: 'Maxfiy' });

    const received = await storekeeper.post('/inventory/receipts', {
      warehouseId: w,
      date: TODAY,
      source: 'opening',
      lines: [{ itemId: i, qty: 10, unitCost: 5000 }],
    });
    expect(received.status).toBe(201);
    expect(received.data.batches[0].unitCost).toBeNull();

    const costCenterId = await f.run(() => generalCostCenterId());
    await storekeeper.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId, lines: [{ itemId: i, qty: 1 }] });

    const check = async (client: Client, visible: boolean) => {
      const stock = (await client.get('/inventory/stock')).data[0];
      const batch = (await client.get(`/inventory/stock/${i}/batches`)).data[0];
      const move = (await client.get('/inventory/movements')).data[0];
      const store = (await client.get('/inventory/warehouses')).data[0];
      expect(stock.qty).toBe(9);
      expect(move.qty).toBe(1);
      if (visible) {
        expect(stock.value).toBe(45_000);
        expect(stock.avgCost).toBe(5000);
        expect(batch.unitCost).toBe(5000);
        expect(move.totalCost).toBe(5000);
        expect(store.value).toBe(45_000);
      } else {
        expect(stock.value).toBeNull();
        expect(stock.avgCost).toBeNull();
        expect(batch.unitCost).toBeNull();
        expect(move.unitCost).toBeNull();
        expect(move.totalCost).toBeNull();
        expect(store.value).toBeNull();
      }
    };
    await check(storekeeper, false);
    await check(director, true);
  });

  it('a PDF for a storekeeper has no price columns', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Ombor');
    const i = await item(owner, { name: 'Hujjat' });
    const { docNo } = (
      await owner.post('/inventory/receipts', { warehouseId: w, date: TODAY, source: 'opening', lines: [{ itemId: i, qty: 2, unitCost: 777 }] })
    ).data;

    const withMoney = await f.run(() => documentLayout(docNo, 'en'));
    const without = await f.run(() => documentLayout(docNo, 'en'), { permissions: ['inventory.view'] });
    expect(JSON.stringify(withMoney.table)).toContain('777');
    expect(JSON.stringify(without.table)).not.toContain('777');
    expect(without.footer).toEqual([]);
    expect(JSON.stringify(without)).not.toContain('Price');
  });
});

describe('issues, transfers and reversals', () => {
  let f: Fixture;
  let owner: Client;
  let w: string;
  let costCenterId: string;

  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
    w = await warehouse(owner, 'Asosiy');
    costCenterId = await f.run(() => generalCostCenterId());
  });

  async function stocked(name: string, qty = 100, unitCost = 10) {
    const i = await item(owner, { name });
    await owner.post('/inventory/receipts', { warehouseId: w, date: daysAgo(10), source: 'opening', lines: [{ itemId: i, qty, unitCost }] });
    return i;
  }

  const onHand = async (name: string) => (await owner.get('/inventory/items/lookup', { search: name })).data[0].qtyOnHand;

  it('locks the unit once an item has stock, because quantities are plain numbers in it', async () => {
    const fresh = await item(owner, { name: 'Unit free' });
    expect((await owner.patch(`/inventory/items/${fresh}`, { unit: 't' })).status).toBe(200);
    const used = await stocked('Unit used', 253, 2000);
    const res = await owner.patch(`/inventory/items/${used}`, { unit: 't' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ITEM_UNIT_LOCKED');
    expect((await owner.patch(`/inventory/items/${used}`, { unit: 'kg', minQty: 5 })).status).toBe(200);
  });

  it('refuses stock documents dated in the future', async () => {
    const i = await stocked('Future', 10, 10);
    const later = '2099-01-01';
    const lines = [{ itemId: i, qty: 1 }];
    const issue = await owner.post('/inventory/issues', { warehouseId: w, date: later, costCenterId, reason: 'ration', lines });
    expect(issue.body.error.code).toBe('FUTURE_DATE');
    const receipt = await owner.post('/inventory/receipts', { warehouseId: w, date: later, source: 'opening', lines: [{ itemId: i, qty: 1, unitCost: 1 }] });
    expect(receipt.body.error.code).toBe('FUTURE_DATE');
  });

  it('feed written off says nothing about how fast it is eaten', async () => {
    const feedItem = await item(owner, { name: 'Spoiled hay', category: 'feed', unit: 'kg' });
    await owner.post('/inventory/receipts', { warehouseId: w, date: daysAgo(3), source: 'opening', lines: [{ itemId: feedItem, qty: 1000, unitCost: 10 }] });
    await owner.post('/inventory/issues', { warehouseId: w, date: daysAgo(1), costCenterId, reason: 'write_off', lines: [{ itemId: feedItem, qty: 100 }] });
    const row = (await owner.get('/feed/balance')).data.find((r: any) => r.itemId === feedItem);
    expect(row.stockQty).toBe(900);
    expect(row.actualDaily).toBeNull();
  });

  it('charges the issue to the cost center at FIFO cost', async () => {
    const i = await stocked('FIFO', 100, 10);
    await owner.post('/inventory/receipts', { warehouseId: w, date: daysAgo(5), source: 'opening', lines: [{ itemId: i, qty: 100, unitCost: 20 }] });
    const res = await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId, reason: 'ration', lines: [{ itemId: i, qty: 150 }] });
    expect(res.status).toBe(201);
    expect(res.data.docNo).toMatch(/^CT-/);
    const moves = (await owner.get('/inventory/movements', { itemId: i, type: 'issue' })).data;
    expect(moves.reduce((sum: number, m: any) => sum + m.totalCost, 0)).toBe(2000);
    expect(moves[0].costCenterName).toBe('General');
    expect(moves[0].reason).toBe('ration');
    expect(moves[0].createdByName).toContain('owner');
  });

  it('a short line fails the whole document and names what is available', async () => {
    const a = await stocked('Enough', 100);
    const b = await stocked('Not enough', 3);
    const res = await owner.post('/inventory/issues', {
      warehouseId: w,
      date: TODAY,
      costCenterId,
      lines: [
        { itemId: a, qty: 10 },
        { itemId: b, qty: 5 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details).toMatchObject({ itemId: b, requested: 5, available: 3 });
    expect(await onHand('Enough')).toBe(100);
  });

  it('an issue needs a cost center of this farm', async () => {
    const i = await stocked('CC check');
    const foreign = await createFixture();
    const elsewhere = await foreign.run(() => generalCostCenterId());
    const res = await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId: elsewhere, lines: [{ itemId: i, qty: 1 }] });
    expect(res.status).toBe(404);
    const missing = await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, lines: [{ itemId: i, qty: 1 }] });
    expect(missing.status).toBe(400);
  });

  it('a transfer moves stock and keeps its cost', async () => {
    const other = await warehouse(owner, 'Ikkinchi');
    const i = await stocked('Moved', 100, 7);
    const res = await owner.post('/inventory/transfers', { fromWarehouseId: w, toWarehouseId: other, date: TODAY, lines: [{ itemId: i, qty: 40 }] });
    expect(res.status).toBe(201);
    expect(res.data.docNo).toMatch(/^KN-/);

    const rows = (await owner.get('/inventory/stock', { search: 'Moved' })).data;
    expect(rows.map((r: any) => [r.warehouseName, r.qty, r.avgCost]).sort()).toEqual([
      ['Asosiy', 60, 7],
      ['Ikkinchi', 40, 7],
    ]);
    expect(await onHand('Moved')).toBe(100);
  });

  it('reverses a receipt and removes its empty batch', async () => {
    const i = await item(owner, { name: 'Mistake' });
    const { docNo } = (await owner.post('/inventory/receipts', { warehouseId: w, date: TODAY, source: 'opening', lines: [{ itemId: i, qty: 9, unitCost: 1 }] })).data;
    expect(await onHand('Mistake')).toBe(9);
    const res = await owner.post(`/inventory/documents/${docNo}/reverse`);
    expect(res.status).toBe(200);
    expect(await onHand('Mistake')).toBe(0);
    expect((await owner.get(`/inventory/stock/${i}/batches`, { all: true })).data).toEqual([]);
    expect((await owner.get('/inventory/movements', { docNo })).data).toEqual([]);
  });

  it('reverses an issue and restores stock', async () => {
    const i = await stocked('Undo issue', 50);
    const { docNo } = (await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId, lines: [{ itemId: i, qty: 20 }] })).data;
    expect(await onHand('Undo issue')).toBe(30);
    expect((await owner.post(`/inventory/documents/${docNo}/reverse`)).status).toBe(200);
    expect(await onHand('Undo issue')).toBe(50);
  });

  it('refuses to reverse a receipt whose stock was already used', async () => {
    const i = await item(owner, { name: 'Used' });
    const { docNo } = (await owner.post('/inventory/receipts', { warehouseId: w, date: TODAY, source: 'opening', lines: [{ itemId: i, qty: 9, unitCost: 1 }] })).data;
    await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId, lines: [{ itemId: i, qty: 1 }] });
    const res = await owner.post(`/inventory/documents/${docNo}/reverse`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BATCH_ALREADY_USED');
  });

  it('refuses to reverse a receipt with a live payment', async () => {
    const vendor = await supplier(owner);
    const i = await item(owner, { name: 'Has payment' });
    const { docNo } = (
      await owner.post('/inventory/receipts', {
        warehouseId: w,
        date: TODAY,
        counterpartyId: vendor,
        lines: [{ itemId: i, qty: 1, unitCost: 1000 }],
        payment: { paymentMethod: 'debt' },
      })
    ).data;
    const res = await owner.post(`/inventory/documents/${docNo}/reverse`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DOCUMENT_HAS_PAYMENT');
  });

  it('only documents from this module can be reversed, and only by those allowed to delete', async () => {
    const i = await stocked('Daily log feed');
    await f.run(() =>
      issueStock({ itemId: i, warehouseId: w, qty: 1, date: TODAY, costCenterId, reason: 'ration', docNo: 'EXT-1', refType: 'daily_log', refId: '0190a7e2-7b1c-7c3d-8e4f-000000000009' }),
    );
    const res = await owner.post('/inventory/documents/EXT-1/reverse');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DOCUMENT_NOT_REVERSIBLE');
    expect((await owner.post('/inventory/documents/NOPE/reverse')).status).toBe(404);

    const storekeeper = await f.as('storekeeper');
    const { docNo } = (await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId, lines: [{ itemId: i, qty: 1 }] })).data;
    expect((await storekeeper.post(`/inventory/documents/${docNo}/reverse`)).status).toBe(403);
  });

  it('filters the journal by type, item, date and document', async () => {
    const i = await stocked('Journal', 10);
    await owner.post('/inventory/issues', { warehouseId: w, date: daysAgo(2), costCenterId, lines: [{ itemId: i, qty: 1 }] });
    await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId, lines: [{ itemId: i, qty: 2 }] });
    const all = await owner.get('/inventory/movements', { itemId: i });
    expect(all.body.meta.total).toBe(3);
    expect(all.data[0].date).toBe(TODAY);
    const issues = await owner.get('/inventory/movements', { itemId: i, type: 'issue', from: daysAgo(3), to: daysAgo(1) });
    expect(issues.data.map((m: any) => m.qty)).toEqual([1]);
    const receipts = await owner.get('/inventory/movements', { itemId: i, type: 'receipt,transfer_in' });
    expect(receipts.body.meta.total).toBe(1);
  });
});

describe('stock moving while a count is open', () => {
  it('books no false surplus, and keeps a difference that was really found', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Ozuqa');
    const stock = async (name: string) => {
      const id = await item(owner, { name });
      await owner.post('/inventory/receipts', { warehouseId: w, date: daysAgo(5), source: 'opening', lines: [{ itemId: id, qty: 100, unitCost: 10 }] });
      return id;
    };
    const untouched = await stock('Untouched');
    const found = await stock('Found short');
    const costCenterId = await f.run(() => generalCostCenterId());
    const count = await owner.post('/inventory/counts', { warehouseId: w, date: TODAY, itemIds: [untouched, found] });
    await owner.patch(`/inventory/counts/${count.data.id}`, { lines: [{ itemId: found, actualQty: 95 }] });

    // 10 kg of each is fed out while the sheet stays open.
    const lines = [{ itemId: untouched, qty: 10 }, { itemId: found, qty: 10 }];
    await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId, reason: 'ration', lines });
    const sheet = (await owner.get(`/inventory/counts/${count.data.id}`)).data.lines;
    expect(sheet.find((l: any) => l.itemId === untouched)).toMatchObject({ systemQty: 90, actualQty: 90, diffQty: 0 });

    expect((await owner.post(`/inventory/counts/${count.data.id}/approve`)).status).toBe(200);
    const onHand = async (id: string) => f.run(() => stockOnHand(id));
    expect(await onHand(untouched)).toBe(90);
    expect(await onHand(found)).toBe(85); // the 5 short that was counted, and the 10 fed out
  });
});

describe('stock counts', () => {
  let f: Fixture;
  let owner: Client;
  let w: string;

  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
    w = await warehouse(owner, 'Sanash');
  });

  async function stocked(name: string, qty = 100, unitCost = 10) {
    const i = await item(owner, { name });
    await owner.post('/inventory/receipts', { warehouseId: w, date: daysAgo(10), source: 'opening', lines: [{ itemId: i, qty, unitCost }] });
    return i;
  }

  it('applies a shortfall and a surplus, and fixes the act', async () => {
    const short = await stocked('Kam', 100, 10);
    const over = await stocked('Ortiq', 50, 4);
    const created = await owner.post('/inventory/counts', { warehouseId: w, date: TODAY, itemIds: [short, over] });
    expect(created.status).toBe(201);
    expect(created.data.status).toBe('draft');
    expect(created.data.docNo).toMatch(/^IA-/);
    expect(created.data.lines.map((l: any) => [l.itemName, l.systemQty, l.actualQty, l.diffQty])).toEqual([
      ['Kam', 100, 100, 0],
      ['Ortiq', 50, 50, 0],
    ]);

    const id = created.data.id;
    const patched = await owner.patch(`/inventory/counts/${id}`, {
      lines: [
        { itemId: short, actualQty: 90 },
        { itemId: over, actualQty: 55 },
      ],
    });
    expect(patched.data.lines.map((l: any) => l.diffQty)).toEqual([-10, 5]);

    const approved = await owner.post(`/inventory/counts/${id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.data.status).toBe('approved');
    expect(approved.data.lines.map((l: any) => [l.diffQty, l.diffCost])).toEqual([
      [-10, -100],
      [5, 20],
    ]);
    expect(approved.data.approvedByName).toContain('owner');

    const stock = (await owner.get('/inventory/items/lookup', { search: 'Kam' })).data[0];
    expect(stock.qtyOnHand).toBe(90);

    const costMoves = (await owner.get('/inventory/movements', { type: 'adjustment_out,adjustment_in', docNo: approved.data.docNo })).data;
    expect(costMoves.every((m: any) => m.costCenterName === 'General')).toBe(true);

    const again = await owner.post(`/inventory/counts/${id}/approve`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('COUNT_NOT_DRAFT');
    expect((await owner.patch(`/inventory/counts/${id}`, { notes: 'x' })).status).toBe(409);
    expect((await owner.delete(`/inventory/counts/${id}`)).status).toBe(409);
  });

  it('measures the difference at approval, not at the time the sheet was opened', async () => {
    const i = await stocked('Moving', 100, 10);
    const id = (await owner.post('/inventory/counts', { warehouseId: w, date: TODAY, itemIds: [i] })).data.id;
    const costCenterId = await f.run(() => generalCostCenterId());
    await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId, lines: [{ itemId: i, qty: 30 }] });
    await owner.patch(`/inventory/counts/${id}`, { lines: [{ itemId: i, actualQty: 68 }] });
    const approved = await owner.post(`/inventory/counts/${id}/approve`);
    expect(approved.data.lines[0]).toMatchObject({ systemQty: 70, actualQty: 68, diffQty: -2 });
  });

  it('a draft shows live book quantities', async () => {
    const i = await stocked('Live', 100, 10);
    const id = (await owner.post('/inventory/counts', { warehouseId: w, date: TODAY, itemIds: [i] })).data.id;
    const costCenterId = await f.run(() => generalCostCenterId());
    await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId, lines: [{ itemId: i, qty: 25 }] });
    expect((await owner.get(`/inventory/counts/${id}`)).data.lines[0]).toMatchObject({ systemQty: 75, actualQty: 75, diffQty: 0 });
  });

  it('counts everything in stock by default and can add a new item', async () => {
    const f2 = await createFixture();
    const o = await f2.as('owner');
    const store = await warehouse(o, 'Yangi');
    const a = await item(o, { name: 'A' });
    const b = await item(o, { name: 'B' });
    await o.post('/inventory/receipts', { warehouseId: store, date: daysAgo(1), source: 'opening', lines: [{ itemId: a, qty: 5, unitCost: 2 }] });
    const count = (await o.post('/inventory/counts', { warehouseId: store, date: TODAY })).data;
    expect(count.lines.map((l: any) => l.itemName)).toEqual(['A']);
    const added = await o.patch(`/inventory/counts/${count.id}`, { lines: [{ itemId: b, actualQty: 3 }] });
    expect(added.data.lines.map((l: any) => [l.itemName, l.systemQty, l.diffQty])).toEqual([
      ['A', 5, 0],
      ['B', 0, 3],
    ]);
    await o.post(`/inventory/counts/${count.id}/approve`);
    expect((await o.get('/inventory/items/lookup', { search: 'B' })).data[0].qtyOnHand).toBe(3);
  });

  it('a count with no lines cannot be approved, and a draft can be deleted', async () => {
    const f2 = await createFixture();
    const o = await f2.as('owner');
    const store = await warehouse(o, 'Bosh');
    const id = (await o.post('/inventory/counts', { warehouseId: store, date: TODAY })).data.id;
    const res = await o.post(`/inventory/counts/${id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COUNT_EMPTY');
    expect((await o.delete(`/inventory/counts/${id}`)).status).toBe(200);
    expect((await o.get(`/inventory/counts/${id}`)).status).toBe(404);
  });

  it('a deleted draft never gives its number to the next count', async () => {
    const f2 = await createFixture();
    const o = await f2.as('owner');
    const store = await warehouse(o, 'Bosh');
    const year = TODAY.slice(0, 4);
    const one = (await o.post('/inventory/counts', { warehouseId: store, date: TODAY })).data;
    expect(one.docNo).toBe(`IA-${year}-0001`);
    expect((await o.delete(`/inventory/counts/${one.id}`)).status).toBe(200);
    const two = (await o.post('/inventory/counts', { warehouseId: store, date: TODAY })).data;
    expect(two.docNo).toBe(`IA-${year}-0002`);

    expect((await o.delete(`/inventory/counts/${two.id}`)).status).toBe(200);
    expect((await o.post('/inventory/counts', { warehouseId: store, date: TODAY })).data.docNo).toBe(`IA-${year}-0003`);
  });

  it('a deleted draft leaves one journal event, and an empty count deleted moves no stock', async () => {
    const f2 = await createFixture();
    const o = await f2.as('owner');
    const store = await warehouse(o, 'Bosh');
    const id = (await o.post('/inventory/counts', { warehouseId: store, date: TODAY })).data.id;
    const { docNo } = (await o.get(`/inventory/counts/${id}`)).data;
    await o.delete(`/inventory/counts/${id}`);
    const written = await f2.run(() => tx().select().from(schema.events).where(eq(schema.events.entityId, id)));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ type: 'stock.document_reversed', entityType: 'stock_count' });
    expect(written[0].data).toMatchObject({ docNo });
  });

  it('the numbering holds across kinds of document, and per farm', async () => {
    const f2 = await createFixture();
    const f3 = await createFixture();
    const o = await f2.as('owner');
    const stranger = await f3.as('owner');
    const store = await warehouse(o, 'Bosh');
    const theirs = await warehouse(stranger, 'Bosh');
    const year = TODAY.slice(0, 4);
    const count = (await o.post('/inventory/counts', { warehouseId: store, date: TODAY })).data;
    await o.delete(`/inventory/counts/${count.id}`);
    // The sequence is shared per farm, and a deleted count keeps its place in it.
    expect((await stranger.post('/inventory/counts', { warehouseId: theirs, date: TODAY })).data.docNo).toBe(`IA-${year}-0001`);
    expect((await o.post('/inventory/counts', { warehouseId: store, date: TODAY })).data.docNo).toBe(`IA-${year}-0002`);
  });

  it('entering a count needs inventory.create, approving needs inventory.update', async () => {
    const i = await stocked('Perm', 10);
    const zootechnician = await f.as('zootechnician');
    const storekeeper = await f.as('storekeeper');
    const id = (await zootechnician.post('/inventory/counts', { warehouseId: w, date: TODAY, itemIds: [i] })).data.id;
    expect((await zootechnician.post(`/inventory/counts/${id}/approve`)).status).toBe(403);
    expect((await storekeeper.post(`/inventory/counts/${id}/approve`)).status).toBe(200);
  });

  it('hides the value of a difference without finance.view', async () => {
    const i = await stocked('Value', 10, 10);
    const storekeeper = await f.as('storekeeper');
    const id = (await storekeeper.post('/inventory/counts', { warehouseId: w, date: TODAY, itemIds: [i] })).data.id;
    await storekeeper.patch(`/inventory/counts/${id}`, { lines: [{ itemId: i, actualQty: 8 }] });
    const approved = await storekeeper.post(`/inventory/counts/${id}/approve`);
    expect(approved.data.lines[0].diffQty).toBe(-2);
    expect(approved.data.lines[0].diffCost).toBeNull();
    expect((await owner.get(`/inventory/counts/${id}`)).data.lines[0].diffCost).toBe(-20);

    const act = await f.run(() => countLayout(id, 'en'), { permissions: ['inventory.view'] });
    expect(act.footer).toEqual([]);
    expect(act.table[0]).toHaveLength(6);
  });
});

describe('expiry and minimums', () => {
  it('lists expired batches first and only those within the window', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Dori', 'vet');
    const drug = await item(owner, { name: 'Dori', category: 'vet_drug', unit: 'vial' });
    const lines = [
      { itemId: drug, qty: 1, unitCost: 1, expiryDate: addDays(TODAY, 20), batchNo: 'soon' },
      { itemId: drug, qty: 1, unitCost: 1, expiryDate: daysAgo(3), batchNo: 'gone' },
      { itemId: drug, qty: 1, unitCost: 1, expiryDate: addDays(TODAY, 200), batchNo: 'later' },
    ];
    await owner.post('/inventory/receipts', { warehouseId: w, date: daysAgo(30), source: 'opening', lines });
    const res = await owner.get('/inventory/stock/expiring', { days: 30 });
    expect(res.data.map((b: any) => [b.batchNo, b.expired])).toEqual([
      ['gone', true],
      ['soon', false],
    ]);
  });

  it('ignores an expired batch that is used up', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Dori', 'vet');
    const drug = await item(owner, { name: 'Dori', category: 'vet_drug', unit: 'vial' });
    await owner.post('/inventory/receipts', {
      warehouseId: w,
      date: daysAgo(30),
      source: 'opening',
      lines: [{ itemId: drug, qty: 1, unitCost: 1, expiryDate: daysAgo(3) }],
    });
    const costCenterId = await f.run(() => generalCostCenterId());
    await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId, lines: [{ itemId: drug, qty: 1 }] });
    expect((await owner.get('/inventory/stock/expiring')).data).toEqual([]);
  });

  it('reports items below minimum quantity, including items with no stock at all', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Yoqilgi', 'fuel');
    const diesel = await item(owner, { name: 'Dizel', category: 'fuel', unit: 'l', minQty: 100 });
    await item(owner, { name: 'Moy', category: 'lubricant', unit: 'l', minQty: 5 });
    await item(owner, { name: 'Yetarli', category: 'fuel', unit: 'l', minQty: 1 });
    await owner.post('/inventory/receipts', { warehouseId: w, date: TODAY, source: 'opening', lines: [{ itemId: diesel, qty: 40, unitCost: 1 }] });
    const res = await owner.get('/inventory/stock/low');
    expect(res.data.map((r: any) => [r.name, r.stockQty, r.minQty, r.reason])).toEqual([
      ['Dizel', 40, 100, 'qty'],
      ['Moy', 0, 5, 'qty'],
      ['Yetarli', 0, 1, 'qty'],
    ]);
  });

  it('stock view can include empty items and flags those below minimum', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await item(owner, { name: 'Bosh', minQty: 5 });
    expect((await owner.get('/inventory/stock')).data).toEqual([]);
    const all = await owner.get('/inventory/stock', { includeEmpty: true });
    expect(all.data).toHaveLength(1);
    expect(all.data[0]).toMatchObject({ name: 'Bosh', qty: 0, belowMinimum: true, avgCost: null });
  });
});

describe('PDF documents', () => {
  it('renders each document type in every language', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Asosiy ombor');
    const other = await warehouse(owner, 'Ikkinchi ombor');
    const vendor = await supplier(owner);
    const i = await item(owner, { name: "Bo'g'oz sovliq ozuqasi" });
    const costCenterId = await f.run(() => generalCostCenterId());
    const receipt = await owner.post('/inventory/receipts', {
      warehouseId: w,
      date: TODAY,
      counterpartyId: vendor,
      invoiceNo: 'HF-1',
      lines: [{ itemId: i, qty: 100, unitCost: 2500, batchNo: 'P-1', expiryDate: addDays(TODAY, 100) }],
    });
    const issue = await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId, reason: 'ration', lines: [{ itemId: i, qty: 10 }] });
    const transfer = await owner.post('/inventory/transfers', { fromWarehouseId: w, toWarehouseId: other, date: TODAY, lines: [{ itemId: i, qty: 5 }] });
    const count = await owner.post('/inventory/counts', { warehouseId: w, date: TODAY });

    const paths = [
      `/inventory/documents/${receipt.data.docNo}/pdf`,
      `/inventory/documents/${issue.data.docNo}/pdf`,
      `/inventory/documents/${transfer.data.docNo}/pdf`,
      `/inventory/counts/${count.data.id}/pdf`,
    ];
    const res = await owner.get(paths[0], { lang: 'uz-Cyrl' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain(`${receipt.data.docNo}.pdf`);
    expect(String(res.body).startsWith('%PDF')).toBe(true);
    for (const path of paths) {
      for (const lang of ['uz', 'ru', 'en']) {
        const r = await owner.get(path, { lang });
        expect(r.status).toBe(200);
        expect(String(r.body).startsWith('%PDF')).toBe(true);
      }
    }
  });

  it('builds the receipt order with supplier, invoice and total', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Asosiy ombor');
    const vendor = await supplier(owner);
    const i = await item(owner, { name: 'Beda' });
    const { docNo } = (
      await owner.post('/inventory/receipts', {
        warehouseId: w,
        date: '2026-11-04',
        counterpartyId: vendor,
        invoiceNo: 'HF-1',
        lines: [{ itemId: i, qty: 100, unitCost: 2500 }],
      })
    ).data;
    const layout = await f.run(() => documentLayout(docNo, 'en'));
    expect(layout.title).toBe('Goods receipt order');
    expect(Object.fromEntries(layout.details)).toMatchObject({
      Date: '04.11.2026',
      Warehouse: 'Asosiy ombor',
      Supplier: 'Yem Savdo',
      'Invoice no.': 'HF-1',
    });
    expect(layout.footer).toEqual(['Total: 250,000 UZS']);
  });

  it('shows both warehouses on a transfer note and writes each line once', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Birinchi');
    const other = await warehouse(owner, 'Ikkinchi');
    const i = await item(owner, { name: 'Beda' });
    await owner.post('/inventory/receipts', { warehouseId: w, date: daysAgo(2), source: 'opening', lines: [{ itemId: i, qty: 10, unitCost: 1 }] });
    const { docNo } = (await owner.post('/inventory/transfers', { fromWarehouseId: w, toWarehouseId: other, date: TODAY, lines: [{ itemId: i, qty: 4 }] })).data;
    const layout = await f.run(() => documentLayout(docNo, 'en'));
    expect(Object.fromEntries(layout.details)).toMatchObject({ From: 'Birinchi', To: 'Ikkinchi' });
    expect(layout.table).toHaveLength(2);
  });

  it('prints a stock count correction as the count act', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Birinchi');
    const i = await item(owner, { name: 'Beda' });
    await owner.post('/inventory/receipts', { warehouseId: w, date: daysAgo(2), source: 'opening', lines: [{ itemId: i, qty: 10, unitCost: 1 }] });
    const count = (await owner.post('/inventory/counts', { warehouseId: w, date: TODAY })).data;
    await owner.patch(`/inventory/counts/${count.id}`, { lines: [{ itemId: i, actualQty: 8 }] });
    await owner.post(`/inventory/counts/${count.id}/approve`);
    const layout = await f.run(() => documentLayout(count.docNo, 'en'));
    expect(layout.title).toBe('Stock count act');
    expect((await owner.get(`/inventory/documents/${count.docNo}/pdf`)).status).toBe(200);
  });

  it('an unknown document is a 404, and another tenant cannot print ours', async () => {
    const f = await createFixture();
    const other = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Ombor');
    const i = await item(owner, { name: 'Beda' });
    const { docNo } = (await owner.post('/inventory/receipts', { warehouseId: w, date: TODAY, source: 'opening', lines: [{ itemId: i, qty: 1, unitCost: 1 }] })).data;
    expect((await owner.get('/inventory/documents/NOPE/pdf')).status).toBe(404);
    expect((await (await other.as('owner')).get(`/inventory/documents/${docNo}/pdf`)).status).toBe(404);
  });
});

describe('rations', () => {
  let f: Fixture;
  let owner: Client;
  let w: string;

  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
    w = await warehouse(owner, 'Ozuqa');
  });

  const receive = (itemId: string, qty: number, unitCost: number, date = daysAgo(5)) =>
    owner.post('/inventory/receipts', { warehouseId: w, date, source: 'opening', lines: [{ itemId, qty, unitCost }] });

  it('prices a ration per head per day and per season', async () => {
    const alfalfa = await item(owner, { name: 'Beda narx' });
    const barley = await item(owner, { name: 'Arpa narx' });
    await receive(alfalfa, 1000, 2000);
    await receive(barley, 1000, 4000);
    const id = await rationOf(owner, [
      { itemId: alfalfa, kgPerHeadDay: 1.2 },
      { itemId: barley, kgPerHeadDay: 0.3 },
    ]);
    const ration = (await owner.get(`/feed/rations/${id}`)).data;
    // 1.2 × 2000 + 0.3 × 4000 = 3600 per day; 3600 × 120 winter days = 432 000
    expect(ration.costPerHeadDay).toBe(3600);
    expect(ration.costPerSeason).toBe(432_000);
    expect(ration.seasonDays).toBe(120);
    expect(ration.totalKgPerHeadDay).toBe(1.5);
    expect(ration.lines.find((l: any) => l.itemId === alfalfa)).toMatchObject({ unitCostPerKg: 2000, costPerHeadDay: 2400 });
  });

  it('values feed at the average of what is in stock', async () => {
    const hay = await item(owner, { name: 'Ikki partiya' });
    await receive(hay, 100, 2000);
    await receive(hay, 300, 3000);
    const id = await rationOf(owner, [{ itemId: hay, kgPerHeadDay: 1 }], 'Ikki partiya');
    // (100 × 2000 + 300 × 3000) / 400 = 2750
    expect((await owner.get(`/feed/rations/${id}`)).data.costPerHeadDay).toBe(2750);
  });

  it('falls back to the last price when the stock has run out', async () => {
    const hay = await item(owner, { name: 'Tugagan' });
    await receive(hay, 10, 1000, daysAgo(9));
    await receive(hay, 10, 1500, daysAgo(4));
    const costCenterId = await f.run(() => generalCostCenterId());
    await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId, lines: [{ itemId: hay, qty: 20 }] });
    const id = await rationOf(owner, [{ itemId: hay, kgPerHeadDay: 1 }], 'Tugagan');
    expect((await owner.get(`/feed/rations/${id}`)).data.costPerHeadDay).toBe(1500);
  });

  it('converts tonnes to a price per kg', async () => {
    const hay = await item(owner, { name: 'Tonnada', unit: 't' });
    await receive(hay, 2, 2_000_000);
    const id = await rationOf(owner, [{ itemId: hay, kgPerHeadDay: 1.5 }], 'Tonnada');
    expect((await owner.get(`/feed/rations/${id}`)).data.costPerHeadDay).toBe(3000);
  });

  it('does not show a partial total when one feed has no price', async () => {
    const priced = await item(owner, { name: 'Narxli' });
    const unpriced = await item(owner, { name: 'Narxsiz' });
    await receive(priced, 10, 100);
    const id = await rationOf(owner, [
      { itemId: priced, kgPerHeadDay: 1 },
      { itemId: unpriced, kgPerHeadDay: 1 },
    ], 'Qisman');
    const ration = (await owner.get(`/feed/rations/${id}`)).data;
    expect(ration.costPerHeadDay).toBeNull();
    expect(ration.costPerSeason).toBeNull();
  });

  it('the zootechnician sees ration cost, as the manager of feed', async () => {
    const hay = await item(owner, { name: 'Zootexnik pichani' });
    await receive(hay, 10, 100);
    const id = await rationOf(owner, [{ itemId: hay, kgPerHeadDay: 1 }], 'Ochiq');
    const ration = (await (await f.as('zootechnician')).get(`/feed/rations/${id}`)).data;
    expect(ration.costPerHeadDay).toBe(100);
    expect(ration.lines[0].unitCostPerKg).toBe(100);
  });

  it('hides ration cost from anyone without finance or feed management access', async () => {
    const hay = await item(owner, { name: 'Cho\'pon' });
    await receive(hay, 10, 100);
    const id = await rationOf(owner, [{ itemId: hay, kgPerHeadDay: 1 }], 'Maxfiy');
    for (const role of ['shepherd', 'storekeeper'] as const) {
      const ration = (await (await f.as(role)).get(`/feed/rations/${id}`)).data;
      expect(ration.costPerHeadDay).toBeNull();
      expect(ration.costPerSeason).toBeNull();
      expect(ration.lines[0].unitCostPerKg).toBeNull();
      expect(ration.lines[0].costPerHeadDay).toBeNull();
      expect(ration.lines[0].kgPerHeadDay).toBe(1);
    }
  });

  it('accepts only feed items, each once', async () => {
    const hay = await item(owner, { name: 'Bir marta' });
    const drug = await item(owner, { name: 'Dori emas', category: 'vet_drug', unit: 'vial' });
    const notFeed = await owner.post('/feed/rations', { name: 'X', state: 'pregnant', lines: [{ itemId: drug, kgPerHeadDay: 1 }] });
    expect(notFeed.status).toBe(400);
    expect(notFeed.body.error.code).toBe('NOT_A_FEED_ITEM');
    const twice = await owner.post('/feed/rations', {
      name: 'X',
      state: 'pregnant',
      lines: [
        { itemId: hay, kgPerHeadDay: 1 },
        { itemId: hay, kgPerHeadDay: 2 },
      ],
    });
    expect(twice.status).toBe(400);
    expect(twice.body.error.code).toBe('DUPLICATE_RATION_ITEM');
    const empty = await owner.post('/feed/rations', { name: 'X', state: 'pregnant', lines: [] });
    expect(empty.status).toBe(400);
  });

  it('replaces lines on update and keeps them on a partial update', async () => {
    const a = await item(owner, { name: 'Almashtirish A' });
    const b = await item(owner, { name: 'Almashtirish B' });
    const id = await rationOf(owner, [{ itemId: a, kgPerHeadDay: 1 }], 'Almashtirish');
    const renamed = await owner.patch(`/feed/rations/${id}`, { name: 'Yangi nom' });
    expect(renamed.data.name).toBe('Yangi nom');
    expect(renamed.data.lines).toHaveLength(1);
    const replaced = await owner.patch(`/feed/rations/${id}`, { lines: [{ itemId: b, kgPerHeadDay: 2 }] });
    expect(replaced.data.lines.map((l: any) => [l.itemId, l.kgPerHeadDay])).toEqual([[b, 2]]);
  });

  it('a ration assigned to a herd cannot be archived', async () => {
    const hay = await item(owner, { name: 'Band' });
    const id = await rationOf(owner, [{ itemId: hay, kgPerHeadDay: 1 }], 'Band');
    await herdWith(f, 0, { rationId: id, name: 'Band poda' });
    const res = await owner.delete(`/feed/rations/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RATION_IN_USE');

    const free = await rationOf(owner, [{ itemId: hay, kgPerHeadDay: 1 }], 'Bosh');
    expect((await owner.delete(`/feed/rations/${free}`)).status).toBe(200);
    expect((await owner.get('/feed/rations', { search: 'Bosh' })).data).toEqual([]);
  });

  it('a shepherd reads rations but cannot change them, a zootechnician can', async () => {
    const hay = await item(owner, { name: 'Huquq' });
    const shepherd = await f.as('shepherd');
    const body = { name: 'Huquq', state: 'lamb', lines: [{ itemId: hay, kgPerHeadDay: 1 }] };
    expect((await shepherd.post('/feed/rations', body)).status).toBe(403);
    expect((await (await f.as('zootechnician')).post('/feed/rations', body)).status).toBe(201);
  });
});

describe('feeding plan and feed balance', () => {
  async function balanceFor(owner: Client, name: string) {
    const rows = (await owner.get('/feed/balance')).data;
    return rows.find((r: any) => r.name === name);
  }

  async function setup(stockKg: number, kgPerHead: number, head: number, itemOver: object = {}) {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Ozuqa');
    const hay = await item(owner, { name: 'Beda', ...itemOver });
    await owner.post('/inventory/receipts', { warehouseId: w, date: daysAgo(30), source: 'opening', lines: [{ itemId: hay, qty: stockKg, unitCost: 2000 }] });
    const rationId = await rationOf(owner, [{ itemId: hay, kgPerHeadDay: kgPerHead }]);
    const herdId = await herdWith(f, head, { rationId });
    const costCenterId = await f.run(() => generalCostCenterId());
    const feed = (date: string, qty: number, reason: string = 'ration') =>
      f.run(() => issueStock({ itemId: hay, warehouseId: w, qty, date, costCenterId, reason }));
    return { f, owner, w, hay, rationId, herdId, costCenterId, feed };
  }

  it('plans daily feeding from ration × head, ignoring animals no longer on the farm', async () => {
    const { f, owner, herdId } = await setup(1000, 1.2, 10);
    await f.run(async () => {
      const [gone] = await tx().select().from(animals).where(eq(animals.herdId, herdId)).limit(1);
      await tx().update(animals).set({ status: 'sold' }).where(eq(animals.id, gone.id));
    });
    const plan = (await owner.get('/feed/plan')).data;
    expect(plan.herds).toHaveLength(1);
    expect(plan.herds[0]).toMatchObject({ head: 9, dailyKg: 10.8 });
    expect(plan.herds[0].lines[0]).toMatchObject({ itemName: 'Beda', kgPerHeadDay: 1.2, dailyKg: 10.8 });
    // 10.8 kg × 2000 so'm/kg
    expect(plan.herds[0].costPerDay).toBe(21_600);
  });

  it('names herds with animals but no ration, since they are invisible to the plan', async () => {
    const { f, owner } = await setup(1000, 1, 5);
    await herdWith(f, 3, { name: 'Ratsionsiz' });
    await herdWith(f, 0, { name: "Bo'sh poda" });
    const plan = (await owner.get('/feed/plan')).data;
    expect(plan.withoutRation).toEqual([expect.objectContaining({ herdName: 'Ratsionsiz', head: 3 })]);
  });

  it('hides the daily cost of the plan from a shepherd', async () => {
    const { f } = await setup(1000, 1, 5);
    const shepherd = await f.as('shepherd');
    const plan = (await shepherd.get('/feed/plan')).data;
    expect(plan.herds[0].dailyKg).toBe(5);
    expect(plan.herds[0].costPerDay).toBeNull();
  });

  it('uses the plan until real consumption exists, and says so', async () => {
    const { owner } = await setup(1200, 1.2, 10);
    const row = await balanceFor(owner, 'Beda');
    // 1200 kg / (1.2 × 10) = 100 days
    expect(row).toMatchObject({
      stockQty: 1200,
      plannedDaily: 12,
      actualDaily: null,
      daysByPlan: 100,
      daysByActual: null,
      days: 100,
      basis: 'plan',
      belowMinimum: false,
    });
  });

  it('switches to actual consumption as soon as it exists (acceptance 24.1)', async () => {
    const { owner, feed } = await setup(1200, 1.2, 10);
    for (const n of [4, 3, 2, 1]) await feed(daysAgo(n), 15);
    const row = await balanceFor(owner, 'Beda');
    // 1200 − 4 × 15 = 1140 left. Actual 15 kg/day → 1140 / 15 = 76 days. Plan 12 kg/day → 95 days.
    expect(row).toMatchObject({
      stockQty: 1140,
      plannedDaily: 12,
      actualDaily: 15,
      daysByPlan: 95,
      daysByActual: 76,
      days: 76,
      basis: 'actual',
      actualDaysCovered: 4,
    });
  });

  it('averages seven days of real feeding and ignores older days', async () => {
    const { owner, feed } = await setup(10_000, 1, 10);
    await feed(daysAgo(20), 900);
    for (const n of [7, 6, 5, 4, 3, 2, 1]) await feed(daysAgo(n), 100);
    const row = await balanceFor(owner, 'Beda');
    // Stock 10 000 − 900 − 700 = 8400; actual 100 kg/day → 84 days.
    expect(row).toMatchObject({ stockQty: 8400, actualDaily: 100, days: 84, actualDaysCovered: 7 });
  });

  it('counts only feed eaten: not sales, transfers or stock count corrections', async () => {
    const { owner, w, hay, feed } = await setup(1000, 1, 10);
    await feed(daysAgo(1), 20);
    await feed(daysAgo(1), 300, 'sale');
    const other = await warehouse(owner, 'Boshqa');
    await owner.post('/inventory/transfers', { fromWarehouseId: w, toWarehouseId: other, date: daysAgo(1), lines: [{ itemId: hay, qty: 100 }] });
    const count = (await owner.post('/inventory/counts', { warehouseId: w, date: daysAgo(1), itemIds: [hay] })).data;
    await owner.patch(`/inventory/counts/${count.id}`, { lines: [{ itemId: hay, actualQty: 500 }] });
    await owner.post(`/inventory/counts/${count.id}/approve`);
    const row = await balanceFor(owner, 'Beda');
    expect(row.actualDaily).toBe(20);
    // 1000 − 20 − 300 − 180 (count) = 500 here + 100 moved = 600 in total; 600 / 20 = 30.
    expect(row.stockQty).toBe(600);
    expect(row.daysByActual).toBe(30);
  });

  it('a reversed issue no longer counts as consumption', async () => {
    const { owner, w, hay, costCenterId } = await setup(1000, 1, 10);
    const { docNo } = (await owner.post('/inventory/issues', { warehouseId: w, date: daysAgo(1), costCenterId, reason: 'ration', lines: [{ itemId: hay, qty: 50 }] })).data;
    expect((await balanceFor(owner, 'Beda')).actualDaily).toBe(50);
    await owner.post(`/inventory/documents/${docNo}/reverse`);
    const row = await balanceFor(owner, 'Beda');
    expect(row).toMatchObject({ actualDaily: null, basis: 'plan', stockQty: 1000 });
  });

  it('adds the demand of every herd on the same feed', async () => {
    const { f, owner, rationId } = await setup(2200, 1, 10);
    await herdWith(f, 12, { rationId, name: 'Ikkinchi poda' });
    // 2200 / (1 × 10 + 1 × 12) = 100 days
    expect((await balanceFor(owner, 'Beda')).daysByPlan).toBe(100);
  });

  it('reports feed kept in tonnes in tonnes, with days computed correctly', async () => {
    const { owner } = await setup(2, 1, 10, { unit: 't' });
    const row = await balanceFor(owner, 'Beda');
    // 2 t = 2000 kg, 1 kg × 10 head = 10 kg/day = 0.01 t/day → 200 days
    expect(row).toMatchObject({ stockQty: 2, unit: 't', plannedDaily: 0.01, daysByPlan: 200 });
  });

  it('needs a bale weight to plan bales, and says nothing rather than guess', async () => {
    const without = await setup(10, 1, 10, { unit: 'bale' });
    expect(await balanceFor(without.owner, 'Beda')).toMatchObject({ plannedDaily: null, daysByPlan: null, days: null, basis: null, belowMinimum: false });

    const weighed = await setup(10, 1, 10, { unit: 'bale', kgPerUnit: 20 });
    // 10 bales × 20 kg = 200 kg, 10 kg/day → 20 days; in bales 0.5 per day
    expect(await balanceFor(weighed.owner, 'Beda')).toMatchObject({ plannedDaily: 0.5, daysByPlan: 20, basis: 'plan' });
  });

  it('measures bales eaten without needing their weight', async () => {
    const { owner, feed } = await setup(10, 1, 10, { unit: 'bale' });
    await feed(daysAgo(1), 2);
    expect(await balanceFor(owner, 'Beda')).toMatchObject({ actualDaily: 2, stockQty: 8, days: 4, basis: 'actual' });
  });

  it('warns below the tenant minimum and below an item minimum', async () => {
    const low = await setup(130, 1, 10);
    // 130 / 10 = 13 days, under the default minimum of 14
    expect(await balanceFor(low.owner, 'Beda')).toMatchObject({ days: 13, minDays: 14, belowMinimum: true });

    const fine = await setup(150, 1, 10);
    expect((await balanceFor(fine.owner, 'Beda')).belowMinimum).toBe(false);

    const strict = await setup(150, 1, 10, { minDays: 30 });
    expect(await balanceFor(strict.owner, 'Beda')).toMatchObject({ days: 15, minDays: 30, belowMinimum: true });

    const quantity = await setup(150, 1, 10, { minQty: 200 });
    expect((await balanceFor(quantity.owner, 'Beda')).belowMinimum).toBe(true);
  });

  it('feeds below minimum days appear in lowStock', async () => {
    const { f } = await setup(130, 1, 10);
    const rows = await f.run(() => lowStock());
    expect(rows).toEqual([expect.objectContaining({ name: 'Beda', reason: 'days', days: 13, minDays: 14, minQty: null })]);
  });

  it('feedConsumption gives every day in kg, with real zeros', async () => {
    const { f, feed } = await setup(1000, 1, 10);
    await feed(daysAgo(2), 12);
    await feed(TODAY, 8);
    const rows = await f.run(() => feedConsumption(3));
    expect(rows).toEqual([
      { date: daysAgo(2), qty: 12 },
      { date: daysAgo(1), qty: 0 },
      { date: TODAY, qty: 8 },
    ]);
  });

  it('feedConsumption converts tonnes to kg', async () => {
    const { f, feed } = await setup(2, 1, 10, { unit: 't' });
    await feed(daysAgo(1), 0.5);
    expect((await f.run(() => feedConsumption(2)))[0]).toEqual({ date: daysAgo(1), qty: 500 });
  });

  it('serves consumption over the API, for anyone who can see feed', async () => {
    const { f, feed } = await setup(1000, 1, 10);
    await feed(daysAgo(1), 12);
    const res = await (await f.as('shepherd')).get('/feed/consumption', { days: 2 });
    expect(res.status).toBe(200);
    expect(res.data).toEqual([
      { date: daysAgo(1), qty: 12 },
      { date: TODAY, qty: 0 },
    ]);
  });

  it('feedBalance is usable as a summary function', async () => {
    const { f } = await setup(1200, 1.2, 10);
    const [row] = await f.run(() => feedBalance());
    expect(row.days).toBe(100);
  });
});

describe('winter planner', () => {
  async function setup() {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Ozuqa');
    const alfalfa = await item(owner, { name: 'Beda' });
    const bran = await item(owner, { name: 'Kepak' });
    const receive = (itemId: string, qty: number, unitCost: number) =>
      owner.post('/inventory/receipts', { warehouseId: w, date: daysAgo(5), source: 'opening', lines: [{ itemId, qty, unitCost }] });
    return { f, owner, w, alfalfa, bran, receive };
  }

  it('computes the pilot case: 500 ewes over 120 days (spec 9.3)', async () => {
    const { owner, alfalfa, bran, receive } = await setup();
    await receive(alfalfa, 120_000, 2200);
    await receive(bran, 3000, 2400);
    const rationId = await rationOf(owner, [
      { itemId: alfalfa, kgPerHeadDay: 1.2 },
      { itemId: bran, kgPerHeadDay: 0.1 },
    ]);
    const plan = (await owner.get('/feed/winter-plan', { rationId, head: 500 })).data;
    expect(plan).toMatchObject({ days: 120, head: 500, basis: 'scenario' });

    const byName = Object.fromEntries(plan.rows.map((r: any) => [r.name, r]));
    // 500 × 120 × 1.2 = 72 000 kg, 48 000 kg to spare
    expect(byName.Beda).toMatchObject({ requiredKg: 72_000, stockKg: 120_000, shortageKg: 0, surplusKg: 48_000, dailyKg: 600, coverageDays: 200, purchaseCost: 0 });
    // 500 × 120 × 0.1 = 6000 kg, 3000 short, 3000 × 2400 = 7 200 000; 3000 / 50 = 60 days
    expect(byName.Kepak).toMatchObject({ requiredKg: 6000, stockKg: 3000, shortageKg: 3000, surplusKg: 0, coverageDays: 60, purchaseCost: 7_200_000 });
    expect(byName.Kepak.runsOutOn).toBe(addDays(TODAY, 60));
    expect(plan.totals).toEqual({ requiredKg: 78_000, shortageKg: 3000, purchaseCost: 7_200_000, shortItems: 1 });
  });

  it('turns a shortage of a grown feed into hectares, using the planned yield', async () => {
    const { f, owner, alfalfa, receive } = await setup();
    await receive(alfalfa, 60_000, 2200);
    const crop = await f.run(async () => {
      const [row] = await tx().select().from(crops).where(sql`key = 'alfalfa' and tenant_id = ${f.tenantId}`);
      await tx().update(crops).set({ defaultYieldTHa: '8' }).where(eq(crops.id, row.id));
      return row;
    });
    await owner.patch(`/inventory/items/${alfalfa}`, { cropId: crop.id });
    const rationId = await rationOf(owner, [{ itemId: alfalfa, kgPerHeadDay: 1.2 }]);

    const plan = (await owner.get('/feed/winter-plan', { rationId, head: 500 })).data;
    // 72 000 − 60 000 = 12 000 kg = 12 t at 8 t/ha → 1.5 ha
    expect(plan.rows[0]).toMatchObject({ shortageKg: 12_000, yieldTHa: 8, hectares: 1.5 });
    expect(plan.rows[0].cropName.en).toBe('Alfalfa');
  });

  it('prefers the yield planned for the crop over the default', async () => {
    const { f, owner, alfalfa, receive } = await setup();
    await receive(alfalfa, 60_000, 2200);
    const crop = await f.run(async () => {
      const [row] = await tx().select().from(crops).where(sql`key = 'alfalfa' and tenant_id = ${f.tenantId}`);
      await tx().update(crops).set({ defaultYieldTHa: '8' }).where(eq(crops.id, row.id));
      const [season] = await tx()
        .insert(schema.seasons)
        .values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Kuzgi', kind: 'autumn', startDate: daysAgo(30), endDate: addDays(TODAY, 200) })
        .returning();
      const [field] = await tx()
        .insert(schema.fields)
        .values({ tenantId: f.tenantId, farmId: f.farmId, number: '1', areaHa: 10 })
        .returning();
      await tx()
        .insert(schema.cropPlans)
        .values({ tenantId: f.tenantId, farmId: f.farmId, seasonId: season.id, fieldId: field.id, cropId: row.id, areaHa: 10, expectedYieldTHa: 12 });
      return row;
    });
    await owner.patch(`/inventory/items/${alfalfa}`, { cropId: crop.id });
    const rationId = await rationOf(owner, [{ itemId: alfalfa, kgPerHeadDay: 1.2 }]);
    const plan = (await owner.get('/feed/winter-plan', { rationId, head: 500 })).data;
    // 12 t at 12 t/ha → 1 ha
    expect(plan.rows[0]).toMatchObject({ yieldTHa: 12, hectares: 1 });
  });

  it('gives no hectares when no yield is known, and none when nothing is short', async () => {
    const { f, owner, alfalfa, bran, receive } = await setup();
    await receive(alfalfa, 60_000, 2200);
    await receive(bran, 99_000, 100);
    const crop = await f.run(async () => {
      const [row] = await tx().select().from(crops).where(sql`key = 'alfalfa' and tenant_id = ${f.tenantId}`);
      return row;
    });
    await owner.patch(`/inventory/items/${alfalfa}`, { cropId: crop.id });
    const rationId = await rationOf(owner, [
      { itemId: alfalfa, kgPerHeadDay: 1.2 },
      { itemId: bran, kgPerHeadDay: 0.1 },
    ]);
    const plan = (await owner.get('/feed/winter-plan', { rationId, head: 500 })).data;
    expect(plan.rows.find((r: any) => r.name === 'Beda')).toMatchObject({ shortageKg: 12_000, yieldTHa: null, hectares: null });
    expect(plan.rows.find((r: any) => r.name === 'Kepak').hectares).toBeNull();
  });

  it('plans from the herds on the farm by default, across rations', async () => {
    const { f, owner, alfalfa, receive } = await setup();
    await receive(alfalfa, 1000, 100);
    const ewes = await rationOf(owner, [{ itemId: alfalfa, kgPerHeadDay: 2 }], 'Sovliq');
    const lambs = await rationOf(owner, [{ itemId: alfalfa, kgPerHeadDay: 0.5 }], "Qo'zi");
    await herdWith(f, 10, { rationId: ewes, name: 'A' });
    await herdWith(f, 20, { rationId: lambs, name: 'B' });
    const plan = (await owner.get('/feed/winter-plan', { days: 100 })).data;
    expect(plan).toMatchObject({ days: 100, head: 30, basis: 'herds' });
    // (10 × 2 + 20 × 0.5) × 100 = 3000 kg against 1000
    expect(plan.rows[0]).toMatchObject({ requiredKg: 3000, shortageKg: 2000, dailyKg: 30 });
  });

  it('uses the winter length from tenant settings', async () => {
    const f = await createFixture({ settings: { feed: { winterDays: 90 } } });
    const owner = await f.as('owner');
    const hay = await item(owner, { name: 'Beda' });
    const rationId = await rationOf(owner, [{ itemId: hay, kgPerHeadDay: 1 }]);
    const plan = (await owner.get('/feed/winter-plan', { rationId, head: 10 })).data;
    expect(plan.days).toBe(90);
    expect(plan.rows[0].requiredKg).toBe(900);
  });

  it('does not total a purchase when a short feed has no price', async () => {
    const { owner, alfalfa, bran, receive } = await setup();
    await receive(alfalfa, 10, 1000);
    const rationId = await rationOf(owner, [
      { itemId: alfalfa, kgPerHeadDay: 1 },
      { itemId: bran, kgPerHeadDay: 1 },
    ]);
    const plan = (await owner.get('/feed/winter-plan', { rationId, head: 10 })).data;
    expect(plan.rows.find((r: any) => r.name === 'Kepak')).toMatchObject({ purchaseCost: null, unitCostPerKg: null, stockKg: 0 });
    expect(plan.totals.purchaseCost).toBeNull();
    expect(plan.totals.shortItems).toBe(2);
  });

  it('the zootechnician gets the purchase cost; a zootechnician still has no finance access', async () => {
    const { f, owner, alfalfa, receive } = await setup();
    await receive(alfalfa, 10, 1000);
    const rationId = await rationOf(owner, [{ itemId: alfalfa, kgPerHeadDay: 1 }]);
    const zootechnician = await f.as('zootechnician');
    const plan = (await zootechnician.get('/feed/winter-plan', { rationId, head: 500 })).data;
    expect(plan.rows[0].unitCostPerKg).toBe(1000);
    expect(plan.totals.purchaseCost).toBeGreaterThan(0);
    expect((await zootechnician.get('/finance/accounts')).status).toBe(403);
  });

  it('hides purchase cost from a shepherd and a storekeeper', async () => {
    const { f, owner, alfalfa, receive } = await setup();
    await receive(alfalfa, 10, 1000);
    const rationId = await rationOf(owner, [{ itemId: alfalfa, kgPerHeadDay: 1 }]);
    for (const role of ['shepherd', 'storekeeper'] as const) {
      const plan = (await (await f.as(role)).get('/feed/winter-plan', { rationId, head: 500 })).data;
      expect(plan.rows[0].shortageKg).toBeGreaterThan(0);
      expect(plan.rows[0].unitCostPerKg).toBeNull();
      expect(plan.rows[0].purchaseCost).toBeNull();
      expect(plan.totals.purchaseCost).toBeNull();
    }
  });

  it('a what-if needs both a ration and a head count', async () => {
    const { owner, alfalfa } = await setup();
    const rationId = await rationOf(owner, [{ itemId: alfalfa, kgPerHeadDay: 1 }]);
    const res = await owner.get('/feed/winter-plan', { rationId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SCENARIO_INCOMPLETE');
    expect((await owner.get('/feed/winter-plan', { rationId: '0190a7e2-7b1c-7c3d-8e4f-000000000001', head: 5 })).status).toBe(404);
  });

  it('an investor has no access', async () => {
    const { f } = await setup();
    expect((await (await f.as('investor')).get('/feed/balance')).status).toBe(403);
  });
});

describe('tenant isolation', () => {
  it("another tenant cannot see or use this tenant's stock", async () => {
    const a = await createFixture();
    const b = await createFixture();
    const ownerA = await a.as('owner');
    const ownerB = await b.as('owner');
    const w = await warehouse(ownerA, 'A ombor');
    const i = await item(ownerA, { name: 'A item' });
    await ownerA.post('/inventory/receipts', { warehouseId: w, date: TODAY, source: 'opening', lines: [{ itemId: i, qty: 10, unitCost: 1 }] });
    const rationId = await rationOf(ownerA, [{ itemId: i, kgPerHeadDay: 1 }]);

    expect((await ownerB.get('/inventory/items')).data).toEqual([]);
    expect((await ownerB.get('/inventory/stock')).data).toEqual([]);
    expect((await ownerB.get('/inventory/movements')).data).toEqual([]);
    expect((await ownerB.get('/feed/balance')).data).toEqual([]);
    expect((await ownerB.get(`/feed/rations/${rationId}`)).status).toBe(404);
    expect((await ownerB.get(`/inventory/stock/${i}/batches`)).status).toBe(404);

    const wB = await warehouse(ownerB, 'B ombor');
    const iB = await item(ownerB, { name: 'B item' });
    const into = await ownerB.post('/inventory/receipts', { warehouseId: w, date: TODAY, source: 'opening', lines: [{ itemId: iB, qty: 1, unitCost: 1 }] });
    expect(into.status).toBe(404);
    const ofItem = await ownerB.post('/inventory/receipts', { warehouseId: wB, date: TODAY, source: 'opening', lines: [{ itemId: i, qty: 1, unitCost: 1 }] });
    expect(ofItem.status).toBe(404);
    const ration = await ownerB.post('/feed/rations', { name: 'X', state: 'lamb', lines: [{ itemId: i, kgPerHeadDay: 1 }] });
    expect(ration.status).toBe(404);
  });

  it("foreign keys cannot be used to attach another tenant's records", async () => {
    const a = await createFixture();
    const b = await createFixture();
    const ownerA = await a.as('owner');
    const ownerB = await b.as('owner');
    const vendorA = await supplier(ownerA);
    const warehouseA = await warehouse(ownerA, 'A ombor');
    const itemA = await item(ownerA, { name: 'A item' });
    const accountA = await a.run(async () => {
      const [row] = await tx().insert(accounts).values({ tenantId: a.tenantId, farmId: a.farmId, name: 'A', type: 'cash' }).returning();
      return row.id;
    });
    const categoryA = await a.run(async () => {
      const [row] = await tx().select().from(financeCategories).where(sql`key = 'feed' and tenant_id = ${a.tenantId}`);
      return row.id;
    });

    const w = await warehouse(ownerB, 'B ombor');
    const i = await item(ownerB, { name: 'B item' });
    const vendorB = await supplier(ownerB);
    const receipt = (over: object) => ({ warehouseId: w, date: TODAY, lines: [{ itemId: i, qty: 1, unitCost: 1 }], ...over });

    expect((await ownerB.post('/inventory/receipts', receipt({ counterpartyId: vendorA }))).status).toBe(404);
    const foreignAccount = await ownerB.post(
      '/inventory/receipts',
      receipt({ counterpartyId: vendorB, payment: { paymentMethod: 'cash', accountId: accountA } }),
    );
    expect(foreignAccount.status).toBe(404);
    const foreignCategory = await ownerB.post(
      '/inventory/receipts',
      receipt({ counterpartyId: vendorB, payment: { paymentMethod: 'debt', categoryId: categoryA } }),
    );
    expect(foreignCategory.status).toBe(400);
    expect(foreignCategory.body.error.code).toBe('CATEGORY_REQUIRED');

    expect((await ownerB.patch(`/inventory/items/${i}`, { defaultWarehouseId: warehouseA })).status).toBe(404);
    expect((await ownerB.post('/inventory/counts', { warehouseId: w, date: TODAY, itemIds: [itemA] })).status).toBe(404);
  });
});

describe('printing', () => {
  it('replaces apostrophes the font cannot draw', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Ombor');
    const i = await item(owner, { name: 'Oʻgʻit' });
    const { docNo } = (await owner.post('/inventory/receipts', { warehouseId: w, date: TODAY, source: 'opening', lines: [{ itemId: i, qty: 1, unitCost: 1 }] })).data;
    const res = await owner.get(`/inventory/documents/${docNo}/pdf`, { lang: 'uz' });
    expect(res.status).toBe(200);
  });
});

describe('seed', () => {
  it('creates all warehouses, items, stock and rations', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await f.run(async () => {
      await tx()
        .insert(schema.facilities)
        .values([
          { tenantId: f.tenantId, farmId: f.farmId, type: 'feed_storage', name: SEED.facility.feedStore },
          { tenantId: f.tenantId, farmId: f.farmId, type: 'warehouse', name: SEED.facility.mainStore },
        ]);
    });
    const context: SeedContext = {
      tenantId: f.tenantId,
      farmId: f.farmId,
      users: {} as SeedContext['users'],
      run: (fn) => f.run(fn),
    };
    await seedInventory(context);

    expect((await owner.get('/inventory/warehouses')).body.meta.total).toBe(Object.keys(SEED.warehouse).length);
    expect((await owner.get('/inventory/items', { pageSize: 100 })).body.meta.total).toBe(Object.keys(SEED.item).length);

    const all = (await owner.get('/inventory/items', { pageSize: 100 })).data;
    const names = new Set(all.map((i: any) => i.name));
    for (const name of Object.values(SEED.item)) expect(names.has(name)).toBe(true);

    const qty = (name: string) => all.find((i: any) => i.name === name).qtyOnHand;
    expect(qty(SEED.item.alfalfa)).toBe(120_000);
    expect(qty(SEED.item.straw)).toBe(80_000);
    expect(qty(SEED.item.barley)).toBe(40_000);
    expect(qty(SEED.item.bran)).toBe(3_000);
    expect(qty(SEED.item.cake)).toBe(10_000);
    expect(qty(SEED.item.silage)).toBe(0);

    const rations = (await owner.get('/feed/rations')).data;
    expect(rations.map((r: any) => r.name).sort()).toEqual(Object.values(SEED.ration).sort());
    const pregnant = rations.find((r: any) => r.name === SEED.ration.pregnant);
    expect(pregnant.lines.find((l: any) => l.itemName === SEED.item.alfalfa).kgPerHeadDay).toBe(1.2);
    expect(pregnant.costPerHeadDay).toBeGreaterThan(0);

    // 500 ewes on the pregnant ration: bran and premix are the planned winter shortages.
    const plan = (await owner.get('/feed/winter-plan', { rationId: pregnant.id, head: 500 })).data;
    const short = plan.rows.filter((r: any) => r.shortageKg > 0).map((r: any) => r.name);
    expect(short.sort()).toEqual([SEED.item.bran, SEED.item.premix].sort());

    // Stock must cover 14 days of daily logs without INSUFFICIENT_STOCK.
    for (const row of plan.rows) expect(row.coverageDays).toBeGreaterThan(20);

    const expiring = (await owner.get('/inventory/stock/expiring', { days: 30 })).data;
    expect(expiring.map((b: any) => b.itemName)).toEqual([SEED.item.poxVaccine]);
  });
});

