import type { ColumnDef, FilterDef, PeriodPreset, Sensitivity } from '../types';

type Options = Partial<Pick<ColumnDef, 'label' | 'labelParams' | 'sensitive' | 'digits' | 'sum'>>;

const MONEY: Sensitivity[] = ['money'];

export const PII: Sensitivity[] = ['pii'];
export const MONEY_PII: Sensitivity[] = ['money', 'pii'];

/** Column builders. A money column is sensitive by default, so it cannot be forgotten. */
export const col = {
  text: (key: string, o: Options = {}): ColumnDef => ({ key, type: 'text', ...o }),
  name: (key: string, o: Options = {}): ColumnDef => ({ key, type: 'name', ...o }),
  enum: (key: string, enumGroup: string, o: Options = {}): ColumnDef => ({ key, type: 'enum', enumGroup, ...o }),
  int: (key: string, o: Options = {}): ColumnDef => ({ key, type: 'integer', ...o }),
  num: (key: string, digits: number, o: Options = {}): ColumnDef => ({ key, type: 'number', digits, ...o }),
  money: (key: string, o: Options = {}): ColumnDef => ({ key, type: 'money', sensitive: MONEY, ...o }),
  pct: (key: string, o: Options = {}): ColumnDef => ({ key, type: 'percent', digits: 1, ...o }),
  date: (key: string, o: Options = {}): ColumnDef => ({ key, type: 'date', ...o }),
  month: (key: string, o: Options = {}): ColumnDef => ({ key, type: 'month', ...o }),
  bool: (key: string, o: Options = {}): ColumnDef => ({ key, type: 'boolean', ...o }),
};

export const filter = {
  period: (preset: PeriodPreset = 'this_month'): FilterDef => ({ key: 'period', type: 'period', preset }),
  month: (fallback: 'current' | 'previous' = 'current'): FilterDef => ({ key: 'month', type: 'month', default: fallback }),
  days: (fallback: number, max = 365): FilterDef => ({ key: 'days', type: 'number', default: fallback, min: 1, max }),
  months: (fallback: number, max = 24): FilterDef => ({ key: 'months', type: 'number', default: fallback, min: 1, max }),
  select: (key: string, values: readonly string[], enumGroup: string): FilterDef => ({ key, type: 'select', values, enumGroup }),
  /** Left empty, it reads the current season and says so. */
  season: { key: 'seasonId', type: 'lookup', path: '/crops/seasons', defaultSeason: 'current' } as FilterDef,
  /** For harvest figures: left empty, it reads the newest season with a harvest in. */
  harvestedSeason: { key: 'seasonId', type: 'lookup', path: '/crops/seasons', defaultSeason: 'harvested' } as FilterDef,
  herd: { key: 'herdId', type: 'lookup', path: '/livestock/herds/lookup' } as FilterDef,
  field: { key: 'fieldId', type: 'lookup', path: '/farm/fields/lookup' } as FilterDef,
  warehouse: { key: 'warehouseId', type: 'lookup', path: '/inventory/warehouses/lookup' } as FilterDef,
  asset: { key: 'assetId', type: 'lookup', path: '/assets/lookup' } as FilterDef,
};
