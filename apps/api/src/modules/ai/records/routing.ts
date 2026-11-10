/**
 * Where each kind of money belongs. A code table, not a model decision: the model picks a category,
 * and this says what that category needs (docs/assistant.md, "What goes where").
 */
import type { CostCenterType, CostTreatment, Permission } from '@yap/shared';

export interface CategoryRule {
  /** Goods. Bought for stock they go through a receipt, so the cost reaches a center on issue. */
  goods?: boolean;
  /** Cost center types this may be charged to. Empty means the general cost center. */
  targets: CostCenterType[];
  /** The general cost center is an acceptable answer when no target was stated. */
  generalAllowed?: boolean;
  /** Ask even when only one target exists: bought animals may start a new herd. */
  alwaysAsk?: boolean;
  treatment?: CostTreatment;
  /** Owned by another module. Recording it here would count it twice. */
  ownedBy?: 'payroll' | 'loans' | 'depreciation' | 'sales' | 'cash_reports';
}

const general: CategoryRule = { targets: [], generalAllowed: true };

export const CATEGORY_RULES: Record<string, CategoryRule> = {
  // Livestock
  animal_purchase: { targets: ['herd'], treatment: 'animal', alwaysAsk: true },
  feed: { goods: true, targets: ['herd'] },
  veterinary: { goods: true, targets: ['herd'] },
  tags_devices: { targets: ['herd'] },
  shearing: { targets: ['herd'] },
  // Crops
  seed: { goods: true, targets: ['field'] },
  fertilizer: { goods: true, targets: ['field'] },
  crop_protection: { goods: true, targets: ['field'] },
  water: { targets: ['field'], generalAllowed: true },
  mechanization_service: { targets: ['field'], generalAllowed: true },
  // Machinery
  fuel: { goods: true, targets: ['asset'] },
  spare_parts: { goods: true, targets: ['asset'] },
  repair: { targets: ['asset', 'field'], generalAllowed: true },
  equipment_rent: { targets: ['asset', 'field'], generalAllowed: true },
  // Day workers and drivers paid by the day who are not on the payroll. Staff go through payroll advances.
  casual_labour: { targets: ['asset', 'field', 'herd'], generalAllowed: true },
  // Shared costs
  electricity: general,
  gas: general,
  utility_water: general,
  construction_repair: general,
  security_guard: general,
  communication: general,
  transport: general,
  paperwork: general,
  licenses: general,
  bank_fees: general,
  insurance: general,
  meals: general,
  clothing: general,
  // Investment
  barn_construction: { ...general, treatment: 'capex' },
  machinery_purchase: { ...general, treatment: 'capex' },
  camera_system: { ...general, treatment: 'capex' },
  land_purchase: { ...general, treatment: 'capex' },
  // Owned elsewhere
  salary: { targets: [], ownedBy: 'payroll' },
  bonus: { targets: [], ownedBy: 'payroll' },
  payroll_tax: { targets: [], ownedBy: 'payroll' },
  loan_interest: { targets: [], ownedBy: 'loans' },
  leasing: { targets: [], ownedBy: 'loans' },
  depreciation: { targets: [], ownedBy: 'depreciation' },
  // Booked only when a weekly cash report is approved, from the counted difference.
  cash_shortage: { targets: [], ownedBy: 'cash_reports' },
  cash_surplus: { targets: [], ownedBy: 'cash_reports' },
  // Income from selling what the farm holds goes through Sales, so stock and the herd stay right.
  lamb_sales: { targets: [], ownedBy: 'sales' },
  sheep_sales: { targets: [], ownedBy: 'sales' },
  meat_sales: { targets: [], ownedBy: 'sales' },
  wool_sales: { targets: [], ownedBy: 'sales' },
  grain_sales: { targets: [], ownedBy: 'sales' },
  alfalfa_sales: { targets: [], ownedBy: 'sales' },
  breeding_stock_sales: { targets: [], ownedBy: 'sales' },
  // Other income
  subsidies: general,
  compensations: general,
  grants: general,
  services_income: general,
  rent_income: general,
  other: general,
};

export const RECORD_KINDS = ['expense', 'stock_purchase', 'income', 'debt_payment', 'transfer'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** A proposal lives this long. */
export const PROPOSAL_TTL_MS = 24 * 3_600_000;
/** After confirming, a person can take it back for this long. */
export const UNDO_WINDOW_MS = 15 * 60_000;
export const DUPLICATE_WINDOW_DAYS = 3;
export const OLD_RECORD_DAYS = 30;
/** Older than this is far more likely a mistake than a late entry, so it is asked about. */
export const MAX_RECORD_AGE_DAYS = 400;
/** A stored rate older than this is shown as such on the card. */
export const STALE_RATE_DAYS = 7;
/** How many times its usual size an amount must be before it is called unusual. */
export const UNUSUAL_FACTOR = 5;
export const UNUSUAL_MIN_SAMPLES = 5;
/** Below this, a bare "500" probably dropped a word such as "ming". */
export const BARE_AMOUNT_FLOOR = 10_000;
/** The same for a price per unit, where "800 dan" is real and "15 dan" is not. */
export const BARE_PRICE_FLOOR = 100;
/** With no stored rate to compare with, what a rate could be at all: "kurs 12,7" is not so'm per dollar. */
export const POSSIBLE_RATES: Record<string, [number, number]> = { USD: [1_000, 40_000], EUR: [1_000, 40_000], RUB: [10, 1_000] };
/** A card with one of these needs an explicit yes from the person, not just Confirm. */
export const ACKNOWLEDGE_WARNINGS = new Set(['POSSIBLE_DUPLICATE', 'OTHER_AMOUNT', 'AMOUNT_FROM_DOCUMENT', 'CURRENCY_CONVERTED']);

/**
 * Farm records the assistant prepares beside money (docs/assistant.md, "Farm records"). A code table:
 * `create` is what the manual screen of the owning module asks for, and `undo` what its delete asks
 * for. Null means the owning service has no safe way back, so no undo is offered.
 */
export const FARM_RECORD_KINDS = ['weight', 'death', 'treatment', 'herd_log'] as const;
export type FarmRecordKind = (typeof FARM_RECORD_KINDS)[number];

export const FARM_RULES: Record<FarmRecordKind, { create: Permission[]; undo: Permission | null }> = {
  weight: { create: ['livestock.update'], undo: 'livestock.update' },
  death: { create: ['livestock.create'], undo: 'livestock.delete' },
  // Clinical records take `health.update`: they consume drugs and set withdrawal dates (health.routes.ts).
  treatment: { create: ['health.update'], undo: 'health.delete' },
  // The rights the daily log routes ask (daily-logs.routes.ts).
  herd_log: { create: ['livestock.create'], undo: 'livestock.delete' },
};
