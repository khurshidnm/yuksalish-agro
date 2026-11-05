import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, MODULES, addDays, monthOf, round, todayIso, type RoleKey } from '@yap/shared';
import { ctx, tx } from '../src/core/context';
import { ensureCostCenter, generalCostCenterId } from '../src/core/costCenters';
import { issueStock, receiveStock } from '../src/core/inventory';
import { postTransaction } from '../src/core/ledger';
import { schema } from '../src/db/client';
import { raiseAlert } from '../src/modules/alerts/alerts.service';
import { isolate } from '../src/modules/dashboard/blocks';
import { cashPosition } from '../src/modules/finance/summary';
import { herdSummary } from '../src/modules/livestock/summary';
import { createFixture, type Client, type Fixture } from './helpers';

// Wrapped, so a test can make one block fail for real while the rest run normally.
vi.mock('../src/modules/finance/summary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/finance/summary')>();
  return { ...actual, cashPosition: vi.fn(actual.cashPosition) };
});
vi.mock('../src/modules/livestock/summary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/livestock/summary')>();
  return { ...actual, herdSummary: vi.fn(actual.herdSummary) };
});

const now = todayIso();
const month = monthOf(now);

/** Distinctive amounts: finding one of these digits in a response means money leaked. */
const OPENING_BALANCE = 123_456_789;
const PURCHASE_PRICE = 4_217_300;
const EXPENSE = 8_000_000;
const INCOME = 10_000_000;
const BUDGET = 7_654_321;
const HIDDEN_ALERT_AMOUNT = 77_777_777;
const EMPLOYEE_NAME = 'Maxfiy Xodim Familiyasi';
const EMPLOYEE_PHONE = '+998911112233';

const base = () => ({ tenantId: ctx().tenantId, farmId: ctx().farmId });

/**
 * Hand-checked farm: 10 animals (9 ewes, 1 ram), 1000 kg of hay fed at 50 kg a day for 7 days and
 * costing 2 000 so'm/kg, cash of 123 456 789 plus 10 mln income minus 8 mln expense.
 */
async function arrange(f: Fixture) {
  return f.run(async () => {
    const [sheep] = await tx().select().from(schema.species).where(eq(schema.species.key, 'sheep'));
    const [warehouse] = await tx().insert(schema.warehouses).values({ ...base(), name: 'Ozuqa', type: 'feed' }).returning();
    const [hay] = await tx()
      .insert(schema.items)
      .values({ ...base(), name: 'Beda', category: 'feed', unit: 'kg', dryMatterPct: 85, minDays: 30 })
      .returning();
    const [ration] = await tx().insert(schema.rations).values({ ...base(), name: 'R', state: 'pregnant' }).returning();
    await tx().insert(schema.rationLines).values({ ...base(), rationId: ration.id, itemId: hay.id, kgPerHeadDay: 4 });

    const [herd] = await tx()
      .insert(schema.herds)
      .values({ ...base(), name: 'Sovliqlar', state: 'pregnant', rationId: ration.id })
      .returning();
    const herdCenter = await ensureCostCenter('herd', herd.id, herd.name);
    await tx().update(schema.herds).set({ costCenterId: herdCenter }).where(eq(schema.herds.id, herd.id));

    const statuses = ['pregnant', 'pregnant', 'pregnant', 'pregnant', 'pregnant', 'pregnant', 'sick', 'quarantine', 'active'];
    const ewes = await tx()
      .insert(schema.animals)
      .values(
        statuses.map((status, i) => ({
          ...base(),
          tag: `T-${i + 1}`,
          speciesId: sheep.id,
          sex: 'female',
          category: 'ewe',
          origin: 'purchased',
          purchaseDate: addDays(now, -60),
          purchasePrice: PURCHASE_PRICE,
          herdId: herd.id,
          status,
        })),
      )
      .returning();
    await tx().insert(schema.animals).values({
      ...base(),
      tag: 'R-1',
      speciesId: sheep.id,
      sex: 'male',
      category: 'ram',
      origin: 'purchased',
      purchaseDate: addDays(now, -60),
      purchasePrice: PURCHASE_PRICE,
      herdId: herd.id,
      status: 'active',
    });

    // Six ewes due in about 100 days, two of them in the same week.
    const pregnant = ewes.filter((e) => e.status === 'pregnant');
    await tx()
      .insert(schema.breedingRecords)
      .values(
        pregnant.map((ewe, i) => {
          const expected = addDays(now, 100 + i * 2);
          return {
            ...base(),
            eweId: ewe.id,
            source: 'purchase',
            matingDate: addDays(expected, -150),
            expectedDate: expected,
            expectedEarliest: addDays(expected, -5),
            expectedLatest: addDays(expected, 2),
          };
        }),
      );

    await receiveStock({ itemId: hay.id, warehouseId: warehouse.id, qty: 1350, unitCost: 2000, date: addDays(now, -30), source: 'purchase' });
    for (let day = 1; day <= 7; day++) {
      await issueStock({ itemId: hay.id, warehouseId: warehouse.id, qty: 50, date: addDays(now, -day), costCenterId: herdCenter, reason: 'ration' });
    }

    const [account] = await tx()
      .insert(schema.accounts)
      .values({ ...base(), name: 'Kassa', type: 'cash', openingBalance: OPENING_BALANCE, openingDate: addDays(now, -90) })
      .returning();
    const category = async (key: string) =>
      (await tx().select().from(schema.financeCategories).where(sql`key = ${key} and tenant_id = ${ctx().tenantId}`))[0];
    const fuel = await category('fuel');
    const lambs = await category('lamb_sales');
    const general = await generalCostCenterId();
    await postTransaction({
      date: now,
      type: 'expense',
      amount: EXPENSE,
      categoryId: fuel.id,
      paymentMethod: 'cash',
      accountId: account.id,
      costCenterId: general,
      autoApprove: true,
    });
    await postTransaction({
      date: now,
      type: 'income',
      amount: INCOME,
      categoryId: lambs.id,
      paymentMethod: 'cash',
      accountId: account.id,
      costCenterId: herdCenter,
      autoApprove: true,
    });
    await tx().insert(schema.budgets).values({ ...base(), month, categoryId: fuel.id, amount: BUDGET });

    const [field] = await tx()
      .insert(schema.fields)
      .values({ ...base(), number: '1', landUse: 'arable', areaHa: 10 })
      .returning();
    await tx().insert(schema.fields).values({ ...base(), number: '2', landUse: 'arable', areaHa: 20 });
    const [season] = await tx()
      .insert(schema.seasons)
      .values({ ...base(), name: 'Kuzgi', kind: 'autumn', startDate: addDays(now, -60), endDate: addDays(now, 200), isCurrent: true })
      .returning();
    const [wheat] = await tx().select().from(schema.crops).where(sql`key = 'wheat' and tenant_id = ${ctx().tenantId}`);
    await tx().insert(schema.cropPlans).values({
      ...base(),
      seasonId: season.id,
      fieldId: field.id,
      cropId: wheat.id,
      areaHa: 10,
      expectedYieldTHa: 4,
      status: 'sown',
    });
    await tx().insert(schema.fieldOperations).values({ ...base(), type: 'irrigation', status: 'planned', date: addDays(now, -3), fieldId: field.id });
    await tx().insert(schema.weatherDaily).values({ ...base(), date: now, tempMin: -2, tempMax: 9 });

    const [employee] = await tx()
      .insert(schema.employees)
      .values({ ...base(), fullName: EMPLOYEE_NAME, phone: EMPLOYEE_PHONE, position: 'Omborchi', hireDate: addDays(now, -100) })
      .returning();
    await tx().insert(schema.employees).values({ ...base(), fullName: 'Ikkinchi', position: 'Qorovul', hireDate: addDays(now, -100) });
    await tx().insert(schema.timesheets).values({ ...base(), employeeId: employee.id, date: now, status: 'present' });

    await tx().insert(schema.tasks).values([
      { ...base(), title: 'A', status: 'open', dueDate: addDays(now, -1) },
      { ...base(), title: 'B', status: 'open', dueDate: addDays(now, 1) },
      { ...base(), title: 'C', status: 'done', completedAt: new Date() },
    ]);
    await tx().insert(schema.assets).values([
      { ...base(), name: 'MTZ', type: 'tractor', status: 'working', inventoryNo: '1' },
      { ...base(), name: 'TTZ', type: 'tractor', status: 'repair', inventoryNo: '2' },
    ]);

    await raiseAlert({ ruleKey: 'test_urgent', dedupKey: 'a', severity: 'urgent', title: 'Urgent one', notify: [] });
    await raiseAlert({ ruleKey: 'test_info', dedupKey: 'b', severity: 'info', title: 'Calm one', notify: [] });
    await raiseAlert({
      ruleKey: 'budget_test',
      dedupKey: 'c',
      severity: 'attention',
      title: 'Budget',
      data: { amount: HIDDEN_ALERT_AMOUNT },
      permission: 'finance.view',
      notify: [],
    });

    const [camera] = await tx().insert(schema.devices).values({ ...base(), type: 'camera', name: 'Molxona 1', status: 'online' }).returning();
    await tx().insert(schema.devices).values({ ...base(), type: 'camera', name: 'Darvoza', status: 'planned' });
    await tx().insert(schema.events).values({ ...base(), source: 'camera', type: 'camera.motion', deviceId: camera.id, data: { sample: true } });
  });
}

const MONEY_KEY = /amount|balance|price|cost|income|expense|salary|profit|revenue|payable|receivable|cash|budget|inflow|outflow|debt|closing/i;

function moneyKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => moneyKeys(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, v]) => [
    ...(MONEY_KEY.test(key) ? [`${path}.${key}`] : []),
    ...moneyKeys(v, `${path}.${key}`),
  ]);
}

function expectNoMoney(body: unknown) {
  const json = JSON.stringify(body);
  expect(moneyKeys(body)).toEqual([]);
  for (const amount of [OPENING_BALANCE, PURCHASE_PRICE, EXPENSE, INCOME, BUDGET, HIDDEN_ALERT_AMOUNT]) {
    expect(json).not.toContain(String(amount));
  }
}

describe('dashboard', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture();
    await arrange(f);
  });

  describe('who sees what', () => {
    it.each<[RoleKey, string[]]>([
      ['owner', ['finance', 'alerts', 'livestock', 'feed', 'crops', 'staff', 'cameras']],
      ['director', ['alerts', 'finance', 'livestock', 'feed', 'crops', 'staff', 'cameras']],
      ['accountant', ['finance', 'alerts', 'staff', 'livestock', 'feed', 'crops']],
      ['auditor', ['finance', 'alerts', 'livestock', 'feed', 'crops', 'staff']],
      ['zootechnician', ['livestock', 'feed', 'alerts', 'staff', 'crops']],
      ['veterinarian', ['livestock', 'alerts', 'feed', 'staff']],
      ['agronomist', ['crops', 'alerts', 'feed', 'staff', 'livestock']],
      ['storekeeper', ['feed', 'alerts', 'staff', 'crops']],
      ['investor', ['finance', 'livestock', 'crops', 'feed', 'staff', 'alerts']],
    ])('%s gets its blocks, in the order that suits the role', async (role, expected) => {
      const client = await f.as(role);
      const res = await client.get('/dashboard');
      expect(res.status).toBe(200);
      expect(res.data.order).toEqual(expected);
      expect(Object.keys(res.data.blocks).sort()).toEqual([...expected].sort());
      for (const key of expected) expect(res.data.blocks[key].status).toBe('ok');
    });

    it('owner sees finance first, zootechnician the herd, agronomist the fields (spec 14)', async () => {
      expect((await (await f.as('owner')).get('/dashboard')).data.order[0]).toBe('finance');
      expect((await (await f.as('zootechnician')).get('/dashboard')).data.order[0]).toBe('livestock');
      expect((await (await f.as('agronomist')).get('/dashboard')).data.order[0]).toBe('crops');
    });

    it.each<RoleKey>(['shepherd', 'mechanic'])('%s has no dashboard permission and gets nothing', async (role) => {
      const client = await f.as(role);
      const res = await client.get('/dashboard');
      expect(res.status).toBe(403);
      expect(res.data).toBeUndefined();
      expect((await client.get('/dashboard/kpis')).status).toBe(403);
    });

    it('a part of a block the reader may not see is left out, not sent as null', async () => {
      const vet = await f.as('veterinarian');
      const { data } = (await vet.get('/dashboard')).data.blocks.staff;
      expect(Object.keys(data)).toEqual(['tasks']);
    });

    it('a module switched off for the tenant has no block, even for the owner', async () => {
      const other = await createFixture({ modules: MODULES.filter((m) => m !== 'finance' && m !== 'hr') });
      const owner = await other.as('owner');
      const res = await owner.get('/dashboard');
      expect(res.status).toBe(200);
      expect(res.data.order).not.toContain('finance');
      expect(res.data.blocks.finance).toBeUndefined();
      expect(res.data.blocks.staff.data.attendance).toBeUndefined();
    });

    it('a custom role takes the default order', async () => {
      const other = await createFixture();
      const owner = await other.as('owner');
      await other.run(() =>
        tx().update(schema.roles).set({ key: 'custom_lead' }).where(eq(schema.roles.id, other.roleIds.owner)),
      );
      expect((await owner.get('/dashboard')).data.order[0]).toBe('alerts');
    });

    it("does not show another tenant's farm", async () => {
      const other = await createFixture();
      const res = await (await other.as('owner')).get('/dashboard');
      expect(res.data.blocks.livestock.data.total).toBe(0);
      expect(res.data.blocks.finance.data.cash.total).toBe(0);
      expect(res.data.blocks.alerts.data.items).toEqual([]);
    });
  });

  describe('money and personal data (rules 7 and 8)', () => {
    it('a shepherd granted the dashboard gets no finance block and no money anywhere', async () => {
      const other = await createFixture();
      await arrange(other);
      await other.run(() =>
        tx()
          .update(schema.roles)
          .set({ permissions: [...DEFAULT_ROLE_PERMISSIONS.shepherd, 'dashboard.view'] })
          .where(eq(schema.roles.id, other.roleIds.shepherd)),
      );
      const shepherd = await other.as('shepherd');

      const dashboard = await shepherd.get('/dashboard');
      expect(dashboard.status).toBe(200);
      expect(dashboard.data.order).toEqual(['alerts', 'livestock', 'feed', 'staff']);
      expect(dashboard.data.blocks.finance).toBeUndefined();
      expectNoMoney(dashboard.body);

      const kpis = await shepherd.get('/dashboard/kpis');
      expect(kpis.status).toBe(200);
      expect(kpis.data.groups.finance).toBeUndefined();
      expectNoMoney(kpis.body);
    });

    it.each<RoleKey>(['storekeeper', 'zootechnician', 'veterinarian', 'agronomist'])(
      '%s receives no money on the dashboard or in KPIs',
      async (role) => {
        const client = await f.as(role);
        expectNoMoney((await client.get('/dashboard')).body);
        expectNoMoney((await client.get('/dashboard/kpis')).body);
      },
    );

    it('the scan itself finds money when money is there', async () => {
      const owner = await f.as('owner');
      expect(moneyKeys((await owner.get('/dashboard')).body).length).toBeGreaterThan(0);
    });

    it('an alert that reveals money reaches only readers who may see it', async () => {
      const titles = async (role: RoleKey) =>
        (await (await f.as(role)).get('/dashboard')).data.blocks.alerts.data.items.map((a: any) => a.title);
      expect(await titles('owner')).toContain('Budget');
      expect(await titles('storekeeper')).not.toContain('Budget');
    });

    it('an investor sees figures without personal data', async () => {
      const investor = await f.as('investor');
      const dashboard = await investor.get('/dashboard');
      const kpis = await investor.get('/dashboard/kpis');
      for (const body of [dashboard.body, kpis.body]) {
        const json = JSON.stringify(body);
        expect(json).not.toContain(EMPLOYEE_NAME);
        expect(json).not.toContain(EMPLOYEE_PHONE);
      }
      // Aggregates still reach them.
      expect(dashboard.data.blocks.livestock.data.total).toBe(10);
      expect(dashboard.data.blocks.staff.data.attendance).toEqual({ present: 1, total: 2 });
    });

    it('an investor gets the finance summary, but the books stay closed', async () => {
      const investor = await f.as('investor');
      const dashboard = await investor.get('/dashboard');
      expect(dashboard.data.order[0]).toBe('finance');
      expect(dashboard.data.blocks.finance.status).toBe('ok');
      expect((await investor.get('/dashboard/kpis')).data.groups.finance.status).toBe('ok');
      for (const path of ['/finance/transactions', '/finance/accounts', '/finance/counterparties']) {
        expect((await investor.get(path)).status).toBe(403);
      }
    });
  });

  describe('figures against hand-computed control numbers', () => {
    it('finance', async () => {
      const { data } = (await (await f.as('owner')).get('/dashboard')).data.blocks.finance;
      expect(data.month).toMatchObject({ month, income: INCOME, expense: EXPENSE });
      expect(data.cash.total).toBe(OPENING_BALANCE + INCOME - EXPENSE);
      expect(data.budget.month).toMatchObject({
        planned: BUDGET,
        actual: EXPENSE,
        deviation: EXPENSE - BUDGET,
        percent: (EXPENSE / BUDGET) * 100,
      });
      expect(data.budget.overruns).toHaveLength(1);
      expect(data.budget.overruns[0]).toMatchObject({ key: 'fuel', deviation: EXPENSE - BUDGET });
      expect(data.forecast.method).toBe('statistical');
      expect(data.forecast.months).toHaveLength(3);
      expect(data.forecast.months[0].month).toBe(month);
    });

    it('livestock', async () => {
      const { data } = (await (await f.as('zootechnician')).get('/dashboard')).data.blocks.livestock;
      expect(data.total).toBe(10);
      expect(data.byCategory).toEqual({ ewe: 9, ram: 1 });
      expect(data.pregnant).toBe(6);
      expect(data.sick).toBe(1);
      expect(data.quarantine).toBe(1);
      expect(data.mortality).toEqual({ dead: 0, percent: 0 });
      expect(data.lambing.totalEwes).toBe(6);
      expect(data.lambing.next7Days).toBe(0);
      expect(data.lambing.nextDate).toBe(addDays(now, 100));
      expect(data.lambing.overdue).toBe(0);
      // No lambing recorded yet, so no estimate of lambs: this is not a guess.
      expect(data.lambing.expectedLambs).toBeNull();
      expect(data.lambing.weeks.reduce((sum: number, w: any) => sum + w.expected, 0)).toBe(6);
      expect(data.weightTrend).toHaveLength(6);
      expect(data.weightTrend.every((m: any) => m.avgKg === null)).toBe(true);
    });

    it('feed: days remaining from actual consumption (spec 24.1)', async () => {
      const { data } = (await (await f.as('storekeeper')).get('/dashboard')).data.blocks.feed;
      const [hay] = data.items;
      // 1350 received, 7 × 50 issued: 1000 kg left at 50 kg a day is 20 days.
      expect(hay).toMatchObject({ name: 'Beda', stockQty: 1000, actualDaily: 50, days: 20, basis: 'actual', minDays: 30, belowMinimum: true });
      expect(data.limiting).toMatchObject({ name: 'Beda', days: 20, basis: 'actual' });
      expect(data.avgDailyKg).toBe(50);
      expect(data.lowStockCount).toBe(1);
      expect(data.consumption).toHaveLength(14);
      expect(data.consumption.filter((d: any) => d.qty === 50)).toHaveLength(7);
    });

    it('crops', async () => {
      const { data } = (await (await f.as('agronomist')).get('/dashboard')).data.blocks.crops;
      expect(data.status).toEqual({ sown: 1, irrigated: 0, harvested: 0, total: 2 });
      expect(data.harvest).toEqual({ plannedT: 40, actualT: 0 });
      expect(data.overdueCount).toBe(1);
      expect(data.overdue[0]).toMatchObject({ type: 'irrigation', fieldNumber: '1', date: addDays(now, -3) });
      expect(data.weather).toHaveLength(1);
      expect(data.weather[0]).toMatchObject({ tempMax: 9, frost: true });
    });

    it('staff and machinery', async () => {
      const { data } = (await (await f.as('owner')).get('/dashboard')).data.blocks.staff;
      expect(data.attendance).toEqual({ present: 1, total: 2 });
      expect(data.tasks).toEqual({ open: 2, overdue: 1, doneToday: 1 });
      expect(data.machinery).toMatchObject({ total: 2, byStatus: { working: 1, repair: 1 } });
      expect(data.fuel).toEqual({ liters: 0, days: 30 });
    });

    it('alerts come most severe first, with counts', async () => {
      const { data } = (await (await f.as('owner')).get('/dashboard')).data.blocks.alerts;
      expect(data.counts).toEqual({ urgent: 1, attention: 1, info: 1, total: 3 });
      expect(data.items.map((a: any) => a.severity)).toEqual(['urgent', 'attention', 'info']);
      // Internal columns stay inside the server.
      expect(data.items[0]).not.toHaveProperty('notifyRoles');
      expect(data.items[0]).not.toHaveProperty('permission');
    });

    it('cameras', async () => {
      const { data } = (await (await f.as('owner')).get('/dashboard')).data.blocks.cameras;
      expect(data.fleet).toEqual({ total: 2, online: 1, offline: 0, planned: 1 });
      expect(data.events).toHaveLength(1);
      expect(data.events[0]).toMatchObject({ deviceName: 'Molxona 1', type: 'camera.motion', sample: true });
      expect(data.events[0]).not.toHaveProperty('data');
    });

    it('an empty farm shows null, never an invented zero', async () => {
      const empty = await createFixture();
      const res = await (await empty.as('owner')).get('/dashboard');
      expect(res.status).toBe(200);
      const { livestock, feed, finance } = res.data.blocks;
      expect(livestock.data.mortality.percent).toBeNull();
      expect(livestock.data.lambing.nextDate).toBeNull();
      expect(feed.data.limiting).toBeNull();
      expect(feed.data.avgDailyKg).toBeNull();
      expect(finance.data.budget.month.percent).toBeNull();
    });
  });

  describe('a failing block', () => {
    it('leaves the rest working, even when the failure is a broken query', async () => {
      // A real SQL error aborts the shared transaction unless the block is in a savepoint.
      vi.mocked(cashPosition).mockImplementationOnce(async () => {
        await tx().execute(sql`select 1 / 0`);
        throw new Error('unreachable');
      });
      const res = await (await f.as('owner')).get('/dashboard');
      expect(res.status).toBe(200);
      expect(res.data.blocks.finance).toEqual({ status: 'unavailable', data: null });
      for (const key of ['alerts', 'livestock', 'feed', 'crops', 'staff', 'cameras']) {
        expect(res.data.blocks[key].status).toBe('ok');
      }
      expect(res.data.blocks.livestock.data.total).toBe(10);
    });

    it('also survives a failure in the first or the last block a reader loads', async () => {
      vi.mocked(herdSummary).mockRejectedValueOnce(new Error('boom'));
      const res = await (await f.as('zootechnician')).get('/dashboard');
      expect(res.status).toBe(200);
      expect(res.data.order[0]).toBe('livestock');
      expect(res.data.blocks.livestock.status).toBe('unavailable');
      expect(res.data.blocks.crops.status).toBe('ok');
    });

    it('a broken KPI group does not take down the others', async () => {
      vi.mocked(herdSummary).mockImplementationOnce(async () => {
        await tx().execute(sql`select 1 / 0`);
        throw new Error('unreachable');
      });
      const res = await (await f.as('owner')).get('/dashboard/kpis');
      expect(res.status).toBe(200);
      expect(res.data.groups.finance.status).toBe('unavailable');
      expect(res.data.groups.crops.status).toBe('ok');
      expect(res.data.groups.machinery.status).toBe('ok');
    });

    it('logs the failure with the name of the block', async () => {
      const log = { error: vi.fn() };
      const error = new Error('broken');
      const block = await f.run(() =>
        isolate('finance', log as never, async () => {
          throw error;
        }),
      );
      expect(block).toEqual({ status: 'unavailable', data: null });
      expect(log.error).toHaveBeenCalledWith({ err: error, block: 'finance' }, 'dashboard block failed');
    });
  });
});

describe('dashboard KPIs (spec 14.3)', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture();
    await arrange(f);
  });

  it('finance figures against control numbers', async () => {
    const { data } = (await (await f.as('owner')).get('/dashboard/kpis', { from: month, to: month })).data.groups.finance;
    // Hay is fed at 100 000 a day for the last 7 days, so how much falls in this month depends on the date.
    const hayUsed = [1, 2, 3, 4, 5, 6, 7].filter((day) => monthOf(addDays(now, -day)) === month).length * 100_000;
    const operating = EXPENSE + hayUsed;
    expect(data).toMatchObject({
      income: INCOME,
      operatingExpense: operating,
      profitabilityPercent: round(((INCOME - operating) / operating) * 100, 1),
      operatingRatio: round(operating / INCOME, 2),
      netCashflow: INCOME - EXPENSE,
      budgetDeviation: EXPENSE - BUDGET,
    });
    expect(data.budgetDeviationPercent).toBeCloseTo(((EXPENSE - BUDGET) / BUDGET) * 100, 1);
    // The herd earned 10 mln and bore the general 8 mln as overhead, since it is the only center
    // with head, plus the hay it ate this month: 50 kg × 2 000 for each feeding day that falls in
    // the month. How many do depends on today's date.
    const feedingDays = [1, 2, 3, 4, 5, 6, 7].filter((day) => monthOf(addDays(now, -day)) === month).length;
    expect(data.profitPerEwe).toBe(Math.round((INCOME - EXPENSE - feedingDays * 100_000) / 9));
  });

  it('staff, feed and machinery figures', async () => {
    const { groups } = (await (await f.as('owner')).get('/dashboard/kpis')).data;
    // 10 head and 30 ha over 2 employees; 1 present day and no absences.
    expect(groups.staff.data).toEqual({ headPerEmployee: 5, haPerEmployee: 15, attendancePercent: 100 });
    expect(groups.feed.data).toMatchObject({ stockDays: 20, limitingItem: 'Beda' });
    // Two owned tractors, no hours logged.
    expect(groups.machinery.data).toMatchObject({ utilizationPercent: 0, unplannedStops: 0, downtimeHours: 0 });
    expect(groups.livestock.data.mortalityPercent).toBe(0);
  });

  describe('feed per kg gained needs at least half the herd weighed', () => {
    /** 10 animals, 100 kg of hay given at 85 % dry matter, `weighed` of them gaining 2 kg each. */
    async function weighedFarm(weighed: number) {
      const other = await createFixture();
      await arrange(other);
      await other.run(async () => {
        const all = await tx().select().from(schema.animals);
        const [herd] = await tx().select().from(schema.herds);
        const [hay] = await tx().select().from(schema.items);
        const [warehouse] = await tx().select().from(schema.warehouses);
        const [log] = await tx()
          .insert(schema.dailyLogs)
          .values({ ...base(), herdId: herd.id, date: addDays(now, -1), headCount: 10 })
          .returning();
        await tx()
          .insert(schema.dailyLogLines)
          .values({ ...base(), logId: log.id, itemId: hay.id, warehouseId: warehouse.id, actualQty: 100 });
        await tx()
          .insert(schema.weightRecords)
          .values(
            all.slice(0, weighed).flatMap((animal) => [
              { ...base(), animalId: animal.id, date: addDays(now, -2), weightKg: 60 },
              { ...base(), animalId: animal.id, date: addDays(now, -1), weightKg: 62 },
            ]),
          );
      });
      const period = { from: monthOf(addDays(now, -2)), to: month };
      return (await (await other.as('owner')).get('/dashboard/kpis', period)).data.groups.livestock.data;
    }

    it('with the whole herd weighed, conversion is dry matter over gain', async () => {
      const data = await weighedFarm(10);
      // 100 kg × 85 % = 85 kg of dry matter over 10 × 2 kg gained.
      expect(data.feedConversion).toBe(4.25);
      expect(data.adgG).toBe(2000);
      expect(data.costPerKgLive).not.toBeNull();
    });

    it('with half weighed, the sample stands for the herd', async () => {
      const data = await weighedFarm(5);
      // Measured gain 5 × 2 kg scales to 20 kg for 10 head: 85 kg of dry matter over 20 kg.
      expect(data.feedConversion).toBe(4.25);
    });

    it('with a quarter weighed, the figures would be four times too high, so they are withheld', async () => {
      const data = await weighedFarm(2);
      expect(data.weighedAnimals).toBe(2);
      expect(data.feedConversion).toBeNull();
      expect(data.costPerKgLive).toBeNull();
      // The average per animal stays valid for a sample.
      expect(data.adgG).toBe(2000);
    });
  });

  it('a stock count is what makes feed losses known', async () => {
    const other = await createFixture();
    await arrange(other);
    const owner = await other.as('owner');
    const before = (await owner.get('/dashboard/kpis')).data.groups.feed.data;
    expect(before.lossPercent).toBeNull();

    await other.run(async () => {
      const [warehouse] = await tx().select().from(schema.warehouses);
      const [hay] = await tx().select().from(schema.items);
      const { adjustStock } = await import('../src/core/inventory');
      await tx().insert(schema.stockCounts).values({ ...base(), warehouseId: warehouse.id, date: now, status: 'approved' });
      // 1000 kg on paper, 950 found: 50 kg × 2 000 written off against 350 kg × 2 000 fed.
      await adjustStock({ itemId: hay.id, warehouseId: warehouse.id, actualQty: 950, date: now });
    });
    const after = (await owner.get('/dashboard/kpis')).data.groups.feed.data;
    expect(after.lossPercent).toBe(12.5);
  });

  it('with no finance permission, money KPIs are left out of each group', async () => {
    const { groups } = (await (await f.as('agronomist')).get('/dashboard/kpis')).data;
    expect(groups.finance).toBeUndefined();
    expect(groups.livestock.data).not.toHaveProperty('costPerKgLive');
    expect(groups.crops.data).not.toHaveProperty('costPerTon');
    expect(groups.feed.data).not.toHaveProperty('costPerHeadDay');
    expect(groups.machinery.data).not.toHaveProperty('costPerHa');
  });

  it('with the permission, money KPIs are there', async () => {
    const { groups } = (await (await f.as('owner')).get('/dashboard/kpis')).data;
    // 4 kg of hay a day at 2 000 so'm/kg.
    expect(groups.feed.data.costPerHeadDay).toBe(8000);
    expect(groups.livestock.data).toHaveProperty('costPerKgLive');
    expect(groups.crops.data).toHaveProperty('costPerTon');
    expect(groups.machinery.data).toHaveProperty('costPerHa');
  });

  it('an empty farm reports null, not zero', async () => {
    const empty = await createFixture();
    const { groups } = (await (await empty.as('owner')).get('/dashboard/kpis')).data;
    expect(groups.finance.data).toMatchObject({
      profitabilityPercent: null,
      profitPerEwe: null,
      operatingRatio: null,
      netCashflow: null,
      budgetDeviation: null,
      budgetDeviationPercent: null,
    });
    expect(groups.livestock.data).toMatchObject({
      lambingPercent: null,
      survivalPercent: null,
      adgG: null,
      feedConversion: null,
      mortalityPercent: null,
      costPerKgLive: null,
    });
    expect(groups.crops.data).toEqual({ yieldTHa: null, onTimePercent: null, waterM3PerTon: null, costPerTon: null });
    expect(groups.feed.data).toMatchObject({ stockDays: null, lossPercent: null, costPerHeadDay: null });
    expect(groups.staff.data).toEqual({ headPerEmployee: null, haPerEmployee: null, attendancePercent: null });
    expect(groups.machinery.data.utilizationPercent).toBeNull();
    expect(groups.machinery.data.costPerHa).toBeNull();
  });

  it('a season without income has no profitability yet, rather than -100 %', async () => {
    const other = await createFixture();
    await other.run(async () => {
      const [account] = await tx().insert(schema.accounts).values({ ...base(), name: 'K', type: 'cash' }).returning();
      const [fuel] = await tx().select().from(schema.financeCategories).where(sql`key = 'fuel' and tenant_id = ${ctx().tenantId}`);
      await postTransaction({
        date: now,
        type: 'expense',
        amount: 100,
        categoryId: fuel.id,
        paymentMethod: 'cash',
        accountId: account.id,
        costCenterId: await generalCostCenterId(),
        autoApprove: true,
      });
    });
    const { data } = (await (await other.as('owner')).get('/dashboard/kpis')).data.groups.finance;
    expect(data.operatingExpense).toBe(100);
    expect(data.profitabilityPercent).toBeNull();
  });

  it('stock bought is a cost only when it is used (rule 3)', async () => {
    const other = await createFixture();
    await other.run(async () => {
      const [account] = await tx().insert(schema.accounts).values({ ...base(), name: 'K', type: 'cash' }).returning();
      const category = async (key: string) =>
        (await tx().select().from(schema.financeCategories).where(sql`key = ${key} and tenant_id = ${ctx().tenantId}`))[0]!;
      const general = await generalCostCenterId();
      const [warehouse] = await tx().insert(schema.warehouses).values({ ...base(), name: 'W', type: 'feed' }).returning();
      const [hay] = await tx().insert(schema.items).values({ ...base(), name: 'Hay', category: 'feed', unit: 'kg' }).returning();
      const money = { date: now, paymentMethod: 'cash' as const, accountId: account.id, autoApprove: true };
      // 1 000 000 of feed bought, of which 200 000 is used, and 100 000 paid for fuel.
      await postTransaction({ ...money, type: 'expense', amount: 1_000_000, categoryId: (await category('feed')).id, costCenterId: general, costTreatment: 'inventory' });
      await receiveStock({ itemId: hay.id, warehouseId: warehouse.id, qty: 1000, unitCost: 1000, date: now, source: 'purchase' });
      await issueStock({ itemId: hay.id, warehouseId: warehouse.id, qty: 200, date: now, costCenterId: general, reason: 'ration' });
      await postTransaction({ ...money, type: 'expense', amount: 100_000, categoryId: (await category('fuel')).id, costCenterId: general });
      await postTransaction({ ...money, type: 'income', amount: 450_000, categoryId: (await category('wool_sales')).id, costCenterId: general });
    });
    const client = await other.as('owner');
    const { data } = (await client.get('/dashboard/kpis')).data.groups.finance;
    expect(data).toMatchObject({
      income: 450_000,
      operatingExpense: 300_000,
      // (450 000 − 300 000) / 300 000
      profitabilityPercent: 50,
    });
    const month = (await client.get('/finance/summary/month', { month: monthOf(now) })).data;
    expect(month.expense).toBe(1_100_000); // money paid is unchanged
    expect(month.operatingExpense).toBe(300_000);
  });

  it('rejects an impossible period', async () => {
    const owner = await f.as('owner');
    const backwards = await owner.get('/dashboard/kpis', { from: '2026-10', to: '2026-01' });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.code).toBe('INVALID_PERIOD');
    expect((await owner.get('/dashboard/kpis', { from: '2020-01', to: '2026-01' })).status).toBe(400);
    expect((await owner.get('/dashboard/kpis', { from: '2026-13' })).status).toBe(400);
  });

  it('accepts a past period and defaults to the current year', async () => {
    const owner = await f.as('owner');
    const past = await owner.get('/dashboard/kpis', { from: '2025-01', to: '2025-06' });
    expect(past.data.period).toEqual({ from: '2025-01', to: '2025-06' });
    expect(past.data.groups.finance.data.income).toBe(0);
    const current = await owner.get('/dashboard/kpis');
    expect(current.data.period).toEqual({ from: `${now.slice(0, 4)}-01`, to: month });
  });
});

describe('performance (acceptance 24.1: 10 people at once, under 2 seconds)', () => {
  it('holds with 500 animals, a season of records and everyone loading at the same moment', async () => {
    const f = await createFixture();
    await arrange(f);
    await f.run(async () => {
      const [sheep] = await tx().select().from(schema.species).where(eq(schema.species.key, 'sheep'));
      const [herd] = await tx().select().from(schema.herds);
      const ewes = await tx()
        .insert(schema.animals)
        .values(
          Array.from({ length: 490 }, (_, i) => ({
            ...base(),
            tag: `P-${i}`,
            speciesId: sheep.id,
            sex: 'female',
            category: 'ewe',
            origin: 'purchased',
            purchaseDate: addDays(now, -60),
            purchasePrice: 4_000_000,
            herdId: herd.id,
            status: 'pregnant',
            currentWeightKg: 60,
          })),
        )
        .returning({ id: schema.animals.id });
      await tx()
        .insert(schema.breedingRecords)
        .values(
          ewes.map((ewe, i) => {
            const expected = addDays(now, 90 + (i % 50));
            return {
              ...base(),
              eweId: ewe.id,
              source: 'purchase',
              matingDate: addDays(expected, -150),
              expectedDate: expected,
              expectedEarliest: addDays(expected, -5),
              expectedLatest: addDays(expected, 2),
            };
          }),
        );
      await tx()
        .insert(schema.weightRecords)
        .values(
          ewes.flatMap((ewe, i) => [
            { ...base(), animalId: ewe.id, date: addDays(now, -40), weightKg: 58 + (i % 5) },
            { ...base(), animalId: ewe.id, date: addDays(now, -10), weightKg: 60 + (i % 5) },
          ]),
        );

      const [hay] = await tx().select().from(schema.items);
      const [warehouse] = await tx().select().from(schema.warehouses);
      const herdCenter = await ensureCostCenter('herd', herd.id, herd.name);
      await receiveStock({ itemId: hay.id, warehouseId: warehouse.id, qty: 500_000, unitCost: 1800, date: addDays(now, -90), source: 'purchase' });
      for (let day = 8; day <= 40; day++) {
        await issueStock({ itemId: hay.id, warehouseId: warehouse.id, qty: 600, date: addDays(now, -day), costCenterId: herdCenter, reason: 'ration' });
      }

      const [account] = await tx().select().from(schema.accounts);
      const [fuel] = await tx().select().from(schema.financeCategories).where(sql`key = 'fuel' and tenant_id = ${ctx().tenantId}`);
      const general = await generalCostCenterId();
      for (let i = 0; i < 300; i++) {
        await postTransaction({
          date: addDays(now, -(i % 60)),
          type: 'expense',
          amount: 100_000 + i,
          categoryId: fuel.id,
          paymentMethod: 'cash',
          accountId: account.id,
          costCenterId: general,
          autoApprove: true,
        });
      }
    });

    const roles: RoleKey[] = [
      'owner',
      'director',
      'accountant',
      'agronomist',
      'zootechnician',
      'veterinarian',
      'storekeeper',
      'investor',
      'auditor',
    ];
    const clients: Client[] = [];
    for (const role of roles) clients.push(await f.as(role));
    clients.push(clients[0]);

    const measure = async (path: string) => {
      const samples: number[] = [];
      // First round warms the connection pool; the numbers that count are the rounds after it.
      for (let round = 0; round < 4; round++) {
        const results = await Promise.all(
          clients.map(async (client) => {
            const started = performance.now();
            const res = await client.get(path);
            expect(res.status).toBe(200);
            return performance.now() - started;
          }),
        );
        if (round > 0) samples.push(...results);
      }
      samples.sort((a, b) => a - b);
      return { median: samples[Math.floor(samples.length / 2)], max: samples[samples.length - 1] };
    };

    const dashboard = await measure('/dashboard');
    const kpis = await measure('/dashboard/kpis');
    console.log(`[perf] 10 concurrent, 500 animals, ms: dashboard median ${dashboard.median.toFixed(0)} max ${dashboard.max.toFixed(0)}; kpis median ${kpis.median.toFixed(0)} max ${kpis.max.toFixed(0)}`);

    const total = (await clients[0].get('/dashboard')).data.blocks.livestock.data.total;
    expect(total).toBe(500);
    expect(dashboard.max).toBeLessThan(2000);
    expect(kpis.max).toBeLessThan(4000);
  }, 120_000);
});
