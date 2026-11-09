import type { Permission } from '@yap/shared';
import type { LanguageCode } from '@yap/shared/i18n';

export type Lang = LanguageCode;

export type ColumnType = 'text' | 'enum' | 'name' | 'integer' | 'number' | 'money' | 'percent' | 'date' | 'month' | 'boolean';

/** What a column reveals. A column disappears unless the caller may see all of these. */
export type Sensitivity = 'money' | 'pii';

export interface ColumnDef {
  key: string;
  /** Key under reports:columns. Defaults to `key`. */
  label?: string;
  /** Values for the label's placeholders: a chemical formula, which must not change script in Uzbek Cyrillic. */
  labelParams?: Record<string, string>;
  type: ColumnType;
  sensitive?: Sensitivity[];
  /** 'animalStatus' reads enums:animalStatus.*; 'reports:dueState' reads the reports namespace. */
  enumGroup?: string;
  digits?: number;
  /** Add up in the totals row and when grouping. Never set this on rates or unit prices. */
  sum?: boolean;
}

export type PeriodPreset =
  | 'today'
  | 'yesterday'
  | 'last_7_days'
  | 'last_30_days'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'this_year'
  | 'last_year';

/** What an empty season filter reads: the current season, or the newest one with a harvest in. */
export type SeasonDefault = 'current' | 'harvested';

export type FilterDef =
  | { key: 'period'; type: 'period'; preset: PeriodPreset }
  | { key: 'month'; type: 'month'; default: 'current' | 'previous' }
  | { key: string; type: 'number'; default: number; min: number; max: number }
  | { key: string; type: 'select'; values: readonly string[]; enumGroup: string }
  /**
   * `path` is a lookup endpoint from docs/contracts.md. An empty lookup means "all", except a
   * season: a season report always reads one season, `defaultSeason` says which when none is chosen.
   */
  | { key: string; type: 'lookup'; path: string; params?: Record<string, string>; defaultSeason?: SeasonDefault };

/** Filter values, parsed and defaulted. Which ones are set depends on the report's filters. */
export interface ReportInput {
  lang: Lang;
  from: string;
  to: string;
  month: string;
  days: number;
  months: number;
  seasonId?: string;
  herdId?: string;
  fieldId?: string;
  warehouseId?: string;
  assetId?: string;
  itemCategory?: string;
  status?: string;
  type?: string;
  direction?: 'payable' | 'receivable';
  sex?: string;
  category?: string;
}

export type Row = Record<string, unknown>;

export interface ReportNote {
  /** Key under reports:notes. */
  key: string;
  params?: Record<string, unknown>;
}

export interface ReportOutput {
  rows: Row[];
  /** Explicit totals, for when a plain sum of rows would be wrong (e.g. opening and closing head). */
  totals?: Row;
  notes?: ReportNote[];
}

export interface ChartDef {
  kind: 'bar' | 'stacked-bar' | 'line' | 'area';
  x: string;
  series: string[];
}

/** Two runs side by side: rows match on `by`, and `values` get a second figure and a difference. */
export interface CompareDef {
  filter: 'period' | 'seasonId';
  by: string[];
  values: string[];
}

export const REPORT_MODULES = ['finance', 'livestock', 'feed', 'inventory', 'crops', 'hr', 'assets', 'sales'] as const;
export type ReportModule = (typeof REPORT_MODULES)[number];

export interface ReportDefinition {
  key: string;
  module: ReportModule;
  /** The report is about money, so it needs finance.view to run at all. */
  money?: boolean;
  /** Further permissions, all required. `reports.view` is always required. */
  requires?: Permission[];
  filters: FilterDef[];
  columns: ColumnDef[];
  chart?: ChartDef;
  compare?: CompareDef;
  run(input: ReportInput): Promise<ReportOutput>;
}

export interface ResultColumn {
  key: string;
  label: string;
  type: ColumnType;
  digits?: number;
  sum?: boolean;
}

export interface ReportResult {
  key: string;
  module: ReportModule;
  title: string;
  description: string;
  tenantName: string;
  farmName: string;
  /** Null when the report has no period. */
  period: { from: string; to: string } | null;
  compareWith: { from: string; to: string } | { seasonId: string } | null;
  /** Human-readable applied filters, for export headers. */
  filterSummary: { label: string; value: string }[];
  /** Filters left empty that the report filled in itself (the season), so the screen can name them. */
  defaults: Record<string, { value: string; label: string }>;
  generatedAt: string;
  /** The farm's time zone, for the generation time printed on exports. */
  timezone: string;
  lang: Lang;
  columns: ResultColumn[];
  rows: Row[];
  totals: Row | null;
  /** Rows before the view limit was applied. */
  rowCount: number;
  truncated: boolean;
  notes: string[];
  /** `slot` is the series' place in the definition, so hiding a column does not repaint the rest. */
  chart: { kind: ChartDef['kind']; x: string; series: { key: string; label: string; slot: number }[] } | null;
  /** Columns withheld from this caller, so the UI can say that some are hidden. */
  hidden: { money: number; pii: number };
  durationMs: number;
}
