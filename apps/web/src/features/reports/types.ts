export type ColumnType = 'text' | 'enum' | 'name' | 'integer' | 'number' | 'money' | 'percent' | 'date' | 'month' | 'boolean';

export interface CatalogColumn {
  key: string;
  label: string;
  type: ColumnType;
  sum: boolean;
}

interface FilterBase {
  key: string;
  label: string;
}

export type CatalogFilter =
  | (FilterBase & { type: 'period'; preset: string })
  | (FilterBase & { type: 'month'; default: 'current' | 'previous' })
  | (FilterBase & { type: 'number'; default: number; min: number; max: number })
  | (FilterBase & { type: 'select'; options: { value: string; label: string }[] })
  | (FilterBase & { type: 'lookup'; path: string; params?: Record<string, string> });

export interface CatalogReport {
  key: string;
  module: string;
  title: string;
  description: string;
  money: boolean;
  filters: CatalogFilter[];
  columns: CatalogColumn[];
  compare: { filter: 'period' | 'seasonId' } | null;
  hasChart: boolean;
}

export interface Catalog {
  presets: string[];
  reports: CatalogReport[];
}

export interface ResultColumn {
  key: string;
  label: string;
  type: ColumnType;
  digits?: number;
  sum?: boolean;
}

export type ReportRow = Record<string, unknown>;

export interface ReportResult {
  key: string;
  title: string;
  description: string;
  period: { from: string; to: string } | null;
  columns: ResultColumn[];
  rows: ReportRow[];
  totals: ReportRow | null;
  rowCount: number;
  truncated: boolean;
  notes: string[];
  chart: { kind: 'bar' | 'stacked-bar' | 'line' | 'area'; x: string; series: { key: string; label: string; slot: number }[] } | null;
  hidden: { money: number; pii: number };
  durationMs: number;
}

export interface SavedConfig {
  columns?: string[];
  groupBy?: string | null;
  filters?: Record<string, string>;
}

export interface SavedReport {
  id: string;
  name: string;
  reportKey: string;
  config: SavedConfig;
  schedule: 'daily' | 'weekly' | 'monthly' | null;
  channels: string[];
  recipients: string[];
  lastSentAt: string | null;
  createdBy: string | null;
}

export interface InvestorData {
  month: string;
  asOf: string;
  finance: {
    income: number;
    expense: number;
    net: number;
    profitabilityPercent: number | null;
    budgetPercent: number | null;
    cash: number;
    receivable: number;
    payable: number;
    loans: number;
    costPerHead: number | null;
    forecast: { month: string; closing: number }[];
  };
  livestock: {
    head: number;
    pregnant: number;
    born: number;
    sold: number;
    dead: number;
    mortalityPercent: number | null;
    lambingExpected: number;
    avgWeightKg: number | null;
  };
  crops: { sown: number; total: number; harvestPlannedT: number; harvestActualT: number };
  feed: { name: string; days: number | null }[];
}

export interface InvestorSnapshot {
  month: string;
  generatedAt: string;
  url: string;
}
