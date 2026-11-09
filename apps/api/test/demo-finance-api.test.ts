/**
 * Finance figures an agronomist or an accountant checks first, against hand-computed control
 * numbers (spec 24.2): what a bought flock cost, what a season's crop cost and earned, what was
 * paid, and what the budget says so far.
 */
import { and, eq } from 'drizzle-orm';
import { addDays, monthOf, monthRange, todayIso } from '@yap/shared';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { ctx, tx } from '../src/core/context';
import { ensureCostCenter, generalCostCenterId } from '../src/core/costCenters';
import { PAYROLL_COUNTERPARTY } from '../src/core/defaults';
import { postTransaction } from '../src/core/ledger';
import { grid } from '../src/modules/finance/budget.service';
import {
  budgetExecution,
  cashflowForecastDetail,
  costCenterCosts,
  debtSummary,
  fieldCosts,
  herdCost,
  incomeExpenseByCategory,
  monthToDate,
} from '../src/modules/finance/summary';
import { createFixture } from './helpers';

const { accounts, animals, budgets, counterparties, cropPlans, crops, fields, financeCategories, harvests, herds, loanInstalments, loans, sales, seasons, species } = schema;

async function setup() {
  const c = ctx();
  const base = { tenantId: c.tenantId, farmId: c.farmId };
  const [account] = await tx().insert(accounts).values({ ...base, name: 'Bank', type: 'bank', openingBalance: 500_000_000 }).returning();
  const categories = await tx().select().from(financeCategories).where(eq(financeCategories.tenantId, c.tenantId));
  const category = (key: string) => categories.find((row) => row.key === key)!.id;
  const pay = { paymentMethod: 'bank' as const, accountId: account.id, autoApprove: true };
  return { base, account, category, pay };
}

describe('a bought flock costs its price plus bringing it in (rule 3)', () => {
  it('adds transport and import vet work to the purchase cost, per head still on the farm', async () => {
    const f = await createFixture();
    const result = await f.run(async () => {
      const { base, category, pay } = await setup();
      const [sheep] = await tx().select().from(species).where(and(eq(species.tenantId, base.tenantId), eq(species.key, 'sheep')));
      const [herd] = await tx().insert(herds).values({ ...base, name: "Bo'g'oz sovliqlar" }).returning();
      const herdCc = await ensureCostCenter('herd', herd.id, herd.name);
      const ewes = await tx()
        .insert(animals)
        .values(
          Array.from({ length: 4 }, (_, i) => ({
            ...base,
            tag: `YA-${i}`,
            speciesId: sheep.id,
            sex: 'female',
            category: 'ewe',
            origin: 'purchased',
            herdId: herd.id,
            purchaseDate: '2026-10-20',
            purchasePrice: 4_600_000,
          })),
        )
        .returning();
      const bought = { ...pay, date: '2026-10-20', type: 'expense' as const, categoryId: category('animal_purchase'), costCenterId: herdCc, costTreatment: 'animal' as const };
      await postTransaction({ ...bought, amount: 18_400_000 }); // the price, 4 × 4 600 000
      await postTransaction({ ...bought, amount: 1_600_000 }); // livestock trucks from Tatarstan
      await postTransaction({ ...bought, amount: 400_000 }); // import quarantine and vet papers
      // Running cost since arrival.
      await postTransaction({ ...pay, date: '2026-10-25', type: 'expense', amount: 800_000, categoryId: category('veterinary'), costCenterId: herdCc });

      const before = await herdCost(herd.id);
      const beforeArrival = await herdCost(herd.id, '2026-10-19');
      // One ewe dies: her share of the transport leaves with her.
      await tx().update(animals).set({ status: 'dead', exitDate: '2026-11-01' }).where(eq(animals.id, ewes[0].id));
      const after = await herdCost(herd.id);
      const center = (await costCenterCosts()).find((row) => row.costCenterId === herdCc)!;
      return { before, beforeArrival, after, center };
    });

    // Landed cost 18 400 000 + 1 600 000 + 400 000 = 20 400 000 for 4 head, plus 800 000 since.
    expect(result.before).toMatchObject({ head: 4, purchaseCost: 20_400_000, landedExtra: 2_000_000, accumulated: 800_000 });
    expect(result.before.costPerHead).toBe(5_300_000); // (20 400 000 + 800 000) / 4
    // 3 head left: 3 × 4 600 000 + 3/4 of the 2 000 000.
    expect(result.after).toMatchObject({ head: 3, purchaseCost: 15_300_000, landedExtra: 1_500_000 });
    // Before the animals came there was nothing to cost.
    expect(result.beforeArrival).toMatchObject({ head: 0, purchaseCost: 0, costPerHead: null });
    // Nothing sold yet: no profit to state, not a −100 % loss.
    expect(result.center).toMatchObject({ total: 800_000, income: 0, profit: null, profitabilityPercent: null });
  });
});

describe('overlapping seasons count one bill and one sale once (rule 3)', () => {
  it("gives a cost to the later season and a sale to the harvest it sold, so neither is in both", async () => {
    const f = await createFixture();
    const ids = await f.run(async () => {
      const { base, category, pay } = await setup();
      const [field] = await tx().insert(fields).values({ ...base, number: '4', areaHa: 14 }).returning();
      const fieldCc = await ensureCostCenter('field', field.id, 'Beda dalasi');
      const [alfalfa] = await tx().select().from(crops).where(and(eq(crops.tenantId, base.tenantId), eq(crops.key, 'alfalfa')));
      const [summer] = await tx()
        .insert(seasons)
        .values({ ...base, name: 'Yozgi 2026', kind: 'summer', startDate: '2026-04-15', endDate: '2026-10-31' })
        .returning();
      const [autumn] = await tx()
        .insert(seasons)
        .values({ ...base, name: 'Kuzgi 2026/27', kind: 'autumn', startDate: '2026-09-01', endDate: '2027-07-15', isCurrent: true })
        .returning();
      const [lastYear] = await tx()
        .insert(seasons)
        .values({ ...base, name: 'Kuzgi 2025/26', kind: 'autumn', startDate: '2025-09-01', endDate: '2026-04-14' })
        .returning();
      const plan = (seasonId: string, plannedCost: number | null) =>
        tx().insert(cropPlans).values({ ...base, seasonId, fieldId: field.id, cropId: alfalfa.id, areaHa: 14, plannedCost }).returning();
      const [summerPlan] = await plan(summer.id, 20_000_000);
      await plan(autumn.id, null);
      const [lastYearPlan] = await plan(lastYear.id, 15_000_000);

      // Last year's crop: harvested, nothing spent on record.
      await tx().insert(harvests).values({ ...base, fieldId: field.id, cropPlanId: lastYearPlan.id, date: '2026-04-10', grossT: 30 });
      // Summer: a June water bill and the last cut on 18.09.
      await postTransaction({ ...pay, date: '2026-06-10', type: 'expense', amount: 2_000_000, categoryId: category('water'), costCenterId: fieldCc });
      await tx().insert(harvests).values({ ...base, fieldId: field.id, cropPlanId: summerPlan.id, date: '2026-09-18', grossT: 42 });
      // Fertilizer for the next crop on 03.10: inside both seasons' dates.
      await postTransaction({ ...pay, date: '2026-10-03', type: 'expense', amount: 26_600_000, categoryId: category('fertilizer'), costCenterId: fieldCc });
      // The summer's hay sold on 18.10: also inside both.
      await postTransaction({ ...pay, date: '2026-10-18', type: 'income', amount: 84_000_000, categoryId: category('alfalfa_sales'), costCenterId: fieldCc });
      return { summer: summer.id, autumn: autumn.id, lastYear: lastYear.id };
    });

    const [summer] = await f.run(() => fieldCosts(ids.summer));
    const [autumn] = await f.run(() => fieldCosts(ids.autumn));
    const [lastYear] = await f.run(() => fieldCosts(ids.lastYear));

    expect(summer).toMatchObject({ actual: 2_000_000, harvestT: 42, income: 84_000_000, deviation: -18_000_000 });
    expect(summer.costPerTon).toBeCloseTo(2_000_000 / 42, 2);
    // (84 000 000 − 2 000 000) / 2 000 000
    expect(summer.profitabilityPercent).toBe(4100);
    // The autumn crop carries its fertilizer and none of the summer's hay money.
    expect(autumn).toMatchObject({ actual: 26_600_000, harvestT: 0, income: 0, costPerTon: null, profit: null, profitabilityPercent: null });
    // Each so'm once: the seasons together hold exactly what was booked on the field.
    expect(summer.actual + autumn.actual).toBe(28_600_000);
    // A harvest with no cost on record is missing data, not a free crop and not a saving.
    expect(lastYear).toMatchObject({ actual: 0, harvestT: 30, costPerTon: null, deviation: null, profit: null, profitabilityPercent: null });
  });
});

describe('money paid is the money that left the accounts', () => {
  it('leaves out wages and goods owed, and depreciation; counts the debt when it is paid', async () => {
    const f = await createFixture();
    const now = todayIso();
    const lastMonth = monthOf(addDays(`${monthOf(now)}-01`, -1));
    const result = await f.run(async () => {
      const { base, category, pay } = await setup();
      const general = await generalCostCenterId();
      const [supplier] = await tx().insert(counterparties).values({ ...base, name: 'Buxoro Yem Savdo', type: 'supplier' }).returning();
      await postTransaction({ ...pay, date: now, type: 'expense', amount: 1_000_000, categoryId: category('fuel'), costCenterId: general });
      // Bran on credit in the first days of last month, paid off in part today.
      await postTransaction({
        date: `${lastMonth}-02`,
        type: 'expense',
        amount: 2_000_000,
        paymentMethod: 'debt',
        counterpartyId: supplier.id,
        categoryId: category('feed'),
        costCenterId: general,
        autoApprove: true,
      });
      await postTransaction({ date: now, type: 'expense', amount: 300_000, paymentMethod: 'non_cash', categoryId: category('depreciation'), costCenterId: general, autoApprove: true });
      await postTransaction({ ...pay, date: now, type: 'debt_payment', amount: 500_000, counterpartyId: supplier.id });
      return {
        month: await monthToDate(monthOf(now)),
        owedThen: await debtSummary(monthRange(lastMonth).to),
        owedNow: await debtSummary(),
      };
    });
    // 1 000 000 of fuel + 500 000 paid on the debt. The 300 000 of depreciation moved no money.
    expect(result.month.expense).toBe(1_500_000);
    expect(result.month.operatingExpense).toBe(1_300_000);
    // At the end of last month the whole 2 000 000 was owed; today's payment came later.
    expect(result.owedThen.payable).toBe(2_000_000);
    expect(result.owedNow.payable).toBe(1_500_000);
  });
});

describe('the budget compares like with like', () => {
  it('keeps depreciation out of the fact and sets spending so far against the plan so far', async () => {
    const f = await createFixture();
    const now = todayIso();
    const thisMonth = monthOf(now);
    const lastMonth = monthOf(addDays(`${thisMonth}-01`, -1));
    const nextMonth = monthOf(addDays(monthRange(thisMonth).to, 1));
    const result = await f.run(async () => {
      const { base, category, pay } = await setup();
      const general = await generalCostCenterId();
      await tx()
        .insert(budgets)
        .values([
          { ...base, month: lastMonth, categoryId: category('fuel'), amount: 1_000_000 },
          { ...base, month: thisMonth, categoryId: category('fuel'), amount: 3_000_000 },
          { ...base, month: nextMonth, categoryId: category('fuel'), amount: 5_000_000 },
        ]);
      await postTransaction({ ...pay, date: `${lastMonth}-10`, type: 'expense', amount: 1_200_000, categoryId: category('fuel'), costCenterId: general });
      await postTransaction({ date: now, type: 'expense', amount: 400_000, paymentMethod: 'non_cash', categoryId: category('depreciation'), costCenterId: general, autoApprove: true });
      return {
        grid: await grid({ from: lastMonth, to: nextMonth }),
        execution: await budgetExecution(`${lastMonth}-01`, monthRange(nextMonth).to),
      };
    });
    const day = Number(now.slice(8, 10));
    const days = Number(monthRange(thisMonth).to.slice(8, 10));
    const planSoFar = 1_000_000 + (3_000_000 * day) / days;

    const fuel = result.grid.rows.find((row) => row.key === 'fuel')!;
    expect(fuel.planned).toBe(9_000_000);
    expect(fuel.plannedToDate).toBeCloseTo(planSoFar, 1);
    expect(fuel.deviationToDate).toBeCloseTo(1_200_000 - planSoFar, 1);
    // Depreciation is booked without money: no budget fact, no overrun.
    expect(result.grid.rows.find((row) => row.key === 'depreciation')).toBeUndefined();
    expect(result.grid.dueThrough).toBe(thisMonth);
    expect(result.execution.plannedToDate).toBeCloseTo(planSoFar, 1);
    expect(result.execution.deviationToDate).toBeCloseTo(1_200_000 - planSoFar, 1);
    expect(result.execution.rows.find((row) => row.key === 'fuel')!.deviationToDate).toBeCloseTo(1_200_000 - planSoFar, 1);
  });
});

describe('income and expense by category', () => {
  it('tells running cost from purchases of things the farm keeps', async () => {
    const f = await createFixture();
    const { rows, operating, purchases } = await f.run(async () => {
      const { category, pay } = await setup();
      const general = await generalCostCenterId();
      const day = todayIso();
      await postTransaction({ ...pay, date: day, type: 'expense', amount: 700_000, categoryId: category('feed'), costCenterId: general });
      await postTransaction({ ...pay, date: day, type: 'expense', amount: 3_000_000, categoryId: category('feed'), costCenterId: general, costTreatment: 'inventory' });
      await postTransaction({ ...pay, date: day, type: 'expense', amount: 9_000_000, categoryId: category('animal_purchase'), costCenterId: general, costTreatment: 'animal' });
      return incomeExpenseByCategory(day, day);
    });
    expect(rows.find((row) => row.key === 'feed')).toMatchObject({ amount: 3_700_000, operating: 700_000, purchases: 3_000_000 });
    expect(rows.find((row) => row.key === 'animal_purchase')).toMatchObject({ amount: 9_000_000, operating: 0, purchases: 9_000_000 });
    expect({ operating, purchases }).toEqual({ operating: 700_000, purchases: 12_000_000 });
  });
});

describe('cash forecast timing', () => {
  it('expects the money of a credit sale when it is due, not when the goods leave', async () => {
    const f = await createFixture();
    const now = todayIso();
    const nextMonth = monthOf(addDays(monthRange(monthOf(now)).to, 1));
    const forecast = await f.run(async () => {
      const { base } = await setup();
      const [buyer] = await tx().insert(counterparties).values({ ...base, name: 'Buxoro Don', type: 'buyer' }).returning();
      await tx()
        .insert(sales)
        .values({ ...base, number: 'S-1', date: now, deliveryDate: now, dueDate: `${nextMonth}-09`, paymentMethod: 'debt', status: 'pending', counterpartyId: buyer.id, totalAmount: 55_200_000 });
      return cashflowForecastDetail(2);
    });
    expect(forecast.rows.map((row) => row.parts.plannedSales)).toEqual([0, 55_200_000]);
  });
});

describe('lookups for the money forms', () => {
  it('keeps the payroll counterparty as the system made it', async () => {
    const f = await createFixture();
    const id = await f.run(async () => {
      const { base } = await setup();
      const [row] = await tx().insert(counterparties).values({ ...base, name: PAYROLL_COUNTERPARTY, type: 'other' }).returning();
      return row.id;
    });
    const owner = await f.as('owner');
    const renamed = await owner.patch(`/finance/counterparties/${id}`, { name: 'Ish haqi' });
    expect(renamed.status).toBe(409);
    expect(renamed.body.error.code).toBe('SYSTEM_COUNTERPARTY');
    expect((await owner.delete(`/finance/counterparties/${id}`)).status).toBe(409);
    // Its phone or notes may still change.
    expect((await owner.patch(`/finance/counterparties/${id}`, { phone: '+998901234567' })).status).toBe(200);
  });

  it('lists the farm-wide center, herds and fields before machines and single animals', async () => {
    const f = await createFixture();
    await f.run(async () => {
      const { base } = await setup();
      await generalCostCenterId();
      const [herd] = await tx().insert(herds).values({ ...base, name: 'Sovliqlar' }).returning();
      await ensureCostCenter('herd', herd.id, 'Sovliqlar');
      const [field] = await tx().insert(fields).values({ ...base, number: '1', areaHa: 10 }).returning();
      await ensureCostCenter('field', field.id, 'Dala 1');
    });
    await f.run(async () => {
      const [sheep] = await tx().select().from(species).where(and(eq(species.tenantId, ctx().tenantId), eq(species.key, 'sheep')));
      const [herd] = await tx().select().from(herds);
      const [animal] = await tx()
        .insert(animals)
        .values({ tenantId: ctx().tenantId, farmId: ctx().farmId, tag: 'A-1', speciesId: sheep.id, sex: 'female', category: 'ewe', origin: 'born', herdId: herd.id })
        .returning();
      await ensureCostCenter('animal', animal.id, 'A-1');
    });
    const owner = await f.as('owner');
    const types = ((await owner.get('/finance/cost-centers/lookup')).data as { type: string }[]).map((row) => row.type);
    expect(types.indexOf('general')).toBe(0);
    expect(types.indexOf('herd')).toBeLessThan(types.indexOf('field'));
    expect(types.at(-1)).toBe('animal');
  });
});

describe('a month-end report shows the loans of that month end', () => {
  it('counts a loan only from the day it came, and an instalment as owed until it was paid', async () => {
    const f = await createFixture();
    const result = await f.run(async () => {
      const { base } = await setup();
      const [loan] = await tx()
        .insert(loans)
        .values({ ...base, name: 'Agrobank', principal: 2_500_000_000, annualRate: 14, termMonths: 2, startDate: '2026-09-15' })
        .returning();
      const instalment = { ...base, loanId: loan.id, interest: 0 };
      await tx()
        .insert(loanInstalments)
        .values([
          { ...instalment, period: 1, dueDate: '2026-10-15', principal: 1_250_000_000, payment: 1_250_000_000, balance: 1_250_000_000, paidDate: '2026-10-15' },
          { ...instalment, period: 2, dueDate: '2026-11-15', principal: 1_250_000_000, payment: 1_250_000_000, balance: 0 },
        ]);
      return {
        august: await debtSummary('2026-08-31'),
        september: await debtSummary('2026-09-30'),
        october: await debtSummary('2026-10-31'),
        now: await debtSummary(),
      };
    });
    expect(result.august.loansOutstanding).toBe(0);
    expect(result.september.loansOutstanding).toBe(2_500_000_000);
    expect(result.october.loansOutstanding).toBe(1_250_000_000);
    expect(result.now.loansOutstanding).toBe(1_250_000_000);
  });
});
