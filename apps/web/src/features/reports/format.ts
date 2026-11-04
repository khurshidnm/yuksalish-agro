import { formatDate, formatMoney, formatMonth, formatNumber, formatPercent } from '@/lib/format';
import type { ReportRow, ResultColumn, SavedConfig } from './types';

const NUMERIC = ['integer', 'number', 'money', 'percent'];

export const isNumeric = (column: Pick<ResultColumn, 'type'>) => NUMERIC.includes(column.type);

/** Types a row can be grouped by. Matches the check on the server. */
export const canGroupBy = (column: Pick<ResultColumn, 'type'>) =>
  ['text', 'enum', 'name', 'date', 'month', 'boolean'].includes(column.type);

export function formatCell(column: ResultColumn, value: unknown, yes: string, no: string): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (column.type) {
    case 'money':
      return formatMoney(value as number, { plain: true });
    case 'integer':
      return formatNumber(value as number, 0);
    case 'number':
      return formatNumber(value as number, column.digits ?? 3);
    case 'percent':
      return formatPercent(value as number, column.digits ?? 1);
    case 'date':
      return formatDate(String(value));
    case 'month':
      return formatMonth(String(value));
    case 'boolean':
      return value ? yes : no;
    default:
      return String(value);
  }
}

/** Nulls go last in both directions: an empty cell tells nothing about rank. */
export function sortRows(rows: ReportRow[], sort: string | undefined): ReportRow[] {
  if (!sort) return rows;
  const descending = sort.startsWith('-');
  const key = descending ? sort.slice(1) : sort;
  const direction = descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    const xEmpty = x === null || x === undefined;
    const yEmpty = y === null || y === undefined;
    if (xEmpty || yEmpty) return xEmpty === yEmpty ? 0 : xEmpty ? 1 : -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * direction;
    return String(x).localeCompare(String(y)) * direction;
  });
}

/** A saved report as viewer URL parameters, so opening it is just opening a link. */
export function savedToSearch(config: SavedConfig): URLSearchParams {
  const params = new URLSearchParams(config.filters ?? {});
  if (config.columns?.length) params.set('columns', config.columns.join(','));
  if (config.groupBy) params.set('groupBy', config.groupBy);
  return params;
}

/** Parameters that are not filters, and so are not stored inside a saved report's filters. */
export const NON_FILTER_PARAMS = ['columns', 'groupBy', 'lang', 'saved'];

/** Last `count` months, newest first. */
export function recentMonths(now: string, count: number): string[] {
  const [year, month] = now.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(year, month - 1 - i, 1));
    return date.toISOString().slice(0, 7);
  });
}

/** The range just before a period, of the same length: the natural thing to compare with. */
export function previousRange(period: { from: string; to: string }): { from: string; to: string } {
  const day = 86_400_000;
  const from = Date.parse(`${period.from}T00:00:00Z`);
  const to = Date.parse(`${period.to}T00:00:00Z`);
  const end = from - day;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(end - (to - from)), to: iso(end) };
}
