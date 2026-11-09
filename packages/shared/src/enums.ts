/**
 * Stable string values shared by DB (text columns), API validation and UI labels.
 * Text columns rather than Postgres enums, so a value can be added without a migration.
 * UI labels live in i18n under `enums:<name>.<value>`.
 */
const e = <const T extends readonly [string, ...string[]]>(v: T) => v;

// Land and crops
export const LAND_USES = e(['arable', 'pasture', 'reserve', 'yard', 'infrastructure']);
/** FAO soil texture classes; formulas/water-balance.ts holds how much water each one stores. */
export const SOIL_TEXTURE_CLASSES = e(['sand', 'loamy_sand', 'sandy_loam', 'loam', 'silt_loam', 'silt', 'silty_clay_loam', 'silty_clay', 'clay']);
export const FACILITY_TYPES = e(['barn', 'feed_storage', 'warehouse', 'water', 'well', 'pump', 'power', 'road', 'fence', 'guardhouse', 'other']);
export const IRRIGATION_NODE_TYPES = e(['canal', 'ditch', 'pump', 'pipe', 'well']);
export const OPERATION_TYPES = e(['tillage', 'sowing', 'irrigation', 'fertilizing', 'protection', 'observation', 'harvest']);
export const CROP_PLAN_STATUSES = e(['planned', 'sown', 'growing', 'harvested', 'cancelled']);

// Livestock
export const SEXES = e(['female', 'male']);
export const ANIMAL_CATEGORIES = e(['ewe', 'ram', 'lamb_male', 'lamb_female', 'wether', 'fattening']);
export const ANIMAL_STATUSES = e(['active', 'pregnant', 'sick', 'quarantine', 'sold', 'slaughtered', 'dead', 'lost']);
/** Statuses of animals still on the farm. */
export const ANIMAL_ON_FARM_STATUSES = e(['active', 'pregnant', 'sick', 'quarantine']);
export const ANIMAL_ORIGINS = e(['born', 'purchased']);
export const IDENTIFIER_TYPES = e(['ear_tag', 'rfid', 'qr']);
export const WEIGHT_METHODS = e(['manual', 'scale', 'rfid']);
export const BREEDING_STATUSES = e(['pregnant', 'lambed', 'aborted', 'failed']);
export const BREEDING_SOURCES = e(['mating', 'purchase']);
export const HEALTH_RECORD_TYPES = e(['vaccination', 'treatment', 'prophylaxis', 'deworming', 'examination', 'quarantine']);
export const ANIMAL_EXIT_TYPES = e(['sale', 'slaughter', 'death', 'loss']);
export const HERD_CONDITIONS = e(['normal', 'deviation']);
export const PHYSIOLOGICAL_STATES = e(['pregnant', 'lactating', 'lamb', 'fattening', 'maintenance']);

// Inventory
export const WAREHOUSE_TYPES = e(['feed', 'seed_fertilizer', 'vet', 'fuel', 'spare_parts', 'finished_goods']);
export const ITEM_CATEGORIES = e(['feed', 'seed', 'fertilizer', 'chemical', 'vet_drug', 'vaccine', 'fuel', 'lubricant', 'spare_part', 'product']);
export const UNITS = e(['kg', 't', 'bale', 'dose', 'vial', 'l', 'pcs', 'head']);
export const MOVEMENT_TYPES = e(['receipt', 'issue', 'transfer_out', 'transfer_in', 'adjustment_in', 'adjustment_out']);
export const RECEIPT_SOURCES = e(['opening', 'purchase', 'own_harvest', 'return', 'adjustment', 'transfer']);
export const COSTING_METHODS = e(['fifo', 'avg']);

// Finance
export const COST_CENTER_TYPES = e(['field', 'herd', 'animal', 'asset', 'employee', 'general']);
/**
 * `contribution` and `withdrawal` are the owner's own money going into the farm and coming back out.
 * They move cash but are neither income nor expense, so profit never counts them.
 */
export const TRANSACTION_TYPES = e(['expense', 'income', 'transfer', 'debt_payment', 'debt_receipt', 'contribution', 'withdrawal']);
/**
 * How an expense reaches cost centers:
 *  expense   — direct cost of the cost center now
 *  inventory — bought for stock; reaches a cost center only when issued from the warehouse
 *  capex     — fixed asset; reaches cost centers through depreciation
 *  animal    — livestock purchase; capitalised into the animal's own cost
 * Without this split, feed would be counted twice: on purchase and again on issue.
 */
export const COST_TREATMENTS = e(['expense', 'inventory', 'capex', 'animal']);
export const TRANSACTION_STATUSES = e(['draft', 'pending', 'approved', 'rejected']);
/** `non_cash` is for postings that move no money, e.g. depreciation. */
export const PAYMENT_METHODS = e(['cash', 'bank', 'card', 'debt', 'non_cash']);
export const ACCOUNT_TYPES = e(['cash', 'bank', 'card']);
/** Cash handed to a person who spends it for the farm (docs/cash-holders.md). Money moves only when accepted. */
export const CASH_HANDOVER_STATUSES = e(['sent', 'accepted', 'disputed', 'cancelled', 'reversed']);
/** Where handed cash came from: the owner's own pocket, or a farm account. */
export const CASH_HANDOVER_SOURCES = e(['own_funds', 'account']);
export const CURRENCIES = e(['UZS', 'USD', 'RUB', 'EUR']);
export const COUNTERPARTY_TYPES = e(['buyer', 'supplier', 'service', 'bank', 'government', 'other']);
export const CATEGORY_KINDS = e(['expense', 'income']);
export const EXPENSE_GROUPS = e(['livestock', 'crops', 'labor', 'machinery', 'infrastructure', 'admin', 'financial', 'investment']);
export const INCOME_GROUPS = e(['livestock_sales', 'product_sales', 'crop_sales', 'breeding_sales', 'subsidy', 'other_income']);
export const OVERHEAD_BASES = e(['head', 'area', 'direct_cost', 'hours']);
export const LOAN_METHODS = e(['annuity', 'equal_principal']);
export const LOAN_STATUSES = e(['active', 'closed']);

// HR
export const PAY_TYPES = e(['monthly', 'daily', 'piece', 'seasonal']);
export const EMPLOYEE_STATUSES = e(['active', 'on_leave', 'terminated']);
export const TIMESHEET_STATUSES = e(['present', 'absent', 'sick', 'vacation', 'day_off']);
export const PAYROLL_STATUSES = e(['draft', 'pending', 'approved', 'paid']);

// Assets
export const ASSET_TYPES = e(['tractor', 'combine', 'excavator', 'seeder', 'plough', 'pump', 'generator', 'scale', 'camera', 'vehicle', 'other']);
export const ASSET_STATUSES = e(['working', 'idle', 'repair', 'written_off']);
export const DEPRECIATION_METHODS = e(['straight_line', 'units']);
export const MAINTENANCE_TYPES = e(['planned', 'repair']);

// Sales
export const SALE_STATUSES = e(['draft', 'pending', 'confirmed', 'cancelled']);
export const PURCHASE_REQUEST_STATUSES = e(['requested', 'approved', 'rejected', 'paid', 'received']);

// Tasks, notifications, events
export const TASK_STATUSES = e(['open', 'in_progress', 'done', 'cancelled']);
export const PRIORITIES = e(['low', 'normal', 'high']);
export const RECURRENCES = e(['none', 'daily', 'weekly', 'monthly']);
export const SEVERITIES = e(['info', 'attention', 'urgent']);
export const ALERT_STATUSES = e(['open', 'acknowledged', 'resolved']);
export const NOTIFICATION_CHANNELS = e(['in_app', 'telegram', 'email', 'sms', 'push']);
export const EVENT_SOURCES = e(['user', 'mobile', 'system', 'camera', 'sensor', 'ai', 'import']);
export const DEVICE_TYPES = e(['camera', 'sensor', 'rfid_reader', 'scale', 'gps_tracker']);
export const DEVICE_STATUSES = e(['planned', 'online', 'offline']);
export const AI_DECISIONS = e(['pending', 'accepted', 'rejected']);
export const DOCUMENT_TYPES = e(['land', 'construction', 'permit', 'contract', 'invoice', 'vet_certificate', 'act', 'other']);
export const LEAD_STATUSES = e(['new', 'contacted', 'qualified', 'won', 'lost']);
export const LEAD_FARM_TYPES = e(['livestock', 'crops', 'mixed', 'other']);

export type Severity = (typeof SEVERITIES)[number];
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export type CostTreatment = (typeof COST_TREATMENTS)[number];
export type AnimalStatus = (typeof ANIMAL_STATUSES)[number];
export type CostCenterType = (typeof COST_CENTER_TYPES)[number];
export type OverheadBaseValue = (typeof OVERHEAD_BASES)[number];
export type EventSource = (typeof EVENT_SOURCES)[number];
export type CostingMethod = (typeof COSTING_METHODS)[number];
