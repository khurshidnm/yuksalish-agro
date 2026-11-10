import { boolean, index, integer, jsonb, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { dec, day, money, pk, ts, type I18nName } from './_helpers';
import { tenantColumns, tenantOnlyColumns } from './_tenant';
import { files } from './core';
import { tenants, users } from './platform';

/** Xarajat markazi: everything money-related attaches here (spec 4.1 p.5). */
export const costCenters = pgTable(
  'cost_centers',
  {
    id: pk(),
    ...tenantColumns(),
    type: text().notNull(),
    /** The field, herd, animal, asset or employee id. Null for 'general'. */
    refId: uuid(),
    name: text().notNull(),
    active: boolean().notNull().default(true),
  },
  (t) => [unique().on(t.farmId, t.type, t.refId), index().on(t.farmId, t.type)],
);

export const accounts = pgTable('accounts', {
  id: pk(),
  ...tenantColumns(),
  name: text().notNull(),
  type: text().notNull(),
  currency: text().notNull().default('UZS'),
  openingBalance: money().notNull().default(0),
  openingDate: day(),
  bankName: text(),
  accountNumber: text(),
  active: boolean().notNull().default(true),
});

/** Moddalar (spec 10.1, 10.2). */
export const financeCategories = pgTable(
  'finance_categories',
  {
    id: pk(),
    ...tenantOnlyColumns(),
    kind: text().notNull(),
    group: text().notNull(),
    key: text().notNull(),
    name: jsonb().$type<I18nName>().notNull(),
    active: boolean().notNull().default(true),
  },
  (t) => [unique().on(t.tenantId, t.key)],
);

export const counterparties = pgTable(
  'counterparties',
  {
    id: pk(),
    ...tenantColumns(),
    name: text().notNull(),
    tin: text(),
    type: text().notNull(),
    phone: text(),
    address: text(),
    contactPerson: text(),
    bankDetails: jsonb().$type<{ bankName?: string | null; account?: string | null; mfo?: string | null }>(),
    notes: text(),
    active: boolean().notNull().default(true),
  },
  (t) => [index().on(t.farmId, t.type)],
);

export const contracts = pgTable(
  'contracts',
  {
    id: pk(),
    ...tenantColumns(),
    counterpartyId: uuid().notNull().references(() => counterparties.id),
    number: text().notNull(),
    title: text(),
    startDate: day(),
    endDate: day(),
    amount: money(),
    currency: text().notNull().default('UZS'),
    terms: text(),
    fileId: uuid().references(() => files.id),
    status: text().notNull().default('active'),
  },
  (t) => [index().on(t.counterpartyId), index().on(t.farmId, t.endDate)],
);

/** Written only by core/ledger. See COST_TREATMENTS in shared/enums.ts. */
export const transactions = pgTable(
  'transactions',
  {
    id: pk(),
    ...tenantColumns(),
    date: day().notNull(),
    type: text().notNull(),
    categoryId: uuid().references(() => financeCategories.id),
    amount: money().notNull(),
    currency: text().notNull().default('UZS'),
    fxRate: dec(18, 6).notNull().default(1),
    /** Amount in the tenant's base currency. Reports sum this column. */
    amountBase: money().notNull(),
    paymentMethod: text().notNull(),
    accountId: uuid().references(() => accounts.id),
    toAccountId: uuid().references(() => accounts.id),
    counterpartyId: uuid().references(() => counterparties.id),
    costCenterId: uuid().references(() => costCenters.id),
    costTreatment: text().notNull().default('expense'),
    status: text().notNull().default('approved'),
    description: text(),
    /** Payment due date for debts. */
    dueDate: day(),
    fileId: uuid().references(() => files.id),
    /** Originating record, e.g. 'sale', 'stock_batch', 'payroll_run', 'loan_instalment'. */
    sourceType: text(),
    sourceId: uuid(),
    approvedBy: uuid().references(() => users.id),
    approvedAt: ts(),
    rejectedReason: text(),
  },
  (t) => [
    index().on(t.farmId, t.date),
    index().on(t.farmId, t.status),
    index().on(t.costCenterId, t.date),
    index().on(t.categoryId, t.date),
    index().on(t.counterpartyId),
    index().on(t.sourceType, t.sourceId),
  ],
);

export const budgets = pgTable(
  'budgets',
  {
    id: pk(),
    ...tenantColumns(),
    /** YYYY-MM */
    month: text().notNull(),
    categoryId: uuid().notNull().references(() => financeCategories.id),
    costCenterId: uuid().references(() => costCenters.id),
    amount: money().notNull(),
    notes: text(),
  },
  (t) => [unique().on(t.farmId, t.month, t.categoryId, t.costCenterId).nullsNotDistinct(), index().on(t.farmId, t.month)],
);

export const fxRates = pgTable(
  'fx_rates',
  {
    tenantId: uuid().notNull().references(() => tenants.id),
    date: day().notNull(),
    currency: text().notNull(),
    rate: dec(18, 6).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.date, t.currency] })],
);

export const loans = pgTable('loans', {
  id: pk(),
  ...tenantColumns(),
  counterpartyId: uuid().references(() => counterparties.id),
  name: text().notNull(),
  principal: money().notNull(),
  annualRate: dec(7, 3).notNull(),
  termMonths: integer().notNull(),
  startDate: day().notNull(),
  method: text().notNull().default('annuity'),
  preferential: boolean().notNull().default(false),
  terms: text(),
  status: text().notNull().default('active'),
});

export const loanInstalments = pgTable(
  'loan_instalments',
  {
    id: pk(),
    ...tenantColumns(),
    loanId: uuid().notNull().references(() => loans.id, { onDelete: 'cascade' }),
    period: integer().notNull(),
    dueDate: day().notNull(),
    principal: money().notNull(),
    interest: money().notNull(),
    payment: money().notNull(),
    balance: money().notNull(),
    paidDate: day(),
    transactionId: uuid().references(() => transactions.id),
  },
  (t) => [index().on(t.loanId), index().on(t.farmId, t.dueDate)],
);

/** Subsidies, grants, preferential credit applications (spec 13.4). */
export const grantApplications = pgTable('grant_applications', {
  id: pk(),
  ...tenantColumns(),
  title: text().notNull(),
  program: text(),
  kind: text().notNull().default('subsidy'),
  amount: money(),
  status: text().notNull().default('draft'),
  submittedOn: day(),
  decisionOn: day(),
  notes: text(),
});

/**
 * Saved three-year plans: one set of assumptions under a name (formulas/scenario.ts). The figures
 * are not stored. They are worked out again from the assumptions each time the plan is opened.
 */
export const scenarios = pgTable(
  'scenarios',
  {
    id: pk(),
    ...tenantColumns(),
    name: text().notNull(),
    /** A ScenarioAssumptions object, checked by the API before it is stored. */
    assumptions: jsonb().$type<Record<string, unknown>>().notNull(),
    notes: text(),
  },
  (t) => [index().on(t.farmId, t.name)],
);
