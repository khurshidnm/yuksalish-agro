/**
 * Where stock and money meet: document numbers, purchases, debts, currency and closed records.
 * Figures are worked out by hand in the comments. Fixture policy: approval from 5 000 000, the
 * two-person rule on, FIFO, USD at 12 500.
 */
import { readFileSync } from 'node:fs';
import { round, todayIso } from '@yap/shared';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { tx, withTenant } from '../src/core/context';
import { activateCostCenter, deactivateCostCenter, ensureCostCenter, generalCostCenterId } from '../src/core/costCenters';
import { adjustStock, issueStock, receiveStock, reverseMovements, stockOnHand, transferStock } from '../src/core/inventory';
import { accountTakesCurrency, assertDebtRemovable, fxRateIsPlausible, postTransaction, rejectTransaction, voidTransactions } from '../src/core/ledger';
import { schema } from '../src/db/client';
import * as assetService from '../src/modules/assets/assets.service';
import { createRentalAct } from '../src/modules/assets/rental.service';
import { removeUsage } from '../src/modules/assets/usage.service';
import * as accountService from '../src/modules/finance/accounts.service';
import { listDebts, settle } from '../src/modules/finance/debts.service';
import { doubleEntry } from '../src/modules/finance/export';
import { cashPosition } from '../src/modules/finance/summary';
import * as loanService from '../src/modules/finance/loans.service';
import * as entries from '../src/modules/finance/transactions.service';
import * as counts from '../src/modules/inventory/counts.service';
import { defaultExpenseCategoryId, nextDocNo, reverseReceipt } from '../src/modules/inventory/stock.service';
import { archiveHerd, createHerd } from '../src/modules/livestock/herds.service';
import * as purchases from '../src/modules/sales/purchases.service';
import { createFixture, type TestResponse } from './helpers';

const { accounts, animals, assets, costCenters, counterparties, events, farms, financeCategories, fxRates, herds, items, species, stockBatches, stockMovements, transactions, warehouses } = schema;

const TODAY = todayIso();
const YEAR = TODAY.slice(0, 4);
const OPENING_CASH = 100_000_000;
const OPENING_USD = 10_000;
const SOME_RECORD = '0190a7e2-7b1c-7c3d-8e4f-000000000001';
const AVERAGE = { inventory: { costingMethod: 'avg' } };

async function world(settings?: Record<string, unknown>) {
  const f = await createFixture(settings ? { settings } : {});
  const base = { tenantId: f.tenantId, farmId: f.farmId };
  const refs = await f.run(async () => {
    const account = async (name: string, type: string, currency: string, openingBalance: number) => {
      const [row] = await tx().insert(accounts).values({ ...base, name, type, currency, openingBalance }).returning();
      return row.id;
    };
    const warehouse = async (name: string) => {
      const [row] = await tx().insert(warehouses).values({ ...base, name, type: 'feed' }).returning();
      return row.id;
    };
    const item = async (name: string, category: string, unit: string) => {
      const [row] = await tx().insert(items).values({ ...base, name, category, unit }).returning();
      return row.id;
    };
    const [supplier] = await tx().insert(counterparties).values({ ...base, name: 'Neft Baza', type: 'supplier' }).returning();
    const [buyer] = await tx().insert(counterparties).values({ ...base, name: 'Xaridor', type: 'buyer' }).returning();
    await tx().insert(fxRates).values({ tenantId: f.tenantId, date: TODAY, currency: 'USD', rate: 12_500 });
    const categories = await tx().select().from(financeCategories).where(eq(financeCategories.tenantId, f.tenantId));
    const category = (key: string) => categories.find((c) => c.key === key)!.id;
    return {
      cash: await account('Kassa', 'cash', 'UZS', OPENING_CASH),
      bank: await account('Bank', 'bank', 'UZS', 500_000_000),
      usd: await account('Dollar seyf', 'cash', 'USD', OPENING_USD),
      usdBank: await account('Dollar bank', 'bank', 'USD', 0),
      store: await warehouse('Ombor'),
      otherStore: await warehouse('Ikkinchi ombor'),
      diesel: await item('Dizel', 'fuel', 'l'),
      barley: await item('Arpa', 'feed', 'kg'),
      wool: await item('Jun', 'product', 'kg'),
      supplier: supplier.id,
      buyer: buyer.id,
      general: await generalCostCenterId(),
      electricity: category('electricity'),
      fuelCategory: category('fuel'),
      feedCategory: category('feed'),
      rentIncome: category('rent_income'),
    };
  });
  return { f, base, owner: await f.as('owner'), director: await f.as('director'), ...refs };
}
type World = Awaited<ReturnType<typeof world>>;

const diesel = (w: World, qty: number, unitCost: number) => ({ itemId: w.diesel, qty, unitCost });
const barley = (w: World, qty: number, unitCost: number) => ({ itemId: w.barley, qty, unitCost });
const paidCash = (w: World) => ({ paymentMethod: 'cash', accountId: w.cash });
/** 400 l x 12 500 = 5 000 000: exactly at the threshold, so the money waits for a second person. */
const large = (w: World) => ({ lines: [diesel(w, 400, 12_500)], payment: paidCash(w) });

const receipt = (w: World, over: object = {}) => ({
  warehouseId: w.store,
  date: TODAY,
  counterpartyId: w.supplier,
  lines: [diesel(w, 100, 15_000)],
  ...over,
});

async function buy(w: World, over: object = {}) {
  const res = await w.owner.post('/inventory/receipts', receipt(w, over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data as { docNo: string; refId: string; batches: { id: string }[]; transactions: { id: string; status: string }[] };
}

async function issueDoc(w: World, qty: number, warehouseId = w.store) {
  const res = await w.owner.post('/inventory/issues', { warehouseId, date: TODAY, costCenterId: w.general, lines: [{ itemId: w.diesel, qty }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data.docNo as string;
}

const issueOf = (w: World, itemId: string, qty: number, warehouseId = w.store) =>
  w.f.run(() => issueStock({ itemId, warehouseId, qty, date: TODAY, costCenterId: w.general, reason: 'manual' }));

async function debtOf(w: World, amount: number) {
  const res = await w.owner.post('/finance/transactions', {
    date: TODAY, type: 'expense', amount, categoryId: w.electricity, costCenterId: w.general, paymentMethod: 'debt', counterpartyId: w.supplier,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data.id as string;
}

async function pay(w: World, amount: number) {
  const res = await w.owner.post('/finance/debts/settle', { counterpartyId: w.supplier, direction: 'payable', amount, date: TODAY, accountId: w.cash });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data.id as string;
}

const reject = (w: World, id: string) => w.director.post(`/finance/transactions/${id}/reject`, { reason: 'xato' });
const voidEntry = (w: World, id: string) => w.director.post(`/finance/transactions/${id}/void`, { reason: 'xato' });

const balance = async (w: World, id: string) => (await w.f.run(cashPosition)).accounts.find((a) => a.id === id)!.balance;
const onHand = (w: World, itemId = w.diesel) => w.f.run(() => stockOnHand(itemId));
const owed = async (w: World) => (await w.f.run(() => listDebts('payable'))).find((d) => d.counterpartyId === w.supplier)?.outstanding ?? 0;
const batchRows = (w: World) => w.f.run(() => tx().select().from(stockBatches));
const movementRows = (w: World) => w.f.run(() => tx().select().from(stockMovements));
/** What the stock report says the warehouse is worth. */
const stockValue = async (w: World, warehouseId?: string) =>
  ((await w.owner.get('/inventory/stock', { warehouseId })).data as { value: number }[]).reduce((sum, row) => sum + row.value, 0);
const issuedCost = async (w: World) =>
  (await movementRows(w)).filter((m) => m.type === 'issue').reduce((sum, m) => sum + m.totalCost, 0);
const exported = async (w: World) => {
  const res = await w.owner.get('/finance/transactions/export.csv');
  expect(res.status).toBe(200);
  return String(res.body).replace(/^﻿/, '').trim().split('\r\n').slice(1).map((line) => line.split(','));
};
const journal = (w: World, type: string) => w.f.run(() => tx().select().from(events).where(eq(events.type, type)));
async function entry(w: World, id: string) {
  const [row] = await w.f.run(() => tx().select().from(transactions).where(eq(transactions.id, id)));
  return row;
}

/** Starts `second` while `first` is still uncommitted, so it has to wait for the outcome. */
async function overlapping(w: World, first: () => Promise<unknown>, second: () => Promise<unknown>): Promise<string> {
  let other: Promise<string> = Promise.resolve('');
  await w.f.run(async () => {
    await first();
    other = w.f.run(second).then(
      () => 'done',
      (error) => error.code,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  return other;
}

describe('document numbers', () => {
  const number = (docNo: string) => Number(docNo.split('-')[2]);

  it('never come back after a reversal, whichever document went', async () => {
    const w = await world();
    const a = await buy(w);
    const b = await buy(w);
    expect(number(b.docNo)).toBe(number(a.docNo) + 1);

    // The newest goes: a count, or a max over what is left, would hand its number out again.
    expect((await w.owner.post(`/inventory/documents/${b.docNo}/reverse`)).status).toBe(200);
    const c = await buy(w);
    expect(number(c.docNo)).toBe(number(b.docNo) + 1);

    expect((await w.owner.post(`/inventory/documents/${a.docNo}/reverse`)).status).toBe(200);
    const d = await buy(w);
    expect(number(d.docNo)).toBe(number(c.docNo) + 1);
  });

  it('hold for issues too', async () => {
    const w = await world();
    await buy(w);
    const first = await issueDoc(w, 1);
    expect((await w.owner.post(`/inventory/documents/${first}/reverse`)).status).toBe(200);
    expect(number(await issueDoc(w, 1))).toBe(number(first) + 1);
  });

  it('compare as numbers, so 10000 follows 9999', async () => {
    const w = await world();
    await w.f.run(async () => {
      for (const no of ['9999', '10000']) {
        await receiveStock({ itemId: w.diesel, warehouseId: w.store, qty: 1, unitCost: 1, date: TODAY, source: 'opening', docNo: `KO-${YEAR}-${no}` });
      }
    });
    expect((await buy(w)).docNo).toBe(`KO-${YEAR}-10001`);
  });

  it('are counted per farm, also within one tenant', async () => {
    const w = await world();
    await buy(w);
    await buy(w);
    expect((await buy(await world())).docNo).toBe(`KO-${YEAR}-0001`);

    const [second] = await w.f.run(() => tx().insert(farms).values({ tenantId: w.f.tenantId, name: 'Ikkinchi ferma' }).returning());
    const docNo = await withTenant({ userId: null, tenantId: w.f.tenantId, farmId: second.id }, () => nextDocNo('receipt', TODAY));
    expect(docNo).toBe(`KO-${YEAR}-0001`);
  });

  it('stay unique when several receipts are saved at once', async () => {
    const w = await world();
    const saved = await Promise.all(Array.from({ length: 5 }, () => w.owner.post('/inventory/receipts', receipt(w))));
    expect(saved.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(saved.map((res) => res.data.docNo)).size).toBe(5);
  });
});

describe('reversing one receipt', () => {
  it('goes by its reference, even when old records share a number', async () => {
    const w = await world();
    const a = await buy(w, { lines: [diesel(w, 100, 15_000)] });
    const b = await buy(w, { lines: [diesel(w, 50, 15_000)] });
    // What an old reversal could leave behind: two documents under one number.
    await w.f.run(() => tx().update(stockMovements).set({ docNo: a.docNo }).where(eq(stockMovements.refId, b.refId)));

    const byNumber = await w.owner.post(`/inventory/documents/${a.docNo}/reverse`);
    expect(byNumber.status).toBe(409);
    expect(byNumber.body.error.code).toBe('DOCUMENT_NUMBER_AMBIGUOUS');
    expect(await onHand(w)).toBe(150);

    await w.f.run(() => reverseReceipt(b.refId));
    expect(await onHand(w)).toBe(100);
    // With the neighbour gone the number is unique again, and it reverses the one that is left.
    expect((await w.owner.post(`/inventory/documents/${a.docNo}/reverse`)).status).toBe(200);
    expect(await onHand(w)).toBe(0);
  });

  it("cannot reach another tenant's receipt", async () => {
    const w = await world();
    const { refId } = await buy(w);
    const other = await world();
    await expect(other.f.run(() => reverseReceipt(refId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await onHand(w)).toBe(100);
  });

  it('refuses a receipt whose money is still live', async () => {
    const w = await world();
    const { refId, transactions: [money] } = await buy(w, { payment: paidCash(w) });
    await expect(w.f.run(() => reverseReceipt(refId))).rejects.toMatchObject({
      code: 'DOCUMENT_HAS_PAYMENT',
      details: { transactionIds: [money.id] },
    });
    expect(await onHand(w)).toBe(100);
  });

  it('takes the stock back once when two reversals arrive together', async () => {
    const w = await world();
    const { refId } = await buy(w);
    const results = await Promise.allSettled([w.f.run(() => reverseReceipt(refId)), w.f.run(() => reverseReceipt(refId))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'NOT_FOUND' } });
    expect(await onHand(w)).toBe(0);
    expect(await journal(w, 'stock.document_reversed')).toHaveLength(1);
  });

  it('restores an issue once when two corrections of its record arrive together', async () => {
    const w = await world();
    await buy(w);
    await w.f.run(() =>
      issueStock({ itemId: w.diesel, warehouseId: w.store, qty: 10, date: TODAY, costCenterId: w.general, reason: 'fuel', refType: 'daily_log', refId: SOME_RECORD }),
    );
    await Promise.all([w.f.run(() => reverseMovements('daily_log', SOME_RECORD)), w.f.run(() => reverseMovements('daily_log', SOME_RECORD))]);
    expect(await onHand(w)).toBe(100);
  });
});

describe('rejecting the money of a stock purchase', () => {
  it('takes the receipt back in the same transaction', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, large(w));
    expect(money.status).toBe('pending');
    expect(await onHand(w)).toBe(400);

    const res = await reject(w, money.id);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ id: money.id, status: 'rejected', rejectedReason: 'xato' });

    expect(await onHand(w)).toBe(0);
    expect(await batchRows(w)).toEqual([]);
    expect(await movementRows(w)).toEqual([]);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
    expect(await journal(w, 'transaction.rejected')).toHaveLength(1);
    expect(await journal(w, 'stock.document_reversed')).toHaveLength(1);
  });

  it('leaves nothing that could reach a cost center', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, large(w));
    await reject(w, money.id);
    await expect(issueOf(w, w.diesel, 400)).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  it('opens no debt when it was bought on credit', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, { lines: [diesel(w, 400, 12_500)], payment: { paymentMethod: 'debt' } });
    expect((await reject(w, money.id)).status).toBe(200);
    expect(await owed(w)).toBe(0);
    expect(await onHand(w)).toBe(0);
  });

  it('is refused once stock was issued, and the money can still be approved', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, large(w));
    await issueDoc(w, 10);

    const res = await reject(w, money.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BATCH_ALREADY_USED');
    expect((await entry(w, money.id)).status).toBe('pending');
    expect(await onHand(w)).toBe(390);

    expect((await w.director.post(`/finance/transactions/${money.id}/approve`)).status).toBe(200);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 5_000_000);
    expect(await onHand(w)).toBe(390);
  });

  it('goes through once the issue that used the stock is reversed', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, large(w));
    const issue = await issueDoc(w, 10);
    expect((await reject(w, money.id)).status).toBe(409);
    expect((await w.owner.post(`/inventory/documents/${issue}/reverse`)).status).toBe(200);
    expect((await reject(w, money.id)).status).toBe(200);
    expect(await onHand(w)).toBe(0);
  });

  it('is refused once stock moved to another warehouse', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, large(w));
    await w.f.run(() => transferStock({ itemId: w.diesel, fromWarehouseId: w.store, toWarehouseId: w.otherStore, qty: 5, date: TODAY }));
    const res = await reject(w, money.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BATCH_ALREADY_USED');
  });

  it('takes a mixed invoice back whole, with the line that was already approved', async () => {
    const w = await world();
    // Fuel 400 l x 12 500 = 5 000 000 and feed 100 kg x 10 000 = 1 000 000 both wait for approval.
    const { transactions: [waiting, approved] } = await buy(w, { lines: [diesel(w, 400, 12_500), barley(w, 100, 10_000)], payment: paidCash(w) });
    expect((await w.director.post(`/finance/transactions/${approved.id}/approve`)).status).toBe(200);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 1_000_000);

    expect((await reject(w, waiting.id)).status).toBe(200);

    expect((await entry(w, waiting.id)).status).toBe('rejected');
    expect((await entry(w, approved.id)).status).toBe('rejected');
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
    expect(await onHand(w)).toBe(0);
    expect(await onHand(w, w.barley)).toBe(0);
    expect(await journal(w, 'transaction.rejected')).toHaveLength(1);
    expect(await journal(w, 'transaction.voided')).toHaveLength(1);
  });

  it('a payment standing on the approved line of a mixed invoice keeps the whole invoice', async () => {
    const w = await world();
    // Fuel 400 l x 12 500 = 5 000 000 and feed 100 kg x 10 000 = 1 000 000, both on debt and both waiting.
    const { transactions: [waiting, feed] } = await buy(w, { lines: [diesel(w, 400, 12_500), barley(w, 100, 10_000)], payment: { paymentMethod: 'debt' } });
    expect((await w.director.post(`/finance/transactions/${feed.id}/approve`)).status).toBe(200);
    await pay(w, 1_000_000);

    const res = await reject(w, waiting.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEBT_ALREADY_SETTLED');
    expect((await entry(w, waiting.id)).status).toBe('pending');
    expect((await entry(w, feed.id)).status).toBe('approved');
    expect(await onHand(w)).toBe(400);
    expect(await onHand(w, w.barley)).toBe(100);
  });

  it('still refuses money whose batch came in on no warehouse document', async () => {
    const w = await world();
    const row = await w.f.run(
      () =>
        postTransaction({
          date: TODAY, type: 'expense', amount: 6_000_000, categoryId: w.fuelCategory, costCenterId: w.general, costTreatment: 'inventory',
          paymentMethod: 'cash', accountId: w.cash, sourceType: 'stock_batch', sourceId: SOME_RECORD,
        }),
      { userId: w.owner.userId },
    );
    expect(row.status).toBe('pending');
    const res = await reject(w, row.id);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('rejected');
  });

  it('stays with the second person: the maker cannot do it, and nothing moves', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, large(w));
    const res = await w.owner.post(`/finance/transactions/${money.id}/reject`, { reason: 'xato' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SAME_MAKER_CHECKER');
    expect(await onHand(w)).toBe(400);
  });

  it('leaves approval as it was: the stock stays and the money moves', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, large(w));
    expect((await w.director.post(`/finance/transactions/${money.id}/approve`)).status).toBe(200);
    expect(await onHand(w)).toBe(400);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 5_000_000);
    expect(await journal(w, 'stock.document_reversed')).toEqual([]);
  });
});

describe('correcting an approved stock purchase', () => {
  it('voids the money and the receipt together', async () => {
    const w = await world();
    // 100 l x 15 000 = 1 500 000, below the threshold.
    const { docNo, transactions: [money] } = await buy(w, { payment: paidCash(w) });
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 1_500_000);

    const res = await voidEntry(w, money.id);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ id: money.id, status: 'rejected', rejectedReason: 'xato' });

    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
    expect(await onHand(w)).toBe(0);
    expect(await batchRows(w)).toEqual([]);
    expect((await w.director.post(`/inventory/documents/${docNo}/reverse`)).status).toBe(404);
  });

  it('voids every money row of a mixed invoice', async () => {
    const w = await world();
    // Fuel 100 l x 15 000 = 1 500 000, feed 100 kg x 10 000 = 1 000 000.
    const { transactions: money } = await buy(w, { lines: [diesel(w, 100, 15_000), barley(w, 100, 10_000)], payment: paidCash(w) });
    expect(money).toHaveLength(2);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 2_500_000);
    expect((await voidEntry(w, money[1].id)).status).toBe(200);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
    expect((await entry(w, money[0].id)).status).toBe('rejected');
    expect(await batchRows(w)).toEqual([]);
  });

  it('is refused once the stock was used, and nothing moves', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, { payment: paidCash(w) });
    await issueDoc(w, 10);
    const res = await voidEntry(w, money.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BATCH_ALREADY_USED');
    expect((await entry(w, money.id)).status).toBe('approved');
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 1_500_000);
    expect(await onHand(w)).toBe(90);
  });

  it('is refused while a payment stands on its debt, and goes through after it is cancelled', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, { payment: { paymentMethod: 'debt' } });
    const payment = await pay(w, 1_500_000);

    const res = await voidEntry(w, money.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEBT_ALREADY_SETTLED');
    expect(await onHand(w)).toBe(100);

    expect((await voidEntry(w, payment)).status).toBe(200);
    expect((await voidEntry(w, money.id)).status).toBe(200);
    expect(await onHand(w)).toBe(0);
    expect(await owed(w)).toBe(0);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
  });

  it('needs a second person with finance.approve', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, { payment: paidCash(w) });
    const byMaker = await w.owner.post(`/finance/transactions/${money.id}/void`, { reason: 'xato' });
    expect(byMaker.status).toBe(403);
    expect(byMaker.body.error.code).toBe('SAME_MAKER_CHECKER');
    expect((await (await w.f.as('storekeeper')).post(`/finance/transactions/${money.id}/void`, { reason: 'xato' })).status).toBe(403);
    expect(await onHand(w)).toBe(100);
  });

  it('leaves entries of other modules with their owners', async () => {
    const w = await world();
    const row = await w.f.run(() =>
      postTransaction({
        date: TODAY, type: 'income', amount: 1_000, categoryId: w.rentIncome, costCenterId: w.general, paymentMethod: 'cash', accountId: w.cash, sourceType: 'sale', sourceId: SOME_RECORD,
      }),
    );
    const res = await voidEntry(w, row.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRANSACTION_HAS_SOURCE');
  });
});

describe('removing a debt document', () => {
  it('is refused only when what stays owed would no longer cover what was paid', async () => {
    const w = await world();
    const small = await debtOf(w, 2_000_000);
    const big = await debtOf(w, 3_000_000);
    await pay(w, 3_000_000);
    expect(await owed(w)).toBe(2_000_000);

    // Without the 3 000 000 only 2 000 000 stays owed, less than the 3 000 000 paid.
    const res = await voidEntry(w, big);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'DEBT_ALREADY_SETTLED',
      details: { counterpartyId: w.supplier, direction: 'payable', settled: 3_000_000, remaining: 2_000_000 },
    });

    // Without the 2 000 000, the 3 000 000 still covers the payment exactly.
    expect((await voidEntry(w, small)).status).toBe(200);
    expect(await owed(w)).toBe(0);
    expect((await voidEntry(w, big)).status).toBe(409);
  });

  it('a payment waiting for approval counts, because approving it later must not strand it', async () => {
    const w = await world();
    // Both at or above the threshold, so the debt needs approving and the payment waits.
    const debt = await debtOf(w, 6_000_000);
    await w.director.post(`/finance/transactions/${debt}/approve`);
    const payment = await pay(w, 6_000_000);
    expect((await entry(w, payment)).status).toBe('pending');

    const res = await voidEntry(w, debt);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEBT_ALREADY_SETTLED');

    expect((await reject(w, payment)).status).toBe(200);
    expect((await voidEntry(w, debt)).status).toBe(200);
  });

  it('looks only at that counterparty and that direction', async () => {
    const w = await world();
    await debtOf(w, 1_000_000);
    await pay(w, 1_000_000);
    const receivable = await w.owner.post('/finance/transactions', {
      date: TODAY, type: 'income', amount: 500_000, categoryId: w.rentIncome, costCenterId: w.general, paymentMethod: 'debt', counterpartyId: w.supplier,
    });
    expect((await voidEntry(w, receivable.data.id)).status).toBe(200);
  });

  it('does not count loan money as a settlement', async () => {
    const w = await world();
    const debt = await debtOf(w, 1_000_000);
    await w.f.run(() =>
      postTransaction({
        date: TODAY, type: 'debt_payment', amount: 1_000_000, paymentMethod: 'cash', accountId: w.cash, counterpartyId: w.supplier, sourceType: 'loan_instalment', sourceId: SOME_RECORD,
      }),
    );
    expect((await voidEntry(w, debt)).status).toBe(200);
  });

  it('can be checked before acting, and the check changes nothing', async () => {
    const w = await world();
    const settled = await debtOf(w, 1_000_000);
    await pay(w, 400_000);
    await expect(w.f.run(() => assertDebtRemovable([settled]))).rejects.toMatchObject({ code: 'DEBT_ALREADY_SETTLED' });
    expect((await entry(w, settled)).status).toBe('approved');
    await expect(w.f.run(() => assertDebtRemovable([]))).resolves.toBeUndefined();

    const open = await debtOf(w, 1_000_000);
    await expect(w.f.run(() => assertDebtRemovable([open]))).resolves.toBeUndefined();
  });

  it('holds for every void in the kernel, including a sale paid on credit', async () => {
    const w = await world();
    await w.f.run(() =>
      postTransaction({
        date: TODAY, type: 'income', amount: 800_000, categoryId: w.rentIncome, costCenterId: w.general, paymentMethod: 'debt', counterpartyId: w.supplier, sourceType: 'sale', sourceId: SOME_RECORD, autoApprove: true,
      }),
    );
    await w.f.run(() => settle({ counterpartyId: w.supplier, direction: 'receivable', amount: 800_000, date: TODAY, accountId: w.cash }));
    await expect(w.f.run(() => voidTransactions({ sourceType: 'sale', sourceId: SOME_RECORD }, 'xato'))).rejects.toMatchObject({ code: 'DEBT_ALREADY_SETTLED' });
  });

  it('a pending debt is not a debt yet, so refusing it strands nothing', async () => {
    const w = await world();
    await debtOf(w, 1_000_000);
    await pay(w, 1_000_000);
    const waiting = await debtOf(w, 6_000_000);
    await expect(w.f.run(() => assertDebtRemovable([waiting]))).resolves.toBeUndefined();
    expect((await reject(w, waiting)).status).toBe(200);
  });

  it('nor does a pending debt cover a payment, so it cannot let the real one go', async () => {
    const w = await world();
    const debt = await debtOf(w, 1_000_000);
    await pay(w, 1_000_000);
    await debtOf(w, 6_000_000);
    expect((await voidEntry(w, debt)).status).toBe(409);
  });

  it('money paid on the spot to the same supplier is no debt, either way', async () => {
    const w = await world();
    const debt = await debtOf(w, 1_000_000);
    await pay(w, 1_000_000);
    const paid = await w.owner.post('/finance/transactions', {
      date: TODAY, type: 'expense', amount: 1_000_000, categoryId: w.electricity, costCenterId: w.general, paymentMethod: 'cash', accountId: w.cash, counterpartyId: w.supplier,
    });
    // It does not stand in for the debt the payment covers.
    expect((await voidEntry(w, debt)).status).toBe(409);
    // And voiding it takes nothing away from that debt.
    expect((await voidEntry(w, paid.data.id)).status).toBe(200);
  });

  it('each supplier stands alone: an open debt with another does not cover this payment', async () => {
    const w = await world();
    const debt = await debtOf(w, 1_000_000);
    await pay(w, 1_000_000);
    const [other] = await w.f.run(() => tx().insert(counterparties).values({ ...w.base, name: 'Boshqa', type: 'supplier' }).returning());
    const theirs = await w.owner.post('/finance/transactions', {
      date: TODAY, type: 'expense', amount: 2_000_000, categoryId: w.electricity, costCenterId: w.general, paymentMethod: 'debt', counterpartyId: other.id,
    });
    expect(theirs.status).toBe(201);
    expect((await voidEntry(w, debt)).status).toBe(409);
  });

  it('each supplier stands alone: a payment to another does not hold this debt', async () => {
    const w = await world();
    const debt = await debtOf(w, 1_000_000);
    const [other] = await w.f.run(() => tx().insert(counterparties).values({ ...w.base, name: 'Boshqa', type: 'supplier' }).returning());
    await w.owner.post('/finance/transactions', {
      date: TODAY, type: 'expense', amount: 500_000, categoryId: w.electricity, costCenterId: w.general, paymentMethod: 'debt', counterpartyId: other.id,
    });
    await w.f.run(() => settle({ counterpartyId: other.id, direction: 'payable', amount: 500_000, date: TODAY, accountId: w.cash }));
    expect((await voidEntry(w, debt)).status).toBe(200);
  });
});

describe('at the same moment', () => {
  const settlement = (w: World, amount: number) => () =>
    settle({ counterpartyId: w.supplier, direction: 'payable', amount, date: TODAY, accountId: w.cash });

  it('two settlements of one debt: the second sees the first and is refused', async () => {
    const w = await world();
    await debtOf(w, 1_000_000);
    expect(await overlapping(w, settlement(w, 1_000_000), settlement(w, 1_000_000))).toBe('AMOUNT_EXCEEDS_DEBT');
    expect(await owed(w)).toBe(0);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 1_000_000);
  });

  it('over HTTP, one debt is never paid twice', async () => {
    const w = await world();
    await debtOf(w, 1_000_000);
    const body = { counterpartyId: w.supplier, direction: 'payable', amount: 1_000_000, date: TODAY, accountId: w.cash };
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all([w.owner.post('/finance/debts/settle', body), w.owner.post('/finance/debts/settle', body)]);
      expect(results.filter((res) => res.status === 201).length).toBeLessThanOrEqual(1);
    }
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 1_000_000);
  });

  it('a settlement and a void: the settlement sees the debt gone', async () => {
    const w = await world();
    const debt = await debtOf(w, 1_000_000);
    expect(await overlapping(w, () => voidTransactions({ id: debt }, 'xato'), settlement(w, 1_000_000))).toBe('AMOUNT_EXCEEDS_DEBT');
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
  });

  it('a void and a settlement: the void sees the payment and is refused', async () => {
    const w = await world();
    const debt = await debtOf(w, 1_000_000);
    expect(await overlapping(w, settlement(w, 1_000_000), () => voidTransactions({ id: debt }, 'xato'))).toBe('DEBT_ALREADY_SETTLED');
    expect((await entry(w, debt)).status).toBe('approved');
  });

  it('two voids, each fine alone, cannot strand a payment together', async () => {
    const w = await world();
    const one = await debtOf(w, 1_000_000);
    const two = await debtOf(w, 1_000_000);
    await pay(w, 1_000_000);
    expect(await overlapping(w, () => voidTransactions({ id: one }, 'xato'), () => voidTransactions({ id: two }, 'xato'))).toBe('DEBT_ALREADY_SETTLED');
    expect(await owed(w)).toBe(0);
    expect((await entry(w, two)).status).toBe('approved');
  });
});

describe('an account moves its own currency', () => {
  it('a so\'m receipt cannot be paid from a dollar account, and nothing stays behind', async () => {
    const w = await world();
    const res = await w.owner.post('/inventory/receipts', receipt(w, { payment: { paymentMethod: 'cash', accountId: w.usd } }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ACCOUNT_CURRENCY_MISMATCH');
    expect(await onHand(w)).toBe(0);
    expect(await batchRows(w)).toEqual([]);
    expect(await balance(w, w.usd)).toBe(OPENING_USD);
  });

  it('a so\'m settlement cannot come from a dollar account', async () => {
    const w = await world();
    await debtOf(w, 4_000_000);
    const res = await w.owner.post('/finance/debts/settle', {
      counterpartyId: w.supplier, direction: 'payable', amount: 1_000_000, currency: 'UZS', date: TODAY, accountId: w.usd,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ACCOUNT_CURRENCY_MISMATCH');
    expect(await balance(w, w.usd)).toBe(OPENING_USD);
    expect(await owed(w)).toBe(4_000_000);
  });

  it('holds in the ledger itself, for any module that posts', async () => {
    const w = await world();
    await expect(
      w.f.run(() =>
        postTransaction({ date: TODAY, type: 'expense', amount: 1_000, categoryId: w.electricity, costCenterId: w.general, paymentMethod: 'cash', accountId: w.usd, autoApprove: true }),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CURRENCY_MISMATCH' });
  });

  it('a foreign amount from a base account moves the base amount, as before', async () => {
    const w = await world();
    const res = await w.owner.post('/finance/transactions', {
      date: TODAY, type: 'expense', amount: 200, currency: 'USD', categoryId: w.electricity, costCenterId: w.general, paymentMethod: 'cash', accountId: w.cash,
    });
    expect(res.status).toBe(201);
    // 200 x 12 500 = 2 500 000.
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 2_500_000);
  });

  it('dollars bought for stock leave the dollar account in dollars', async () => {
    const w = await world();
    // 100 l x 3 USD = 300 USD, 300 x 12 500 = 3 750 000 in the batch.
    const res = await w.owner.post('/inventory/receipts', receipt(w, {
      currency: 'USD', fxRate: 12_500, lines: [diesel(w, 100, 3)], payment: { paymentMethod: 'cash', accountId: w.usd },
    }));
    expect(res.status).toBe(201);
    expect(await balance(w, w.usd)).toBe(OPENING_USD - 300);
    expect((await movementRows(w))[0].totalCost).toBe(3_750_000);
  });

  it('a transfer needs two accounts in one currency', async () => {
    const w = await world();
    const transfer = (accountId: string, toAccountId: string, over: object = {}) =>
      w.owner.post('/finance/transactions', { date: TODAY, type: 'transfer', amount: 100, paymentMethod: 'cash', accountId, toAccountId, ...over });
    const across = await transfer(w.cash, w.usd, { currency: 'USD' });
    expect(across.status).toBe(400);
    expect(across.body.error.code).toBe('ACCOUNT_CURRENCY_MISMATCH');

    expect((await transfer(w.usd, w.usdBank, { currency: 'USD' })).status).toBe(201);
    expect(await balance(w, w.usd)).toBe(OPENING_USD - 100);
    expect(await balance(w, w.usdBank)).toBe(100);
  });

  it('an account of another tenant is not found, whoever posts', async () => {
    const w = await world();
    const other = await world();
    await expect(
      other.f.run(() =>
        postTransaction({ date: TODAY, type: 'expense', amount: 1_000, categoryId: other.electricity, costCenterId: other.general, paymentMethod: 'cash', accountId: w.cash, autoApprove: true }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('gives a draft the same rule to ask with', async () => {
    const w = await world();
    const takes = await w.f.run(async () => [
      accountTakesCurrency('USD', 'USD'),
      accountTakesCurrency('UZS', 'USD'),
      accountTakesCurrency('USD', 'UZS'),
      accountTakesCurrency('USD', 'EUR'),
    ]);
    expect(takes).toEqual([true, true, false, false]);
  });
});

describe('paying a debt from a dollar account', () => {
  it('reads the amount in the account\'s own currency when the form sends none', async () => {
    const w = await world();
    await debtOf(w, 2_500_000);
    const res = await w.owner.post('/finance/debts/settle', { counterpartyId: w.supplier, direction: 'payable', amount: 200, date: TODAY, accountId: w.usd });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // 200 x 12 500 = 2 500 000, the whole debt.
    expect(res.data).toMatchObject({ amount: 200, currency: 'USD', fxRate: 12_500, amountBase: 2_500_000 });
    expect(await balance(w, w.usd)).toBe(OPENING_USD - 200);
    expect(await owed(w)).toBe(0);
  });

  it('a so\'m figure typed against a dollar account meets the limit of the debt', async () => {
    const w = await world();
    await debtOf(w, 4_000_000);
    // Read as dollars, 1 000 000 x 12 500 is far beyond the 4 000 000 owed.
    const res = await w.owner.post('/finance/debts/settle', { counterpartyId: w.supplier, direction: 'payable', amount: 1_000_000, date: TODAY, accountId: w.usd });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AMOUNT_EXCEEDS_DEBT');
    expect(await balance(w, w.usd)).toBe(OPENING_USD);
  });

  it('counts at what it comes to in so\'m', async () => {
    const w = await world();
    await debtOf(w, 4_000_000);
    const res = await w.owner.post('/finance/debts/settle', {
      counterpartyId: w.supplier, direction: 'payable', amount: 200, currency: 'USD', date: TODAY, accountId: w.usd,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // 200 x 12 500 = 2 500 000 of the 4 000 000.
    expect(res.data).toMatchObject({ amount: 200, currency: 'USD', amountBase: 2_500_000 });
    expect(await owed(w)).toBe(1_500_000);
    expect(await balance(w, w.usd)).toBe(OPENING_USD - 200);
  });

  it('is limited by the debt in so\'m, not by the dollar figure', async () => {
    const w = await world();
    await debtOf(w, 4_000_000);
    // 400 x 12 500 = 5 000 000, more than the debt, though 400 is a small number.
    const res = await w.owner.post('/finance/debts/settle', {
      counterpartyId: w.supplier, direction: 'payable', amount: 400, currency: 'USD', date: TODAY, accountId: w.usd,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'AMOUNT_EXCEEDS_DEBT', details: { outstanding: 4_000_000 } });
  });

  it('posts no exchange difference: a rate that moved past the debt is refused, not guessed', async () => {
    const w = await world();
    await debtOf(w, 2_500_000);
    // 200 x 12 700 = 2 540 000 against 2 500 000 booked at 12 500.
    const res = await w.owner.post('/finance/debts/settle', {
      counterpartyId: w.supplier, direction: 'payable', amount: 200, currency: 'USD', fxRate: 12_700, date: TODAY, accountId: w.usd,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AMOUNT_EXCEEDS_DEBT');
  });
});

describe('the accounting export', () => {
  it('debits the destination of a transfer and credits its source, whatever method it was entered with', async () => {
    const w = await world();
    const transfer = (accountId: string, toAccountId: string, paymentMethod: string, amount: number) =>
      w.owner.post('/finance/transactions', { date: TODAY, type: 'transfer', amount, paymentMethod, accountId, toAccountId });
    expect((await transfer(w.bank, w.cash, 'bank', 2_000_000)).status).toBe(201);
    expect((await transfer(w.bank, w.cash, 'cash', 700_000)).status).toBe(201);
    expect((await transfer(w.cash, w.bank, 'cash', 300_000)).status).toBe(201);

    const rows = await exported(w);
    const entryOf = (amount: string) => rows.filter((row) => row[7] === amount).map((row) => [row[2], row[3]]);
    expect(entryOf('2000000')).toEqual([['5010', '5110']]);
    expect(entryOf('700000')).toEqual([['5010', '5110']]);
    expect(entryOf('300000')).toEqual([['5110', '5010']]);
  });

  it('knows a card account', () => {
    const row = { type: 'transfer', paymentMethod: 'bank', accountType: 'bank', toAccountType: 'card' };
    expect(doubleEntry(row as never)).toEqual({ debit: '5210', credit: '5110' });
  });

  it('follows the account the money really moved through, not the method it was entered with', async () => {
    const w = await world();
    const money = { date: TODAY, costCenterId: w.general, paymentMethod: 'cash', accountId: w.bank };
    expect((await w.owner.post('/finance/transactions', { ...money, type: 'expense', amount: 1_000_000, categoryId: w.electricity })).status).toBe(201);
    expect((await w.owner.post('/finance/transactions', { ...money, type: 'income', amount: 700_000, categoryId: w.rentIncome })).status).toBe(201);
    await buy(w, { payment: { paymentMethod: 'cash', accountId: w.bank } });
    expect(await balance(w, w.bank)).toBe(500_000_000 - 1_000_000 + 700_000 - 1_500_000);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);

    const rows = await exported(w);
    const entryOf = (amount: string) => rows.filter((row) => row[7] === amount).map((row) => [row[2], row[3]]);
    expect(entryOf('1000000')).toEqual([['2510', '5110']]);
    expect(entryOf('700000')).toEqual([['5110', '9390']]);
    expect(entryOf('1500000')).toEqual([['1000', '5110']]);
  });

  it.each([
    [{ type: 'debt_payment', paymentMethod: 'cash', accountType: 'card' }, '6010', '5210'],
    [{ type: 'debt_receipt', paymentMethod: 'cash', accountType: 'bank' }, '5110', '4010'],
  ])('settles through the real account too: %j', (row, debit, credit) => {
    expect(doubleEntry(row as never)).toEqual({ debit, credit });
  });
});

describe('a closed cost center takes no new costs', () => {
  async function closed(w: World) {
    const herd = await w.f.run(() => createHerd({ name: 'Eski' }));
    await w.f.run(() => archiveHerd(herd.id));
    return herd.costCenterId!;
  }
  const expense = (w: World, costCenterId: string) => ({
    date: TODAY, type: 'expense', amount: 1_000, categoryId: w.electricity, costCenterId, paymentMethod: 'cash', accountId: w.cash,
  });

  it('on a stock issue', async () => {
    const w = await world();
    const costCenterId = await closed(w);
    await buy(w);
    const res = await w.owner.post('/inventory/issues', { warehouseId: w.store, date: TODAY, costCenterId, lines: [{ itemId: w.diesel, qty: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COST_CENTER_CLOSED');
    expect(await onHand(w)).toBe(100);
  });

  it('on a finance entry', async () => {
    const w = await world();
    const res = await w.owner.post('/finance/transactions', expense(w, await closed(w)));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COST_CENTER_CLOSED');
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
  });

  it('on an entry moved there while it waits', async () => {
    const w = await world();
    const costCenterId = await closed(w);
    const row = await w.owner.post('/finance/transactions', { ...expense(w, w.general), amount: 6_000_000 });
    const res = await w.owner.patch(`/finance/transactions/${row.data.id}`, { costCenterId });
    expect(res.body.error.code).toBe('COST_CENTER_CLOSED');
    expect((await entry(w, row.data.id)).costCenterId).toBe(w.general);
  });

  it('still takes a late bill worked out from the record', async () => {
    const w = await world();
    const costCenterId = await closed(w);
    const row = await w.f.run(() =>
      postTransaction({ date: TODAY, type: 'expense', amount: 1_000, categoryId: w.electricity, costCenterId, paymentMethod: 'cash', accountId: w.cash, sourceType: 'rental_act', sourceId: SOME_RECORD }),
    );
    expect(row.costCenterId).toBe(costCenterId);
  });

  it('answers not found for a cost center of another farm', async () => {
    const w = await world();
    const other = await world();
    const res = await w.owner.post('/finance/transactions', expense(w, other.general));
    expect(res.status).toBe(404);
  });
});

describe('closed records stop being cost centers', () => {
  const activeOf = async (w: World, id: string) => {
    const [row] = await w.f.run(() => tx().select({ active: costCenters.active }).from(costCenters).where(eq(costCenters.id, id)));
    return row.active;
  };

  it('archiving a herd closes its cost center and no other', async () => {
    const w = await world();
    const { old, live } = await w.f.run(async () => ({ old: await createHerd({ name: 'Eski' }), live: await createHerd({ name: 'Yangi' }) }));
    await w.f.run(() => archiveHerd(old.id));
    expect(await activeOf(w, old.costCenterId!)).toBe(false);
    expect(await activeOf(w, live.costCenterId!)).toBe(true);
  });

  it('closes the cost center of a herd that never stored its id', async () => {
    const w = await world();
    const { herd, center } = await w.f.run(async () => {
      const [row] = await tx().insert(herds).values({ ...w.base, name: 'Import' }).returning();
      return { herd: row, center: await ensureCostCenter('herd', row.id, row.name) };
    });
    expect((await w.owner.delete(`/livestock/herds/${herd.id}`)).status).toBe(200);
    expect(await activeOf(w, center)).toBe(false);
  });

  it('writing off a machine closes it, and taking the write-off back opens it again', async () => {
    const w = await world();
    const asset = await w.f.run(() => assetService.create({ name: 'MTZ-82', type: 'tractor' }));
    expect(await activeOf(w, asset.costCenterId!)).toBe(true);
    await w.f.run(() => assetService.update(asset.id, { status: 'written_off' }));
    expect(await activeOf(w, asset.costCenterId!)).toBe(false);
    await w.f.run(() => assetService.update(asset.id, { status: 'working' }));
    expect(await activeOf(w, asset.costCenterId!)).toBe(true);
  });

  it('a machine entered as written off never opens', async () => {
    const w = await world();
    const asset = await w.f.run(() => assetService.create({ name: 'Eski kombayn', type: 'tractor', status: 'written_off' }));
    expect(await activeOf(w, asset.costCenterId!)).toBe(false);
  });

  it('other status changes leave a machine open', async () => {
    const w = await world();
    const asset = await w.f.run(() => assetService.create({ name: 'MTZ-80', type: 'tractor' }));
    await w.f.run(() => assetService.update(asset.id, { status: 'repair' }));
    expect(await activeOf(w, asset.costCenterId!)).toBe(true);
  });

  it('the data fix closes what was closed before the services did it', async () => {
    const w = await world();
    const centers = await w.f.run(async () => {
      const herd = async (name: string, status: string) => {
        const [row] = await tx().insert(herds).values({ ...w.base, name, status }).returning();
        return ensureCostCenter('herd', row.id, name);
      };
      const asset = async (name: string, status: string) => {
        const [row] = await tx().insert(assets).values({ ...w.base, name, type: 'tractor', status }).returning();
        return ensureCostCenter('asset', row.id, name);
      };
      return {
        closed: [await herd('Eski', 'archived'), await asset('Eski MTZ', 'written_off')],
        open: [await herd('Yangi', 'active'), await asset('Yangi MTZ', 'working')],
      };
    });

    const client = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
    await client.connect();
    await client.query(readFileSync(new URL('../drizzle/0003_close_cost_centers.sql', import.meta.url), 'utf8'));
    await client.end();

    expect(await Promise.all(centers.closed.map((id) => activeOf(w, id)))).toEqual([false, false]);
    expect(await Promise.all(centers.open.map((id) => activeOf(w, id)))).toEqual([true, true]);
  });
});

/** 100 l x 10 000 = 1 000 000, then 100 l x 30 000 = 3 000 000: 4 000 000 / 200 l = 20 000 a litre. */
async function twoReceipts(settings?: Record<string, unknown>) {
  const w = await world(settings);
  const first = await buy(w, { lines: [diesel(w, 100, 10_000)] });
  const second = await buy(w, { lines: [diesel(w, 100, 30_000)] });
  return { w, first, second };
}

describe('average costing keeps the value that was paid', () => {
  it('an issue plus what stays comes to what was paid', async () => {
    const { w } = await twoReceipts(AVERAGE);
    // 50 l x 20 000 = 1 000 000 leaves 150 l x 20 000 = 3 000 000.
    expect((await issueOf(w, w.diesel, 50)).totalCost).toBe(1_000_000);
    expect(await stockValue(w)).toBe(3_000_000);
  });

  it('takes every batch in proportion, each at its own cost', async () => {
    const { w } = await twoReceipts(AVERAGE);
    const { movements } = await issueOf(w, w.diesel, 50);
    expect(movements.map((m) => [m.qty, m.unitCost, m.totalCost])).toEqual([
      [25, 10_000, 250_000],
      [25, 30_000, 750_000],
    ]);
    expect((await batchRows(w)).map((b) => [b.unitCost, b.qtyRemaining])).toEqual([
      [10_000, 75],
      [30_000, 75],
    ]);
  });

  it('all of the stock issued costs exactly what was paid', async () => {
    const { w } = await twoReceipts(AVERAGE);
    await issueOf(w, w.diesel, 50);
    // The other 150 l x 20 000 = 3 000 000, so 4 000 000 in all.
    expect((await issueOf(w, w.diesel, 150)).totalCost).toBe(3_000_000);
    expect(await issuedCost(w)).toBe(4_000_000);
    expect(await onHand(w)).toBe(0);
  });

  it('holds when the shares do not divide evenly', async () => {
    const w = await world(AVERAGE);
    // 100 l x 10 000 + 200 l x 10 001 = 1 000 000 + 2 000 200 = 3 000 200.
    await buy(w, { lines: [diesel(w, 100, 10_000)] });
    await buy(w, { lines: [diesel(w, 200, 10_001)] });
    for (const qty of [100, 100, 100]) await issueOf(w, w.diesel, qty);
    expect(await issuedCost(w)).toBe(3_000_200);
    expect(await onHand(w)).toBe(0);
  });

  it('a purchase that does not divide into a stored price still comes back in full', async () => {
    const w = await world(AVERAGE);
    // 142.8571 a kg is what the batch keeps of 1 000 000 / 7 000.
    await buy(w, { lines: [barley(w, 7000, 1_000_000 / 7000)] });
    await issueOf(w, w.barley, 3000);
    await issueOf(w, w.barley, 4000);
    expect(await issuedCost(w)).toBe(1_000_000);
  });

  it('a reversed issue puts back exactly what it took', async () => {
    const { w } = await twoReceipts(AVERAGE);
    const issue = await issueDoc(w, 50);
    expect((await w.owner.post(`/inventory/documents/${issue}/reverse`)).status).toBe(200);
    expect(await stockValue(w)).toBe(4_000_000);
    expect((await batchRows(w)).map((b) => b.qtyRemaining)).toEqual([100, 100]);
  });

  it('a transfer carries the value with it', async () => {
    const { w } = await twoReceipts(AVERAGE);
    await w.f.run(() => transferStock({ itemId: w.diesel, fromWarehouseId: w.store, toWarehouseId: w.otherStore, qty: 50, date: TODAY }));
    // 50 l x 20 000 moves, 150 l x 20 000 stays.
    expect(await stockValue(w, w.otherStore)).toBe(1_000_000);
    expect(await stockValue(w, w.store)).toBe(3_000_000);
    expect((await issueOf(w, w.diesel, 50, w.otherStore)).totalCost).toBe(1_000_000);
  });

  it('a stock count that comes up short costs what left', async () => {
    const { w } = await twoReceipts(AVERAGE);
    const count = await w.f.run(() => adjustStock({ itemId: w.diesel, warehouseId: w.store, actualQty: 150, date: TODAY }));
    // 50 l short x 20 000.
    expect(count).toMatchObject({ systemQty: 200, diffQty: -50, diffCost: -1_000_000 });
    expect(await stockValue(w)).toBe(3_000_000);
  });

  it('a confirmed sale takes the same', async () => {
    const w = await world(AVERAGE);
    const accountant = await w.f.as('accountant');
    await w.f.run(async () => {
      await receiveStock({ itemId: w.wool, warehouseId: w.store, qty: 100, unitCost: 10_000, date: TODAY, source: 'opening' });
      await receiveStock({ itemId: w.wool, warehouseId: w.store, qty: 100, unitCost: 30_000, date: TODAY, source: 'opening' });
    });
    const sale = await accountant.post('/sales/orders', {
      date: TODAY, counterpartyId: w.buyer, paymentMethod: 'cash', accountId: w.cash, lines: [{ itemId: w.wool, warehouseId: w.store, qty: 50, price: 40_000 }],
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect((await accountant.post(`/sales/orders/${sale.data.id}/confirm`)).status).toBe(200);
    expect(await issuedCost(w)).toBe(1_000_000);
    expect(await stockValue(w)).toBe(3_000_000);
  });

  it('leaves FIFO taking the oldest batch whole', async () => {
    const { w } = await twoReceipts();
    // 100 l x 10 000 + 50 l x 30 000.
    expect((await issueOf(w, w.diesel, 150)).totalCost).toBe(2_500_000);
    expect((await batchRows(w)).map((b) => b.qtyRemaining)).toEqual([0, 50]);
  });
});

describe('editing an entry that waits', () => {
  const waiting = async (w: World, over: object = {}) => {
    const res = await w.owner.post('/finance/transactions', {
      date: TODAY, type: 'expense', amount: 6_000_000, categoryId: w.electricity, costCenterId: w.general, paymentMethod: 'cash', accountId: w.cash, ...over,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.data as { id: string; status: string };
  };
  const edit = (w: World, id: string, changes: object) => w.owner.patch(`/finance/transactions/${id}`, changes);

  it('a change to dollars takes the dollar rate, not the 1 of a so\'m entry', async () => {
    const w = await world();
    const row = await waiting(w);
    const edited = await edit(w, row.id, { amount: 480, currency: 'USD' });
    // 480 x 12 500 = 6 000 000, not 480.
    expect(edited.status).toBe(200);
    expect(edited.data).toMatchObject({ fxRate: 12_500, amountBase: 6_000_000, status: 'pending' });
  });

  it('through a dollar account it still waits for the second person', async () => {
    const w = await world();
    const row = await waiting(w);
    const edited = await edit(w, row.id, { amount: 480, currency: 'USD', accountId: w.usd });
    expect(edited.data).toMatchObject({ fxRate: 12_500, amountBase: 6_000_000, status: 'pending' });
    expect(await balance(w, w.usd)).toBe(OPENING_USD);
  });

  it('a change between foreign currencies takes the new rate', async () => {
    const w = await world();
    await w.f.run(() => tx().insert(fxRates).values({ tenantId: w.f.tenantId, date: TODAY, currency: 'EUR', rate: 14_000 }));
    const row = await waiting(w, { amount: 500, currency: 'USD' });
    const edited = await edit(w, row.id, { currency: 'EUR' });
    // 500 x 14 000, not 500 x 12 500.
    expect(edited.data).toMatchObject({ fxRate: 14_000, amountBase: 7_000_000 });
  });

  it('a change back to so\'m drops the foreign rate', async () => {
    const w = await world();
    const row = await waiting(w, { amount: 500, currency: 'USD' });
    const edited = await edit(w, row.id, { amount: 6_000_000, currency: 'UZS' });
    expect(edited.data).toMatchObject({ fxRate: 1, amountBase: 6_000_000 });
  });

  it('a rate sent with the change is the one used', async () => {
    const w = await world();
    const row = await waiting(w);
    const edited = await edit(w, row.id, { amount: 480, currency: 'USD', fxRate: 13_000 });
    // 480 x 13 000.
    expect(edited.data).toMatchObject({ fxRate: 13_000, amountBase: 6_240_000 });
  });

  it('a currency with no stored rate needs one, and the entry stays as it was', async () => {
    const w = await world();
    const row = await waiting(w);
    const res = await edit(w, row.id, { currency: 'EUR' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FX_RATE_REQUIRED');
    expect(await entry(w, row.id)).toMatchObject({ currency: 'UZS', amountBase: 6_000_000, status: 'pending' });
  });

  it('an edit that leaves the currency alone keeps a typed rate', async () => {
    const w = await world();
    const row = await waiting(w, { amount: 500, currency: 'USD', fxRate: 13_000 });
    const edited = await edit(w, row.id, { amount: 480 });
    expect(edited.data).toMatchObject({ fxRate: 13_000, amountBase: 6_240_000 });
  });
});

describe('a refused or voided entry stays in the journal as it was', () => {
  const paid = async (w: World, amount = 1_000_000) => {
    const res = await w.owner.post('/finance/transactions', {
      date: TODAY, type: 'expense', amount, categoryId: w.electricity, costCenterId: w.general, paymentMethod: 'cash', accountId: w.cash,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.data.id as string;
  };

  it('an edit does not bring a voided entry back', async () => {
    const w = await world();
    const id = await paid(w);
    expect((await voidEntry(w, id)).status).toBe(200);
    const res = await w.owner.patch(`/finance/transactions/${id}`, { description: 'qayta' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRANSACTION_REJECTED');
    expect((await entry(w, id)).status).toBe('rejected');
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
  });

  it('a voided entry cannot be deleted', async () => {
    const w = await world();
    const id = await paid(w);
    expect((await voidEntry(w, id)).status).toBe(200);
    const res = await w.owner.delete(`/finance/transactions/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRANSACTION_REJECTED');
    expect((await entry(w, id))?.status).toBe('rejected');
  });

  it('the same goes for an entry the second person refused', async () => {
    const w = await world();
    const id = await paid(w, 6_000_000);
    expect((await reject(w, id)).status).toBe(200);
    expect((await w.owner.patch(`/finance/transactions/${id}`, { amount: 5_000_000 })).status).toBe(409);
    expect((await w.owner.delete(`/finance/transactions/${id}`)).status).toBe(409);
    expect(await entry(w, id)).toMatchObject({ status: 'rejected', amountBase: 6_000_000 });
  });

  it('and for a row the assistant recorded and took back', async () => {
    const w = await world();
    const row = await w.f.run(
      () =>
        entries.create(
          { date: TODAY, type: 'expense', amount: 300_000, categoryId: w.electricity, costCenterId: w.general, paymentMethod: 'cash', accountId: w.cash },
          { type: 'ai_proposal', id: SOME_RECORD },
        ),
      { userId: w.owner.userId },
    );
    expect((await voidEntry(w, row.id)).status).toBe(200);
    const res = await w.owner.patch(`/finance/transactions/${row.id}`, { description: 'qayta' });
    expect(res.status).toBe(409);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
  });
});

describe('a typed exchange rate', () => {
  const entered = (w: World, fxRate: number) =>
    w.owner.post('/finance/transactions', {
      date: TODAY, type: 'expense', amount: 1, currency: 'USD', fxRate, categoryId: w.electricity, costCenterId: w.general, paymentMethod: 'cash', accountId: w.usd,
    });

  it('of 1 cannot take millions off a dollar account through a settlement', async () => {
    const w = await world();
    await debtOf(w, 3_000_000);
    const res = await w.owner.post('/finance/debts/settle', {
      counterpartyId: w.supplier, direction: 'payable', amount: 3_000_000, currency: 'USD', fxRate: 1, date: TODAY, accountId: w.usd,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'FX_RATE_OUT_OF_RANGE', details: { currency: 'USD', given: 1, stored: 12_500 } });
    expect(await balance(w, w.usd)).toBe(OPENING_USD);
    expect(await owed(w)).toBe(3_000_000);
  });

  it('nor through a stock purchase, and nothing stays behind', async () => {
    const w = await world();
    const res = await w.owner.post('/inventory/receipts', receipt(w, {
      currency: 'USD', fxRate: 1, lines: [diesel(w, 200, 15_000)], payment: { paymentMethod: 'cash', accountId: w.usd },
    }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FX_RATE_OUT_OF_RANGE');
    expect(await batchRows(w)).toEqual([]);
    expect(await balance(w, w.usd)).toBe(OPENING_USD);
  });

  it('is checked on a receipt with no money too, because it prices the stock', async () => {
    const w = await world();
    const res = await w.owner.post('/inventory/receipts', receipt(w, { currency: 'USD', fxRate: 1, lines: [diesel(w, 100, 3)] }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FX_RATE_OUT_OF_RANGE');
  });

  it.each([
    [25_000, 201],
    [6_250, 201],
    [25_001, 400],
    [6_249, 400],
  ])('%d against a stored 12 500 answers %d', async (rate, status) => {
    const w = await world();
    expect((await entered(w, rate)).status).toBe(status);
  });

  it('gives a draft the same rule to ask with', () => {
    expect([25_000, 6_250, 25_001, 6_249, 1].map((rate) => fxRateIsPlausible(rate, 12_500))).toEqual([true, true, false, false, false]);
  });

  it('stands when no rate is stored, because there is nothing to compare it with', async () => {
    const w = await world();
    const res = await w.owner.post('/finance/transactions', {
      date: TODAY, type: 'expense', amount: 100, currency: 'EUR', fxRate: 14_000, categoryId: w.electricity, costCenterId: w.general, paymentMethod: 'cash', accountId: w.cash,
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ fxRate: 14_000, amountBase: 1_400_000 });
  });
});

describe('a closed account', () => {
  const attempts: [string, (w: World) => Promise<TestResponse>][] = [
    ['a stock purchase', (w) => w.owner.post('/inventory/receipts', receipt(w, { payment: { paymentMethod: 'bank', accountId: w.bank } }))],
    [
      'an expense',
      (w) =>
        w.owner.post('/finance/transactions', {
          date: TODAY, type: 'expense', amount: 1_000, categoryId: w.electricity, costCenterId: w.general, paymentMethod: 'bank', accountId: w.bank,
        }),
    ],
    [
      'a settlement',
      (w) => w.owner.post('/finance/debts/settle', { counterpartyId: w.supplier, direction: 'payable', amount: 1_000, date: TODAY, accountId: w.bank }),
    ],
    ['a transfer out', (w) => w.owner.post('/finance/transactions', { date: TODAY, type: 'transfer', amount: 1_000, paymentMethod: 'bank', accountId: w.bank, toAccountId: w.cash })],
    ['a transfer in', (w) => w.owner.post('/finance/transactions', { date: TODAY, type: 'transfer', amount: 1_000, paymentMethod: 'cash', accountId: w.cash, toAccountId: w.bank })],
  ];

  it.each(attempts)('takes no %s, and nothing stays behind', async (_name, attempt) => {
    const w = await world();
    await debtOf(w, 1_000_000);
    await w.f.run(() => tx().update(accounts).set({ active: false }).where(eq(accounts.id, w.bank)));
    const res = await attempt(w);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_CLOSED');
    expect(await batchRows(w)).toEqual([]);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
    expect(await owed(w)).toBe(1_000_000);
  });
});

describe('a closed account and money that waits', () => {
  it('cannot be approved, and can still be refused', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, { lines: [diesel(w, 400, 12_500)], payment: { paymentMethod: 'bank', accountId: w.bank } });
    expect(money.status).toBe('pending');
    await w.f.run(() => tx().update(accounts).set({ active: false }).where(eq(accounts.id, w.bank)));

    const res = await w.director.post(`/finance/transactions/${money.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_CLOSED');
    expect((await entry(w, money.id)).status).toBe('pending');

    expect((await reject(w, money.id)).status).toBe(200);
    expect(await onHand(w)).toBe(0);
  });

  it('on credit needs no account, so it is approved as usual', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, { lines: [diesel(w, 400, 12_500)], payment: { paymentMethod: 'debt' } });
    await w.f.run(() => tx().update(accounts).set({ active: false }).where(eq(accounts.id, w.bank)));
    expect((await w.director.post(`/finance/transactions/${money.id}/approve`)).status).toBe(200);
    expect(await owed(w)).toBe(5_000_000);
  });
});

describe('an invoice split across categories', () => {
  it('waits for a second person on its total', async () => {
    const w = await world();
    // 200 l x 15 000 + 300 kg x 10 000 = 3 000 000 + 3 000 000 = 6 000 000, over the 5 000 000 threshold.
    const { transactions: money } = await buy(w, { lines: [diesel(w, 200, 15_000), barley(w, 300, 10_000)], payment: paidCash(w) });
    expect(money.map((m) => m.status)).toEqual(['pending', 'pending']);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
  });

  it('counts exactly at the threshold', async () => {
    const w = await world();
    // 100 l x 25 000 + 250 kg x 10 000 = 5 000 000.
    const { transactions: money } = await buy(w, { lines: [diesel(w, 100, 25_000), barley(w, 250, 10_000)], payment: paidCash(w) });
    expect(money.map((m) => m.status)).toEqual(['pending', 'pending']);
  });

  it('a tiyin below it goes straight through', async () => {
    const w = await world();
    // 100 l x 25 000 + 1 kg x 2 499 999.99 = 4 999 999.99.
    const { transactions: money } = await buy(w, { lines: [diesel(w, 100, 25_000), barley(w, 1, 2_499_999.99)], payment: paidCash(w) });
    expect(money.map((m) => m.status)).toEqual(['approved', 'approved']);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 4_999_999.99);
  });

  it('a dollar invoice counts its total in so\'m', async () => {
    const w = await world();
    // 240 + 240 = 480 USD, 480 x 12 500 = 6 000 000, though each row is only 3 000 000.
    const { transactions: money } = await buy(w, {
      currency: 'USD', fxRate: 12_500, lines: [diesel(w, 100, 2.4), barley(w, 100, 2.4)], payment: { paymentMethod: 'cash', accountId: w.usd },
    });
    expect(money.map((m) => m.status)).toEqual(['pending', 'pending']);
  });

  it('each row still carries only its own amount, and both approved move the whole invoice', async () => {
    const w = await world();
    const { transactions: [fuel, feed] } = await buy(w, { lines: [diesel(w, 200, 15_000), barley(w, 300, 10_000)], payment: paidCash(w) });
    expect((await entry(w, fuel.id)).amountBase).toBe(3_000_000);
    expect((await w.director.post(`/finance/transactions/${fuel.id}/approve`)).status).toBe(200);
    expect((await w.director.post(`/finance/transactions/${feed.id}/approve`)).status).toBe(200);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 6_000_000);
    expect(await onHand(w)).toBe(200);
  });
});

describe('a quantity the stock columns cannot hold', () => {
  it('too small to store posts nothing at all', async () => {
    const w = await world();
    const res = await w.owner.post('/inventory/receipts', receipt(w, { lines: [diesel(w, 0.0004, 1_000_000_000)], payment: paidCash(w) }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_QUANTITY');
    expect(await batchRows(w)).toEqual([]);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
  });

  it('too small to issue is refused the same way', async () => {
    const w = await world();
    await buy(w);
    const res = await w.owner.post('/inventory/issues', { warehouseId: w.store, date: TODAY, costCenterId: w.general, lines: [{ itemId: w.diesel, qty: 0.0004 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_QUANTITY');
    expect(await onHand(w)).toBe(100);
  });

  it('the smallest that fits goes through', async () => {
    const w = await world();
    await buy(w, { lines: [diesel(w, 0.001, 1_000_000)] });
    expect(await onHand(w)).toBe(0.001);
  });

  it('more decimals than the column keeps: the stock still costs what the money says', async () => {
    const w = await world();
    // 1.0004 l x 1 000 000 = 1 000 400 paid, for what the column keeps as 1.000 l.
    const { transactions: [money] } = await buy(w, { lines: [diesel(w, 1.0004, 1_000_000)], payment: paidCash(w) });
    expect((await entry(w, money.id)).amountBase).toBe(1_000_400);
    expect(await onHand(w)).toBe(1);
    expect((await movementRows(w))[0].totalCost).toBe(1_000_400);
    expect(await stockValue(w)).toBe(1_000_400);
  });
});

describe('a foreign purchase', () => {
  const dollars = (w: World, over: object) => ({ currency: 'USD', fxRate: 12_500, payment: { paymentMethod: 'cash', accountId: w.usd }, ...over });

  it('costs in stock exactly what the money comes to', async () => {
    const w = await world();
    // 3 l x 33.335 = 100.005 USD, which the money keeps as 100.01, and 100.01 x 12 500 = 1 250 125.
    const { transactions: [money] } = await buy(w, dollars(w, { lines: [diesel(w, 3, 33.335)] }));
    expect(await entry(w, money.id)).toMatchObject({ amount: 100.01, amountBase: 1_250_125 });
    expect((await movementRows(w))[0].totalCost).toBe(1_250_125);
    // The batch keeps a four-decimal unit cost, so the report is right to the tiyin, not beyond.
    expect(round(await stockValue(w), 2)).toBe(1_250_125);
    expect((await issueOf(w, w.diesel, 3)).totalCost).toBe(1_250_125);
  });

  it('two lines of one category add up to the money, rounding included', async () => {
    const w = await world();
    // Each line is 100.01 x 12 512.35 = 1 251 360.1235, but the money is 200.02 x 12 512.35 =
    // 2 502 720.247, kept as 2 502 720.25. Rounding each line would lose a tiyin.
    const { transactions: [money] } = await buy(w, dollars(w, { fxRate: 12_512.35, lines: [diesel(w, 1, 100.01), diesel(w, 1, 100.01)] }));
    expect(await entry(w, money.id)).toMatchObject({ amount: 200.02, amountBase: 2_502_720.25 });
    expect((await movementRows(w)).map((m) => m.totalCost).sort()).toEqual([1_251_360.12, 1_251_360.13]);
  });

  it.each(['usd', 'ABC'])('does not take %s as a currency', async (currency) => {
    const w = await world();
    const res = await w.owner.post('/inventory/receipts', receipt(w, { currency, fxRate: 12_500, lines: [diesel(w, 10, 3)], payment: paidCash(w) }));
    expect(res.status).toBe(400);
    expect(await batchRows(w)).toEqual([]);
  });
});

describe('money cancelled in finance frees the record it came from', () => {
  async function soldAnimal(w: World, amount: number, payment: object = { paymentMethod: 'cash', accountId: w.cash }) {
    const animal = await w.f.run(async () => {
      const herd = await createHerd({ name: 'Sovliqlar' });
      const [sheep] = await tx().select().from(species).where(eq(species.tenantId, w.f.tenantId)).limit(1);
      const [row] = await tx()
        .insert(animals)
        .values({
          ...w.base, tag: 'T-1', speciesId: sheep.id, sex: 'female', category: 'ewe', origin: 'purchased', purchasePrice: 1_500_000, herdId: herd.id, status: 'active', currentWeightKg: 55,
        })
        .returning();
      return row;
    });
    const exit = await w.owner.post('/livestock/exits', {
      animalId: animal.id, type: 'sale', date: TODAY, amount, counterpartyId: w.buyer, liveWeightKg: 50, ...payment,
    });
    expect(exit.status, JSON.stringify(exit.body)).toBe(201);
    return { animalId: animal.id, exitId: exit.data.id as string, moneyId: exit.data.transactionId as string };
  }
  const animalStatus = async (w: World, id: string) => {
    const [row] = await w.f.run(() => tx().select({ status: animals.status }).from(animals).where(eq(animals.id, id)));
    return row.status;
  };
  async function repair(w: World, cost: number) {
    const asset = await w.owner.post('/assets', { name: 'MTZ-82', type: 'tractor' });
    expect(asset.status, JSON.stringify(asset.body)).toBe(201);
    const record = await w.owner.post(`/assets/${asset.data.id}/maintenance`, {
      date: TODAY, type: 'repair', cost, payment: { paymentMethod: 'cash', accountId: w.cash },
    });
    expect(record.status, JSON.stringify(record.body)).toBe(201);
    return { url: `/assets/${asset.data.id}/maintenance/${record.data.id}`, moneyId: record.data.transactionId as string };
  }

  it('an animal sale voided by mistake can then be undone, and the animal is back', async () => {
    const w = await world();
    const { animalId, exitId, moneyId } = await soldAnimal(w, 2_000_000);
    const blocked = await w.owner.delete(`/livestock/exits/${exitId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('EXIT_HAS_TRANSACTION');
    expect(await balance(w, w.cash)).toBe(OPENING_CASH + 2_000_000);

    expect((await voidEntry(w, moneyId)).status).toBe(200);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
    expect((await w.owner.delete(`/livestock/exits/${exitId}`)).status).toBe(200);
    expect(await animalStatus(w, animalId)).toBe('active');
  });

  it('an animal sale refused by the second person can be undone', async () => {
    const w = await world();
    const { animalId, exitId, moneyId } = await soldAnimal(w, 6_000_000);
    expect((await entry(w, moneyId)).status).toBe('pending');
    expect((await reject(w, moneyId)).status).toBe(200);
    expect((await w.owner.delete(`/livestock/exits/${exitId}`)).status).toBe(200);
    expect(await animalStatus(w, animalId)).toBe('active');
  });

  it('a sale on credit with a payment on it stays as it is', async () => {
    const w = await world();
    const { exitId, moneyId } = await soldAnimal(w, 2_000_000, { paymentMethod: 'debt' });
    const paid = await w.owner.post('/finance/debts/settle', { counterpartyId: w.buyer, direction: 'receivable', amount: 500_000, date: TODAY, accountId: w.cash });
    expect(paid.status).toBe(201);
    const res = await voidEntry(w, moneyId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEBT_ALREADY_SETTLED');
    expect((await w.owner.delete(`/livestock/exits/${exitId}`)).body.error.code).toBe('EXIT_HAS_TRANSACTION');
  });

  it('a repair voided by mistake can then be deleted', async () => {
    const w = await world();
    const { url, moneyId } = await repair(w, 900_000);
    expect((await w.owner.delete(url)).body.error.code).toBe('MAINTENANCE_HAS_PAYMENT');
    expect((await voidEntry(w, moneyId)).status).toBe(200);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
    expect((await w.owner.delete(url)).status).toBe(200);
  });

  it('a repair refused by the second person can be deleted', async () => {
    const w = await world();
    const { url, moneyId } = await repair(w, 6_000_000);
    expect((await reject(w, moneyId)).status).toBe(200);
    expect((await w.owner.delete(url)).status).toBe(200);
  });

  it('a rental act voided by mistake can be billed again, and the debt is not doubled', async () => {
    const w = await world();
    const asset = await w.owner.post('/assets', {
      name: 'Kombayn', type: 'combine', rented: true, rentalCounterpartyId: w.supplier, rentalPrice: 450_000, rentalUnit: 'ha',
    });
    expect(asset.status, JSON.stringify(asset.body)).toBe(201);
    const shift = await w.owner.post(`/assets/${asset.data.id}/usage`, { date: TODAY, volumeHa: 2 });
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    const bill = () => w.owner.post(`/assets/${asset.data.id}/rental-act`, { from: TODAY, to: TODAY });

    const act = await bill();
    // 2 ha x 450 000.
    expect(act.data.total).toBe(900_000);
    expect((await bill()).body.error.code).toBe('NOTHING_TO_BILL');

    expect((await voidEntry(w, act.data.lines[0].transactionId)).status).toBe(200);
    expect(await owed(w)).toBe(0);
    expect((await bill()).status).toBe(201);
    expect(await owed(w)).toBe(900_000);
  });

  it('keeps the two-person rule', async () => {
    const w = await world();
    const { exitId, moneyId } = await soldAnimal(w, 2_000_000);
    const res = await w.owner.post(`/finance/transactions/${moneyId}/void`, { reason: 'xato' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SAME_MAKER_CHECKER');
    expect((await w.owner.delete(`/livestock/exits/${exitId}`)).status).toBe(409);
  });

  it('these entries still cannot be edited in finance', async () => {
    const w = await world();
    const { moneyId } = await soldAnimal(w, 6_000_000);
    const res = await w.director.patch(`/finance/transactions/${moneyId}`, { amount: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRANSACTION_HAS_SOURCE');
  });
});

describe('reversing a receipt under average costing', () => {
  it('is refused once a later issue was priced on it', async () => {
    const { w, second } = await twoReceipts(AVERAGE);
    // 50 l x 20 000 = 1 000 000.
    expect((await issueOf(w, w.diesel, 50)).totalCost).toBe(1_000_000);

    await expect(w.f.run(() => reverseReceipt(second.refId))).rejects.toMatchObject({ code: 'AVERAGE_COST_USED' });
    expect(await onHand(w)).toBe(150);
  });

  it('goes through once that issue is reversed', async () => {
    const { w, second } = await twoReceipts(AVERAGE);
    const issue = await issueDoc(w, 50);
    await expect(w.f.run(() => reverseReceipt(second.refId))).rejects.toMatchObject({ code: 'AVERAGE_COST_USED' });
    expect((await w.owner.post(`/inventory/documents/${issue}/reverse`)).status).toBe(200);
    await w.f.run(() => reverseReceipt(second.refId));
    expect(await onHand(w)).toBe(100);
  });

  it('is refused for an issue whose transaction began before the receipt but read it', async () => {
    const w = await world(AVERAGE);
    await buy(w, { lines: [diesel(w, 100, 10_000)] });
    let beginIssue!: () => void;
    const mayIssue = new Promise<void>((resolve) => (beginIssue = resolve));
    let issueOpen!: () => void;
    const open = new Promise<void>((resolve) => (issueOpen = resolve));
    const issuing = w.f.run(async () => {
      await tx().execute(sql`select 1`);
      issueOpen();
      await mayIssue;
      return issueStock({ itemId: w.diesel, warehouseId: w.store, qty: 50, date: TODAY, costCenterId: w.general, reason: 'manual' });
    });
    await open;
    // The clock must move on, or the two transactions could share a start time.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await buy(w, { lines: [diesel(w, 100, 30_000)] });
    beginIssue();
    // 25 l x 10 000 + 25 l x 30 000: this issue is priced on the second receipt.
    expect((await issuing).totalCost).toBe(1_000_000);
    await expect(w.f.run(() => reverseReceipt(second.refId))).rejects.toMatchObject({ code: 'AVERAGE_COST_USED' });
    expect(await onHand(w)).toBe(150);
  });

  it('is not refused by an issue that came before the receipt', async () => {
    const w = await world(AVERAGE);
    await buy(w, { lines: [diesel(w, 100, 10_000)] });
    await issueOf(w, w.diesel, 10);
    const second = await buy(w, { lines: [diesel(w, 100, 30_000)] });
    await w.f.run(() => reverseReceipt(second.refId));
    expect(await onHand(w)).toBe(90);
  });

  it('looks only at that item in that warehouse', async () => {
    const { w, second } = await twoReceipts(AVERAGE);
    await buy(w, { warehouseId: w.otherStore, lines: [diesel(w, 10, 15_000)] });
    await buy(w, { lines: [barley(w, 10, 1_000)] });
    await issueOf(w, w.diesel, 5, w.otherStore);
    await issueOf(w, w.barley, 5);
    await w.f.run(() => reverseReceipt(second.refId));
    expect(await onHand(w)).toBe(105);
  });

  it('counts a transfer out, which carries the average to another warehouse', async () => {
    const { w, second } = await twoReceipts(AVERAGE);
    await w.f.run(() => transferStock({ itemId: w.diesel, fromWarehouseId: w.store, toWarehouseId: w.otherStore, qty: 10, date: TODAY }));
    await expect(w.f.run(() => reverseReceipt(second.refId))).rejects.toMatchObject({ code: 'AVERAGE_COST_USED' });
  });

  it('an issue larger than a batch still costs the average', async () => {
    const { w } = await twoReceipts(AVERAGE);
    // 150 l x 20 000 = 3 000 000, though the first batch alone holds 1 000 000 of value.
    expect((await issueOf(w, w.diesel, 150)).totalCost).toBe(3_000_000);
  });

  it('with FIFO an issue costs its own batch, so the later receipt can still go', async () => {
    const { w, second } = await twoReceipts();
    // 50 l x 10 000 = 500 000, from the first batch at its own cost.
    expect((await issueOf(w, w.diesel, 50)).totalCost).toBe(500_000);
    await w.f.run(() => reverseReceipt(second.refId));
    expect(await onHand(w)).toBe(50);
  });
});

describe('a purchase with no named supplier', () => {
  it('is fine paid on the spot, and no placeholder supplier appears', async () => {
    const w = await world();
    const known = async () => (await w.f.run(() => tx().select().from(counterparties))).length;
    const before = await known();
    const { batches, transactions: [money] } = await buy(w, { counterpartyId: null, payment: paidCash(w) });
    expect((await entry(w, money.id)).counterpartyId).toBeNull();
    expect((await batchRows(w)).find((b) => b.id === batches[0].id)?.counterpartyId).toBeNull();
    expect(await known()).toBe(before);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 1_500_000);
  });

  it.each([
    ['on credit', { payment: { paymentMethod: 'debt' } }],
    ['with no payment', {}],
  ])('needs one %s, because something is owed', async (_name, over) => {
    const w = await world();
    const res = await w.owner.post('/inventory/receipts', receipt(w, { counterpartyId: null, ...over }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('COUNTERPARTY_REQUIRED');
    expect(await batchRows(w)).toEqual([]);
  });
});

describe('links between records', () => {
  const expense = (w: World) => ({
    date: TODAY, type: 'expense' as const, amount: 300_000, categoryId: w.electricity, costCenterId: w.general, paymentMethod: 'cash' as const, accountId: w.cash,
  });
  const fromAssistant = { type: 'ai_proposal', id: SOME_RECORD };

  it('the note of a purchase reaches its money, next to the number and the invoice', async () => {
    const w = await world();
    const { docNo, batches, transactions: [money] } = await buy(w, { invoiceNo: 'INV-7', notes: 'MTZ uchun', payment: paidCash(w) });
    expect(await entry(w, money.id)).toMatchObject({
      description: `${docNo} / INV-7 / MTZ uchun`,
      sourceType: 'stock_batch',
      sourceId: batches[0].id,
    });
  });

  it('with no note or invoice the money carries just the number', async () => {
    const w = await world();
    const { docNo, transactions: [money] } = await buy(w, { payment: paidCash(w) });
    expect((await entry(w, money.id)).description).toBe(docNo);
  });

  it('transactions.create and debts.settle take a source from a caller', async () => {
    const w = await world();
    const row = await w.f.run(() => entries.create(expense(w), fromAssistant));
    expect(row).toMatchObject({ sourceType: 'ai_proposal', sourceId: SOME_RECORD });

    await debtOf(w, 1_000_000);
    const payment = await w.f.run(() => settle({ counterpartyId: w.supplier, direction: 'payable', amount: 400_000, date: TODAY, accountId: w.cash }, fromAssistant));
    expect(payment).toMatchObject({ sourceType: 'ai_proposal', sourceId: SOME_RECORD });
    // A settlement with a source still pays the debt.
    expect(await owed(w)).toBe(600_000);
  });

  it('no source means none', async () => {
    const w = await world();
    expect(await w.f.run(() => entries.create(expense(w)))).toMatchObject({ sourceType: null, sourceId: null });
  });

  it('a client cannot set the source', async () => {
    const w = await world();
    const res = await w.owner.post('/finance/transactions', { ...expense(w), sourceType: 'sale', sourceId: SOME_RECORD });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ sourceType: null, sourceId: null });
  });

  it('an entry the assistant prepared stays finance\'s to void', async () => {
    const w = await world();
    const row = await w.f.run(() => entries.create(expense(w), fromAssistant), { userId: w.owner.userId });
    expect((await voidEntry(w, row.id)).status).toBe(200);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
  });

  it('an entry the assistant prepared can be edited while it waits, and keeps its link', async () => {
    const w = await world();
    const row = await w.f.run(() => entries.create({ ...expense(w), amount: 6_000_000 }, fromAssistant), { userId: w.owner.userId });
    expect(row.status).toBe('pending');
    const edited = await w.director.patch(`/finance/transactions/${row.id}`, { amount: 5_500_000 });
    expect(edited.status).toBe(200);
    expect(edited.data).toMatchObject({ id: row.id, amount: 5_500_000, sourceType: 'ai_proposal', sourceId: SOME_RECORD });
  });
});

describe('an item with no expense category', () => {
  const wool = (w: World) => ({ lines: [{ itemId: w.wool, qty: 50, unitCost: 40_000 }] });

  it('is refused before anything is written, naming the item', async () => {
    const w = await world();
    const res = await w.owner.post('/inventory/receipts', receipt(w, { ...wool(w), payment: paidCash(w) }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'CATEGORY_REQUIRED', details: { itemId: w.wool, itemName: 'Jun' } });
    expect(await batchRows(w)).toEqual([]);
    expect((await buy(w)).docNo).toBe(`KO-${YEAR}-0001`);
  });

  it('goes through when a category is chosen', async () => {
    const w = await world();
    const { transactions: [money] } = await buy(w, { ...wool(w), payment: { ...paidCash(w), categoryId: w.feedCategory } });
    // 50 kg x 40 000 = 2 000 000.
    expect(await entry(w, money.id)).toMatchObject({ categoryId: w.feedCategory, amountBase: 2_000_000 });
  });

  it('an income category is not an answer', async () => {
    const w = await world();
    const res = await w.owner.post('/inventory/receipts', receipt(w, { ...wool(w), payment: { ...paidCash(w), categoryId: w.rentIncome } }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CATEGORY_REQUIRED');
  });

  it('needs none when nothing is paid', async () => {
    const w = await world();
    await buy(w, wool(w));
    expect(await onHand(w, w.wool)).toBe(50);
  });

  it('can be known before a card is shown', async () => {
    const w = await world();
    expect(await w.f.run(() => defaultExpenseCategoryId('product'))).toBeNull();
    expect(await w.f.run(() => defaultExpenseCategoryId('fuel'))).toBe(w.fuelCategory);
  });
});

describe('a purchase issued in full', () => {
  /** 1 000 000 / 7 000 kg = 142.857142..., which the batch keeps as 142.8571. */
  const lot = (w: World) => ({ lines: [barley(w, 7000, 1_000_000 / 7000)] });

  it('costs exactly what was paid, across two issues', async () => {
    const w = await world();
    await buy(w, lot(w));
    // 3 000 x 142.8571 = 428 571.30.
    expect((await issueOf(w, w.barley, 3000)).totalCost).toBe(428_571.3);
    // What is left of the value, not 4 000 x 142.8571 = 571 428.40.
    expect((await issueOf(w, w.barley, 4000)).totalCost).toBe(571_428.7);
  });

  it('costs exactly what was paid after moving warehouse', async () => {
    const w = await world();
    await buy(w, lot(w));
    await w.f.run(() => transferStock({ itemId: w.barley, fromWarehouseId: w.store, toWarehouseId: w.otherStore, qty: 7000, date: TODAY }));
    expect((await issueOf(w, w.barley, 7000, w.otherStore)).totalCost).toBe(1_000_000);
  });

  it('costs the same when the last issue is reversed and made again', async () => {
    const w = await world();
    await buy(w, lot(w));
    await issueOf(w, w.barley, 3000);
    const again = () =>
      w.f.run(() =>
        issueStock({ itemId: w.barley, warehouseId: w.store, qty: 4000, date: TODAY, costCenterId: w.general, reason: 'ration', refType: 'daily_log', refId: SOME_RECORD }),
      );
    expect((await again()).totalCost).toBe(571_428.7);
    await w.f.run(() => reverseMovements('daily_log', SOME_RECORD));
    expect((await again()).totalCost).toBe(571_428.7);
  });

  it('leaves a part issue at the plain price', async () => {
    const w = await world();
    await buy(w, lot(w));
    // 7 x 142.8571 = 999.9997, rounded to the tiyin.
    expect((await issueOf(w, w.barley, 7)).totalCost).toBe(1000);
  });
});

describe('the money of a purchase request', () => {
  const NOT_PAID = {
    status: 'approved',
    transactionId: null,
    paidAmount: null,
    unitCost: null,
    warehouseId: null,
    receivedQty: null,
    receivedOn: null,
    batchId: null,
    quality: null,
    diffQty: null,
    diffAmount: null,
  };

  /** Asked for by the owner and approved by the director, so paying it is the next step. */
  async function approved(w: World, over: object = {}) {
    const created = await w.owner.post('/sales/purchases', { itemId: w.diesel, qty: 400, counterpartyId: w.supplier, ...over });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.data.id as string;
    expect((await w.director.post(`/sales/purchases/${id}/approve`)).status).toBe(200);
    return id;
  }
  const paying = (w: World, id: string, amount: number, over: object = {}) =>
    w.owner.post(`/sales/purchases/${id}/pay`, { date: TODAY, amount, paymentMethod: 'cash', accountId: w.cash, ...over });
  async function paid(w: World, id: string, amount: number, over: object = {}) {
    const res = await paying(w, id, amount, over);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.data.transactionId as string;
  }
  const receiving = (w: World, id: string, qty: number, warehouseId = w.store) =>
    w.owner.post(`/sales/purchases/${id}/receive`, { date: TODAY, qty, warehouseId, quality: 'Yaxshi' });
  async function received(w: World, id: string, qty: number) {
    const res = await receiving(w, id, qty);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  const request = async (w: World, id: string) => (await w.owner.get(`/sales/purchases/${id}`)).data;

  /** 400 l x 15 000 = 6 000 000 with no estimate: in the warehouse, the money waiting for a second person. */
  async function waiting(w: World) {
    const id = await approved(w);
    const moneyId = await paid(w, id, 6_000_000);
    expect((await entry(w, moneyId)).status).toBe('pending');
    const [qtyBefore, valueBefore] = [await onHand(w), await stockValue(w)];
    await received(w, id, 400);
    expect(await onHand(w)).toBe(qtyBefore + 400);
    expect(await stockValue(w)).toBe(valueBefore + 6_000_000);
    return { id, moneyId };
  }

  /** 100 l x 15 000 = 1 500 000 within the estimate: approved at once and out of the till. */
  async function settled(w: World, over: object = {}) {
    const id = await approved(w, { qty: 100, expectedPrice: 15_000 });
    const moneyId = await paid(w, id, 1_500_000, over);
    expect((await entry(w, moneyId)).status).toBe('approved');
    await received(w, id, 100);
    return { id, moneyId };
  }

  it('rejected after the goods came: the goods leave and the request waits to be paid again', async () => {
    const w = await world();
    const { id, moneyId } = await waiting(w);

    const res = await reject(w, moneyId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.status).toBe('rejected');

    expect(await request(w, id)).toMatchObject(NOT_PAID);
    expect(await onHand(w)).toBe(0);
    expect(await stockValue(w)).toBe(0);
    expect(await batchRows(w)).toEqual([]);
    expect(await movementRows(w)).toEqual([]);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
  });

  it('rejected before the goods came: nothing can be received against it', async () => {
    const w = await world();
    const id = await approved(w);
    const moneyId = await paid(w, id, 6_000_000);

    expect((await reject(w, moneyId)).status).toBe(200);

    expect(await request(w, id)).toMatchObject(NOT_PAID);
    const res = await receiving(w, id, 400);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PURCHASE_WRONG_STATE');
    expect(await onHand(w)).toBe(0);
  });

  it('can be paid again after a rejection, and stock takes the new price', async () => {
    const w = await world();
    const { id, moneyId } = await waiting(w);
    await reject(w, moneyId);

    // The right bill: 400 l x 2 500 = 1 000 000, below the threshold.
    const again = await paid(w, id, 1_000_000);
    expect(again).not.toBe(moneyId);
    expect(await request(w, id)).toMatchObject({ status: 'paid', transactionId: again, paidAmount: 1_000_000, unitCost: 2_500 });
    await received(w, id, 400);

    expect(await stockValue(w)).toBe(1_000_000);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 1_000_000);
    expect((await issueOf(w, w.diesel, 400)).totalCost).toBe(1_000_000);
    expect((await entry(w, moneyId)).status).toBe('rejected');
  });

  it('is refused once part of the goods was used, and can still be approved', async () => {
    const w = await world();
    const { id, moneyId } = await waiting(w);
    await issueDoc(w, 1);

    const res = await reject(w, moneyId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BATCH_ALREADY_USED');

    expect((await entry(w, moneyId)).status).toBe('pending');
    expect(await request(w, id)).toMatchObject({ status: 'received', transactionId: moneyId, receivedQty: 400 });
    expect(await onHand(w)).toBe(399);

    expect((await w.director.post(`/finance/transactions/${moneyId}/approve`)).status).toBe(200);
    // 400 l x 15 000 left the till, 1 l of it issued.
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 6_000_000);
    expect(await issuedCost(w)).toBe(15_000);
  });

  it('goes through once the issue that used the goods is reversed', async () => {
    const w = await world();
    const { id, moneyId } = await waiting(w);
    const docNo = await issueDoc(w, 50);
    expect((await reject(w, moneyId)).status).toBe(409);

    expect((await w.owner.post(`/inventory/documents/${docNo}/reverse`)).status).toBe(200);
    expect(await onHand(w)).toBe(400);
    expect((await reject(w, moneyId)).status).toBe(200);
    expect(await onHand(w)).toBe(0);
    expect(await request(w, id)).toMatchObject(NOT_PAID);
  });

  it('is refused once the goods moved to another warehouse', async () => {
    const w = await world();
    const { moneyId } = await waiting(w);
    await w.f.run(() => transferStock({ itemId: w.diesel, fromWarehouseId: w.store, toWarehouseId: w.otherStore, qty: 1, date: TODAY }));
    const res = await reject(w, moneyId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BATCH_ALREADY_USED');
    expect(await onHand(w)).toBe(400);
  });

  it('under average costing is refused when a later issue was priced on these goods', async () => {
    const w = await world(AVERAGE);
    // Older stock that can be issued while the requested goods stay untouched in their own batch.
    await buy(w, { lines: [diesel(w, 400, 10_000)] });
    const { moneyId } = await waiting(w);
    // 400 l x 10 000 + 400 l x 15 000 = 10 000 000, so 12 500 a litre: the price leans on the waiting goods.
    expect((await issueOf(w, w.diesel, 1)).totalCost).toBe(12_500);
    const res = await reject(w, moneyId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AVERAGE_COST_USED');
    expect((await entry(w, moneyId)).status).toBe('pending');
  });

  it('leaves another request for the same item alone', async () => {
    const w = await world();
    const other = await settled(w);
    const { id, moneyId } = await waiting(w);
    expect(await onHand(w)).toBe(500);

    expect((await reject(w, moneyId)).status).toBe(200);

    expect(await onHand(w)).toBe(100);
    expect(await stockValue(w)).toBe(1_500_000);
    expect(await request(w, id)).toMatchObject(NOT_PAID);
    expect(await request(w, other.id)).toMatchObject({ status: 'received', transactionId: other.moneyId, receivedQty: 100 });
  });

  it('on credit: a rejected purchase leaves no debt behind', async () => {
    const w = await world();
    const id = await approved(w);
    const moneyId = await paid(w, id, 6_000_000, { paymentMethod: 'debt', accountId: null });
    await received(w, id, 400);
    expect(await owed(w)).toBe(0);
    expect((await reject(w, moneyId)).status).toBe(200);
    expect(await owed(w)).toBe(0);
    expect(await onHand(w)).toBe(0);
  });

  it('voided after approval: money, goods and request go together', async () => {
    const w = await world();
    const { id, moneyId } = await settled(w);
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 1_500_000);

    const res = await voidEntry(w, moneyId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect((await entry(w, moneyId)).status).toBe('rejected');
    expect(await balance(w, w.cash)).toBe(OPENING_CASH);
    expect(await onHand(w)).toBe(0);
    expect(await batchRows(w)).toEqual([]);
    expect(await request(w, id)).toMatchObject(NOT_PAID);
    expect((await paying(w, id, 1_500_000)).status).toBe(200);
  });

  it('a void is refused once the goods were used, and nothing moves', async () => {
    const w = await world();
    const { id, moneyId } = await settled(w);
    await issueDoc(w, 100);
    const res = await voidEntry(w, moneyId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BATCH_ALREADY_USED');
    expect((await entry(w, moneyId)).status).toBe('approved');
    expect(await balance(w, w.cash)).toBe(OPENING_CASH - 1_500_000);
    expect(await request(w, id)).toMatchObject({ status: 'received' });
  });

  it('a void is refused while a payment stands on its debt', async () => {
    const w = await world();
    const { id, moneyId } = await settled(w, { paymentMethod: 'debt', accountId: null });
    expect(await owed(w)).toBe(1_500_000);
    await pay(w, 500_000);

    const res = await voidEntry(w, moneyId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEBT_ALREADY_SETTLED');
    expect(await onHand(w)).toBe(100);
    expect(await request(w, id)).toMatchObject({ status: 'received' });
  });

  it('stays with a second person, and the maker moves nothing', async () => {
    const w = await world();
    const { id, moneyId } = await waiting(w);
    const res = await w.owner.post(`/finance/transactions/${moneyId}/reject`, { reason: 'xato' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SAME_MAKER_CHECKER');
    expect(await onHand(w)).toBe(400);
    expect(await request(w, id)).toMatchObject({ status: 'received' });
  });

  it('needs finance.approve, whoever else may touch the stock', async () => {
    const w = await world();
    const { moneyId } = await waiting(w);
    const storekeeper = await w.f.as('storekeeper');
    expect((await storekeeper.post(`/finance/transactions/${moneyId}/reject`, { reason: 'xato' })).status).toBe(403);
    expect((await storekeeper.post(`/finance/transactions/${moneyId}/void`, { reason: 'xato' })).status).toBe(403);
    expect(await onHand(w)).toBe(400);
  });

  it('cannot be reached from another tenant', async () => {
    const w = await world();
    const other = await world();
    const { moneyId } = await waiting(w);
    expect((await reject(other, moneyId)).status).toBe(404);
    expect(await onHand(w)).toBe(400);
  });

  it('still cannot be edited or deleted in finance', async () => {
    const w = await world();
    const { moneyId } = await waiting(w);
    expect((await w.director.patch(`/finance/transactions/${moneyId}`, { amount: 1 })).body.error.code).toBe('TRANSACTION_HAS_SOURCE');
    expect((await w.director.delete(`/finance/transactions/${moneyId}`)).body.error.code).toBe('TRANSACTION_HAS_SOURCE');
  });

  it('writes one journal event saying what left', async () => {
    const w = await world();
    const { id, moneyId } = await waiting(w);
    await reject(w, moneyId);
    const written = await journal(w, 'purchase.payment_cancelled');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ entityType: 'purchase_request', entityId: id, severity: 'attention' });
    expect(written[0].data).toMatchObject({ transactionId: moneyId, reason: 'xato', receivedQty: 400 });
  });

  describe('at the same moment', () => {
    const issuing = (w: World, qty: number) => () =>
      issueStock({ itemId: w.diesel, warehouseId: w.store, qty, date: TODAY, costCenterId: w.general, reason: 'manual' });

    it('an issue and a rejection: the rejection sees the goods used', async () => {
      const w = await world();
      const { moneyId } = await waiting(w);
      expect(await overlapping(w, issuing(w, 1), () => rejectTransaction(moneyId, 'xato'))).toBe('BATCH_ALREADY_USED');
      expect(await onHand(w)).toBe(399);
      expect((await entry(w, moneyId)).status).toBe('pending');
    });

    it('a rejection and an issue: the issue finds nothing left', async () => {
      const w = await world();
      const { moneyId } = await waiting(w);
      expect(await overlapping(w, () => rejectTransaction(moneyId, 'xato'), issuing(w, 1))).toBe('INSUFFICIENT_STOCK');
      expect(await onHand(w)).toBe(0);
    });

    it('a receipt and a rejection: the rejection takes back what just came in', async () => {
      const w = await world();
      const id = await approved(w);
      const moneyId = await paid(w, id, 6_000_000);
      const receipt = () => purchases.receive(id, { date: TODAY, qty: 400, warehouseId: w.store });
      expect(await overlapping(w, receipt, () => rejectTransaction(moneyId, 'xato'))).toBe('done');
      expect(await onHand(w)).toBe(0);
      expect(await request(w, id)).toMatchObject(NOT_PAID);
    });

    it('a rejection and a receipt: nothing comes in against refused money', async () => {
      const w = await world();
      const id = await approved(w);
      const moneyId = await paid(w, id, 6_000_000);
      const receipt = () => purchases.receive(id, { date: TODAY, qty: 400, warehouseId: w.store });
      expect(await overlapping(w, () => rejectTransaction(moneyId, 'xato'), receipt)).toBe('PURCHASE_WRONG_STATE');
      expect(await onHand(w)).toBe(0);
    });

    it('two rejections take the goods back once', async () => {
      const w = await world();
      const { id, moneyId } = await waiting(w);
      const results = await Promise.all([reject(w, moneyId), reject(w, moneyId)]);
      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(await onHand(w)).toBe(0);
      expect(await journal(w, 'purchase.payment_cancelled')).toHaveLength(1);
      expect(await request(w, id)).toMatchObject(NOT_PAID);
    });

    it('over HTTP, rejections and issues in a storm: goods and money never part', async () => {
      const w = await world();
      const { id, moneyId } = await waiting(w);
      const issues = Array.from({ length: 4 }, () =>
        w.owner.post('/inventory/issues', { warehouseId: w.store, date: TODAY, costCenterId: w.general, lines: [{ itemId: w.diesel, qty: 1 }] }),
      );
      const [refused, ...done] = await Promise.all([reject(w, moneyId), ...issues]);
      const issued = done.filter((res) => res.status === 201).length;
      expect(refused.status === 200).toBe(issued === 0);
      expect(await onHand(w)).toBe(refused.status === 200 ? 0 : 400 - issued);
      expect((await entry(w, moneyId)).status).toBe(refused.status === 200 ? 'rejected' : 'pending');
      expect((await request(w, id)).status).toBe(refused.status === 200 ? 'approved' : 'received');
    });
  });
});

describe('at the same moment, on records that hold money', () => {
  describe('a rental act', () => {
    async function hired(w: World) {
      const asset = await w.owner.post('/assets', {
        name: 'Kombayn', type: 'combine', rented: true, rentalCounterpartyId: w.supplier, rentalPrice: 450_000, rentalUnit: 'ha',
      });
      expect(asset.status, JSON.stringify(asset.body)).toBe(201);
      const shift = await w.owner.post(`/assets/${asset.data.id}/usage`, { date: TODAY, volumeHa: 2 });
      expect(shift.status, JSON.stringify(shift.body)).toBe(201);
      return { assetId: asset.data.id as string, shiftId: shift.data.id as string };
    }
    const act = (assetId: string) => () => createRentalAct(assetId, { from: TODAY, to: TODAY });

    it('two acts bill a shift once, so the contractor is owed it once', async () => {
      const w = await world();
      const { assetId } = await hired(w);
      expect(await overlapping(w, act(assetId), act(assetId))).toBe('NOTHING_TO_BILL');
      // 2 ha x 450 000.
      expect(await owed(w)).toBe(900_000);
    });

    it('a shift deleted while it is billed stays, because money stands on it', async () => {
      const w = await world();
      const { assetId, shiftId } = await hired(w);
      expect(await overlapping(w, act(assetId), () => removeUsage(assetId, shiftId))).toBe('USAGE_ALREADY_BILLED');
      expect(await owed(w)).toBe(900_000);
    });

    it('a shift deleted just before billing is not billed', async () => {
      const w = await world();
      const { assetId, shiftId } = await hired(w);
      expect(await overlapping(w, () => removeUsage(assetId, shiftId), act(assetId))).toBe('NOTHING_TO_BILL');
      expect(await owed(w)).toBe(0);
    });

    it('two deletions of one shift give its motor-hours back once', async () => {
      const w = await world();
      const asset = await w.owner.post('/assets', { name: 'MTZ-82', type: 'tractor', motoHours: 100 });
      const shift = await w.owner.post(`/assets/${asset.data.id}/usage`, { date: TODAY, motoHours: 8 });
      expect(shift.status, JSON.stringify(shift.body)).toBe(201);
      const remove = () => removeUsage(asset.data.id, shift.data.id);
      expect(await overlapping(w, remove, remove)).toBe('NOT_FOUND');
      expect((await w.owner.get(`/assets/${asset.data.id}`)).data.motoHours).toBe(100);
    });
  });

  describe('closing an account', () => {
    const depositInto = (w: World, accountId: string) => () =>
      postTransaction({ date: TODAY, type: 'income', amount: 1_000_000, categoryId: w.rentIncome, costCenterId: w.general, paymentMethod: 'cash', accountId });
    async function emptyAccount(w: World) {
      const res = await w.owner.post('/finance/accounts', { name: 'Yangi kassa', type: 'cash' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.data.id as string;
    }

    it('waits for money moving into it, and then refuses', async () => {
      const w = await world();
      const id = await emptyAccount(w);
      expect(await overlapping(w, depositInto(w, id), () => accountService.remove(id))).toBe('ACCOUNT_NOT_EMPTY');
      expect(await balance(w, id)).toBe(1_000_000);
    });

    it('stops money moving in right after it', async () => {
      const w = await world();
      const id = await emptyAccount(w);
      expect(await overlapping(w, () => accountService.remove(id), depositInto(w, id))).toBe('ACCOUNT_CLOSED');
    });

    it('cannot change its currency under money moving in', async () => {
      const w = await world();
      const id = await emptyAccount(w);
      expect(await overlapping(w, depositInto(w, id), () => accountService.update(id, { currency: 'USD' }))).toBe('ACCOUNT_CURRENCY_LOCKED');
    });
  });

  describe('a loan', () => {
    const loanBody = (w: World) => ({ counterpartyId: w.supplier, name: 'Kredit', principal: 12_000_000, annualRate: 12, termMonths: 12, startDate: '2026-01-15' });

    it('being paid cannot be deleted', async () => {
      const w = await world();
      const loan = (await w.owner.post('/finance/loans', loanBody(w))).data;
      const [first] = (await w.owner.get(`/finance/loans/${loan.id}`)).data.instalments;
      const paying = () => loanService.payInstalment(loan.id, first.id, { date: TODAY, accountId: w.cash });
      expect(await overlapping(w, paying, () => loanService.remove(loan.id))).toBe('LOAN_HAS_PAYMENTS');
      expect((await w.owner.get(`/finance/loans/${loan.id}`)).status).toBe(200);
    });

    it('being deleted cannot be paid', async () => {
      const w = await world();
      const loan = (await w.owner.post('/finance/loans', loanBody(w))).data;
      const [first] = (await w.owner.get(`/finance/loans/${loan.id}`)).data.instalments;
      const paying = () => loanService.payInstalment(loan.id, first.id, { date: TODAY, accountId: w.cash });
      expect(await overlapping(w, () => loanService.remove(loan.id), paying)).toBe('NOT_FOUND');
      expect(await balance(w, w.cash)).toBe(OPENING_CASH);
    });
  });

  describe('a stock count', () => {
    async function counted(w: World) {
      await buy(w);
      const res = await w.owner.post('/inventory/counts', { warehouseId: w.store, date: TODAY, itemIds: [w.diesel] });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const id = res.data.id as string;
      await w.owner.patch(`/inventory/counts/${id}`, { lines: [{ itemId: w.diesel, actualQty: 90 }] });
      return id;
    }

    it('being approved cannot be deleted', async () => {
      const w = await world();
      const id = await counted(w);
      expect(await overlapping(w, () => counts.approve(id), () => counts.remove(id))).toBe('COUNT_NOT_DRAFT');
      expect(await onHand(w)).toBe(90);
      expect((await w.owner.get(`/inventory/counts/${id}`)).data.status).toBe('approved');
    });

    it('being approved cannot have its figures changed', async () => {
      const w = await world();
      const id = await counted(w);
      const change = () => counts.update(id, { lines: [{ itemId: w.diesel, actualQty: 5 }] });
      expect(await overlapping(w, () => counts.approve(id), change)).toBe('COUNT_NOT_DRAFT');
      expect((await w.owner.get(`/inventory/counts/${id}`)).data.lines[0]).toMatchObject({ actualQty: 90, diffQty: -10 });
    });
  });
});

describe('a cost center of this farm only', () => {
  it('is what the three closing helpers touch', async () => {
    const w = await world();
    const other = await world();
    const center = await w.f.run(() => ensureCostCenter('asset', SOME_RECORD, 'MTZ-82'));
    const activeOf = async () => (await w.f.run(() => tx().select().from(costCenters).where(eq(costCenters.id, center))))[0];

    await other.f.run(() => deactivateCostCenter(center));
    expect((await activeOf()).active).toBe(true);
    await w.f.run(() => deactivateCostCenter(center));
    expect((await activeOf()).active).toBe(false);
    await other.f.run(() => activateCostCenter(center));
    expect((await activeOf()).active).toBe(false);
    await w.f.run(() => activateCostCenter(center));
    expect((await activeOf()).active).toBe(true);
  });
});
