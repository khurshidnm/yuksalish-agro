import { index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { dec, day, money, pk, qty, ts } from './_helpers';
import { tenantColumns } from './_tenant';
import { files } from './core';
import { accounts, costCenters, counterparties, financeCategories, transactions } from './finance';
import { items, stockBatches, warehouses } from './inventory';
import { animals } from './livestock';
import { users } from './platform';

export const sales = pgTable(
  'sales',
  {
    id: pk(),
    ...tenantColumns(),
    number: text(),
    date: day().notNull(),
    counterpartyId: uuid().notNull().references(() => counterparties.id),
    status: text().notNull().default('draft'),
    totalAmount: money().notNull().default(0),
    currency: text().notNull().default('UZS'),
    /** Rate to the base currency. Fixed when the sale is confirmed. */
    fxRate: dec(18, 6),
    deliveryDate: day(),
    /** Payment term for a sale on credit. */
    dueDate: day(),
    paymentMethod: text().notNull().default('debt'),
    accountId: uuid().references(() => accounts.id),
    /** First income posting. All postings carry sourceType 'sale' and this sale's id. */
    transactionId: uuid().references(() => transactions.id),
    confirmedBy: uuid().references(() => users.id),
    confirmedAt: ts(),
    /** Why an approver sent the sale back to draft. */
    rejectedReason: text(),
    cancelledBy: uuid().references(() => users.id),
    cancelledAt: ts(),
    cancelReason: text(),
    notes: text(),
  },
  (t) => [unique().on(t.farmId, t.number), index().on(t.farmId, t.date.desc()), index().on(t.counterpartyId)],
);

export const saleLines = pgTable(
  'sale_lines',
  {
    id: pk(),
    ...tenantColumns(),
    saleId: uuid().notNull().references(() => sales.id, { onDelete: 'cascade' }),
    itemId: uuid().references(() => items.id),
    warehouseId: uuid().references(() => warehouses.id),
    animalId: uuid().references(() => animals.id),
    description: text(),
    qty: qty().notNull(),
    unit: text().notNull(),
    price: money().notNull(),
    amount: money().notNull(),
    /** Cost of what was sold: stock issue cost, or the animal's book value. Set on confirmation. */
    costAmount: money().notNull().default(0),
    /** Income category. Derived from the product when not chosen. */
    categoryId: uuid().references(() => financeCategories.id),
    /** Where the income lands. Derived from the herd or the source field when not chosen. */
    costCenterId: uuid().references(() => costCenters.id),
    /** Animal state before the sale, restored if the sale is cancelled. */
    previousStatus: text(),
    previousHerdId: uuid(),
  },
  (t) => [index().on(t.saleId), index().on(t.animalId)],
);

/** Price list and history; market prices are entered by hand or from a source (spec 13.2). */
export const prices = pgTable(
  'prices',
  {
    id: pk(),
    ...tenantColumns(),
    itemId: uuid().notNull().references(() => items.id),
    date: day().notNull(),
    price: money().notNull(),
    kind: text().notNull().default('sale'),
    source: text(),
  },
  (t) => [index().on(t.itemId, t.date.desc())],
);

/** Purchase flow: request → approve → pay → receive (spec 13.3). */
export const purchaseRequests = pgTable(
  'purchase_requests',
  {
    id: pk(),
    ...tenantColumns(),
    itemId: uuid().notNull().references(() => items.id),
    qty: qty().notNull(),
    expectedPrice: money(),
    counterpartyId: uuid().references(() => counterparties.id),
    status: text().notNull().default('requested'),
    neededBy: day(),
    approvedBy: uuid().references(() => users.id),
    approvedAt: ts(),
    rejectedReason: text(),
    transactionId: uuid().references(() => transactions.id),
    /** Paid amount in base currency. */
    paidAmount: money(),
    /** Paid amount / requested quantity: what one unit really cost. */
    unitCost: dec(18, 4),
    warehouseId: uuid().references(() => warehouses.id),
    receivedQty: qty(),
    receivedOn: day(),
    batchId: uuid().references(() => stockBatches.id),
    quality: text(),
    /** Difference act (farq akti): received minus requested, and what that is worth. */
    diffQty: qty(),
    diffAmount: money(),
    notes: text(),
  },
  (t) => [index().on(t.farmId, t.status)],
);

/** Reports due to state bodies: veterinary, statistics, tax (spec 13.4). */
export const stateReports = pgTable(
  'state_reports',
  {
    id: pk(),
    ...tenantColumns(),
    title: text().notNull(),
    authority: text().notNull(),
    /** Repeats after submission unless 'once'. */
    period: text().notNull().default('once'),
    dueDate: day().notNull(),
    status: text().notNull().default('planned'),
    submittedOn: day(),
    fileId: uuid().references(() => files.id),
    notes: text(),
  },
  (t) => [index().on(t.farmId, t.dueDate)],
);
