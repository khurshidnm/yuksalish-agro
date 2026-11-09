import type { Alert } from '@/features/alerts/types';

/** Mirrors apps/api/src/modules/dashboard. A part the reader may not see is absent, not null. */
export type BlockKey = 'finance' | 'livestock' | 'crops' | 'feed' | 'staff' | 'alerts' | 'cameras';

export type Block<T> = { status: 'ok'; data: T } | { status: 'unavailable'; data: null };

export interface LocalizedName {
  uz: string;
  ru: string;
  en: string;
}

export interface FinanceData {
  month: { month: string; income: number; expense: number; operatingExpense: number };
  cash: {
    accounts: {
      id: string;
      /** Null for another person's cash when the reader may not see names. */
      name: string | null;
      type: string;
      currency: string;
      balance: number;
      balanceBase: number;
      holder: { isMe: boolean } | null;
    }[];
    total: number;
  };
  /** The owner's own money put in, and cash in people's hands. Null without finance.view. */
  capital: { invested: number; contributed: number; withdrawn: number; cashWithPeople: number; holders: number } | null;
  debts: {
    receivable: number;
    payable: number;
    overdue: number;
    overduePayable: number;
    overdueReceivable: number;
    loansOutstanding: number;
  };
  budget: {
    month: BudgetTotals;
    year: BudgetTotals;
    overruns: { categoryId: string; key: string; name: LocalizedName; planned: number; actual: number; deviation: number }[];
  };
  forecast: {
    method: string;
    lowConfidence: boolean;
    firstNegativeMonth: string | null;
    months: { month: string; inflow: number; outflow: number; net: number; closing: number; negative: boolean }[];
  };
}

export interface BudgetTotals {
  planned: number;
  actual: number;
  deviation: number;
  percent: number | null;
}

export interface LivestockData {
  total: number;
  byCategory: Record<string, number>;
  byStatus: Record<string, number>;
  pregnant: number;
  sick: number;
  quarantine: number;
  lambing: {
    weeks: { week: string; expected: number }[];
    totalEwes: number;
    overdue: number;
    /** From the farm's own lambings; null until it has some. */
    expectedLambs: number | null;
    /** The outlook's stated assumption applied to the same ewes, for while expectedLambs is null. */
    assumedLambs?: number | null;
    assumedLambsPerEwe?: number;
    next7Days: number;
    nextDate: string | null;
  };
  mortality: { dead: number; percent: number | null };
  weightTrend: { month: string; avgKg: number | null }[];
}

export interface WeatherDay {
  date: string;
  tempMin: number | null;
  tempMax: number | null;
  precipitationMm: number | null;
  weatherCode: number | null;
  frost: boolean | null;
}

export interface CropsData {
  status: { sown: number; irrigated: number; harvested: number; total: number };
  overdueCount: number;
  overdue: { id: string; type: string; date: string; fieldNumber: string }[];
  harvest: { plannedT: number; actualT: number };
  weather: WeatherDay[];
}

export interface FeedItem {
  itemId: string;
  name: string;
  unit: string;
  stockQty: number;
  /** Daily use by the rations, in the item's unit. Null when no ration plans it, or its weight is unknown. */
  plannedDaily: number | null;
  /** Average issued per day lately. Null when nothing was issued. */
  actualDaily: number | null;
  days: number | null;
  basis: 'actual' | 'plan' | null;
  minDays: number;
  belowMinimum: boolean;
}

export interface FeedData {
  items: FeedItem[];
  limiting: { itemId: string; name: string; days: number; basis: 'actual' | 'plan' | null } | null;
  avgDailyKg: number | null;
  consumption: { date: string; qty: number }[];
  lowStockCount: number;
  lowStock: { itemId: string; name: string; unit: string; stockQty: number; minQty: number | null; days: number | null; minDays: number | null; reason: 'qty' | 'days' }[];
}

export interface StaffData {
  attendance?: { present: number; total: number };
  tasks?: { open: number; overdue: number; doneToday: number };
  machinery?: { total: number; byStatus: Record<string, number>; maintenanceDue: number };
  fuel?: { liters: number; days: number };
}

export interface AlertsData {
  counts: { urgent: number; attention: number; info: number; total: number };
  items: Alert[];
}

export interface CamerasData {
  fleet: { total: number; online: number; offline: number; planned: number };
  events: { id: string; occurredAt: string; source: string; type: string; severity: string; deviceId: string | null; deviceName: string | null; sample: boolean }[];
}

export interface DashboardData {
  asOf: string;
  order: BlockKey[];
  blocks: {
    finance?: Block<FinanceData>;
    livestock?: Block<LivestockData>;
    crops?: Block<CropsData>;
    feed?: Block<FeedData>;
    staff?: Block<StaffData>;
    alerts?: Block<AlertsData>;
    cameras?: Block<CamerasData>;
  };
}

export type KpiGroupKey = 'finance' | 'livestock' | 'crops' | 'feed' | 'staff' | 'machinery';

export interface KpiData {
  period: { from: string; to: string };
  groups: Partial<Record<KpiGroupKey, Block<Record<string, number | string | null>>>>;
}

export interface OutlookFeedRow {
  itemId: string;
  name: string;
  stockKg: number;
  /** Grown on the farm, so it next comes in at harvest. */
  ownCrop: boolean;
  nextHarvest: string | null;
  needKg: number;
  surplusKg: number;
  runsOutMonth: string | null;
}

export interface OutlookHerdRow {
  month: string;
  ewesLambing: number;
  lambsBorn: number;
  lambsSold: number;
  lambsOnFarm: number;
  head: number;
}

export interface OutlookMoneyRow {
  month: string;
  inflow: number;
  outflow: number;
  net: number;
  closing: number;
}

export interface OutlookData {
  asOf: string;
  months: string[];
  herd: {
    assumptions: { lambsPerEwe: number; survival: number; monthsToSale: number; keepShare: number; saleWeightKg: number };
    pregnant: number;
    lambing: { from: string | null; to: string | null };
    lambsBorn: number;
    lambsSold: number;
    lambsKept: number;
    peakHead: number;
    closingHead: number;
    rows: OutlookHerdRow[];
  } | null;
  feed: OutlookFeedRow[] | null;
  crops: {
    rows: { crop: string; name: { uz: string; ru: string; en: string }; areaHa: number; expectedT: number | null; expectedYieldTHa: number | null; lastYearT: number | null }[];
    areaHa: number;
  } | null;
  money: {
    opening: number;
    inflow: number;
    outflow: number;
    closing: number;
    lowest: { month: string; closing: number } | null;
    firstNegativeMonth: string | null;
    lambPricePerKg: number | null;
    lambIncome: number | null;
    rows: OutlookMoneyRow[];
  } | null;
}
