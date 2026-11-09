/**
 * Runs a report definition. Everything here applies to every report and every output format:
 * permissions, filter parsing, column visibility, comparison, grouping, totals. An exporter only
 * ever receives a ReportResult, so it cannot show a column the caller may not see.
 */
import { eq } from 'drizzle-orm';
import { PII_VIEW, addDays, deviationPercent, monthRange, round, type Permission } from '@yap/shared';
import { schema } from '../../db/client';
import { canSeeMoney, ctx, hasPermission, today, tx } from '../../core/context';
import { AppError, badRequest, forbidden, notFound } from '../../core/errors';
import { enumLabel, formatIsoMonth, formatPeriod, localizedName, t } from './i18n';
import { resolveSeason } from './seasons';
import type {
  ColumnDef,
  FilterDef,
  Lang,
  PeriodPreset,
  ReportDefinition,
  ReportInput,
  ReportOutput,
  ReportResult,
  ResultColumn,
  Row,
} from './types';

const { farms, tenants } = schema;

/** Rows sent to the screen. Exports always get all of them. */
export const VIEW_ROW_LIMIT = 2000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Access ────────────────────────────────────────────────────────────────

export function requiredPermissions(def: ReportDefinition): Permission[] {
  return [...(def.money ? (['finance.view'] as Permission[]) : []), ...(def.requires ?? [])];
}

export function canRun(def: ReportDefinition): boolean {
  return hasPermission('reports.view') && requiredPermissions(def).every(hasPermission);
}

export async function enabledModules(): Promise<Set<string>> {
  const [tenant] = await tx().select({ modules: tenants.modules }).from(tenants).where(eq(tenants.id, ctx().tenantId));
  return new Set(tenant?.modules ?? []);
}

export function assertCanRun(def: ReportDefinition, modules: Set<string>): void {
  if (!modules.has(def.module)) {
    throw forbidden('This module is not enabled for your workspace', 'MODULE_DISABLED', { module: def.module });
  }
  if (!canRun(def)) throw forbidden(undefined, 'FORBIDDEN', { required: requiredPermissions(def) });
}

function columnAllowed(column: ColumnDef): boolean {
  const needs = column.sensitive ?? [];
  if (needs.includes('money') && !canSeeMoney()) return false;
  if (needs.includes('pii') && !hasPermission(PII_VIEW)) return false;
  return true;
}

export function visibleColumns(def: ReportDefinition): ColumnDef[] {
  return def.columns.filter(columnAllowed);
}

function hiddenCounts(def: ReportDefinition) {
  const hidden = def.columns.filter((c) => !columnAllowed(c));
  return {
    money: hidden.filter((c) => c.sensitive?.includes('money')).length,
    pii: hidden.filter((c) => c.sensitive?.includes('pii')).length,
  };
}

// ─── Filters ───────────────────────────────────────────────────────────────

function quarterStart(month: number): number {
  return month - ((month - 1) % 3);
}

export function presetRange(preset: PeriodPreset, now: string): { from: string; to: string } {
  const year = Number(now.slice(0, 4));
  const month = Number(now.slice(5, 7));
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (preset) {
    case 'today':
      return { from: now, to: now };
    case 'yesterday':
      return { from: addDays(now, -1), to: addDays(now, -1) };
    case 'last_7_days':
      return { from: addDays(now, -6), to: now };
    case 'last_30_days':
      return { from: addDays(now, -29), to: now };
    case 'this_month':
      return { from: `${now.slice(0, 7)}-01`, to: monthRange(now.slice(0, 7)).to };
    case 'last_month': {
      const key = month === 1 ? `${year - 1}-12` : `${year}-${pad(month - 1)}`;
      return monthRange(key);
    }
    case 'this_quarter': {
      const start = quarterStart(month);
      return { from: `${year}-${pad(start)}-01`, to: monthRange(`${year}-${pad(start + 2)}`).to };
    }
    case 'this_year':
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    case 'last_year':
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
  }
}

export const PERIOD_PRESETS: PeriodPreset[] = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'last_year',
];

const fieldError = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_ERROR', 'Please check the highlighted fields', { fieldErrors: { [field]: message } });

function parsePeriod(filter: Extract<FilterDef, { type: 'period' }>, raw: Record<string, string>) {
  const now = today();
  const preset = raw.preset;
  if (preset && !PERIOD_PRESETS.includes(preset as PeriodPreset)) throw fieldError('preset', 'Unknown period');
  if (raw.from || raw.to) {
    const from = raw.from;
    const to = raw.to;
    if (!from || !ISO_DATE.test(from)) throw fieldError('from', 'A start date is required');
    if (!to || !ISO_DATE.test(to)) throw fieldError('to', 'An end date is required');
    if (to < from) throw badRequest('INVALID_RANGE', 'The end date is before the start date');
    return { from, to };
  }
  return presetRange((preset as PeriodPreset) ?? filter.preset, now);
}

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export interface ParsedFilters {
  input: ReportInput;
  period: { from: string; to: string } | null;
}

export function parseFilters(def: ReportDefinition, raw: Record<string, string>, lang: Lang): ParsedFilters {
  const now = today();
  const input: ReportInput = { lang, from: now, to: now, month: now.slice(0, 7), days: 30, months: 12 };
  let period: { from: string; to: string } | null = null;
  const bag = input as unknown as Record<string, unknown>;

  for (const filter of def.filters) {
    const value = raw[filter.key];
    switch (filter.type) {
      case 'period':
        period = parsePeriod(filter, raw);
        input.from = period.from;
        input.to = period.to;
        break;
      case 'month':
        if (value && !ISO_MONTH.test(value)) throw fieldError('month', 'Choose a month');
        input.month = value || (filter.default === 'previous' ? previousMonth(now.slice(0, 7)) : now.slice(0, 7));
        break;
      case 'number': {
        const parsed = value === undefined || value === '' ? filter.default : Number(value);
        if (!Number.isInteger(parsed) || parsed < filter.min || parsed > filter.max) {
          throw fieldError(filter.key, `Must be between ${filter.min} and ${filter.max}`);
        }
        bag[filter.key] = parsed;
        break;
      }
      case 'select':
        if (value) {
          if (!filter.values.includes(value)) throw fieldError(filter.key, 'Unknown value');
          bag[filter.key] = value;
        }
        break;
      case 'lookup':
        if (value) {
          if (!UUID.test(value)) throw fieldError(filter.key, 'Unknown value');
          bag[filter.key] = value;
        }
        break;
    }
  }
  return { input, period };
}

interface ResolvedLookups {
  /** Names read from the database, which win over a label the client sent. */
  labels: Record<string, string>;
  defaults: ReportResult['defaults'];
}

/**
 * A season report always reads one season. Fill an empty choice in now, so that every run, the
 * comparison and the export name the same season, and the filter never reads "all" for one season.
 */
async function resolveLookups(def: ReportDefinition, input: ReportInput): Promise<ResolvedLookups> {
  const resolved: ResolvedLookups = { labels: {}, defaults: {} };
  for (const filter of def.filters) {
    if (filter.type !== 'lookup' || !filter.defaultSeason) continue;
    const { season, filled } = await resolveSeason(input.seasonId, filter.defaultSeason);
    if (!season) continue;
    input.seasonId = season.id;
    resolved.labels[filter.key] = season.name;
    if (filled) resolved.defaults[filter.key] = { value: season.id, label: season.name };
  }
  return resolved;
}

function summarizeFilters(
  def: ReportDefinition,
  raw: Record<string, string>,
  input: ReportInput,
  lang: Lang,
  names: Record<string, string> = {},
) {
  const rows: { label: string; value: string }[] = [];
  for (const filter of def.filters) {
    if (filter.type === 'period') continue;
    const label = t(lang, `filters.${filter.key}`);
    if (filter.type === 'month') rows.push({ label, value: formatIsoMonth(input.month) });
    if (filter.type === 'number') rows.push({ label, value: String((input as unknown as Record<string, unknown>)[filter.key]) });
    if (filter.type === 'select' && raw[filter.key]) rows.push({ label, value: enumLabel(lang, filter.enumGroup, raw[filter.key]) });
    const named = names[filter.key] ?? raw[`${filter.key}Label`];
    if (filter.type === 'lookup' && named) rows.push({ label, value: named });
  }
  return rows;
}

// ─── Shaping rows ──────────────────────────────────────────────────────────

function roundTo(column: { type: string; digits?: number }, value: number): number {
  return round(value, column.type === 'money' ? 2 : (column.digits ?? 3));
}

function localizeCell(column: ColumnDef, value: unknown, lang: Lang): unknown {
  if (value === null || value === undefined) return null;
  if (column.type === 'enum') return enumLabel(lang, column.enumGroup!, value);
  if (column.type === 'name') return localizedName(value, lang);
  return value;
}

/** Allowlist: a value reaches the caller only under a column they may see. */
function project(row: Row, columns: ColumnDef[], lang: Lang): Row {
  const out: Row = {};
  for (const column of columns) out[column.key] = localizeCell(column, row[column.key], lang);
  return out;
}

function sumRows(rows: Row[], columns: ColumnDef[]): Row | null {
  const summed = columns.filter((c) => c.sum);
  if (summed.length === 0) return null;
  const totals: Row = {};
  for (const column of summed) {
    let total: number | null = null;
    for (const row of rows) {
      const value = row[column.key];
      if (typeof value === 'number') total = (total ?? 0) + value;
    }
    totals[column.key] = total === null ? null : roundTo(column, total);
  }
  return totals;
}

function compareKey(row: Row, by: string[]): string {
  return by.map((key) => JSON.stringify(row[key] ?? null)).join('|');
}

/** Merge two runs. Keeps rows found in only one of them, with the other side empty. */
function mergeCompare(def: ReportDefinition, a: ReportOutput, b: ReportOutput, columns: ColumnDef[], lang: Lang) {
  const spec = def.compare!;
  const keep = columns.filter((c) => spec.by.includes(c.key));
  const values = columns.filter((c) => spec.values.includes(c.key));

  const out: ColumnDef[] = [...keep];
  for (const column of values) {
    const base = t(lang, `columns.${column.label ?? column.key}`, column.labelParams);
    const named = (key: string, label: string, extra: Partial<ColumnDef>): ColumnDef => ({
      ...column,
      key,
      label: `=${base} ${label}`,
      ...extra,
    });
    out.push(named(column.key, 'A', {}));
    out.push(named(`${column.key}__b`, 'B', {}));
    out.push(named(`${column.key}__diff`, `(${t(lang, 'compare.difference')})`, {}));
    out.push({
      key: `${column.key}__pct`,
      label: `=${base} (%)`,
      type: 'percent',
      digits: 1,
      sensitive: column.sensitive,
    });
  }

  const rows = new Map<string, Row>();
  const order: string[] = [];
  const add = (source: Row[], side: 'a' | 'b') => {
    for (const row of source) {
      const key = compareKey(row, spec.by);
      if (!rows.has(key)) {
        order.push(key);
        rows.set(key, Object.fromEntries(keep.map((c) => [c.key, row[c.key]])));
      }
      const target = rows.get(key)!;
      for (const column of values) {
        const value = (row[column.key] as number | null | undefined) ?? 0;
        const field = side === 'a' ? column.key : `${column.key}__b`;
        target[field] = ((target[field] as number | undefined) ?? 0) + value;
      }
    }
  };
  add(a.rows, 'a');
  add(b.rows, 'b');

  const merged = order.map((key) => {
    const row = rows.get(key)!;
    for (const column of values) {
      const current = (row[column.key] as number | undefined) ?? 0;
      const other = (row[`${column.key}__b`] as number | undefined) ?? 0;
      row[column.key] = roundTo(column, current);
      row[`${column.key}__b`] = roundTo(column, other);
      row[`${column.key}__diff`] = roundTo(column, current - other);
      const pct = deviationPercent(current, other);
      row[`${column.key}__pct`] = pct === null ? null : round(pct, 1);
    }
    return row;
  });
  return { columns: out, rows: merged };
}

/** The builder's grouping: one row per value, summing the columns that can be summed. */
function groupRows(columns: ColumnDef[], rows: Row[], groupBy: string, lang: Lang) {
  const group = columns.find((c) => c.key === groupBy);
  if (!group || !['text', 'enum', 'name', 'date', 'month', 'boolean'].includes(group.type)) {
    throw badRequest('INVALID_GROUPING', 'This column cannot be used for grouping', { groupBy });
  }
  const isDate = group.type === 'date';
  const summed = columns.filter((c) => c.sum);
  const groups = new Map<string, Row>();
  for (const row of rows) {
    const value = row[groupBy];
    const key = isDate && typeof value === 'string' ? value.slice(0, 7) : value;
    const id = String(key ?? '');
    const target = groups.get(id) ?? { [groupBy]: key ?? null, __count: 0 };
    target.__count = (target.__count as number) + 1;
    for (const column of summed) {
      const number = row[column.key];
      if (typeof number === 'number') target[column.key] = ((target[column.key] as number | undefined) ?? 0) + number;
    }
    groups.set(id, target);
  }
  const grouped = [...groups.values()];
  for (const row of grouped) {
    for (const column of summed) {
      if (typeof row[column.key] === 'number') row[column.key] = roundTo(column, row[column.key] as number);
    }
  }
  const out: ColumnDef[] = [
    isDate ? { ...group, type: 'month' } : group,
    { key: '__count', label: `=${t(lang, 'columns.count')}`, type: 'integer', sum: true },
    ...summed.filter((c) => c.key !== groupBy),
  ];
  return { columns: out, rows: grouped };
}

function toResultColumn(column: ColumnDef, lang: Lang): ResultColumn {
  const label = column.label?.startsWith('=')
    ? column.label.slice(1)
    : t(lang, `columns.${column.label ?? column.key}`, column.labelParams);
  return { key: column.key, label, type: column.type, digits: column.digits, sum: column.sum };
}

async function farmNames() {
  const c = ctx();
  const [tenant] = await tx().select({ name: tenants.name }).from(tenants).where(eq(tenants.id, c.tenantId));
  const [farm] = await tx().select({ name: farms.name }).from(farms).where(eq(farms.id, c.farmId));
  return { tenantName: tenant?.name ?? '', farmName: farm?.name ?? '' };
}

export interface RunOptions {
  raw: Record<string, string>;
  lang: Lang;
  /** Chosen columns, in order. Hidden or unknown ones are refused. */
  columns?: string[];
  groupBy?: string;
  /** Cut rows for the screen. Exports leave this off. */
  limit?: number;
}

function parseCompare(def: ReportDefinition, raw: Record<string, string>) {
  if (!def.compare) return null;
  if (def.compare.filter === 'seasonId') {
    const seasonId = raw.compareSeasonId;
    if (!seasonId) return null;
    if (!UUID.test(seasonId)) throw fieldError('compareSeasonId', 'Unknown value');
    return { seasonId };
  }
  if (!raw.compareFrom && !raw.compareTo) return null;
  const { compareFrom: from, compareTo: to } = raw;
  if (!from || !ISO_DATE.test(from)) throw fieldError('compareFrom', 'A start date is required');
  if (!to || !ISO_DATE.test(to)) throw fieldError('compareTo', 'An end date is required');
  if (to < from) throw badRequest('INVALID_RANGE', 'The end date is before the start date');
  return { from, to };
}

export async function runReport(def: ReportDefinition, options: RunOptions): Promise<ReportResult> {
  const started = performance.now();
  const { raw, lang } = options;
  assertCanRun(def, await enabledModules());

  const { input, period } = parseFilters(def, raw, lang);
  const lookups = await resolveLookups(def, input);
  const compareWith = parseCompare(def, raw);
  if (compareWith && options.groupBy) {
    throw badRequest('COMPARE_WITH_GROUPING', 'Comparison and grouping cannot be used together');
  }

  const allowed = visibleColumns(def);
  const output = await def.run(input);
  let working: ColumnDef[] = allowed;
  let rows: Row[] = output.rows;
  let totals: Row | null = output.totals ?? null;

  if (compareWith) {
    const other = await def.run({ ...input, ...compareWith });
    const merged = mergeCompare(def, output, other, allowed, lang);
    working = merged.columns;
    rows = merged.rows;
    totals = null;
  }

  rows = rows.map((row) => project(row, working, lang));

  if (options.groupBy) {
    const grouped = groupRows(working, rows, options.groupBy, lang);
    working = grouped.columns;
    rows = grouped.rows;
    totals = null;
  }

  if (options.columns?.length) {
    // A column the caller may not see simply vanishes, as it does everywhere else. This also lets a
    // saved report run for a recipient with fewer rights. Only a name no report has is an error.
    const defined = new Set([...def.columns.map((c) => c.key), ...working.map((c) => c.key)]);
    const unknown = options.columns.filter((key) => !defined.has(key));
    if (unknown.length) throw badRequest('UNKNOWN_COLUMN', 'A chosen column does not exist', { columns: unknown });
    // The grouping column stays first; grouping is meaningless without it.
    const wanted = options.groupBy ? [options.groupBy, '__count', ...options.columns] : options.columns;
    const chosen = [...new Set(wanted)].flatMap((key) => working.filter((c) => c.key === key));
    if (chosen.length) {
      working = chosen;
      rows = rows.map((row) => Object.fromEntries(chosen.map((c) => [c.key, row[c.key] ?? null])));
    }
  }

  const visibleTotals = totals
    ? Object.fromEntries(working.filter((c) => c.key in totals!).map((c) => [c.key, totals![c.key]]))
    : sumRows(rows, working);

  const shown = options.limit && rows.length > options.limit ? rows.slice(0, options.limit) : rows;
  const chartable = def.chart && !compareWith && !options.groupBy ? def.chart : null;
  const series = chartable?.series.filter((key) => working.some((c) => c.key === key)) ?? [];
  const chartColumn = (key: string) => working.find((c) => c.key === key)!;

  return {
    key: def.key,
    module: def.module,
    title: t(lang, `catalog.${def.key}.title`),
    description: t(lang, `catalog.${def.key}.description`),
    ...(await farmNames()),
    period,
    compareWith,
    filterSummary: summarizeFilters(def, raw, input, lang, lookups.labels),
    defaults: lookups.defaults,
    generatedAt: new Date().toISOString(),
    timezone: ctx().timezone,
    lang,
    columns: working.map((c) => toResultColumn(c, lang)),
    rows: shown,
    totals: visibleTotals && Object.keys(visibleTotals).length ? visibleTotals : null,
    rowCount: rows.length,
    truncated: shown.length < rows.length,
    notes: (output.notes ?? []).map((note) => t(lang, `notes.${note.key}`, note.params)),
    chart:
      chartable && series.length && working.some((c) => c.key === chartable.x)
        ? {
            kind: chartable.kind,
            x: chartable.x,
            series: series.map((key) => ({
              key,
              label: toResultColumn(chartColumn(key), lang).label,
              slot: chartable.series.indexOf(key) + 1,
            })),
          }
        : null,
    hidden: hiddenCounts(def),
    durationMs: Math.round(performance.now() - started),
  };
}

/** A period line for headers and messages. */
export function periodLine(result: ReportResult): string | null {
  return result.period ? formatPeriod(result.period) : null;
}

export function getDefinitionOrThrow(registry: Map<string, ReportDefinition>, key: string): ReportDefinition {
  const def = registry.get(key);
  if (!def) throw notFound('Report');
  return def;
}
