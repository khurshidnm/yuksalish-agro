import { boolean, index, jsonb, pgTable, text, unique, uuid, doublePrecision } from 'drizzle-orm/pg-core';
import { dec, day, money, pk, ts } from './_helpers';
import { tenantColumns } from './_tenant';
import { files } from './core';
import { accounts, transactions } from './finance';
import { herds } from './livestock';
import { users } from './platform';

export const employees = pgTable(
  'employees',
  {
    id: pk(),
    ...tenantColumns(),
    /** Linked login. Blocking the employee blocks this account; their records stay (spec 5.1). */
    userId: uuid().references(() => users.id),
    fullName: text().notNull(),
    position: text().notNull(),
    division: text(),
    phone: text(),
    passport: text(),
    hireDate: day().notNull(),
    terminationDate: day(),
    payType: text().notNull().default('monthly'),
    /** Per month, day or season depending on payType. */
    baseRate: money().notNull().default(0),
    /** Piece rates, e.g. { "ha": 45000, "head": 2000, "headDay": 50, "t": 60000 } */
    pieceRates: jsonb().$type<Record<string, number>>().notNull().default({}),
    /** Herd this person looks after: scope of the shepherd KPI, and where labour goes if no work is logged. */
    herdId: uuid().references(() => herds.id),
    status: text().notNull().default('active'),
    contractFileId: uuid().references(() => files.id),
    contractEndDate: day(),
    /** Date the next medical check is due. */
    medicalCheckDate: day(),
    notes: text(),
  },
  (t) => [index().on(t.farmId, t.status), unique().on(t.farmId, t.userId)],
);

export const timesheets = pgTable(
  'timesheets',
  {
    id: pk(),
    ...tenantColumns(),
    employeeId: uuid().notNull().references(() => employees.id),
    date: day().notNull(),
    status: text().notNull().default('present'),
    checkIn: ts(),
    checkOut: ts(),
    hours: dec(5, 2),
    /** Where the person checked in. */
    lat: doublePrecision(),
    lng: doublePrecision(),
    checkOutLat: doublePrecision(),
    checkOutLng: doublePrecision(),
    notes: text(),
  },
  (t) => [unique().on(t.employeeId, t.date), index().on(t.farmId, t.date)],
);

export const payrollRuns = pgTable(
  'payroll_runs',
  {
    id: pk(),
    ...tenantColumns(),
    /** YYYY-MM */
    month: text().notNull(),
    status: text().notNull().default('draft'),
    totalGross: money().notNull().default(0),
    totalNet: money().notNull().default(0),
    /** Last person to change the figures: the maker in maker-checker, even if someone else created the run. */
    preparedBy: uuid().references(() => users.id),
    approvedBy: uuid().references(() => users.id),
    approvedAt: ts(),
    returnedReason: text(),
    paidAt: ts(),
    paymentTransactionId: uuid().references(() => transactions.id),
    notes: text(),
  },
  (t) => [unique().on(t.farmId, t.month)],
);

export const payrollLines = pgTable(
  'payroll_lines',
  {
    id: pk(),
    ...tenantColumns(),
    runId: uuid().notNull().references(() => payrollRuns.id, { onDelete: 'cascade' }),
    employeeId: uuid().notNull().references(() => employees.id),
    daysWorked: dec(6, 2).notNull().default(0),
    base: money().notNull().default(0),
    piecework: money().notNull().default(0),
    bonus: money().notNull().default(0),
    advance: money().notNull().default(0),
    deductions: money().notNull().default(0),
    net: money().notNull().default(0),
    /** Labour cost split across cost centers: { [costCenterId]: amount } (spec 11.6). */
    allocation: jsonb().$type<Record<string, number>>().notNull().default({}),
    /** Fields edited by hand, which a recalculation must keep. */
    overrides: jsonb().$type<string[]>().notNull().default([]),
    /** What the figures rest on: work done, KPI values, attendance. Shown on the pay slip. */
    basis: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [unique().on(t.runId, t.employeeId)],
);

/**
 * Advance paid during the month. Money leaves the account on this date as a settlement of the
 * payroll payable, so the later payroll accrual does not count the cost twice.
 */
export const payrollAdvances = pgTable(
  'payroll_advances',
  {
    id: pk(),
    ...tenantColumns(),
    employeeId: uuid().notNull().references(() => employees.id),
    date: day().notNull(),
    /** YYYY-MM it is deducted from. */
    month: text().notNull(),
    amount: money().notNull(),
    accountId: uuid().references(() => accounts.id),
    transactionId: uuid().references(() => transactions.id),
    notes: text(),
  },
  (t) => [index().on(t.farmId, t.month), index().on(t.employeeId)],
);

/** Automatic bonus rules (spec 11.7). */
export const kpiRules = pgTable(
  'kpi_rules',
  {
    id: pk(),
    ...tenantColumns(),
    name: text().notNull(),
    /** See KPI_METRICS in shared/formulas/payroll.ts. */
    metric: text().notNull(),
    /** Applies to this position; null means everyone. */
    position: text(),
    /** Lowest metric value that earns the bonus. */
    threshold: dec(12, 3).notNull(),
    /** 'fixed' pays `amount` once; 'per_unit' pays it for each unit above the threshold. */
    rewardType: text().notNull().default('fixed'),
    amount: money().notNull(),
    active: boolean().notNull().default(true),
  },
  (t) => [index().on(t.farmId)],
);

/** Safety instructions acknowledged by employees (spec 11.8). */
export const safetyInstructions = pgTable('safety_instructions', {
  id: pk(),
  ...tenantColumns(),
  employeeId: uuid().notNull().references(() => employees.id),
  title: text().notNull(),
  signedOn: day(),
  validUntil: day(),
});
