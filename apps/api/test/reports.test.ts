import { and, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { DEFAULT_ROLE_PERMISSIONS, FINANCE_SUMMARY_VIEW, todayIso, type Permission, type RoleKey } from '@yap/shared';
import { resources } from '@yap/shared/i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db/client';
import { ctx, tx } from '../src/core/context';
import { ensureCostCenter, generalCostCenterId } from '../src/core/costCenters';
import { issueStock, receiveStock } from '../src/core/inventory';
import { postTransaction } from '../src/core/ledger';
import { addMember } from '../src/core/tenancy';
import { herdCost, incomeExpenseByCategory } from '../src/modules/finance/summary';
import { deliverDueReports, deliverSaved, isDue } from '../src/modules/reports/delivery';
import { runReport, presetRange } from '../src/modules/reports/engine';
import { csvCell, reportPdfDefinition } from '../src/modules/reports/export';
import { hasText } from '../src/modules/reports/i18n';
import { investorData, investorPdfDefinition, reportingMonth, sendMonthlyInvestorReport } from '../src/modules/reports/investor';
import { REPORTS, REPORTS_BY_KEY } from '../src/modules/reports/registry';
import { REPORT_MODULES, type Lang } from '../src/modules/reports/types';
import { createFixture, type Client, type Fixture } from './helpers';

const FROM = '2026-01-01';
const TO = '2026-12-31';
const PERIOD = { from: FROM, to: TO };

const EMPLOYEE_NAME = 'Karim Aliyev';
const EMPLOYEE_PHONE = '+998911112233';
const PURCHASE_PRICE = 1_000_000;

interface World {
  f: Fixture;
  herdId: string;
  otherHerdId: string;
  itemId: string;
  warehouseId: string;
  fieldId: string;
  seasonId: string;
  animalIds: string[];
}

/**
 * Control scenario, computed by hand.
 *
 *   Herd "Sovliqlar": 10 ewes at 1 000 000 each, bought 2026-02-01; one dies 2026-03-25.
 *   Income   wool 3 000 000 + grain 7 000 000                      = 10 000 000
 *   Expense  wages 2 000 000 (herd), electricity 1 000 000 (general),
 *            feed bought 4 000 000 ('inventory'), field work 8 000 000 (field)
 *                                                                  = 15 000 000
 *   Pending  repair 9 000 000: must not appear anywhere.
 *   Stock    2000 kg feed at 2000; 500 kg issued to the herd       =  1 000 000 materials
 *   Herd     accumulated 2 000 000 + 1 000 000 + overhead 1 000 000 = 4 000 000
 *            head 9, purchase 9 000 000, cost per head 13 000 000 / 9 = 1 444 444.44
 *   Field    10 ha, 40 t, cost 8 000 000: 4 t/ha, 200 000 per ton
 *   Feed     1500 kg left; ration 0.5 kg × 9 head = 4.5 kg/day; 333.3 days
 */
async function buildWorld(): Promise<World> {
  const f = await createFixture();
  const world = await f.run(async () => {
    const c = ctx();
    const base = { tenantId: c.tenantId, farmId: c.farmId };
    const [account] = await tx().insert(schema.accounts).values({ ...base, name: 'Kassa', type: 'cash', openingBalance: 50_000_000 }).returning();
    const categories = await tx().select().from(schema.financeCategories).where(eq(schema.financeCategories.tenantId, c.tenantId));
    const category = (key: string) => categories.find((row) => row.key === key)!.id;
    const general = await generalCostCenterId();

    const [sheep] = await tx()
      .select()
      .from(schema.species)
      .where(and(eq(schema.species.tenantId, c.tenantId), eq(schema.species.key, 'sheep')));
    const [herd] = await tx().insert(schema.herds).values({ ...base, name: 'Sovliqlar' }).returning();
    const [otherHerd] = await tx().insert(schema.herds).values({ ...base, name: 'Boshqa poda' }).returning();
    const herdCc = await ensureCostCenter('herd', herd.id, herd.name);
    await tx().update(schema.herds).set({ costCenterId: herdCc }).where(eq(schema.herds.id, herd.id));

    const animals = await tx()
      .insert(schema.animals)
      .values(
        Array.from({ length: 10 }, (_, i) => ({
          ...base,
          tag: `C-${String(i + 1).padStart(3, '0')}`,
          speciesId: sheep.id,
          sex: 'female',
          category: 'ewe',
          origin: 'purchased',
          purchaseDate: '2026-02-01',
          purchasePrice: PURCHASE_PRICE,
          herdId: herd.id,
          status: 'active',
          currentWeightKg: 60,
        })),
      )
      .returning();
    await tx()
      .insert(schema.animals)
      .values({ ...base, tag: 'OTHER-1', speciesId: sheep.id, sex: 'male', category: 'ram', origin: 'purchased', purchaseDate: '2026-02-01', herdId: otherHerd.id, status: 'active' });
    await tx().update(schema.animals).set({ status: 'dead', exitDate: '2026-03-25' }).where(eq(schema.animals.id, animals[9].id));
    await tx().insert(schema.animalExits).values({ ...base, animalId: animals[9].id, type: 'death', date: '2026-03-25', reason: 'Pnevmoniya', lossAmount: PURCHASE_PRICE });

    const post = (date: string, type: 'income' | 'expense', key: string, amount: number, costCenterId: string, costTreatment?: 'expense' | 'inventory') =>
      postTransaction({ date, type, categoryId: category(key), amount, paymentMethod: 'cash', accountId: account.id, costCenterId, costTreatment, autoApprove: true });

    await post('2026-03-10', 'income', 'wool_sales', 3_000_000, general);
    await post('2026-04-05', 'income', 'grain_sales', 7_000_000, general);
    await post('2026-03-15', 'expense', 'salary', 2_000_000, herdCc);
    await post('2026-03-20', 'expense', 'electricity', 1_000_000, general);
    await post('2026-03-01', 'expense', 'feed', 4_000_000, general, 'inventory');
    await postTransaction({
      date: '2026-03-21',
      type: 'expense',
      categoryId: category('repair'),
      amount: 9_000_000,
      paymentMethod: 'cash',
      accountId: account.id,
      costCenterId: general,
    });

    const [warehouse] = await tx().insert(schema.warehouses).values({ ...base, name: 'Ozuqa ombori', type: 'feed' }).returning();
    const [item] = await tx().insert(schema.items).values({ ...base, name: 'Beda', category: 'feed', unit: 'kg', dryMatterPct: 85 }).returning();
    await receiveStock({ itemId: item.id, warehouseId: warehouse.id, qty: 2000, unitCost: 2000, date: '2026-03-01', source: 'purchase' });
    await issueStock({ itemId: item.id, warehouseId: warehouse.id, qty: 500, date: '2026-03-02', costCenterId: herdCc, reason: 'ration' });

    const [ration] = await tx().insert(schema.rations).values({ ...base, name: 'Qishki', state: 'pregnant' }).returning();
    await tx().insert(schema.rationLines).values({ ...base, rationId: ration.id, itemId: item.id, kgPerHeadDay: 0.5 });
    await tx().update(schema.herds).set({ rationId: ration.id }).where(eq(schema.herds.id, herd.id));

    const [log] = await tx().insert(schema.dailyLogs).values({ ...base, herdId: herd.id, date: '2026-03-02', headCount: 10 }).returning();
    await tx().insert(schema.dailyLogLines).values({ ...base, logId: log.id, itemId: item.id, warehouseId: warehouse.id, plannedQty: 5, actualQty: 6, totalCost: 12_000 });

    const [field] = await tx().insert(schema.fields).values({ ...base, number: '7', areaHa: 10 }).returning();
    const fieldCc = await ensureCostCenter('field', field.id, 'Dala 7');
    await tx().update(schema.fields).set({ costCenterId: fieldCc }).where(eq(schema.fields.id, field.id));
    const [season] = await tx()
      .insert(schema.seasons)
      .values({ ...base, name: 'Test 2026', kind: 'autumn', startDate: '2026-01-01', endDate: '2026-12-31', isCurrent: true })
      .returning();
    const [crop] = await tx().select().from(schema.crops).where(and(eq(schema.crops.tenantId, c.tenantId), eq(schema.crops.key, 'wheat')));
    const [plan] = await tx()
      .insert(schema.cropPlans)
      .values({ ...base, seasonId: season.id, fieldId: field.id, cropId: crop.id, areaHa: 10, expectedYieldTHa: 5, plannedCost: 10_000_000, status: 'harvested' })
      .returning();
    await tx().insert(schema.harvests).values({ ...base, fieldId: field.id, cropPlanId: plan.id, date: '2026-07-01', grossT: 40 });
    await post('2026-05-01', 'expense', 'mechanization_service', 4_000_000, fieldCc);
    await post('2026-06-01', 'expense', 'mechanization_service', 4_000_000, fieldCc);

    const [employee] = await tx()
      .insert(schema.employees)
      .values({ ...base, fullName: EMPLOYEE_NAME, position: 'Mexanizator', phone: EMPLOYEE_PHONE, hireDate: '2026-01-10', baseRate: 3_000_000 })
      .returning();
    await tx()
      .insert(schema.timesheets)
      .values([
        { ...base, employeeId: employee.id, date: '2026-03-02', status: 'present', hours: 8 },
        { ...base, employeeId: employee.id, date: '2026-03-03', status: 'present', hours: 8 },
      ]);

    const [asset] = await tx()
      .insert(schema.assets)
      .values({ ...base, name: 'MTZ-82', type: 'tractor', inventoryNo: 'INV-1', fuelNormLPerHour: 10, purchasePrice: 100_000_000 })
      .returning();
    await tx().insert(schema.assetUsageLogs).values({ ...base, assetId: asset.id, date: '2026-03-05', motoHours: 5, volumeHa: 3, fuelL: 60 });

    const [buyer] = await tx().insert(schema.counterparties).values({ ...base, name: 'Xaridor MChJ', type: 'buyer' }).returning();
    const [sale] = await tx()
      .insert(schema.sales)
      .values({ ...base, date: '2026-04-10', counterpartyId: buyer.id, status: 'confirmed', totalAmount: 5_000_000 })
      .returning();
    await tx()
      .insert(schema.saleLines)
      .values({ ...base, saleId: sale.id, itemId: item.id, qty: 100, unit: 'kg', price: 50_000, amount: 5_000_000, costAmount: 3_000_000 });

    await tx().insert(schema.budgets).values({ ...base, month: '2026-03', categoryId: category('electricity'), amount: 2_000_000 });

    return {
      herdId: herd.id,
      otherHerdId: otherHerd.id,
      itemId: item.id,
      warehouseId: warehouse.id,
      fieldId: field.id,
      seasonId: season.id,
      animalIds: animals.map((a) => a.id),
    };
  });
  return { f, ...world };
}

/** Give a role extra permissions, the way a tenant customising roles would. */
async function grant(f: Fixture, role: RoleKey, extra: Permission[]) {
  await f.run(() =>
    tx()
      .update(schema.roles)
      .set({ permissions: [...DEFAULT_ROLE_PERMISSIONS[role], ...extra] })
      .where(and(eq(schema.roles.tenantId, f.tenantId), eq(schema.roles.key, role))),
  );
}

/** Exports are binary, which the JSON test client cannot return, so these go through inject. */
async function exportRaw(f: Fixture, token: string, key: string, format: string, query: Record<string, unknown> = {}) {
  return f.app.inject({
    method: 'GET',
    url: `/api/v1/reports/${key}/export`,
    query: Object.fromEntries(Object.entries({ format, ...query }).map(([k, v]) => [k, String(v)])),
    headers: { authorization: `Bearer ${token}` },
  });
}

async function tokenFor(f: Fixture, role: RoleKey) {
  const { signAccessToken } = await import('../src/core/tokens');
  const client = await f.as(role);
  return signAccessToken({ userId: client.userId, membershipId: client.membershipId, tenantId: f.tenantId, farmId: f.farmId });
}

async function readWorkbook(body: Buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(body as never);
  return book.worksheets[0];
}

function pdfPages(body: Buffer): number {
  return (body.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;
}

describe('catalogue', () => {
  it('meets the spec: over 40 reports and at least 5 per module', () => {
    expect(REPORTS.length).toBeGreaterThanOrEqual(40);
    const groups = { finance: 0, livestock: 0, stock: 0, crops: 0, hr: 0, assets: 0, sales: 0 };
    for (const report of REPORTS) {
      const group = report.module === 'feed' || report.module === 'inventory' ? 'stock' : report.module;
      groups[group] += 1;
    }
    for (const [group, count] of Object.entries(groups)) expect(count, group).toBeGreaterThanOrEqual(5);
    expect(new Set(REPORTS.map((r) => r.key)).size).toBe(REPORTS.length);
    expect(REPORT_MODULES.every((m) => REPORTS.some((r) => r.module === m))).toBe(true);
  });

  it('has a title, description and label for everything, in each language', () => {
    const missing: string[] = [];
    for (const lang of ['uz', 'ru', 'en'] as Lang[]) {
      for (const report of REPORTS) {
        for (const path of [`catalog.${report.key}.title`, `catalog.${report.key}.description`]) {
          if (!hasText(lang, path)) missing.push(`${lang}:${path}`);
        }
        for (const column of report.columns) {
          const path = `columns.${column.label ?? column.key}`;
          if (!hasText(lang, path)) missing.push(`${lang}:${path}`);
          if (column.enumGroup) {
            const group = column.enumGroup.startsWith('reports:')
              ? (resources[lang].reports as Record<string, unknown>)[column.enumGroup.slice(8)]
              : (resources[lang].enums as Record<string, unknown>)[column.enumGroup];
            if (!group) missing.push(`${lang}:enum ${column.enumGroup}`);
          }
        }
        for (const filter of report.filters) {
          if (!hasText(lang, `filters.${filter.key}`)) missing.push(`${lang}:filters.${filter.key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('marks every money column as sensitive, so none can reach someone without finance.view', () => {
    const unmarked = REPORTS.flatMap((r) =>
      r.columns.filter((c) => c.type === 'money' && !c.sensitive?.includes('money')).map((c) => `${r.key}.${c.key}`),
    );
    expect(unmarked).toEqual([]);
  });

  it('marks every person column as personal data', () => {
    const people = ['employee', 'vet', 'operator', 'phone'];
    const unmarked = REPORTS.flatMap((r) =>
      r.columns
        .filter((c) => people.includes(c.key) && c.type === 'text' && !c.sensitive?.includes('pii'))
        .map((c) => `${r.key}.${c.key}`),
    );
    expect(unmarked).toEqual([]);
  });

  it('never sums a rate or a unit price', () => {
    const summed = REPORTS.flatMap((r) =>
      r.columns.filter((c) => c.sum && (c.type === 'percent' || /^(costPer|avg|unitCost|price)/.test(c.key))).map((c) => `${r.key}.${c.key}`),
    );
    expect(summed).toEqual([]);
  });
});

describe('reports on the control scenario', () => {
  let w: World;
  let owner: Client;

  beforeAll(async () => {
    w = await buildWorld();
    owner = await w.f.as('owner');
  });

  const run = async (key: string, query: Record<string, unknown> = {}) => {
    const res = await owner.get(`/reports/${key}`, query);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.data;
  };

  it('every report runs on real data, and the owner sees them all', async () => {
    const failed: string[] = [];
    for (const report of REPORTS) {
      const query = report.filters.some((filter) => filter.type === 'period') ? PERIOD : {};
      const res = await owner.get(`/reports/${report.key}`, query);
      if (res.status !== 200) failed.push(`${report.key}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    expect(failed).toEqual([]);
    const list = await owner.get('/reports');
    expect(list.data.reports).toHaveLength(REPORTS.length);
  });

  it('every report exports to all three formats', async () => {
    const token = await tokenFor(w.f, 'owner');
    const failed: string[] = [];
    for (const report of REPORTS) {
      const query = report.filters.some((filter) => filter.type === 'period') ? PERIOD : {};
      for (const format of ['xlsx', 'csv', 'pdf']) {
        const res = await exportRaw(w.f, token, report.key, format, query);
        if (res.statusCode !== 200) failed.push(`${report.key}.${format}: ${res.statusCode} ${res.body.slice(0, 200)}`);
      }
    }
    expect(failed).toEqual([]);
  }, 120_000);

  it('income and expense match the hand count and leave out what is pending', async () => {
    const data = await run('finance.income_expense', PERIOD);
    expect(data.totals).toEqual({ income: 10_000_000, expense: 15_000_000 });
    const summary = await w.f.run(() => incomeExpenseByCategory(FROM, TO));
    expect(data.totals.income).toBe(summary.income);
    expect(data.totals.expense).toBe(summary.expense);
    expect(JSON.stringify(data.rows)).not.toContain('9000000');
  });

  it('monthly result nets to the same total', async () => {
    const data = await run('finance.monthly_result', { from: '2026-03-01', to: '2026-04-30' });
    expect(data.rows.map((r: any) => [r.month, r.income, r.expense])).toEqual([
      ['2026-03', 3_000_000, 7_000_000],
      ['2026-04', 7_000_000, 0],
    ]);
    expect(data.totals.net).toBe(3_000_000);
  });

  it('cost per head matches the hand count and the dashboard function', async () => {
    const data = await run('finance.cost_per_head');
    const row = data.rows.find((r: any) => r.herd === 'Sovliqlar');
    expect(row.head).toBe(9);
    expect(row.purchaseCost).toBe(9_000_000);
    expect(row.feed).toBe(1_000_000);
    expect(row.labor).toBe(2_000_000);
    expect(row.accumulated).toBe(4_000_000);
    expect(row.costPerHead).toBeCloseTo(1_444_444.44, 2);
    const engine = await w.f.run(() => herdCost(w.herdId));
    expect(row.costPerHead).toBe(engine.costPerHead);
  });

  it('cost per ton and yield match the hand count', async () => {
    const data = await run('finance.cost_per_ton', { seasonId: w.seasonId });
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ field: '7', actualCost: 8_000_000, harvestT: 40, yieldTHa: 4, costPerTon: 200_000 });
    expect((await run('crops.yield', { seasonId: w.seasonId })).rows[0]).toMatchObject({ expectedHarvestT: 50, harvestedT: 40, actualYieldTHa: 4, yieldDeviationPercent: -20 });
  });

  it('budget execution shows plan against fact', async () => {
    const data = await run('finance.budget_execution', { from: '2026-03-01', to: '2026-03-31' });
    const row = data.rows.find((r: any) => r.category === 'Elektr' || r.category === 'Электроэнергия' || r.category === 'Electricity');
    expect(row).toMatchObject({ planned: 2_000_000, actual: 1_000_000, percent: 50 });
  });

  it('herd movement matches, with an exact total row', async () => {
    const data = await run('livestock.herd_movement', { from: '2026-02-01', to: '2026-03-31' });
    expect(data.rows.map((r: any) => [r.month, r.opening, r.purchased, r.dead, r.closing])).toEqual([
      ['2026-02', 0, 11, 0, 11],
      ['2026-03', 11, 0, 1, 10],
    ]);
    expect(data.totals).toMatchObject({ opening: 0, purchased: 11, dead: 1, closing: 10 });
  });

  it('feed days remaining uses the ration when there is no recent use', async () => {
    const data = await run('feed.days_remaining', { lang: 'en' });
    expect(data.rows[0]).toMatchObject({ item: 'Beda', stockQty: 1500, plannedDaily: 4.5, days: 333.3, basis: 'Ration plan' });
  });

  it('feed use compares plan with actual', async () => {
    const data = await run('feed.consumption_by_herd', { from: '2026-03-01', to: '2026-03-31' });
    expect(data.rows[0]).toMatchObject({ herd: 'Sovliqlar', item: 'Beda', plannedQty: 5, actualQty: 6, deviationPercent: 20, totalCost: 12_000 });
  });

  it('fuel deviation is against the norm', async () => {
    const data = await run('assets.fuel', { from: '2026-03-01', to: '2026-03-31' });
    expect(data.rows[0]).toMatchObject({ asset: 'MTZ-82', fuelL: 60, litersPerHour: 12, normLPerHour: 10, deviationPercent: 20 });
  });

  it('sales reports add up, with margin', async () => {
    const data = await run('sales.by_month', PERIOD);
    expect(data.rows[0]).toMatchObject({ month: '2026-04', amount: 5_000_000, cost: 3_000_000, margin: 2_000_000 });
    expect(data.totals).toEqual({ amount: 5_000_000, cost: 3_000_000, margin: 2_000_000 });
  });

  it('timesheet counts days', async () => {
    const data = await run('hr.timesheet', { month: '2026-03' });
    expect(data.rows[0]).toMatchObject({ employee: EMPLOYEE_NAME, present: 2, hours: 16 });
  });

  it('a date range filters', async () => {
    const data = await run('finance.income_expense', { from: '2026-04-01', to: '2026-04-30' });
    expect(data.totals.income).toBe(7_000_000);
    expect(data.totals.expense).toBeNull();
    expect(data.period).toEqual({ from: '2026-04-01', to: '2026-04-30' });
  });

  it('a lookup filter limits rows, and a select filter too', async () => {
    const all = await run('livestock.animal_register');
    const one = await run('livestock.animal_register', { herdId: w.otherHerdId });
    expect(all.rows).toHaveLength(10);
    expect(one.rows.map((r: any) => r.tag)).toEqual(['OTHER-1']);
    const dead = await run('livestock.animal_register', { status: 'dead' });
    expect(dead.rows.map((r: any) => r.tag)).toEqual(['C-010']);
  });

  it('refuses bad filters by name', async () => {
    const expectField = async (query: Record<string, unknown>, code: string, key = 'finance.income_expense') => {
      const res = await owner.get(`/reports/${key}`, query);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(code);
      return res;
    };
    await expectField({ from: '2026-05-01', to: '2026-04-01' }, 'INVALID_RANGE');
    await expectField({ from: 'yesterday', to: '2026-04-01' }, 'VALIDATION_ERROR');
    await expectField({ preset: 'next_decade' }, 'VALIDATION_ERROR');
    await expectField({ herdId: 'not-a-uuid' }, 'VALIDATION_ERROR', 'livestock.animal_register');
    await expectField({ status: 'flying' }, 'VALIDATION_ERROR', 'livestock.animal_register');
    await expectField({ month: '2026-13' }, 'VALIDATION_ERROR', 'hr.timesheet');
    await expectField({ months: 999 }, 'VALIDATION_ERROR', 'finance.cashflow_forecast');
  });

  it('an unknown report is a 404', async () => {
    expect((await owner.get('/reports/nothing.here')).status).toBe(404);
  });

  it('presets give the right ranges', () => {
    const now = '2026-03-15';
    expect(presetRange('this_month', now)).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(presetRange('last_month', now)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(presetRange('last_month', '2026-01-10')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(presetRange('this_quarter', now)).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(presetRange('this_quarter', '2026-11-04')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(presetRange('last_7_days', now)).toEqual({ from: '2026-03-09', to: '2026-03-15' });
    expect(presetRange('last_year', now)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('compares two periods side by side, keeping rows found in only one', async () => {
    const data = await run('finance.income_expense', {
      from: '2026-03-01',
      to: '2026-03-31',
      compareFrom: '2026-04-01',
      compareTo: '2026-04-30',
      lang: 'en',
    });
    const wool = data.rows.find((r: any) => r.category === 'Wool sales');
    const grain = data.rows.find((r: any) => r.category === 'Grain sales');
    expect(wool).toMatchObject({ income: 3_000_000, income__b: 0, income__diff: 3_000_000, income__pct: null });
    expect(grain).toMatchObject({ income: 0, income__b: 7_000_000, income__diff: -7_000_000, income__pct: -100 });
    expect(data.totals).toMatchObject({ income: 3_000_000, income__b: 7_000_000, income__diff: -4_000_000 });
    expect(data.compareWith).toEqual({ from: '2026-04-01', to: '2026-04-30' });
  });

  it('compares two seasons', async () => {
    const data = await run('crops.field_costs', { seasonId: w.seasonId, compareSeasonId: w.seasonId });
    expect(data.rows[0]).toMatchObject({ actual: 8_000_000, actual__b: 8_000_000, actual__diff: 0, actual__pct: 0 });
  });

  it('refuses a comparison on grouped rows', async () => {
    const res = await owner.get('/reports/finance.income_expense', { ...PERIOD, compareFrom: FROM, compareTo: TO, groupBy: 'kind' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('COMPARE_WITH_GROUPING');
  });

  it('groups by a column, summing only what can be summed', async () => {
    const data = await run('finance.transactions', { from: FROM, to: TO, groupBy: 'paymentMethod', status: 'approved', lang: 'en' });
    expect(data.columns.map((c: any) => c.key)).toEqual(['paymentMethod', '__count', 'amountBase']);
    expect(data.rows).toEqual([{ paymentMethod: 'Cash', __count: 7, amountBase: 25_000_000 }]);
    expect(data.totals).toEqual({ __count: 7, amountBase: 25_000_000 });
  });

  it('groups dates by month', async () => {
    const data = await run('finance.transactions', { from: FROM, to: TO, groupBy: 'date', status: 'approved' });
    expect(data.rows.map((r: any) => r.date).sort()).toEqual(['2026-03', '2026-04', '2026-05', '2026-06']);
    expect(data.columns[0].type).toBe('month');
  });

  it('keeps only chosen columns, in order, and rejects a name no report has', async () => {
    const data = await run('finance.transactions', { from: FROM, to: TO, columns: 'amountBase,date' });
    expect(data.columns.map((c: any) => c.key)).toEqual(['amountBase', 'date']);
    expect(Object.keys(data.rows[0])).toEqual(['amountBase', 'date']);
    const bad = await owner.get('/reports/finance.transactions', { columns: 'madeUp' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('UNKNOWN_COLUMN');
  });

  it('refuses grouping on a number', async () => {
    const res = await owner.get('/reports/finance.transactions', { groupBy: 'amountBase' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_GROUPING');
  });

  it('localizes labels and reference names per language', async () => {
    const ru = await run('livestock.animal_register', { lang: 'ru' });
    expect(ru.title).toBe('Реестр животных');
    expect(ru.columns.find((c: any) => c.key === 'tag').label).toBe('Бирка');
    expect(ru.rows[0].category).toBe((resources.ru.enums as any).animalCategory.ewe);
    const cyr = await run('livestock.animal_register', { lang: 'uz-Cyrl' });
    expect(cyr.title).toBe('Ҳайвонлар реестри');
    const name = await run('finance.income_expense', { ...PERIOD, lang: 'ru' });
    expect(name.rows.some((r: any) => r.category === 'Продажа шерсти')).toBe(true);
  });

  it('shows missing data as null, never as zero', async () => {
    const data = await run('finance.cost_per_kg');
    expect(data.rows.find((r: any) => r.herd === 'Sovliqlar').costPerKg).toBeNull();
  });

  it('quotes feed conversion only when at least half the herd was weighed, and null is never 0', async () => {
    const world = await buildWorld();
    const client = await world.f.as('owner');
    const weigh = (ids: string[]) =>
      world.f.run(() =>
        tx()
          .insert(schema.weightRecords)
          .values(
            ids.flatMap((animalId) => [
              { tenantId: world.f.tenantId, farmId: world.f.farmId, animalId, date: '2026-03-01', weightKg: 50 },
              { tenantId: world.f.tenantId, farmId: world.f.farmId, animalId, date: '2026-03-31', weightKg: 60 },
            ]),
          ),
      );
    const query = { from: '2026-03-01', to: '2026-03-31' };
    const herdRow = async () => {
      const res = await client.get('/reports/livestock.weight_gain', query);
      return res.data.rows.find((r: any) => r.herd === 'Sovliqlar');
    };

    await weigh(world.animalIds.slice(0, 2));
    const few = await herdRow();
    expect(few.animals).toBe(2);
    expect(few.gainKg).toBe(20);
    expect(few.feedConversion).toBeNull();

    const costs = await client.get('/reports/finance.cost_per_kg', { lang: 'en' });
    expect(costs.data.rows[0].costPerKg).toBeNull();
    expect(costs.data.notes.join(' ')).toContain('at least half of the herd');

    await weigh(world.animalIds.slice(2, 5));
    const half = await herdRow();
    expect(half.animals).toBe(5);
    // 6 kg of feed at 85 % dry matter is 5.1 kg, over a gain of 50 kg scaled to the 9 head on the farm.
    expect(half.feedConversion).toBeCloseTo(5.1 / 90, 4);
  });

  it('adds notes that explain a figure', async () => {
    const data = await run('livestock.mortality', { from: '2026-03-01', to: '2026-03-31', lang: 'en' });
    expect(data.rows[0]).toMatchObject({ tag: 'C-010', reason: 'Pnevmoniya', lossAmount: PURCHASE_PRICE });
    // 1 dead over an average of (11 + 10) / 2 = 10.5 head.
    expect(data.notes[0]).toContain('9.52');
  });
});

describe('exports', () => {
  let w: World;
  let token: string;

  beforeAll(async () => {
    w = await buildWorld();
    token = await tokenFor(w.f, 'owner');
  });

  it('Excel holds real numbers and dates, headers in the chosen language, and the context', async () => {
    const res = await exportRaw(w.f, token, 'finance.transactions', 'xlsx', { ...PERIOD, status: 'approved', lang: 'ru' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('finance_transactions_2026-01-01_2026-12-31.xlsx');

    const sheet = await readWorkbook(res.rawPayload);
    const values = sheet.getColumn(1).values as unknown[];
    const text = values.filter((v) => typeof v === 'string').join('\n');
    const [tenant] = await w.f.run(() => tx().select().from(schema.tenants).where(eq(schema.tenants.id, w.f.tenantId)));
    expect(text).toContain(tenant.name);
    expect(text).toContain('Журнал операций');
    expect(text).toContain('01.01.2026 – 31.12.2026');
    expect(text).toContain('Сформирован');

    let headerRow = 0;
    sheet.eachRow((row, number) => {
      if (row.getCell(1).value === 'Дата') headerRow = number;
    });
    expect(headerRow).toBeGreaterThan(0);
    const headers = (sheet.getRow(headerRow).values as unknown[]).slice(1);
    expect(headers).toContain('Сумма в базовой валюте');

    const amountColumn = headers.indexOf('Сумма в базовой валюте') + 1;
    const first = sheet.getRow(headerRow + 1);
    expect(typeof first.getCell(amountColumn).value).toBe('number');
    expect(first.getCell(amountColumn).numFmt).toBe('#,##0');
    expect(first.getCell(1).value).toBeInstanceOf(Date);
    expect(first.getCell(1).numFmt).toBe('dd.mm.yyyy');

    const last = sheet.getRow(sheet.rowCount);
    expect(last.getCell(amountColumn).value).toBe(25_000_000);
    expect(last.getCell(amountColumn).font?.bold).toBe(true);
  });

  it('Excel stores a percentage as a true percentage', async () => {
    const res = await exportRaw(w.f, token, 'finance.budget_execution', 'xlsx', { from: '2026-03-01', to: '2026-03-31', lang: 'en' });
    const sheet = await readWorkbook(res.rawPayload);
    let found: ExcelJS.Cell | undefined;
    sheet.eachRow((row) => {
      if (row.getCell(2).value === 'Electricity') found = row.getCell(6);
    });
    expect(found?.value).toBe(0.5);
    expect(found?.numFmt).toBe('0.0%');
  });

  it('CSV is UTF-8 with a byte order mark and carries the context', async () => {
    const res = await exportRaw(w.f, token, 'livestock.animal_register', 'csv', { lang: 'ru' });
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const text = res.rawPayload.toString('utf8');
    expect(text).toContain('Реестр животных');
    expect(text).toContain('Сформирован');
    expect(text).toContain('C-001');
  });

  it('CSV defuses text that a spreadsheet would run as a formula', async () => {
    expect(csvCell('=HYPERLINK("http://evil")', true)).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+998901234567', true)).toBe(`'+998901234567`);
    expect(csvCell('@SUM(A1)', true)).toBe(`'@SUM(A1)`);
    expect(csvCell('-5', false)).toBe('-5');
    expect(csvCell('oddiy, matn', true)).toBe('"oddiy, matn"');

    await w.f.run(() =>
      tx().update(schema.animals).set({ tag: '=1+1' }).where(eq(schema.animals.id, w.animalIds[0])),
    );
    const res = await exportRaw(w.f, token, 'livestock.animal_register', 'csv');
    expect(res.rawPayload.toString('utf8')).toContain(`'=1+1`);
    await w.f.run(() => tx().update(schema.animals).set({ tag: 'C-001' }).where(eq(schema.animals.id, w.animalIds[0])));
  });

  it('PDF is a valid document', async () => {
    const res = await exportRaw(w.f, token, 'finance.income_expense', 'pdf', { ...PERIOD, lang: 'uz-Cyrl' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.rawPayload.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdfPages(res.rawPayload)).toBeGreaterThanOrEqual(1);
  });

  it('PDF turns wide tables landscape', async () => {
    const wide = await w.f.run(() =>
      runReport(REPORTS_BY_KEY.get('livestock.animal_register')!, { raw: {}, lang: 'uz' }),
    );
    expect(reportPdfDefinition(wide).pageOrientation).toBe('landscape');
  });

  it('refuses an unknown format', async () => {
    const res = await exportRaw(w.f, token, 'finance.income_expense', 'docx', PERIOD);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FORMAT');
  });
});

describe('sensitivity', () => {
  let w: World;

  beforeAll(async () => {
    w = await buildWorld();
  });

  const priceValue = String(PURCHASE_PRICE);

  it('a shepherd has no reports at all (spec 24.1)', async () => {
    const shepherd = await w.f.as('shepherd');
    expect((await shepherd.get('/reports')).status).toBe(403);
    expect((await shepherd.get('/reports/livestock.animal_register')).status).toBe(403);
    const token = await tokenFor(w.f, 'shepherd');
    expect((await exportRaw(w.f, token, 'livestock.animal_register', 'xlsx')).statusCode).toBe(403);
    expect((await exportRaw(w.f, token, 'finance.income_expense', 'csv')).statusCode).toBe(403);
    expect((await shepherd.get('/reports/investor')).status).toBe(403);
  });

  it('an investor runs no money report and sees none in the catalogue', async () => {
    const investor = await w.f.as('investor');
    const list = await investor.get('/reports');
    expect(list.status).toBe(200);
    const keys = list.data.reports.map((r: any) => r.key);
    const money = REPORTS.filter((r) => r.money).map((r) => r.key);
    expect(money.length).toBeGreaterThan(15);
    expect(keys.filter((k: string) => money.includes(k))).toEqual([]);
    expect(keys).toContain('livestock.herd_movement');

    const denied = await investor.get('/reports/finance.income_expense');
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.required).toEqual(['finance.view']);
    const token = await tokenFor(w.f, 'investor');
    expect((await exportRaw(w.f, token, 'finance.cost_per_head', 'pdf')).statusCode).toBe(403);
  });

  it("an investor's report and every export of it have no money column", async () => {
    const investor = await w.f.as('investor');
    const json = await investor.get('/reports/livestock.animal_register', { lang: 'en' });
    expect(json.status).toBe(200);
    expect(json.data.columns.map((c: any) => c.key)).not.toContain('purchasePrice');
    expect(json.data.columns.map((c: any) => c.key)).not.toContain('seller');
    expect(Object.keys(json.data.rows[0])).not.toContain('purchasePrice');
    expect(JSON.stringify(json.data.rows)).not.toContain(priceValue);
    expect(json.data.totals).toBeNull();
    expect(json.data.hidden.money).toBe(2);

    const token = await tokenFor(w.f, 'investor');
    const xlsx = await exportRaw(w.f, token, 'livestock.animal_register', 'xlsx', { lang: 'en' });
    const sheet = await readWorkbook(xlsx.rawPayload);
    const cells: unknown[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => cells.push(cell.value)));
    expect(cells).not.toContain('Purchase price');
    expect(cells).not.toContain(PURCHASE_PRICE);

    const csv = await exportRaw(w.f, token, 'livestock.animal_register', 'csv', { lang: 'en' });
    expect(csv.rawPayload.toString('utf8')).not.toContain('Purchase price');
    expect(csv.rawPayload.toString('utf8')).not.toContain(priceValue);

    const pdf = await exportRaw(w.f, token, 'livestock.animal_register', 'pdf', { lang: 'en' });
    expect(pdf.statusCode).toBe(200);
  });

  it('the PDF model also holds no forbidden column for an investor', async () => {
    const permissions = DEFAULT_ROLE_PERMISSIONS.investor;
    const result = await w.f.run(
      () => runReport(REPORTS_BY_KEY.get('livestock.animal_register')!, { raw: {}, lang: 'en' }),
      { permissions },
    );
    const model = JSON.stringify(reportPdfDefinition(result));
    expect(model).not.toContain('Purchase price');
    expect(model).not.toContain('1 000 000');
    expect(model).toContain('C-001');
  });

  it('asking for a hidden column by name does not reveal it', async () => {
    const investor = await w.f.as('investor');
    const res = await investor.get('/reports/livestock.animal_register', { columns: 'tag,purchasePrice', lang: 'en' });
    expect(res.status).toBe(200);
    expect(res.data.columns.map((c: any) => c.key)).toEqual(['tag']);
    expect(JSON.stringify(res.data.rows)).not.toContain(priceValue);
  });

  it('asking for only hidden columns leaks nothing either', async () => {
    const investor = await w.f.as('investor');
    const res = await investor.get('/reports/livestock.animal_register', { columns: 'purchasePrice' });
    expect(res.status).toBe(200);
    expect(res.data.columns.map((c: any) => c.key)).not.toContain('purchasePrice');
    expect(JSON.stringify(res.data.rows)).not.toContain(priceValue);
  });

  it('a hidden column cannot be reached through grouping', async () => {
    const investor = await w.f.as('investor');
    const res = await investor.get('/reports/livestock.animal_register', { groupBy: 'seller' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_GROUPING');
    const totals = await investor.get('/reports/livestock.animal_register', { groupBy: 'category' });
    expect(JSON.stringify(totals.data)).not.toContain(priceValue);
    expect(totals.data.columns.map((c: any) => c.key)).toEqual(['category', '__count']);
  });

  it('a shepherd given reports.view still gets no money, in any format', async () => {
    const f = (await buildWorld()).f;
    await grant(f, 'shepherd', ['reports.view']);
    const shepherd = await f.as('shepherd');
    const json = await shepherd.get('/reports/livestock.animal_register', { lang: 'en' });
    expect(json.status).toBe(200);
    expect(json.data.columns.map((c: any) => c.key)).not.toContain('purchasePrice');

    const token = await tokenFor(f, 'shepherd');
    const csv = await exportRaw(f, token, 'livestock.animal_register', 'csv', { lang: 'en' });
    expect(csv.statusCode).toBe(200);
    expect(csv.rawPayload.toString('utf8')).not.toContain('Purchase price');
    expect(csv.rawPayload.toString('utf8')).not.toContain(priceValue);
    const xlsx = await exportRaw(f, token, 'livestock.animal_register', 'xlsx', { lang: 'en' });
    const cells: unknown[] = [];
    (await readWorkbook(xlsx.rawPayload)).eachRow((row) => row.eachCell((cell) => cells.push(cell.value)));
    expect(cells).not.toContain(PURCHASE_PRICE);
    expect((await shepherd.get('/reports/finance.income_expense')).status).toBe(403);
  });

  it('a mixed report keeps its operational columns and drops cost', async () => {
    const investor = await w.f.as('investor');
    const res = await investor.get('/reports/feed.consumption_by_herd', { from: '2026-03-01', to: '2026-03-31' });
    expect(res.data.rows[0]).toMatchObject({ plannedQty: 5, actualQty: 6, deviationPercent: 20 });
    expect(res.data.rows[0]).not.toHaveProperty('totalCost');
    const kpi = await investor.get('/reports/livestock.kpi', { ...PERIOD, lang: 'en' });
    expect(kpi.data.rows.map((r: any) => r.indicator)).not.toContain('Cost per kg live weight');
  });

  it('a role with hr.view but no pii.view gets no names or phones, in any format', async () => {
    const f = (await buildWorld()).f;
    await grant(f, 'mechanic', ['reports.view', 'hr.view']);
    const mechanic = await f.as('mechanic');
    const sheet = await mechanic.get('/reports/hr.timesheet', { month: '2026-03' });
    expect(sheet.status).toBe(200);
    expect(sheet.data.columns.map((c: any) => c.key)).not.toContain('employee');
    expect(JSON.stringify(sheet.data)).not.toContain(EMPLOYEE_NAME);
    expect(sheet.data.hidden.pii).toBe(1);

    const staff = await mechanic.get('/reports/hr.staff');
    expect(JSON.stringify(staff.data)).not.toContain(EMPLOYEE_NAME);
    expect(JSON.stringify(staff.data)).not.toContain(EMPLOYEE_PHONE);

    const token = await tokenFor(f, 'mechanic');
    const csv = await exportRaw(f, token, 'hr.staff', 'csv');
    expect(csv.rawPayload.toString('utf8')).not.toContain(EMPLOYEE_NAME);
    expect(csv.rawPayload.toString('utf8')).not.toContain(EMPLOYEE_PHONE);
  });

  it('personal reports need hr.view at all', async () => {
    const investor = await w.f.as('investor');
    expect((await investor.get('/reports/hr.timesheet')).status).toBe(403);
    expect((await investor.get('/reports/hr.staff')).status).toBe(403);
  });

  it('a pay report needs both finance.view and payroll.view', async () => {
    const f = (await buildWorld()).f;
    await grant(f, 'mechanic', ['reports.view', 'finance.view']);
    const mechanic = await f.as('mechanic');
    const res = await mechanic.get('/reports/hr.payroll');
    expect(res.status).toBe(403);
    expect(res.body.error.details.required).toEqual(['finance.view', 'payroll.view']);
  });

  it('another tenant sees only its own figures', async () => {
    const other = await createFixture();
    const owner = await other.as('owner');
    const res = await owner.get('/reports/finance.income_expense', PERIOD);
    expect(res.status).toBe(200);
    expect(res.data.rows).toEqual([]);
    expect((await owner.get('/reports/livestock.animal_register')).data.rows).toEqual([]);
  });

  it('a disabled module hides its reports and refuses them', async () => {
    const f = await createFixture({ modules: ['reports', 'livestock'] });
    const owner = await f.as('owner');
    const list = await owner.get('/reports');
    expect(new Set(list.data.reports.map((r: any) => r.module))).toEqual(new Set(['livestock']));
    const res = await owner.get('/reports/finance.income_expense');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MODULE_DISABLED');
  });
});

describe('investor one-pager', () => {
  let w: World;

  beforeAll(async () => {
    w = await buildWorld();
  });

  it('holds the farm figures for the month', async () => {
    const investor = await w.f.as('investor');
    const res = await investor.get('/reports/investor', { month: '2026-03' });
    expect(res.status).toBe(200);
    expect(res.data.finance).toMatchObject({ income: 3_000_000, expense: 7_000_000, net: -4_000_000 });
    expect(res.data.finance.operatingExpense).toBe(7_000_000);
    // Farm-wide, so the ram in the second herd counts: (9 000 000 + 4 000 000) / 10 head.
    expect(res.data.finance.costPerHead).toBe(1_300_000);
    expect(res.data.livestock).toMatchObject({ head: 10, dead: 1 });
    expect(res.data.crops).toMatchObject({ total: 1, harvestPlannedT: 50, harvestActualT: 40 });
  });

  it('fits on one page and contains no personal data', async () => {
    const token = await tokenFor(w.f, 'investor');
    const res = await w.f.app.inject({
      method: 'GET',
      url: '/api/v1/reports/investor/pdf',
      query: { month: '2026-03', lang: 'ru' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfPages(res.rawPayload)).toBe(1);

    const data = await w.f.run(() => investorData('2026-03'), { permissions: DEFAULT_ROLE_PERMISSIONS.investor });
    for (const text of [JSON.stringify(data), JSON.stringify(investorPdfDefinition(data, 'uz'))]) {
      expect(text).not.toContain(EMPLOYEE_NAME);
      expect(text).not.toContain(EMPLOYEE_PHONE);
      expect(text).not.toContain('Xaridor MChJ');
    }
  });

  it('stays on one page in every language, with a full set of figures', async () => {
    const data = await w.f.run(() => investorData('2026-03'));
    const { renderPdf } = await import('../src/modules/reports/pdf');
    for (const lang of ['uz', 'uz-Cyrl', 'ru', 'en'] as Lang[]) {
      const body = await renderPdf(investorPdfDefinition(data, lang));
      expect(pdfPages(body), lang).toBe(1);
    }
  });

  it('a tenant can grant it to another role through the role matrix', async () => {
    const f = (await buildWorld()).f;
    const denied = await (await f.as('zootechnician')).get('/reports/investor', { month: '2026-03' });
    expect(denied.status).toBe(403);
    await grant(f, 'zootechnician', [FINANCE_SUMMARY_VIEW as Permission]);
    const allowed = await (await f.as('zootechnician')).get('/reports/investor', { month: '2026-03' });
    expect(allowed.status).toBe(200);
    expect((await (await f.as('zootechnician')).get('/reports/finance.income_expense')).status).toBe(403);
  });

  it('is refused to reports.view holders without finance.view or finance.summary', async () => {
    const zootechnician = await w.f.as('zootechnician');
    const res = await zootechnician.get('/reports/investor');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVESTOR_REPORT_FORBIDDEN');
    expect((await (await w.f.as('accountant')).get('/reports/investor', { month: '2026-03' })).status).toBe(200);
  });

  it('does not leave the investor holding finance.view afterwards', async () => {
    const investor = await w.f.as('investor');
    await investor.get('/reports/investor', { month: '2026-03' });
    expect((await investor.get('/reports/finance.income_expense')).status).toBe(403);
    await w.f.run(
      async () => {
        await investorData('2026-03');
        expect(ctx().permissions.has('finance.view')).toBe(false);
      },
      { permissions: DEFAULT_ROLE_PERMISSIONS.investor },
    );
  });

  it('the monthly job stores the PDF, tells investors, and runs once per month', async () => {
    const investor = await w.f.as('investor');
    expect(await w.f.run(() => sendMonthlyInvestorReport('2026-03'))).toBe('sent');
    expect(await w.f.run(() => sendMonthlyInvestorReport('2026-03'))).toBe('exists');

    const notes = await w.f.run(() =>
      tx().select().from(schema.notifications).where(eq(schema.notifications.userId, investor.userId)),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain('03.2026');
    expect(notes[0].link).toBe('/reports?tab=investor&month=2026-03');
    expect(notes[0].deliveries).toEqual({ telegram: 'pending' });

    const archive = await investor.get('/reports/investor/archive');
    expect(archive.data).toHaveLength(1);
    expect(archive.data[0].month).toBe('2026-03');
    const file = await w.f.app.inject({ method: 'GET', url: archive.data[0].url });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('reports on the month that has just closed', () => {
    expect(reportingMonth('2026-11-01')).toBe('2026-10');
    expect(reportingMonth('2027-01-01')).toBe('2026-12');
  });
});

describe('report builder and delivery', () => {
  let w: World;
  let owner: Client;

  beforeAll(async () => {
    w = await buildWorld();
    owner = await w.f.as('owner');
  });

  const body = (over: object = {}) => ({
    name: 'Hayvonlar',
    reportKey: 'livestock.animal_register',
    config: { columns: ['tag', 'purchasePrice'] },
    ...over,
  });

  it('saves, lists, updates and deletes', async () => {
    const created = await owner.post('/reports/saved', body({ schedule: 'daily', channels: ['telegram'] }));
    expect(created.status).toBe(201);
    expect(created.data.recipients).toEqual([owner.userId]);

    expect((await owner.get('/reports/saved')).data.map((s: any) => s.id)).toContain(created.data.id);
    const updated = await owner.patch(`/reports/saved/${created.data.id}`, { name: 'Yangi', schedule: null });
    expect(updated.data).toMatchObject({ name: 'Yangi', schedule: null });
    expect((await owner.delete(`/reports/saved/${created.data.id}`)).status).toBe(200);
    expect((await owner.get('/reports/saved')).data.map((s: any) => s.id)).not.toContain(created.data.id);
  });

  it('refuses a saved report that cannot run', async () => {
    const code = async (over: object) => (await owner.post('/reports/saved', body(over))).body.error.code;
    expect(await code({ reportKey: 'nope.nothing' })).toBe('UNKNOWN_REPORT');
    expect(await code({ config: { columns: ['madeUp'] } })).toBe('UNKNOWN_COLUMN');
    expect(await code({ config: { groupBy: 'madeUp' } })).toBe('INVALID_GROUPING');
    expect(await code({ config: { filters: { herdId: 'bad' } } })).toBe('VALIDATION_ERROR');
    expect(await code({ schedule: 'hourly' })).toBe('VALIDATION_ERROR');
  });

  it('a person cannot save a report they cannot run', async () => {
    const investor = await w.f.as('investor');
    const res = await investor.post('/reports/saved', body({ reportKey: 'finance.income_expense', config: {} }));
    expect(res.status).toBe(403);
  });

  it('without reports.update, a report can only go to yourself', async () => {
    const investor = await w.f.as('investor');
    const res = await investor.post('/reports/saved', body({ recipients: [owner.userId], config: {} }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RECIPIENTS_FORBIDDEN');
  });

  it('a recipient must work on this farm', async () => {
    const other = await createFixture();
    const stranger = await other.as('owner');
    const res = await owner.post('/reports/saved', body({ recipients: [stranger.userId] }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNKNOWN_RECIPIENT');
  });

  it("one person cannot see or delete another's saved report", async () => {
    const investor = await w.f.as('investor');
    const auditor = await w.f.as('auditor');
    const created = await investor.post('/reports/saved', body({ name: 'Mine', config: {} }));
    expect(created.status).toBe(201);
    expect((await auditor.get('/reports/saved')).data.map((s: any) => s.id)).not.toContain(created.data.id);
    expect((await auditor.delete(`/reports/saved/${created.data.id}`)).status).toBe(404);
    expect((await owner.get('/reports/saved')).data.map((s: any) => s.id)).toContain(created.data.id);
  });

  it('a recipient can open a report sent to them, but not change, resend or delete it', async () => {
    const f = (await buildWorld()).f;
    const boss = await f.as('owner');
    const investor = await f.as('investor');
    const created = await boss.post('/reports/saved', {
      name: 'Hammaga',
      reportKey: 'livestock.herd_structure',
      config: {},
      recipients: [boss.userId, investor.userId],
    });
    // The link in a delivered message opens the report by this id, so it must be readable.
    expect((await investor.get('/reports/saved')).data.map((s: any) => s.id)).toEqual([created.data.id]);

    for (const res of [
      await investor.patch(`/reports/saved/${created.data.id}`, { name: 'Boshqa' }),
      await investor.delete(`/reports/saved/${created.data.id}`),
      await investor.post(`/reports/saved/${created.data.id}/send`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('NOT_REPORT_OWNER');
    }
  });

  it('delivery builds the report with each recipient’s own permissions', async () => {
    const f = (await buildWorld()).f;
    await grant(f, 'shepherd', ['reports.view']);
    const boss = await f.as('owner');
    const shepherd = await f.as('shepherd');
    const created = await boss.post('/reports/saved', {
      name: 'Tannarx',
      reportKey: 'livestock.animal_register',
      config: { columns: ['tag', 'purchasePrice'] },
      schedule: 'daily',
      channels: ['telegram'],
      recipients: [boss.userId, shepherd.userId],
    });
    expect(created.status).toBe(201);

    const sent = await f.run(async () => {
      const [row] = await tx().select().from(schema.savedReports).where(eq(schema.savedReports.id, created.data.id));
      return deliverSaved(row);
    });
    expect(sent).toBe(2);

    const bodyOf = async (userId: string) => {
      const [note] = await f.run(() => tx().select().from(schema.notifications).where(eq(schema.notifications.userId, userId)));
      return note;
    };
    const forBoss = await bodyOf(boss.userId);
    const forShepherd = await bodyOf(shepherd.userId);
    expect(forBoss.body).toContain('C-001');
    expect(forBoss.body).toContain('1 000 000'.replaceAll(' ', ' '));
    expect(forShepherd.body).toContain('C-001');
    expect(forShepherd.body).not.toContain('000');
    expect(forBoss.deliveries).toEqual({ telegram: 'pending' });
    expect(forBoss.link).toBe(`/reports/livestock.animal_register?saved=${created.data.id}`);
  });

  it('a recipient who may not run the report receives nothing', async () => {
    const f = (await buildWorld()).f;
    const boss = await f.as('owner');
    const shepherd = await f.as('shepherd');
    const created = await boss.post('/reports/saved', {
      name: 'Moliya',
      reportKey: 'finance.income_expense',
      config: {},
      recipients: [boss.userId, shepherd.userId],
    });
    const sent = await f.run(async () => {
      const [row] = await tx().select().from(schema.savedReports).where(eq(schema.savedReports.id, created.data.id));
      return deliverSaved(row);
    });
    expect(sent).toBe(1);
    const notes = await f.run(() => tx().select().from(schema.notifications).where(eq(schema.notifications.userId, shepherd.userId)));
    expect(notes).toEqual([]);
  });

  it('delivery leaves the job’s own permissions as they were', async () => {
    await w.f.run(async () => {
      const before = ctx().permissions;
      const [row] = await tx()
        .insert(schema.savedReports)
        .values({ tenantId: w.f.tenantId, farmId: w.f.farmId, name: 'X', reportKey: 'livestock.herd_structure', recipients: [owner.userId] })
        .returning();
      await deliverSaved(row);
      expect(ctx().permissions).toBe(before);
    });
  });

  it('without Telegram chosen, it stays in the app', async () => {
    const f = (await buildWorld()).f;
    const boss = await f.as('owner');
    const created = await boss.post('/reports/saved', { name: 'App', reportKey: 'livestock.herd_structure', config: {} });
    const res = await boss.post(`/reports/saved/${created.data.id}/send`);
    expect(res.status).toBe(200);
    expect(res.data.recipients).toBe(1);
    const [note] = await f.run(() => tx().select().from(schema.notifications).where(eq(schema.notifications.userId, boss.userId)));
    expect(note.deliveries).toEqual({});
  });

  it('a person cannot send someone else’s report', async () => {
    const investor = await w.f.as('investor');
    const created = await owner.post('/reports/saved', body({ name: 'Boss', config: {} }));
    expect((await investor.post(`/reports/saved/${created.data.id}/send`)).status).toBe(404);
  });

  it('the schedule fires once on its day', () => {
    const tz = 'Asia/Tashkent';
    expect(isDue('daily', null, '2026-11-04', tz)).toBe(true);
    expect(isDue('daily', new Date('2026-11-03T03:00:00Z'), '2026-11-04', tz)).toBe(true);
    expect(isDue('daily', new Date('2026-11-04T03:00:00Z'), '2026-11-04', tz)).toBe(false);
    // 20:00 UTC on Nov 3 is already Nov 4 in Tashkent.
    expect(isDue('daily', new Date('2026-11-03T20:00:00Z'), '2026-11-04', tz)).toBe(false);
    expect(isDue('weekly', null, '2026-11-02', tz)).toBe(true); // a Monday
    expect(isDue('weekly', null, '2026-11-03', tz)).toBe(false);
    expect(isDue('monthly', null, '2026-11-01', tz)).toBe(true);
    expect(isDue('monthly', null, '2026-11-02', tz)).toBe(false);
    expect(isDue(null, null, '2026-11-01', tz)).toBe(false);
  });

  it('the daily job sends what is due, once', async () => {
    const f = (await buildWorld()).f;
    const boss = await f.as('owner');
    await boss.post('/reports/saved', { name: 'Kunlik', reportKey: 'livestock.herd_structure', config: {}, schedule: 'daily' });
    await boss.post('/reports/saved', { name: 'Hech qachon', reportKey: 'livestock.herd_structure', config: {} });
    expect(await f.run(() => deliverDueReports())).toEqual({ delivered: 1, recipients: 1 });
    expect(await f.run(() => deliverDueReports())).toEqual({ delivered: 0, recipients: 0 });
  });
});

describe('performance', () => {
  it('large reports finish under the spec’s 4 seconds with 500 animals', async () => {
    const f = await createFixture();
    await f.run(async () => {
      const c = ctx();
      const base = { tenantId: c.tenantId, farmId: c.farmId };
      const [sheep] = await tx().select().from(schema.species).where(and(eq(schema.species.tenantId, c.tenantId), eq(schema.species.key, 'sheep')));
      const [herd] = await tx().insert(schema.herds).values({ ...base, name: 'Katta poda' }).returning();
      const animals = await tx()
        .insert(schema.animals)
        .values(
          Array.from({ length: 500 }, (_, i) => ({
            ...base,
            tag: `YA-${String(i + 1).padStart(4, '0')}`,
            speciesId: sheep.id,
            sex: 'female',
            category: 'ewe',
            origin: 'purchased',
            purchaseDate: '2026-02-01',
            purchasePrice: PURCHASE_PRICE,
            herdId: herd.id,
            status: 'active',
          })),
        )
        .returning({ id: schema.animals.id });
      await tx()
        .insert(schema.weightRecords)
        .values(
          animals.flatMap((a, i) => [
            { ...base, animalId: a.id, date: '2026-03-01', weightKg: 55 + (i % 10) },
            { ...base, animalId: a.id, date: '2026-04-01', weightKg: 60 + (i % 10) },
          ]),
        );
    });
    const token = await tokenFor(f, 'owner');
    const owner = await f.as('owner');

    const timings: Record<string, number> = {};
    const measure = async (label: string, fn: () => Promise<{ ok: boolean }>) => {
      const started = performance.now();
      const { ok } = await fn();
      timings[label] = Math.round(performance.now() - started);
      expect(ok, label).toBe(true);
    };
    const json = (key: string, query: Record<string, unknown> = {}) => async () => ({
      ok: (await owner.get(`/reports/${key}`, query)).status === 200,
    });
    const file = (key: string, format: string) => async () => ({
      ok: (await exportRaw(f, token, key, format)).statusCode === 200,
    });

    await measure('animal_register view', json('livestock.animal_register'));
    await measure('herd_movement 12 months', json('livestock.herd_movement', PERIOD));
    await measure('weight_gain', json('livestock.weight_gain', PERIOD));
    await measure('cost_per_head', json('finance.cost_per_head'));
    await measure('profitability', json('finance.profitability', PERIOD));
    await measure('animal_register xlsx', file('livestock.animal_register', 'xlsx'));
    await measure('animal_register csv', file('livestock.animal_register', 'csv'));
    await measure('animal_register pdf', file('livestock.animal_register', 'pdf'));

    console.info('report timings (ms) with 500 animals:', JSON.stringify(timings));
    for (const [label, ms] of Object.entries(timings)) expect(ms, label).toBeLessThan(4000);
  }, 60_000);
});

// Referenced so an accidental change of the date helper shows up here rather than in production.
describe('business dates', () => {
  it('uses farm-local today for "this month"', () => {
    const spy = vi.fn(() => todayIso('Asia/Tashkent', new Date('2026-11-30T20:00:00Z')));
    expect(spy()).toBe('2026-12-01');
    expect(presetRange('this_month', spy()).from).toBe('2026-12-01');
  });
});

