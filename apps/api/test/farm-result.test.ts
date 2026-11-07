import { and, eq, sql, type AnyColumn } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROLE_KEYS, addDays, monthOf, monthRange, todayIso, type RoleKey } from '@yap/shared';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { ensureCostCenter } from '../src/core/costCenters';
import { adjustStock, issueStock, receiveStock } from '../src/core/inventory';
import { postTransaction } from '../src/core/ledger';
import { costCenterCosts, monthToDate } from '../src/modules/finance/summary';
import { seedAssets, seedDepreciation } from '../src/seed/assets';
import { seedCrops } from '../src/seed/crops';
import { seedFinance } from '../src/seed/finance';
import { seedFinanceBase } from '../src/seed/finance-base';
import { seedHr, seedPayroll } from '../src/seed/hr';
import { seedInventory } from '../src/seed/inventory';
import { seedLand } from '../src/seed/land';
import { seedLivestock } from '../src/seed/livestock';
import { seedSales } from '../src/seed/sales';
import type { SeedContext } from '../src/seed/types';
import { seedVet } from '../src/seed/vet';
import { createFixture, type Client, type Fixture } from './helpers';

const { accounts, counterparties, financeCategories, herds, items, stockBatches, stockMovements: m, transactions: t, warehouses } = schema;

const now = todayIso();
const month = monthOf(now);
const { from, to } = monthRange(month);
const noSalesMonth = monthOf(addDays(from, -1));

/**
 * One month, by hand:
 *   income    1 000 000 wool money + 150 000 own wool sold           = 1 150 000
 *   paid      300 000 fuel + 5 000 000 tractor + 2 000 000 rams
 *             + 400 000 feed bought for stock                        = 7 700 000
 *   operating 300 000 fuel + 25 kg of the bought feed at 4 000       =   400 000
 *   net       1 150 000 − 400 000                                    =   750 000
 * Left out of operating: 100 kg of own hay fed (100 000), 10 kg of it short at a count (10 000) and
 * 5 kg of own wool sold (60 000). All three are transfer value, and no money moved.
 */
async function arrange(f: Fixture) {
  return f.run(async () => {
    const base = { tenantId: f.tenantId, farmId: f.farmId };
    const [account] = await tx().insert(accounts).values({ ...base, name: 'Kassa', type: 'cash' }).returning();
    const [buyer] = await tx().insert(counterparties).values({ ...base, name: 'Xaridor', type: 'buyer' }).returning();
    const [warehouse] = await tx().insert(warehouses).values({ ...base, name: 'Ombor', type: 'feed' }).returning();
    const [hay] = await tx().insert(items).values({ ...base, name: 'Beda', category: 'feed', unit: 'kg', transferPrice: 1_000 }).returning();
    const [bran] = await tx().insert(items).values({ ...base, name: 'Kepak', category: 'feed', unit: 'kg' }).returning();
    const [wool] = await tx().insert(items).values({ ...base, name: 'Jun', category: 'product', unit: 'kg', transferPrice: 12_000 }).returning();
    const [herd] = await tx().insert(herds).values({ ...base, name: 'Sovliqlar' }).returning();
    const herdCenter = await ensureCostCenter('herd', herd.id, herd.name);

    const category = async (key: string) => {
      const [row] = await tx()
        .select({ id: financeCategories.id })
        .from(financeCategories)
        .where(and(eq(financeCategories.tenantId, f.tenantId), eq(financeCategories.key, key)));
      return row.id;
    };
    const money = { date: now, paymentMethod: 'cash' as const, accountId: account.id, costCenterId: herdCenter, autoApprove: true };
    await postTransaction({ ...money, type: 'income', amount: 1_000_000, categoryId: await category('wool_sales') });
    await postTransaction({ ...money, type: 'expense', amount: 300_000, categoryId: await category('fuel') });
    await postTransaction({ ...money, type: 'expense', amount: 5_000_000, categoryId: await category('machinery_purchase'), costTreatment: 'capex' });
    await postTransaction({ ...money, type: 'expense', amount: 2_000_000, categoryId: await category('animal_purchase'), costTreatment: 'animal' });
    await postTransaction({ ...money, type: 'expense', amount: 400_000, categoryId: await category('feed'), costTreatment: 'inventory' });
    await postTransaction({ ...money, date: `${noSalesMonth}-15`, type: 'expense', amount: 100_000, categoryId: await category('fuel') });

    const stock = { warehouseId: warehouse.id, date: now };
    await receiveStock({ ...stock, itemId: bran.id, qty: 100, unitCost: 4_000, source: 'purchase' });
    await issueStock({ ...stock, itemId: bran.id, qty: 25, costCenterId: herdCenter, reason: 'ration' });

    await receiveStock({ ...stock, itemId: hay.id, qty: 1_000, unitCost: 1_000, source: 'own_harvest' });
    await issueStock({ ...stock, itemId: hay.id, qty: 100, costCenterId: herdCenter, reason: 'ration' });
    await adjustStock({ ...stock, itemId: hay.id, actualQty: 890 });

    await receiveStock({ ...stock, itemId: wool.id, qty: 10, unitCost: 12_000, source: 'own_harvest' });
    return { accountId: account.id, buyerId: buyer.id, warehouseId: warehouse.id, woolId: wool.id, herdCenter };
  });
}

describe('net result of a month', () => {
  let f: Fixture;
  let owner: Client;
  let herdCenter: string;

  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
    const w = await arrange(f);
    herdCenter = w.herdCenter;
    const sale = await owner.post('/sales/orders', {
      date: now,
      counterpartyId: w.buyerId,
      paymentMethod: 'cash',
      accountId: w.accountId,
      lines: [{ itemId: w.woolId, warehouseId: w.warehouseId, qty: 5, price: 30_000 }],
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const confirmed = await owner.post(`/sales/orders/${sale.data.id}/confirm`);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  });

  const expected = { income: 1_150_000, operatingExpense: 400_000, net: 750_000, expense: 7_700_000 };

  it('is income less operating cost, against the hand count', async () => {
    expect((await owner.get('/finance/summary/month', { month })).data).toMatchObject(expected);
  });

  it('is the same figure in the monthly report and the investor report', async () => {
    const report = (await owner.get('/reports/finance.monthly_result', { from, to })).data;
    expect(report.rows).toEqual([expect.objectContaining({ month, ...expected })]);
    expect(report.totals).toMatchObject(expected);

    const investor = (await owner.get('/reports/investor', { month })).data.finance;
    expect(investor).toMatchObject(expected);
    // (1 150 000 − 400 000) / 400 000
    expect(investor.profitabilityPercent).toBe(187.5);
  });

  it('the KPIs stand on the same two figures', async () => {
    const kpis = (await owner.get('/dashboard/kpis', { from: month, to: month })).data.groups.finance.data;
    // 400 000 / 1 150 000
    expect(kpis).toMatchObject({ income: 1_150_000, operatingExpense: 400_000, profitabilityPercent: 187.5, operatingRatio: 0.35 });
    const report = (await owner.get('/reports/finance.kpi', { from, to, lang: 'en' })).data.rows;
    const indicator = (label: string) => report.find((row: { indicator: string }) => row.indicator === label).value;
    expect(indicator('Operating expense')).toBe(400_000);
    expect(indicator('Profitability')).toBe(187.5);
  });

  it('a month of costs and no sales is a loss everywhere, with no return to measure', async () => {
    const range = monthRange(noSalesMonth);
    const loss = { income: 0, operatingExpense: 100_000, net: -100_000 };
    expect((await owner.get('/finance/summary/month', { month: noSalesMonth })).data).toMatchObject(loss);
    expect((await owner.get('/reports/finance.monthly_result', range)).data.rows[0]).toMatchObject(loss);
    expect((await owner.get('/reports/investor', { month: noSalesMonth })).data.finance).toMatchObject({ ...loss, profitabilityPercent: null });

    const kpis = (await owner.get('/dashboard/kpis', { from: noSalesMonth, to: noSalesMonth })).data.groups.finance.data;
    expect(kpis.profitabilityPercent).toBeNull();
    const report = (await owner.get('/reports/finance.kpi', { ...range, lang: 'en' })).data.rows;
    expect(report.find((row: { indicator: string }) => row.indicator === 'Profitability').value).toBeNull();
  });

  it('keeps own produce at cost-center level: the herd is still charged what it ate', async () => {
    const centers = await f.run(() => costCenterCosts(from, to));
    // 25 kg of bought feed at 4 000 + 100 kg of own hay at 1 000.
    expect(centers.find((c) => c.costCenterId === herdCenter)?.materials).toBe(200_000);
  });

  it('calls the result a result and money money, in every language', async () => {
    const label = async (report: string, lang: string) => {
      const { columns } = (await owner.get(`/reports/${report}`, { from, to, lang })).data;
      return Object.fromEntries(columns.map((c: { key: string; label: string }) => [c.key, c.label]));
    };
    expect(await label('finance.monthly_result', 'uz')).toMatchObject({ net: 'Sof natija', expense: "To'langan pul (aktivlar bilan)" });
    expect(await label('finance.cashflow', 'uz')).toMatchObject({ net: 'Sof pul oqimi' });
    expect(await label('finance.monthly_result', 'ru')).toMatchObject({ net: 'Чистый итог', expense: 'Оплачено (включая активы)' });
    expect(await label('finance.cashflow', 'ru')).toMatchObject({ net: 'Чистый денежный поток' });
    expect(await label('finance.monthly_result', 'en')).toMatchObject({ net: 'Net result', expense: 'Money paid (assets included)' });
    expect(await label('finance.cashflow', 'en')).toMatchObject({ net: 'Net cash flow' });
  });
});

describe('net result on the pilot seed', () => {
  it('feeds the flock from its own harvest and counts that once', async () => {
    const f = await createFixture();
    const users = {} as Record<RoleKey, string>;
    for (const role of ROLE_KEYS) users[role] = (await f.as(role)).userId;
    const seed: SeedContext = {
      tenantId: f.tenantId,
      farmId: f.farmId,
      users,
      run: (fn, as = 'owner') => f.run(fn, { userId: users[as] }),
    };
    const steps = [seedFinanceBase, seedLand, seedHr, seedAssets, seedInventory, seedLivestock, seedPayroll, seedVet, seedCrops, seedFinance, seedSales, seedDepreciation];
    for (const step of steps) await step(seed);

    const monthOfDate = (column: AnyColumn) => sql<string>`to_char(${column}::date, 'YYYY-MM')`;
    const { stock, direct } = await f.run(async () => ({
      stock: await tx()
        .select({
          month: monthOfDate(m.date),
          own: sql<boolean>`${stockBatches.source} = 'own_harvest'`,
          charged: sql<boolean>`${m.costCenterId} is not null`,
          amount: sql<number>`sum(case when ${m.type} = 'adjustment_in' then -${m.totalCost} else ${m.totalCost} end)`.mapWith(Number),
        })
        .from(m)
        .innerJoin(stockBatches, eq(stockBatches.id, m.batchId))
        .where(and(eq(m.farmId, f.farmId), sql`${m.type} in ('issue', 'adjustment_out', 'adjustment_in')`))
        .groupBy(sql`1`, sql`2`, sql`3`),
      direct: await tx()
        .select({ month: monthOfDate(t.date), amount: sql<number>`sum(${t.amountBase})`.mapWith(Number) })
        .from(t)
        .where(and(eq(t.farmId, f.farmId), eq(t.status, 'approved'), eq(t.type, 'expense'), eq(t.costTreatment, 'expense')))
        .groupBy(sql`1`),
    }));
    const total = (month: string, match: (row: (typeof stock)[number]) => boolean) =>
      stock.filter((row) => row.month === month && match(row)).reduce((sum, row) => sum + row.amount, 0);

    const owner = await f.as('owner');
    const months = [...new Set(stock.map((row) => row.month))];
    expect(stock.filter((row) => row.own).reduce((sum, row) => sum + row.amount, 0)).toBeGreaterThan(0);
    for (const month of months) {
      const directCost = direct.find((row) => row.month === month)?.amount ?? 0;
      const result = await f.run(() => monthToDate(month));
      expect(result.operatingExpense, month).toBeCloseTo(directCost + total(month, (row) => !row.own), 2);

      const { from, to } = monthRange(month);
      const report = (await owner.get('/reports/finance.monthly_result', { from, to })).data;
      expect(report.rows[0].net, month).toBe(result.net);
      expect((await owner.get('/reports/investor', { month })).data.finance.net, month).toBe(result.net);

      const centers = await f.run(() => costCenterCosts(from, to));
      const materials = centers.reduce((sum, center) => sum + center.materials, 0);
      expect(materials, month).toBeCloseTo(total(month, (row) => row.charged), 0);
    }
  });
});
