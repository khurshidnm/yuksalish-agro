import { boolean, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { day, dec, money, pk, ts } from './_helpers';
import { tenantColumns } from './_tenant';
import { accounts, transactions } from './finance';
import { employees } from './hr';
import { users } from './platform';

/**
 * Cash held by people who spend it for the farm (docs/cash-holders.md): the manager's weekly money,
 * later a foreman's. Each is an ordinary cash account, so balances, reports and the ledger need nothing
 * new; this table says whose it is.
 */
export const cashHolders = pgTable(
  'cash_holders',
  {
    id: pk(),
    ...tenantColumns(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id),
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    active: boolean().notNull().default(true),
  },
  (t) => [unique().on(t.accountId), index().on(t.farmId, t.employeeId)],
);

/**
 * Cash handed to a holder. Nothing moves until the holder says it arrived: then the money is posted,
 * from the owner's own pocket as a contribution, or from a farm account as a transfer.
 */
export const cashHandovers = pgTable(
  'cash_handovers',
  {
    id: pk(),
    ...tenantColumns(),
    holderAccountId: uuid()
      .notNull()
      .references(() => accounts.id),
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    amount: money().notNull(),
    currency: text().notNull(),
    /** A rate the sender stated for foreign own money; otherwise the stored one for the day. */
    fxRate: dec(18, 6),
    date: day().notNull(),
    /** own_funds | account (CASH_HANDOVER_SOURCES). */
    source: text().notNull(),
    fromAccountId: uuid().references(() => accounts.id),
    note: text(),
    /** sent → accepted | disputed | cancelled; accepted → reversed (CASH_HANDOVER_STATUSES). */
    status: text().notNull().default('sent'),
    /** Who received it or said it did not arrive, and when. */
    decidedBy: uuid().references(() => users.id),
    decidedAt: ts(),
    disputeReason: text(),
    transactionId: uuid().references(() => transactions.id),
    reversedBy: uuid().references(() => users.id),
    reversedAt: ts(),
    reversedReason: text(),
  },
  (t) => [index().on(t.farmId, t.status), index().on(t.holderAccountId, t.date)],
);
