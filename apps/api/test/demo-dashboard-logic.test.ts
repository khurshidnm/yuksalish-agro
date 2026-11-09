/**
 * Dashboard figures an agronomist questioned: the cash forecast, the expected lambs, the machinery
 * load and the budget deviation of a month still running. Control numbers are worked by hand.
 */
import { and, eq } from 'drizzle-orm';
import { addDays, diffDays, monthOf, monthRange, round, todayIso } from '@yap/shared';
import { OUTLOOK_ASSUMPTIONS, expectedLambs } from '@yap/shared/formulas/outlook';
import { describe, expect, it } from 'vitest';
import { ctx, tx } from '../src/core/context';
import { generalCostCenterId } from '../src/core/costCenters';
import { postTransaction } from '../src/core/ledger';
import { schema } from '../src/db/client';
import { runStatistics } from '../src/modules/ai/analysis';
import { addMonths } from '../src/modules/finance/loans.service';
import { createFixture, type Fixture } from './helpers';

const now = todayIso();
const month = monthOf(now);
const plus = (n: number) => monthOf(addMonths(`${month}-01`, n));
const base = () => ({ tenantId: ctx().tenantId, farmId: ctx().farmId });

/** A cash account and the tenant's categories by key. */
async function money(f: Fixture) {
  return f.run(async () => {
    const [account] = await tx().insert(schema.accounts).values({ ...base(), name: 'Kassa', type: 'cash', openingBalance: 1_000_000 }).returning();
    const categories = await tx().select().from(schema.financeCategories).where(eq(schema.financeCategories.tenantId, ctx().tenantId));
    const generalId = await generalCostCenterId();
    const category = (key: string) => categories.find((row) => row.key === key)!.id;
    const post = (date: string, type: 'income' | 'expense', key: string, amount: number) =>
      f.run(() =>
        postTransaction({ date, type, amount, categoryId: category(key), costCenterId: generalId, paymentMethod: 'cash', accountId: account.id, autoApprove: true }),
      );
    return { category, post };
  });
}

describe('cash-flow forecast: income comes from plans, not from an average', () => {
  it('two harvest sales do not come back every month, while spending still recurs', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { post } = await money(f);
    // Grain sold twice after the harvest, as the pilot farm did in August and October.
    await post(`${plus(-3)}-12`, 'income', 'grain_sales', 374_000_000);
    await post(`${plus(-1)}-09`, 'income', 'grain_sales', 188_700_000);
    // Electricity is paid month by month.
    await post(`${plus(-2)}-05`, 'expense', 'electricity', 600_000);
    await post(`${plus(-1)}-05`, 'expense', 'electricity', 600_000);

    const res = await owner.get('/finance/cashflow/forecast', { months: 3 });
    expect(res.status).toBe(200);
    // Before: (374 000 000 + 188 700 000) / 6 = 93 783 333 a month, for grain nobody has.
    expect(res.data.rows.map((row: any) => row.parts.recurringIncome)).toEqual([0, 0, 0]);
    expect(res.data.rows[1].inflow).toBe(0);
    // 1 200 000 over the six-month window.
    expect(res.data.rows[1].parts.recurringExpense).toBe(200_000);
  });

  it('a sale comes back in the same month a year on, once a year of history exists', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { post } = await money(f);
    await post(`${plus(-13)}-05`, 'expense', 'electricity', 600_000);
    await post(`${plus(-11)}-10`, 'income', 'grain_sales', 374_000_000);

    const res = await owner.get('/finance/cashflow/forecast', { months: 3 });
    expect(res.data.historyMonths).toBeGreaterThanOrEqual(12);
    expect(res.data.rows.map((row: any) => row.parts.recurringIncome)).toEqual([0, 374_000_000, 0]);
  });
});

describe('expected lambs: one assumption, one count on every screen', () => {
  /** 25 ewes due in one month and 15 in the next: 27.5 and 16.5 lambs, 44 in all. */
  async function flock(f: Fixture) {
    return f.run(async () => {
      const [species] = await tx().select().from(schema.species).where(eq(schema.species.key, 'sheep'));
      const ewes = await tx()
        .insert(schema.animals)
        .values(
          Array.from({ length: 40 }, (_, i) => ({
            ...base(),
            tag: `E-${i + 1}`,
            speciesId: species.id,
            sex: 'female',
            category: 'ewe',
            origin: 'purchased',
            purchaseDate: addDays(now, -200),
            status: 'pregnant',
          })),
        )
        .returning();
      await tx()
        .insert(schema.breedingRecords)
        .values(
          ewes.map((ewe, i) => {
            const date = i < 25 ? `${plus(2)}-10` : `${plus(3)}-10`;
            return { ...base(), eweId: ewe.id, matingDate: addDays(date, -150), expectedDate: date, expectedEarliest: addDays(date, -5), expectedLatest: addDays(date, 2) };
          }),
        );
      // Lambs priced by the head, so the forecast can value the ones sold.
      const [lamb] = await tx().insert(schema.items).values({ ...base(), name: "Qo'zi", category: 'product', unit: 'head' }).returning();
      await tx().insert(schema.prices).values({ ...base(), itemId: lamb.id, date: now, kind: 'sale', price: 3_000_000 });
      // A lactating ewe eats 18 kg a day more than a pregnant one.
      for (const [state, kg] of [['pregnant', 2], ['lactating', 20]] as const) {
        const [item] = await tx().insert(schema.items).values({ ...base(), name: `Feed ${state}`, category: 'feed', unit: 'kg' }).returning();
        const [ration] = await tx().insert(schema.rations).values({ ...base(), name: state, state }).returning();
        await tx().insert(schema.rationLines).values({ ...base(), rationId: ration.id, itemId: item.id, kgPerHeadDay: kg });
      }
    });
  }

  it('the lambing plan, the outlook, the assistant and the cash forecast agree', async () => {
    const f = await createFixture();
    await flock(f);
    const owner = await f.as('owner');
    // 40 × 1.1 = 44. Rounding each month alone would give 28 + 17 = 45.
    const lambs = 44;
    expect(expectedLambs(40)).toBe(lambs);

    const plan = (await owner.get('/dashboard')).data.blocks.livestock.data.lambing;
    expect(plan).toMatchObject({ totalEwes: 40, expectedLambs: null, assumedLambs: lambs, assumedLambsPerEwe: OUTLOOK_ASSUMPTIONS.lambsPerEwe });

    const outlook = (await owner.get('/dashboard/outlook')).data;
    expect(outlook.herd.lambsBorn).toBe(lambs);
    expect(outlook.herd.rows.reduce((sum: number, row: any) => sum + row.lambsBorn, 0)).toBe(lambs);

    await f.run(() => runStatistics());
    const [insight] = await f.run(() =>
      tx().select().from(schema.aiInsights).where(and(eq(schema.aiInsights.farmId, f.farmId), eq(schema.aiInsights.type, 'lambing_workload'))),
    );
    expect((insight.data as any).i18n.lambs).toBe(lambs);
    expect(insight.sources).toMatchObject({ assumptions: { lambsPerEwe: 1.1, lambsPerEweSource: 'assumed_default' } });

    // Six months after lambing the forecast sells what the outlook sells: 25 × 1.1 × 0.92 × 0.8 =
    // 20.24, so 20 lambs, and 15 × 1.1 × 0.92 × 0.8 = 12.14, so 12, at 3 000 000 each.
    const forecast = (await owner.get('/finance/cashflow/forecast', { months: 12 })).data;
    expect(forecast.assumptions).toEqual({ lambsPerEwe: 1.1, survival: 0.92, monthsToSale: 6, keepShare: 0.2 });
    const lambIncome = (m: string) => forecast.rows.find((row: any) => row.month === m).parts.plannedLambs;
    expect(lambIncome(plus(8))).toBe(60_000_000);
    expect(lambIncome(plus(9))).toBe(36_000_000);
    const sold = (m: string) => outlook.herd.rows.find((row: any) => row.month === m)?.lambsSold;
    expect([sold(plus(8)), sold(plus(9))]).toEqual([20, 12]);
  });

  it('no ewes due, no assumed lambs', async () => {
    const f = await createFixture();
    const plan = (await (await f.as('owner')).get('/dashboard')).data.blocks.livestock.data.lambing;
    expect(plan).toMatchObject({ totalEwes: 0, expectedLambs: null, assumedLambs: null, assumedLambsPerEwe: 1.1 });
  });

  it('extra feed of ten tonnes or more is given in whole tonnes, with no decimal sign to get wrong', async () => {
    const f = await createFixture();
    await flock(f);
    await f.run(() => runStatistics());
    const [insight] = await f.run(() =>
      tx().select().from(schema.aiInsights).where(and(eq(schema.aiInsights.farmId, f.farmId), eq(schema.aiInsights.type, 'lambing_workload'))),
    );
    const weeks = (insight.data as any).weeks as { extraFeedKg: number }[];
    const extraKg = weeks.reduce((sum, week) => sum + week.extraFeedKg, 0);
    expect(extraKg).toBeGreaterThanOrEqual(10_000);
    const tons = (insight.data as any).i18n.extraFeedT;
    expect(tons).toBe(Math.round(extraKg / 1000));
    expect(insight.body).toContain(`${tons} t`);
  });
});

describe('machinery load counts from the day the farm began logging hours', () => {
  async function fleet(f: Fixture) {
    return f.run(async () => {
      const [a, b] = await tx()
        .insert(schema.assets)
        .values([
          { ...base(), name: 'MTZ', type: 'tractor', inventoryNo: '1', purchaseDate: '2020-01-01' },
          // Arrived after the farm began logging: it counts from its own first day.
          { ...base(), name: 'TTZ', type: 'tractor', inventoryNo: '2', purchaseDate: `${plus(-1)}-20` },
          // Never logged: its hours are unknown, so it is left out rather than called idle.
          { ...base(), name: 'GAZ', type: 'vehicle', inventoryNo: '3', purchaseDate: '2020-01-01' },
          // Hired by the job: idle time on it is not this farm's load.
          { ...base(), name: 'Kombayn', type: 'combine', inventoryNo: '4', rented: true },
        ])
        .returning();
      const log = (assetId: string, date: string, motoHours: number) =>
        tx().insert(schema.assetUsageLogs).values({ ...base(), assetId, date, motoHours });
      await log(a.id, `${plus(-1)}-15`, 16);
      await log(a.id, `${plus(-1)}-18`, 8);
      await log(b.id, `${plus(-1)}-25`, 4);
    });
  }

  it('against hand-computed control numbers', async () => {
    const f = await createFixture();
    await fleet(f);
    const owner = await f.as('owner');
    const kpi = async (from: string, to: string) => (await owner.get('/dashboard/kpis', { from, to })).data.groups.machinery.data;

    // MTZ from the 15th, TTZ from the 20th of last month, both up to today, 8 h a day.
    const machineDays = diffDays(`${plus(-1)}-15`, now) + 1 + diffDays(`${plus(-1)}-20`, now) + 1;
    const expected = round((28 / (machineDays * 8)) * 100, 1);
    expect((await kpi(plus(-1), month)).utilizationPercent).toBe(expected);
    // Before the first log nothing is known: not 0 %.
    expect((await kpi(plus(-2), plus(-2))).utilizationPercent).toBeNull();
  });

  it('machines that have never been logged give no figure, not 0 %', async () => {
    const f = await createFixture();
    await f.run(() =>
      tx()
        .insert(schema.assets)
        .values([
          { ...base(), name: 'MTZ', type: 'tractor', inventoryNo: '1' },
          { ...base(), name: 'TTZ', type: 'tractor', inventoryNo: '2' },
        ]),
    );
    const { data } = (await (await f.as('owner')).get('/dashboard/kpis')).data.groups.machinery;
    expect(data).toMatchObject({ utilizationPercent: null, unplannedStops: 0 });
  });
});

describe('budget deviation of a month still running', () => {
  it('sets spending so far against the plan so far, and leaves past months whole', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { category, post } = await money(f);
    await owner.put('/finance/budget', {
      entries: [
        { month: plus(-1), categoryId: category('fuel'), amount: 2_000_000 },
        { month, categoryId: category('fuel'), amount: 3_000_000 },
      ],
    });
    await post(`${plus(-1)}-10`, 'expense', 'fuel', 2_500_000);
    await post(now, 'expense', 'fuel', 1_000_000);
    const finance = async (from: string, to: string) => (await owner.get('/dashboard/kpis', { from, to })).data.groups.finance.data;

    // This month's 3 000 000 counts for the days gone: on the 9th of a 30-day month, 900 000.
    const day = Number(now.slice(8, 10));
    const days = Number(monthRange(month).to.slice(8, 10));
    const planSoFar = (3_000_000 * day) / days;
    const running = await finance(month, month);
    expect(running.budgetDeviation).toBeCloseTo(1_000_000 - planSoFar, 1);
    expect(running.budgetDeviationPercent).toBeCloseTo(round(((1_000_000 - planSoFar) / planSoFar) * 100, 1), 5);

    // A month that is over keeps its whole plan: 2 500 000 against 2 000 000.
    const past = await finance(plus(-1), plus(-1));
    expect(past).toMatchObject({ budgetDeviation: 500_000, budgetDeviationPercent: 25 });

    // Both together: 3 500 000 against 2 000 000 and the part of this month gone.
    const both = await finance(plus(-1), month);
    expect(both.budgetDeviation).toBeCloseTo(3_500_000 - (2_000_000 + planSoFar), 1);

    // The dashboard's budget card still shows this month's whole plan and how much of it is used.
    const card = (await owner.get('/dashboard')).data.blocks.finance.data.budget.month;
    expect(card).toMatchObject({ planned: 3_000_000, actual: 1_000_000 });
  });
});
