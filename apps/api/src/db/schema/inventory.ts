import { boolean, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { dec, day, money, pk, qty, ts } from './_helpers';
import { tenantColumns } from './_tenant';
import { crops } from './core';
import { costCenters, counterparties } from './finance';
import { facilities, fields } from './land';
import { users } from './platform';

export const warehouses = pgTable(
  'warehouses',
  {
    id: pk(),
    ...tenantColumns(),
    name: text().notNull(),
    type: text().notNull(),
    facilityId: uuid().references(() => facilities.id),
    active: boolean().notNull().default(true),
    notes: text(),
  },
  (t) => [index().on(t.farmId)],
);

/** Nomenklatura. Each item has one unit; all quantities are stored in it. */
export const items = pgTable(
  'items',
  {
    id: pk(),
    ...tenantColumns(),
    name: text().notNull(),
    category: text().notNull(),
    unit: text().notNull(),
    sku: text(),
    barcode: text(),
    /** Dry matter percent, for feed conversion. */
    dryMatterPct: dec(5, 2),
    minQty: qty(),
    /** Alert when stock covers fewer days than this (spec 9.2). */
    minDays: dec(8, 2),
    defaultWarehouseId: uuid().references(() => warehouses.id),
    /** Default withdrawal period for drugs, days. */
    withdrawalDays: dec(6, 0),
    /** Internal transfer price for own produce (spec 7.3). */
    transferPrice: money(),
    /** Weight of one unit, for items not kept in kg or t, e.g. one bale. Rations are in kg. */
    kgPerUnit: dec(10, 3),
    /** The crop this feed is grown from. Links a winter shortage to the hectares to sow (9.3). */
    cropId: uuid().references(() => crops.id),
    active: boolean().notNull().default(true),
    notes: text(),
  },
  (t) => [index().on(t.farmId, t.category)],
);

/** Every receipt is its own batch (spec 9.2). */
export const stockBatches = pgTable(
  'stock_batches',
  {
    id: pk(),
    ...tenantColumns(),
    itemId: uuid().notNull().references(() => items.id),
    warehouseId: uuid().notNull().references(() => warehouses.id),
    batchNo: text(),
    /** Supplier's invoice number (hisob-faktura), spec 9.2. */
    invoiceNo: text(),
    receivedDate: day().notNull(),
    qtyReceived: qty().notNull(),
    qtyRemaining: qty().notNull(),
    unitCost: dec(18, 4).notNull(),
    expiryDate: day(),
    source: text().notNull(),
    counterpartyId: uuid().references(() => counterparties.id),
    fieldId: uuid().references(() => fields.id),
    notes: text(),
  },
  (t) => [index().on(t.itemId, t.warehouseId, t.receivedDate), index().on(t.farmId, t.expiryDate)],
);

/** Written only by core/inventory. `totalCost` of issue rows is what reaches cost centers. */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: pk(),
    ...tenantColumns(),
    type: text().notNull(),
    date: day().notNull(),
    itemId: uuid().notNull().references(() => items.id),
    batchId: uuid().notNull().references(() => stockBatches.id),
    warehouseId: uuid().notNull().references(() => warehouses.id),
    /** Always positive; `type` gives the direction. */
    qty: qty().notNull(),
    unitCost: dec(18, 4).notNull(),
    totalCost: money().notNull(),
    costCenterId: uuid().references(() => costCenters.id),
    /** Why: 'ration', 'field_operation', 'fuel', 'treatment', 'sale', 'count'... */
    reason: text(),
    docNo: text(),
    /** Source record that caused the movement. */
    refType: text(),
    refId: uuid(),
    notes: text(),
  },
  (t) => [
    index().on(t.farmId, t.date),
    index().on(t.itemId, t.date),
    index().on(t.costCenterId, t.date),
    index().on(t.refType, t.refId),
  ],
);

export const stockCounts = pgTable('stock_counts', {
  id: pk(),
  ...tenantColumns(),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  date: day().notNull(),
  docNo: text(),
  status: text().notNull().default('draft'),
  notes: text(),
  approvedBy: uuid().references(() => users.id),
  approvedAt: ts(),
});

export const stockCountLines = pgTable(
  'stock_count_lines',
  {
    id: pk(),
    ...tenantColumns(),
    countId: uuid().notNull().references(() => stockCounts.id, { onDelete: 'cascade' }),
    itemId: uuid().notNull().references(() => items.id),
    systemQty: qty().notNull(),
    actualQty: qty().notNull(),
    diffQty: qty().notNull(),
    diffCost: money().notNull().default(0),
  },
  (t) => [index().on(t.countId)],
);

export const rations = pgTable('rations', {
  id: pk(),
  ...tenantColumns(),
  name: text().notNull(),
  state: text().notNull(),
  active: boolean().notNull().default(true),
  notes: text(),
});

export const rationLines = pgTable(
  'ration_lines',
  {
    id: pk(),
    ...tenantColumns(),
    rationId: uuid().notNull().references(() => rations.id, { onDelete: 'cascade' }),
    itemId: uuid().notNull().references(() => items.id),
    kgPerHeadDay: dec(10, 4).notNull(),
  },
  (t) => [index().on(t.rationId)],
);
