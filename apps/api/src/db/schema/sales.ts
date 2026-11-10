import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
  (t) => [unique().on(t.farmId, t.number), index().on(t.farmId, t.date), index().on(t.counterpartyId)],
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
  (t) => [index().on(t.itemId, t.date)],
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

/**
 * An animal held for a buyer. The buyer is a counterparty, or a name and phone typed in for someone
 * who is not one yet. No money moves here: a reservation becomes a sale through the sales order.
 */
export const animalReservations = pgTable(
  'animal_reservations',
  {
    id: pk(),
    ...tenantColumns(),
    animalId: uuid().notNull().references(() => animals.id),
    counterpartyId: uuid().references(() => counterparties.id),
    /** Personal data: shown only with pii.view. */
    customerName: text(),
    customerPhone: text(),
    /** For the whole animal, in the base currency. Shown only with finance.view. */
    agreedPrice: money(),
    reservedUntil: day().notNull(),
    /** open, converted, cancelled, expired (RESERVATION_STATUSES). */
    status: text().notNull().default('open'),
    note: text(),
    /** The sale this reservation became. */
    saleId: uuid().references(() => sales.id, { onDelete: 'set null' }),
    /** The pre-order from the public catalogue it answers, if any. */
    requestId: uuid().references(() => catalogueRequests.id),
    closedBy: uuid().references(() => users.id),
    closedAt: ts(),
    closeReason: text(),
  },
  (t) => [
    // The rule itself: two people reserving the same animal at the same moment cannot both succeed.
    uniqueIndex('animal_reservations_one_open_per_animal').on(t.animalId).where(sql`status = 'open'`),
    index().on(t.farmId, t.status, t.reservedUntil),
    index().on(t.counterpartyId),
    index().on(t.saleId),
  ],
);

/** An animal the farm chose to show on its public catalogue page. No row: not shown. */
export const catalogueListings = pgTable(
  'catalogue_listings',
  {
    id: pk(),
    ...tenantColumns(),
    animalId: uuid().notNull().references(() => animals.id, { onDelete: 'cascade' }),
    /** The price the farm publishes for this animal, in the base currency. Null: no price is shown. */
    price: money(),
  },
  (t) => [uniqueIndex('catalogue_listings_animal').on(t.animalId), index().on(t.farmId)],
);

/**
 * A pre-order a visitor sent from the public catalogue page. Everything in it is a stranger's text:
 * it is stored and shown, never interpreted, and the AI role cannot read this table (post-schema.sql).
 */
export const catalogueRequests = pgTable(
  'catalogue_requests',
  {
    id: pk(),
    ...tenantColumns(),
    name: text().notNull(),
    phone: text().notNull(),
    /** Listed animals the visitor picked. Checked against the catalogue when the request arrives. */
    animalIds: jsonb().$type<string[]>().notNull().default([]),
    /** What they want, in their own words, when it is not a listed animal. */
    wanted: text(),
    note: text(),
    language: text().notNull().default('uz'),
    /** new, reserved, closed (CATALOGUE_REQUEST_STATUSES). */
    status: text().notNull().default('new'),
    /** How many times this phone sent the form while the request was still waiting. */
    submissions: integer().notNull().default(1),
    closedBy: uuid().references(() => users.id),
    closedAt: ts(),
  },
  (t) => [index().on(t.farmId, t.status), index().on(t.tenantId, t.phone)],
);
