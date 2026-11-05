import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { dec, day, money, pk, qty } from './_helpers';
import { tenantColumns } from './_tenant';
import { breeds, files, species } from './core';
import { counterparties, transactions } from './finance';
import { employees } from './hr';
import { items, rations, stockBatches, warehouses } from './inventory';
import { facilities, fields } from './land';

export const herds = pgTable(
  'herds',
  {
    id: pk(),
    ...tenantColumns(),
    name: text().notNull(),
    /** Physiological state; selects the ration template (spec 9.3). */
    state: text().notNull().default('maintenance'),
    facilityId: uuid().references(() => facilities.id),
    rationId: uuid().references(() => rations.id),
    costCenterId: uuid(),
    status: text().notNull().default('active'),
    notes: text(),
  },
  (t) => [index().on(t.farmId)],
);

export const animals = pgTable(
  'animals',
  {
    id: pk(),
    ...tenantColumns(),
    /** Primary ear tag; other identifiers live in animal_identifiers. */
    tag: text().notNull(),
    speciesId: uuid().notNull().references(() => species.id),
    breedId: uuid().references(() => breeds.id),
    sex: text().notNull(),
    category: text().notNull(),
    birthDate: day(),
    birthDateEstimated: boolean().notNull().default(false),
    origin: text().notNull(),
    damId: uuid().references((): AnyPgColumn => animals.id),
    sireId: uuid().references((): AnyPgColumn => animals.id),
    purchaseDate: day(),
    purchasePrice: money(),
    sellerId: uuid().references(() => counterparties.id),
    herdId: uuid().references(() => herds.id),
    facilityId: uuid().references(() => facilities.id),
    status: text().notNull().default('active'),
    quarantineUntil: day(),
    currentWeightKg: dec(8, 2),
    lastWeighedOn: day(),
    birthWeightKg: dec(6, 2),
    photoFileId: uuid().references(() => files.id),
    exitDate: day(),
    notes: text(),
  },
  (t) => [
    unique().on(t.tenantId, t.tag),
    index().on(t.farmId, t.status),
    index().on(t.herdId),
    index().on(t.damId),
    index().on(t.sireId),
  ],
);

export const animalIdentifiers = pgTable(
  'animal_identifiers',
  {
    id: pk(),
    ...tenantColumns(),
    animalId: uuid().notNull().references(() => animals.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    value: text().notNull(),
    active: boolean().notNull().default(true),
  },
  (t) => [unique().on(t.tenantId, t.type, t.value), index().on(t.animalId)],
);

export const weighingCampaigns = pgTable('weighing_campaigns', {
  id: pk(),
  ...tenantColumns(),
  herdId: uuid().references(() => herds.id),
  date: day().notNull(),
  name: text().notNull(),
  status: text().notNull().default('open'),
});

export const weightRecords = pgTable(
  'weight_records',
  {
    id: pk(),
    ...tenantColumns(),
    animalId: uuid().notNull().references(() => animals.id, { onDelete: 'cascade' }),
    date: day().notNull(),
    weightKg: dec(8, 2).notNull(),
    method: text().notNull().default('manual'),
    campaignId: uuid().references(() => weighingCampaigns.id),
    notes: text(),
  },
  (t) => [index().on(t.animalId, t.date), index().on(t.farmId, t.date)],
);

export const breedingRecords = pgTable(
  'breeding_records',
  {
    id: pk(),
    ...tenantColumns(),
    eweId: uuid().notNull().references(() => animals.id),
    ramId: uuid().references(() => animals.id),
    source: text().notNull().default('mating'),
    matingDate: day().notNull(),
    expectedDate: day().notNull(),
    expectedEarliest: day().notNull(),
    expectedLatest: day().notNull(),
    status: text().notNull().default('pregnant'),
    notes: text(),
  },
  (t) => [
    index().on(t.eweId),
    index().on(t.farmId, t.status, t.expectedDate),
    // A ewe carries one pregnancy at a time, whatever order concurrent requests arrive in.
    uniqueIndex('breeding_one_open_per_ewe').on(t.eweId).where(sql`status = 'pregnant'`),
  ],
);

export const lambingRecords = pgTable(
  'lambing_records',
  {
    id: pk(),
    ...tenantColumns(),
    breedingId: uuid().references(() => breedingRecords.id),
    eweId: uuid().notNull().references(() => animals.id),
    date: day().notNull(),
    lambsBorn: integer().notNull(),
    lambsAlive: integer().notNull(),
    /** One entry per lamb, including stillborn ones, which never become animals. */
    lambs: jsonb()
      .$type<{ sex: string; birthWeightKg: number | null; alive: boolean; animalId: string | null; tag: string | null }[]>()
      .notNull()
      .default([]),
    complications: text(),
    notes: text(),
  },
  (t) => [index().on(t.eweId), index().on(t.farmId, t.date)],
);

export const healthRecords = pgTable(
  'health_records',
  {
    id: pk(),
    ...tenantColumns(),
    type: text().notNull(),
    /** One animal, or a whole herd when animalId is null. */
    animalId: uuid().references(() => animals.id),
    herdId: uuid().references(() => herds.id),
    date: day().notNull(),
    diagnosis: text(),
    itemId: uuid().references(() => items.id),
    warehouseId: uuid().references(() => warehouses.id),
    dose: dec(10, 3),
    doseUnit: text(),
    qtyUsed: qty(),
    courseDays: integer(),
    vetEmployeeId: uuid().references(() => employees.id),
    result: text(),
    withdrawalDays: integer(),
    withdrawalUntil: day(),
    headCount: integer(),
    totalCost: money().notNull().default(0),
    nextDueDate: day(),
    vaccinationPlanId: uuid(),
    /** Set on a shepherd's sick report: 'open' until the vet closes it. Null on other records. */
    reportStatus: text(),
    /** When a quarantine ended or a sick report was closed. */
    endedOn: day(),
    photoFileIds: jsonb().$type<string[]>().notNull().default([]),
    notes: text(),
  },
  (t) => [
    index().on(t.animalId, t.date),
    index().on(t.herdId, t.date),
    index().on(t.farmId, t.date),
    index().on(t.farmId, t.type, t.endedOn),
    index().on(t.farmId, t.withdrawalUntil),
  ],
);

/** Vaccination calendar template (spec 8.3). */
export const vaccinationPlans = pgTable('vaccination_plans', {
  id: pk(),
  ...tenantColumns(),
  name: text().notNull(),
  itemId: uuid().references(() => items.id),
  speciesId: uuid().references(() => species.id),
  category: text(),
  /** First dose age, days; null means it applies to any age. */
  ageDays: integer(),
  /** Repeat interval, days. */
  intervalDays: integer(),
  mandatory: boolean().notNull().default(true),
  active: boolean().notNull().default(true),
  notes: text(),
});

export const herdTransfers = pgTable(
  'herd_transfers',
  {
    id: pk(),
    ...tenantColumns(),
    animalId: uuid().notNull().references(() => animals.id, { onDelete: 'cascade' }),
    fromHerdId: uuid().references(() => herds.id),
    toHerdId: uuid().references(() => herds.id),
    date: day().notNull(),
    reason: text(),
  },
  (t) => [index().on(t.animalId)],
);

/** Daily herd record (spec 8.4). One per herd per day. */
export const dailyLogs = pgTable(
  'daily_logs',
  {
    id: pk(),
    ...tenantColumns(),
    herdId: uuid().notNull().references(() => herds.id),
    date: day().notNull(),
    headCount: integer().notNull(),
    waterL: dec(12, 2),
    condition: text().notNull().default('normal'),
    photoFileIds: jsonb().$type<string[]>().notNull().default([]),
    notes: text(),
  },
  (t) => [unique().on(t.herdId, t.date), index().on(t.farmId, t.date)],
);

export const dailyLogLines = pgTable(
  'daily_log_lines',
  {
    id: pk(),
    ...tenantColumns(),
    logId: uuid().notNull().references(() => dailyLogs.id, { onDelete: 'cascade' }),
    itemId: uuid().notNull().references(() => items.id),
    warehouseId: uuid().notNull().references(() => warehouses.id),
    plannedQty: qty().notNull().default(0),
    actualQty: qty().notNull(),
    totalCost: money().notNull().default(0),
  },
  (t) => [index().on(t.logId), index().on(t.itemId)],
);

export const shearingRecords = pgTable('shearing_records', {
  id: pk(),
  ...tenantColumns(),
  animalId: uuid().references(() => animals.id),
  herdId: uuid().references(() => herds.id),
  date: day().notNull(),
  woolKg: dec(8, 3).notNull(),
  quality: text(),
  batchId: uuid().references(() => stockBatches.id),
  notes: text(),
});

export const pastureMoves = pgTable('pasture_moves', {
  id: pk(),
  ...tenantColumns(),
  herdId: uuid().notNull().references(() => herds.id),
  fieldId: uuid().notNull().references(() => fields.id),
  outDate: day().notNull(),
  returnDate: day(),
  notes: text(),
});

/** Leaving the farm: sale, slaughter, death, loss (spec 8.5). */
export const animalExits = pgTable(
  'animal_exits',
  {
    id: pk(),
    ...tenantColumns(),
    animalId: uuid().notNull().references(() => animals.id),
    type: text().notNull(),
    date: day().notNull(),
    liveWeightKg: dec(8, 2),
    carcassWeightKg: dec(8, 2),
    pricePerKg: money(),
    amount: money(),
    counterpartyId: uuid().references(() => counterparties.id),
    reason: text(),
    vetConclusion: text(),
    /** Book value lost on death or loss. */
    lossAmount: money(),
    transactionId: uuid().references(() => transactions.id),
    batchId: uuid().references(() => stockBatches.id),
    photoFileIds: jsonb().$type<string[]>().notNull().default([]),
    notes: text(),
  },
  (t) => [unique().on(t.animalId), index().on(t.farmId, t.date), index().on(t.farmId, t.type)],
);
