import { boolean, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { dec, day, money, pk } from './_helpers';
import { tenantColumns } from './_tenant';
import { contracts, counterparties, transactions } from './finance';
import { employees } from './hr';
import { items, warehouses } from './inventory';
import { fields } from './land';

export const assets = pgTable(
  'assets',
  {
    id: pk(),
    ...tenantColumns(),
    name: text().notNull(),
    type: text().notNull(),
    inventoryNo: text(),
    purchaseDate: day(),
    /** Always in the base currency: depreciation, book value and reports read this. */
    purchasePrice: money(),
    /** Set only when the price was paid in another currency: the figure on the contract, and its rate. */
    purchaseAmount: money(),
    purchaseCurrency: text(),
    purchaseFxRate: dec(18, 6),
    status: text().notNull().default('working'),
    usefulLifeMonths: dec(6, 0),
    salvageValue: money().notNull().default(0),
    depreciationMethod: text().notNull().default('straight_line'),
    /** Total lifetime units for units-of-production depreciation. */
    totalUnits: dec(14, 2),
    /** Worn before the farm came onto this system: every month ended by its date is in this figure. */
    openingDepreciation: money().notNull().default(0),
    openingDepreciationDate: day(),
    motoHours: dec(12, 2).notNull().default(0),
    fuelNormLPerHour: dec(8, 2),
    fuelNormLPerHa: dec(8, 2),
    costCenterId: uuid(),
    /** Hired equipment, e.g. a rented combine (spec 12.6). */
    rented: boolean().notNull().default(false),
    rentalCounterpartyId: uuid().references(() => counterparties.id),
    rentalContractId: uuid().references(() => contracts.id),
    /** Price per rentalUnit ('ha', 'hour' or 'day'). */
    rentalPrice: money(),
    rentalUnit: text(),
    notes: text(),
  },
  (t) => [index().on(t.farmId, t.type), unique().on(t.farmId, t.inventoryNo)],
);

export const assetUsageLogs = pgTable(
  'asset_usage_logs',
  {
    id: pk(),
    ...tenantColumns(),
    assetId: uuid().notNull().references(() => assets.id),
    date: day().notNull(),
    operatorEmployeeId: uuid().references(() => employees.id),
    fieldId: uuid().references(() => fields.id),
    operationId: uuid(),
    workType: text(),
    motoHours: dec(10, 2),
    volumeHa: dec(12, 4),
    fuelL: dec(12, 2),
    /** Set when fuel came out of a warehouse; kept so an edit can re-issue it. */
    fuelItemId: uuid().references(() => items.id),
    fuelWarehouseId: uuid().references(() => warehouses.id),
    fuelCost: money().notNull().default(0),
    /** Rental act that billed this shift (spec 12.6). */
    billedTransactionId: uuid().references(() => transactions.id),
    notes: text(),
  },
  (t) => [index().on(t.assetId, t.date), index().on(t.operationId), index().on(t.fieldId)],
);

export const maintenanceRecords = pgTable(
  'maintenance_records',
  {
    id: pk(),
    ...tenantColumns(),
    assetId: uuid().notNull().references(() => assets.id),
    date: day().notNull(),
    type: text().notNull(),
    description: text(),
    cost: money().notNull().default(0),
    nextDueDate: day(),
    nextDueMotoHours: dec(12, 2),
    downtimeHours: dec(8, 2),
    transactionId: uuid().references(() => transactions.id),
  },
  (t) => [index().on(t.assetId, t.date), index().on(t.farmId, t.nextDueDate)],
);

export const depreciationEntries = pgTable(
  'depreciation_entries',
  {
    id: pk(),
    ...tenantColumns(),
    assetId: uuid().notNull().references(() => assets.id),
    /** YYYY-MM */
    month: text().notNull(),
    amount: money().notNull(),
    transactionId: uuid().references(() => transactions.id),
  },
  (t) => [unique().on(t.assetId, t.month)],
);
