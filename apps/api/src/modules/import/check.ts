/**
 * Validation of one row. Getters read a column, record a human reason when it cannot be used, and
 * return undefined, so a template reads as a plain list of what it needs.
 */
import { todayIso } from '@yap/shared';
import type { Permission } from '@yap/shared';
import type { Choice, LanguageCode } from './i18n';
import { tr } from './i18n';
import { cellText, parseDate, parseMonth, parseNumber, type Cell, type NumberKind } from './values';

export type RowStatus = 'new' | 'update' | 'skip' | 'error';

export interface Column {
  key: string;
  type: 'text' | 'date' | 'number' | 'money' | 'month' | 'any';
  required?: boolean;
  /** Refused and hidden without finance.view (CLAUDE.md rule 7). */
  money?: boolean;
  /** Hidden without pii.view (CLAUDE.md rule 8). */
  pii?: boolean;
  /** Dropdown source in the template. */
  list?: string;
  /** Example value when it needs no translation. Dates are ISO. */
  example?: string | number;
  aliases?: string[];
  width?: number;
}

export interface RawRow {
  row: number;
  values: Record<string, Cell>;
}

export interface RowMessage {
  row: number;
  column?: string;
  message: string;
  /** Says nothing about the cell's content, so it stays visible even when the column is hidden. */
  open?: boolean;
}

export interface CheckEnv {
  lang: LanguageCode;
  template: string;
  columns: Map<string, Column>;
  canSeeMoney: boolean;
  /** Keys already met in this file, with the row they were first seen on. */
  seen: Map<string, number>;
  today: string;
}

const MAX_LISTED = 8;

function listed(labels: string[]): string {
  return labels.length > MAX_LISTED ? `${labels.slice(0, MAX_LISTED).join(', ')}, …` : labels.join(', ');
}

export class RowCheck {
  status: RowStatus = 'new';
  readonly errors: RowMessage[] = [];
  readonly warnings: RowMessage[] = [];
  /** Why the row needs no work, shown instead of an error. */
  note?: string;

  constructor(
    readonly row: number,
    readonly values: Record<string, Cell>,
    readonly env: CheckEnv,
  ) {}

  get lang(): LanguageCode {
    return this.env.lang;
  }

  get today(): string {
    return this.env.today;
  }

  label(key: string): string {
    return tr(this.lang, `templates.${this.env.template}.columns.${key}.label`);
  }

  private message(key: string, vars: Record<string, string | number> = {}, column?: string): string {
    return tr(this.lang, `rows.${key}`, { ...(column ? { column: this.label(column) } : {}), ...vars });
  }

  error(column: string | undefined, key: string, vars?: Record<string, string | number>): undefined {
    this.errors.push({ row: this.row, column, message: this.message(key, vars, column) });
    return undefined;
  }

  warn(column: string | undefined, key: string, vars?: Record<string, string | number>): void {
    this.warnings.push({ row: this.row, column, message: this.message(key, vars, column) });
  }

  /** The row is already in the system. Nothing else about it matters any more. */
  skip(key: string, vars?: Record<string, string | number>): undefined {
    this.status = 'skip';
    this.note = this.message(key, vars);
    return undefined;
  }

  /** The row changes an existing record. */
  willUpdate(key: string, vars?: Record<string, string | number>): void {
    this.status = 'update';
    this.note = this.message(key, vars);
  }

  /** False, with an error, when the same key was already met in this file. */
  unique(key: string, column?: string): boolean {
    const first = this.env.seen.get(key);
    if (first !== undefined) {
      this.error(column, 'duplicateInFile', { row: first });
      return false;
    }
    this.env.seen.set(key, this.row);
    return true;
  }

  blank(key: string): boolean {
    return cellText(this.values[key]) === '';
  }

  /** The raw cell, or undefined with an error when a required one is empty. */
  cell(key: string): Cell | undefined {
    const column = this.env.columns.get(key);
    if (this.blank(key)) {
      if (column?.required) this.error(key, 'required');
      return undefined;
    }
    if (column?.money && !this.env.canSeeMoney) {
      this.errors.push({ row: this.row, column: key, message: this.message('moneyNotAllowed', {}, key), open: true });
      return undefined;
    }
    return this.values[key];
  }

  text(key: string, opts: { max?: number } = {}): string | undefined {
    const cell = this.cell(key);
    if (cell === undefined) return undefined;
    const value = cellText(cell).replace(/\s+/g, ' ');
    if (opts.max && value.length > opts.max) return this.error(key, 'tooLong', { max: opts.max });
    return value;
  }

  private numeric(
    key: string,
    kind: NumberKind,
    opts: { min?: number; above?: number; max?: number; integer?: boolean },
  ): number | undefined {
    const cell = this.cell(key);
    if (cell === undefined) return undefined;
    const value = parseNumber(cell, kind);
    if (value === null) return this.error(key, 'invalidNumber');
    if (opts.min !== undefined && value < opts.min) return this.error(key, 'tooSmall', { min: opts.min });
    if (opts.above !== undefined && value <= opts.above) return this.error(key, 'mustBeAbove', { min: opts.above });
    if (opts.max !== undefined && value > opts.max) return this.error(key, 'tooBig', { max: opts.max });
    if (opts.integer && !Number.isInteger(value)) return this.error(key, 'invalidNumber');
    return value;
  }

  number(key: string, opts: { min?: number; above?: number; max?: number; integer?: boolean } = {}) {
    return this.numeric(key, 'quantity', opts);
  }

  money(key: string, opts: { min?: number; above?: number } = {}) {
    return this.numeric(key, 'money', { min: 0, max: 1e14, ...opts });
  }

  date(key: string, opts: { notFuture?: boolean } = {}): string | undefined {
    const cell = this.cell(key);
    if (cell === undefined) return undefined;
    const value = parseDate(cell);
    if (value === null) return this.error(key, 'invalidDate');
    if (opts.notFuture && value > this.today) return this.error(key, 'futureDate');
    return value;
  }

  month(key: string): string | undefined {
    const cell = this.cell(key);
    if (cell === undefined) return undefined;
    return parseMonth(cell) ?? this.error(key, 'invalidMonth');
  }

  /** A value from a fixed set. The message names what is allowed, so a person can fix it alone. */
  pick<T>(key: string, choice: Choice<T>): T | undefined {
    const text = this.text(key);
    if (text === undefined) return undefined;
    const value = choice.lookup.get(text);
    if (value === undefined) {
      return this.error(key, 'unknownValue', { value: text, allowed: listed(choice.labels) });
    }
    return value;
  }
}

export interface Checked<P> {
  row: number;
  status: RowStatus;
  values: Record<string, Cell>;
  errors: RowMessage[];
  warnings: RowMessage[];
  note?: string;
  parsed?: P;
}

export interface RefsEnv {
  lang: LanguageCode;
  rows: RawRow[];
}

/** What an applied row adds to the job's counters, beyond created and updated. */
export type ApplyResult = Record<string, number> | void;

export interface Template<R = any, P = any> {
  key: string;
  /** Modules that must be enabled for the tenant. */
  modules: string[];
  /** Every group must be satisfied by one of its permissions. */
  requires: Permission[][];
  columns: Column[];
  /** Where the imported records can be seen afterwards. */
  link: string;
  refs(env: RefsEnv): Promise<R>;
  /** Dropdown values for the workbook. */
  lists?(refs: R, lang: LanguageCode): Record<string, string[]>;
  check(row: RowCheck, refs: R): Promise<P | undefined> | P | undefined;
  /** One row. Must go through the owning module's service. */
  apply?(parsed: P, refs: R, lang: LanguageCode): Promise<ApplyResult>;
  /** All rows at once, when the owning service takes a batch. */
  applyAll?(parsed: P[], refs: R): Promise<ApplyResult>;
}

export function makeEnv(template: Template, lang: LanguageCode, canSeeMoney: boolean, timezone: string): CheckEnv {
  return {
    lang,
    template: template.key,
    columns: new Map(template.columns.map((c) => [c.key, c])),
    canSeeMoney,
    seen: new Map(),
    today: todayIso(timezone),
  };
}
