import { describe, expect, it } from 'vitest';
import * as enums from '../enums';
import { ACTIONS, MODULES, ROLE_KEYS } from '../permissions';
import { LANGUAGES, NAMESPACES, resources } from './index';

type Dict = Record<string, unknown>;

function flatKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Dict).flatMap(([k, v]) => flatKeys(v, prefix ? `${prefix}.${k}` : k));
}

/** Plural suffixes differ between languages, so compare the base key. */
const stripPlural = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, '');

function isNonEmpty(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (value && typeof value === 'object') return Object.values(value).every(isNonEmpty);
  return true;
}

describe('dictionaries', () => {
  it.each([...NAMESPACES])('%s has the same keys in uz, ru and en', (ns) => {
    const keys = (lang: 'uz' | 'ru' | 'en') => [...new Set(flatKeys(resources[lang][ns]).filter(Boolean).map(stripPlural))].sort();
    expect(keys('ru')).toEqual(keys('uz'));
    expect(keys('en')).toEqual(keys('uz'));
  });

  it('has no empty strings', () => {
    for (const lang of ['uz', 'ru', 'en'] as const) {
      for (const ns of NAMESPACES) expect(isNonEmpty(resources[lang][ns]), `${lang}/${ns}`).toBe(true);
    }
  });

  it('derives Cyrillic for every language entry', () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(['uz', 'uz-Cyrl', 'ru', 'en']);
    const common = resources['uz-Cyrl'].common as { actions: { save: string } };
    expect(common.actions.save).toBe('Сақлаш');
  });
});

describe('enum labels', () => {
  const groups: Record<string, readonly string[]> = {
    landUse: enums.LAND_USES,
    leadStatus: enums.LEAD_STATUSES,
    leadFarmType: enums.LEAD_FARM_TYPES,
    facilityType: enums.FACILITY_TYPES,
    irrigationNodeType: enums.IRRIGATION_NODE_TYPES,
    operationType: enums.OPERATION_TYPES,
    cropPlanStatus: enums.CROP_PLAN_STATUSES,
    sex: enums.SEXES,
    animalCategory: enums.ANIMAL_CATEGORIES,
    animalStatus: enums.ANIMAL_STATUSES,
    animalOrigin: enums.ANIMAL_ORIGINS,
    identifierType: enums.IDENTIFIER_TYPES,
    weightMethod: enums.WEIGHT_METHODS,
    breedingStatus: enums.BREEDING_STATUSES,
    breedingSource: enums.BREEDING_SOURCES,
    healthRecordType: enums.HEALTH_RECORD_TYPES,
    animalExitType: enums.ANIMAL_EXIT_TYPES,
    herdCondition: enums.HERD_CONDITIONS,
    physiologicalState: enums.PHYSIOLOGICAL_STATES,
    warehouseType: enums.WAREHOUSE_TYPES,
    itemCategory: enums.ITEM_CATEGORIES,
    unit: enums.UNITS,
    movementType: enums.MOVEMENT_TYPES,
    receiptSource: enums.RECEIPT_SOURCES,
    costingMethod: enums.COSTING_METHODS,
    costCenterType: enums.COST_CENTER_TYPES,
    transactionType: enums.TRANSACTION_TYPES,
    costTreatment: enums.COST_TREATMENTS,
    transactionStatus: enums.TRANSACTION_STATUSES,
    paymentMethod: enums.PAYMENT_METHODS,
    accountType: enums.ACCOUNT_TYPES,
    currency: enums.CURRENCIES,
    counterpartyType: enums.COUNTERPARTY_TYPES,
    categoryKind: enums.CATEGORY_KINDS,
    expenseGroup: enums.EXPENSE_GROUPS,
    incomeGroup: enums.INCOME_GROUPS,
    overheadBase: enums.OVERHEAD_BASES,
    loanMethod: enums.LOAN_METHODS,
    loanStatus: enums.LOAN_STATUSES,
    payType: enums.PAY_TYPES,
    employeeStatus: enums.EMPLOYEE_STATUSES,
    timesheetStatus: enums.TIMESHEET_STATUSES,
    payrollStatus: enums.PAYROLL_STATUSES,
    assetType: enums.ASSET_TYPES,
    assetStatus: enums.ASSET_STATUSES,
    depreciationMethod: enums.DEPRECIATION_METHODS,
    maintenanceType: enums.MAINTENANCE_TYPES,
    saleStatus: enums.SALE_STATUSES,
    purchaseRequestStatus: enums.PURCHASE_REQUEST_STATUSES,
    taskStatus: enums.TASK_STATUSES,
    priority: enums.PRIORITIES,
    recurrence: enums.RECURRENCES,
    severity: enums.SEVERITIES,
    alertStatus: enums.ALERT_STATUSES,
    notificationChannel: enums.NOTIFICATION_CHANNELS,
    eventSource: enums.EVENT_SOURCES,
    deviceType: enums.DEVICE_TYPES,
    deviceStatus: enums.DEVICE_STATUSES,
    aiDecision: enums.AI_DECISIONS,
    documentType: enums.DOCUMENT_TYPES,
    soilTexture: enums.SOIL_TEXTURE_CLASSES,
    role: ROLE_KEYS,
    module: MODULES,
    action: ACTIONS,
  };

  it.each(Object.entries(groups))('%s is fully labelled', (group, values) => {
    for (const lang of ['uz', 'ru', 'en'] as const) {
      const labels = (resources[lang].enums as Record<string, Dict>)[group];
      expect(labels, `${lang}: enums:${group}`).toBeDefined();
      for (const value of values) expect(labels[value], `${lang}: enums:${group}.${value}`).toBeTruthy();
    }
  });

  it('covers every enum exported from enums.ts', () => {
    const exported = Object.entries(enums).filter(([, v]) => Array.isArray(v)).map(([, v]) => v as readonly string[]);
    const known = new Set(Object.values(groups));
    // ANIMAL_ON_FARM_STATUSES is a subset of ANIMAL_STATUSES and shares its labels.
    const missing = exported.filter((list) => !known.has(list) && list !== enums.ANIMAL_ON_FARM_STATUSES);
    expect(missing).toEqual([]);
  });

  it('every species has its own word for every animal category', () => {
    for (const lang of ['uz', 'ru', 'en'] as const) {
      const bySpecies = (resources[lang].enums as unknown as { animalCategoryBySpecies: Record<string, Record<string, string>> }).animalCategoryBySpecies;
      expect(Object.keys(bySpecies).sort()).toEqual(['cattle', 'goat', 'horse', 'poultry']);
      for (const words of Object.values(bySpecies)) expect(Object.keys(words).sort()).toEqual([...enums.ANIMAL_CATEGORIES].sort());
    }
  });
});
