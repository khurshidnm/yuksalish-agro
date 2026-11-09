import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  ANIMAL_ON_FARM_STATUSES,
  PII_VIEW,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
  profitabilityPercent,
  round,
} from '@yap/shared';
import { profitPerHead } from '@yap/shared/formulas/kpi';
import { schema } from '../../../db/client';
import { ctx, hasPermission, today, tx } from '../../../core/context';
import { monthsBetween } from '../../finance/budget.service';
import { listDebts } from '../../finance/debts.service';
import { list as listLoans } from '../../finance/loans.service';
import {
  budgetExecution,
  cashPosition,
  cashflowActual,
  cashflowForecastDetail,
  costCenterCosts,
  herdResult,
  fieldCosts,
  herdCosts,
  incomeExpenseByCategory,
  monthToDate,
  sumHerds,
} from '../../finance/summary';
import type { ReportDefinition, Row } from '../types';
import { col, filter } from './_helpers';

const { accounts, animals, costCenters, counterparties, financeCategories, loanInstalments, loans, transactions: t } = schema;

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
const animalCount = sql<number>`count(*)`.mapWith(Number);

/** Cost per kg stays empty until enough of a herd is weighed, which needs saying next to the blank. */
function costPerKgNote(herds: { head: number; costPerKg: number | null }[]) {
  return herds.some((h) => h.head > 0 && h.costPerKg === null) ? [{ key: 'cost_per_kg_needs_weighing' }] : [];
}

export const financeReports: ReportDefinition[] = [
  {
    key: 'finance.income_expense',
    module: 'finance',
    money: true,
    filters: [filter.period('this_year')],
    columns: [
      col.enum('kind', 'categoryKind'),
      col.name('category', { label: 'financeCategory' }),
      col.money('income', { sum: true }),
      col.money('expense', { sum: true }),
    ],
    chart: { kind: 'bar', x: 'category', series: ['income', 'expense'] },
    compare: { filter: 'period', by: ['kind', 'category'], values: ['income', 'expense'] },
    async run({ from, to }) {
      const { rows } = await incomeExpenseByCategory(from, to);
      return {
        rows: rows.map((r) => ({
          kind: r.kind,
          category: r.name,
          income: r.kind === 'income' ? r.amount : null,
          expense: r.kind === 'expense' ? r.amount : null,
        })),
      };
    },
  },
  {
    key: 'finance.monthly_result',
    module: 'finance',
    money: true,
    filters: [filter.period('this_year')],
    columns: [
      col.month('month'),
      col.money('income', { sum: true }),
      col.money('operatingExpense', { sum: true }),
      col.money('net', { sum: true, label: 'netResult' }),
      col.money('expense', { sum: true, label: 'moneyPaid' }),
    ],
    chart: { kind: 'bar', x: 'month', series: ['income', 'operatingExpense'] },
    async run({ from, to }) {
      const rows: Row[] = [];
      for (const month of monthsBetween(from.slice(0, 7), to.slice(0, 7))) rows.push(await monthToDate(month));
      return { rows, notes: [{ key: 'net_result_definition' }] };
    },
  },
  {
    key: 'finance.cashflow',
    module: 'finance',
    money: true,
    filters: [filter.period('this_year')],
    columns: [
      col.month('month'),
      col.money('inflow', { sum: true }),
      col.money('outflow', { sum: true }),
      col.money('net', { sum: true, label: 'netCashFlow' }),
      // How much of the flow was the owner's own money: real cash, but never income or expense.
      col.money('financingIn', { sum: true }),
      col.money('financingOut', { sum: true }),
    ],
    chart: { kind: 'bar', x: 'month', series: ['inflow', 'outflow'] },
    run: async ({ from, to }) => ({ rows: await cashflowActual(from, to) }),
  },
  {
    key: 'finance.cashflow_forecast',
    module: 'finance',
    money: true,
    filters: [filter.months(12)],
    columns: [
      col.month('month'),
      col.money('inflow', { sum: true }),
      col.money('outflow', { sum: true }),
      col.money('net', { sum: true, label: 'netCashFlow' }),
      col.money('closing'),
    ],
    chart: { kind: 'line', x: 'month', series: ['closing'] },
    async run({ months }) {
      const forecast = await cashflowForecastDetail(months);
      return {
        rows: forecast.rows.map((row) => ({ ...row })),
        notes: [
          { key: 'forecast_statistical' },
          ...(forecast.firstNegativeMonth ? [{ key: 'forecast_negative', params: { month: forecast.firstNegativeMonth } }] : []),
        ],
      };
    },
  },
  {
    key: 'finance.cost_per_head',
    module: 'finance',
    money: true,
    filters: [],
    columns: [
      col.text('herd'),
      col.int('head', { sum: true }),
      col.money('purchaseCost', { sum: true }),
      col.money('feed', { sum: true }),
      col.money('vet', { sum: true, label: 'vetCost' }),
      col.money('labor', { sum: true }),
      col.money('overhead', { sum: true }),
      col.money('accumulated', { sum: true }),
      col.money('costPerHead'),
      col.num('weightGainKg', 2, { sum: true }),
      col.money('costPerKg'),
    ],
    async run() {
      const herds = await herdCosts();
      const shape = (r: ReturnType<typeof sumHerds>) => ({
        head: r.head,
        purchaseCost: r.purchaseCost,
        ...r.breakdown,
        accumulated: r.accumulated,
        costPerHead: r.costPerHead,
        weightGainKg: r.weightGainKg,
        costPerKg: r.costPerKg,
      });
      return {
        rows: herds.map((h) => ({ herd: h.name, ...shape(sumHerds([h])) })),
        totals: shape(sumHerds(herds)),
        notes: costPerKgNote(herds),
      };
    },
  },
  {
    key: 'finance.cost_per_ton',
    module: 'finance',
    money: true,
    filters: [filter.season],
    columns: [
      col.text('field'),
      col.name('crop'),
      col.num('areaHa', 2, { sum: true }),
      col.money('actualCost', { sum: true }),
      col.num('harvestT', 3, { sum: true }),
      col.num('yieldTHa', 3),
      col.money('costPerTon'),
    ],
    chart: { kind: 'bar', x: 'field', series: ['costPerTon'] },
    async run({ seasonId }) {
      const rows = await fieldCosts(seasonId);
      return {
        rows: rows.map((r) => ({
          field: r.number,
          crop: r.crop,
          areaHa: r.areaHa,
          actualCost: r.actual,
          harvestT: r.harvestT,
          yieldTHa: r.yieldTHa,
          costPerTon: r.costPerTon,
        })),
      };
    },
  },
  {
    key: 'finance.cost_per_kg',
    module: 'finance',
    money: true,
    filters: [],
    columns: [
      col.text('herd'),
      col.int('head', { sum: true }),
      col.num('weightGainKg', 2, { sum: true }),
      col.money('accumulated', { sum: true }),
      col.money('costPerKg'),
    ],
    async run() {
      const herds = await herdCosts();
      const all = sumHerds(herds);
      return {
        rows: herds.map((h) => ({
          herd: h.name,
          head: h.head,
          weightGainKg: h.weightGainKg,
          accumulated: h.accumulated,
          costPerKg: h.costPerKg,
        })),
        totals: { head: all.head, weightGainKg: all.weightGainKg, accumulated: all.accumulated, costPerKg: all.costPerKg },
        notes: costPerKgNote(herds),
      };
    },
  },
  {
    key: 'finance.profitability',
    module: 'finance',
    money: true,
    filters: [filter.period('this_year')],
    columns: [
      col.enum('type', 'costCenterType'),
      col.enum('costCenter', 'reports:costCenterName'),
      col.money('direct', { sum: true }),
      col.money('materials', { sum: true }),
      col.money('machinery', { sum: true }),
      col.money('overhead', { sum: true }),
      col.money('total', { sum: true }),
      col.money('income', { sum: true }),
      col.money('profit', { sum: true }),
      col.pct('profitabilityPercent'),
    ],
    compare: { filter: 'period', by: ['type', 'costCenter'], values: ['total', 'income'] },
    async run({ from, to }) {
      const rows = await costCenterCosts(from, to);
      return {
        rows: rows
          .filter((r) => r.total !== 0 || r.income !== 0)
          .map((r) => ({ ...r, costCenter: r.name ?? null })),
        notes: [{ key: 'internal_transfers' }],
      };
    },
  },
  {
    key: 'finance.budget_execution',
    module: 'finance',
    money: true,
    filters: [filter.period('this_year')],
    columns: [
      col.enum('group', 'expenseGroup'),
      col.name('category', { label: 'financeCategory' }),
      col.money('planned', { sum: true }),
      col.money('actual', { sum: true }),
      col.money('deviation', { sum: true }),
      col.pct('percent'),
    ],
    chart: { kind: 'bar', x: 'category', series: ['planned', 'actual'] },
    async run({ from, to }) {
      const b = await budgetExecution(from, to);
      return {
        rows: b.rows.map((r) => ({ ...r, category: r.name })),
        totals: { planned: b.planned, actual: b.actual, deviation: b.deviation, percent: b.percent },
      };
    },
  },
  {
    key: 'finance.debts',
    module: 'finance',
    money: true,
    filters: [filter.select('direction', ['payable', 'receivable'], 'reports:debtDirection')],
    columns: [
      col.enum('direction', 'reports:debtDirection'),
      col.text('counterparty'),
      col.money('total', { sum: true }),
      col.money('paid', { sum: true }),
      col.money('outstanding', { sum: true }),
      col.money('overdue', { sum: true }),
      col.date('nextDueDate'),
    ],
    async run({ direction }) {
      const debts = await listDebts(direction);
      return { rows: debts.map((d) => ({ ...d, counterparty: d.counterpartyName })) };
    },
  },
  {
    key: 'finance.loans',
    module: 'finance',
    money: true,
    filters: [],
    columns: [
      col.text('loan'),
      col.text('counterparty'),
      col.date('startDate'),
      col.money('principal', { sum: true }),
      col.pct('annualRate'),
      col.int('termMonths'),
      col.money('paidPrincipal', { sum: true }),
      col.money('paidInterest', { sum: true }),
      col.money('outstanding', { sum: true }),
      col.date('nextDueDate'),
      col.money('nextPayment'),
    ],
    async run() {
      const rows = await listLoans();
      return { rows: rows.map((r) => ({ ...r, loan: r.name, counterparty: r.counterpartyName })) };
    },
  },
  {
    key: 'finance.loan_schedule',
    module: 'finance',
    money: true,
    filters: [filter.period('this_year')],
    columns: [
      col.date('dueDate'),
      col.text('loan'),
      col.money('principal', { sum: true }),
      col.money('interest', { sum: true }),
      col.money('payment', { sum: true }),
      col.money('balance'),
      col.date('paidDate'),
    ],
    async run({ from, to }) {
      const rows = await tx()
        .select({
          dueDate: loanInstalments.dueDate,
          loan: loans.name,
          principal: loanInstalments.principal,
          interest: loanInstalments.interest,
          payment: loanInstalments.payment,
          balance: loanInstalments.balance,
          paidDate: loanInstalments.paidDate,
        })
        .from(loanInstalments)
        .innerJoin(loans, eq(loans.id, loanInstalments.loanId))
        .where(and(eq(loanInstalments.farmId, ctx().farmId), gte(loanInstalments.dueDate, from), lte(loanInstalments.dueDate, to)))
        .orderBy(asc(loanInstalments.dueDate));
      return { rows };
    },
  },
  {
    key: 'finance.accounts',
    module: 'finance',
    money: true,
    filters: [],
    columns: [
      col.text('account'),
      col.enum('type', 'accountType'),
      col.text('currency'),
      col.money('balance'),
      col.money('balanceBase', { sum: true }),
    ],
    async run() {
      const { accounts: rows, total } = await cashPosition();
      return { rows: rows.map((a) => ({ ...a, account: a.name })), totals: { balanceBase: total } };
    },
  },
  {
    key: 'finance.transactions',
    module: 'finance',
    money: true,
    filters: [
      filter.period('this_month'),
      filter.select('type', TRANSACTION_TYPES, 'transactionType'),
      filter.select('status', TRANSACTION_STATUSES, 'transactionStatus'),
    ],
    columns: [
      col.date('date'),
      col.enum('type', 'transactionType'),
      col.name('category', { label: 'financeCategory' }),
      // No total: this column mixes money in, money out, transfers and rows not approved.
      col.money('amountBase'),
      col.enum('paymentMethod', 'paymentMethod'),
      col.text('account'),
      col.text('counterparty'),
      col.enum('costCenter', 'reports:costCenterName'),
      col.enum('status', 'transactionStatus'),
      col.text('description'),
    ],
    async run({ from, to, type, status }) {
      const rows = await tx()
        .select({
          date: t.date,
          type: t.type,
          category: financeCategories.name,
          amountBase: t.amountBase,
          paymentMethod: t.paymentMethod,
          account: accounts.name,
          counterparty: counterparties.name,
          costCenter: costCenters.name,
          costCenterType: costCenters.type,
          status: t.status,
          description: t.description,
        })
        .from(t)
        .leftJoin(financeCategories, eq(financeCategories.id, t.categoryId))
        .leftJoin(accounts, eq(accounts.id, t.accountId))
        .leftJoin(counterparties, eq(counterparties.id, t.counterpartyId))
        .leftJoin(costCenters, eq(costCenters.id, t.costCenterId))
        .where(
          and(
            eq(t.farmId, ctx().farmId),
            gte(t.date, from),
            lte(t.date, to),
            type ? eq(t.type, type) : undefined,
            status ? eq(t.status, status) : undefined,
          ),
        )
        .orderBy(desc(t.date), desc(t.createdAt));
      const seesPeople = hasPermission(PII_VIEW);
      return {
        rows: rows.map((r) => ({
          ...r,
          // A cost center of type 'employee' is a person's name.
          costCenter: r.costCenterType === 'employee' && !seesPeople ? null : r.costCenter,
        })),
      };
    },
  },
  {
    key: 'finance.kpi',
    module: 'finance',
    money: true,
    filters: [filter.period('this_year')],
    columns: [col.enum('indicator', 'reports:kpi'), col.num('value', 2), col.enum('unit', 'reports:kpiUnit')],
    async run({ from, to }) {
      let income = 0;
      let operating = 0;
      for (const month of monthsBetween(from.slice(0, 7), to.slice(0, 7))) {
        const m = await monthToDate(month);
        income += m.income;
        operating += m.operatingExpense;
      }
      const [ewes] = await tx()
        .select({ head: animalCount })
        .from(animals)
        .where(
          and(
            eq(animals.farmId, ctx().farmId),
            eq(animals.category, 'ewe'),
            inArray(animals.status, [...ANIMAL_ON_FARM_STATUSES]),
          ),
        );
      const flow = await cashflowActual(from, to);
      const budget = await budgetExecution(from, to);
      // The same figure as the dashboard: a period running past today has no later costs to count.
      const herds = await herdResult(from, to < today() ? to : today());
      const perEwe = profitPerHead(herds.income, herds.expense, ewes.head);
      const costRatio = ratio(operating, income);
      const value = (v: number | null) => (v === null ? null : round(v, 2));
      return {
        rows: [
          { indicator: 'income', value: value(income), unit: 'money' },
          { indicator: 'operating_expense', value: value(operating), unit: 'money' },
          { indicator: 'profitability', value: income > 0 ? value(profitabilityPercent(income, operating)) : null, unit: 'percent' },
          { indicator: 'profit_per_ewe', value: value(perEwe), unit: 'money' },
          { indicator: 'cost_to_income', value: costRatio === null ? null : value(costRatio * 100), unit: 'percent' },
          { indicator: 'net_cash_flow', value: value(flow.reduce((sum, m) => sum + m.net, 0)), unit: 'money' },
          { indicator: 'budget_deviation', value: value(budget.deviation), unit: 'money' },
        ],
      };
    },
  },
];
