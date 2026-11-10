import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { dec, day, money, pk, qty, ts } from './_helpers';
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
    /** Foetuses counted at the latest pregnancy scan; null until she is scanned. History is in pregnancy_scans. */
    fetusCount: integer(),
    scanDate: day(),
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
    /** When the person saved the form on their device: the closest thing to the hour of birth. */
    bornAt: ts(),
  },
  (t) => [index().on(t.eweId), index().on(t.farmId, t.date)],
);

/** Every pregnancy scan, newest wins: the count on the pregnancy is the latest one here. */
export const pregnancyScans = pgTable(
  'pregnancy_scans',
  {
    id: pk(),
    ...tenantColumns(),
    breedingId: uuid().notNull().references(() => breedingRecords.id),
    eweId: uuid().notNull().references(() => animals.id),
    date: day().notNull(),
    /** 0 means she is empty. */
    fetusCount: integer().notNull(),
    /** Who held the scanner: often a visiting specialist, so a name, not an employee. */
    scannedBy: text(),
    notes: text(),
  },
  (t) => [index().on(t.breedingId), index().on(t.farmId, t.date)],
);

/** Care of a newborn, one row per lamb. The genetic dam stays in animals.dam_id. */
export const lambCare = pgTable(
  'lamb_care',
  {
    id: pk(),
    ...tenantColumns(),
    lambId: uuid().notNull().references(() => animals.id),
    colostrumAt: ts(),
    navelTreated: boolean().notNull().default(false),
    mothering: text().notNull().default('with_dam'),
    /** The ewe raising the lamb when it is fostered. Never used for productivity figures. */
    fosterEweId: uuid().references(() => animals.id),
    notes: text(),
  },
  (t) => [uniqueIndex('lamb_care_one_per_lamb').on(t.lambId), index().on(t.farmId, t.mothering)],
);

/** A ewe and her lambs kept in a lambing pen (a facility section marked as one). */
export const penStays = pgTable(
  'pen_stays',
  {
    id: pk(),
    ...tenantColumns(),
    facilityId: uuid().notNull().references(() => facilities.id),
    eweId: uuid().notNull().references(() => animals.id),
    lambingId: uuid().references(() => lambingRecords.id),
    sinceDate: day().notNull(),
    plannedReleaseDate: day().notNull(),
    releasedDate: day(),
    /** Where she was kept before, to put her and her lambs back on release. */
    previousFacilityId: uuid().references(() => facilities.id),
    notes: text(),
  },
  (t) => [
    index().on(t.farmId, t.facilityId),
    // A ewe is in one pen at a time, whatever order requests arrive in.
    uniqueIndex('pen_stays_one_open_per_ewe').on(t.eweId).where(sql`released_date is null`),
  ],
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

/**
 * Body condition score: how much fat and muscle a hand finds over the loin, 1 (emaciated) to 5
 * (very fat) in half steps. The scale is Russel, Doney and Gunn (1969), "Subjective assessment of
 * body fat in live sheep", Journal of Agricultural Science 72:451-454.
 */
export const bodyConditionScores = pgTable(
  'body_condition_scores',
  {
    id: pk(),
    ...tenantColumns(),
    animalId: uuid().notNull().references(() => animals.id),
    date: day().notNull(),
    score: dec(2, 1).notNull(),
    notes: text(),
  },
  // One score per animal per day: scoring her again the same day corrects the first entry.
  (t) => [unique('body_condition_one_per_day').on(t.animalId, t.date), index().on(t.farmId, t.date)],
);

/** The fat tail (dumba) of a fat-tailed sheep, measured by tape. Any one of the three may be missing. */
export const fatTailMeasurements = pgTable(
  'fat_tail_measurements',
  {
    id: pk(),
    ...tenantColumns(),
    animalId: uuid().notNull().references(() => animals.id),
    date: day().notNull(),
    widthCm: dec(5, 1),
    lengthCm: dec(5, 1),
    circumferenceCm: dec(5, 1),
    notes: text(),
  },
  (t) => [index().on(t.animalId, t.date)],
);

/** Grading (bonitirovka): the class a person gave the animal on inspection. The class list is a tenant setting. */
export const animalGradings = pgTable(
  'animal_gradings',
  {
    id: pk(),
    ...tenantColumns(),
    animalId: uuid().notNull().references(() => animals.id),
    date: day().notNull(),
    classKey: text().notNull(),
    /** Free text, often a visiting specialist: personal data (rule 8). */
    gradedBy: text(),
    notes: text(),
  },
  (t) => [index().on(t.animalId, t.date), index().on(t.farmId, t.classKey)],
);

/** A person's own decision to cull an animal. Suggestions are computed and never stored. */
export const cullMarks = pgTable(
  'cull_marks',
  {
    id: pk(),
    ...tenantColumns(),
    animalId: uuid().notNull().references(() => animals.id),
    reason: text().notNull(),
    note: text(),
    markedOn: day().notNull(),
    clearedOn: day(),
  },
  (t) => [
    index().on(t.farmId, t.clearedOn),
    index().on(t.animalId),
    // An animal is marked or it is not: one open mark at a time.
    uniqueIndex('cull_marks_one_open_per_animal').on(t.animalId).where(sql`cleared_on is null`),
  ],
);
