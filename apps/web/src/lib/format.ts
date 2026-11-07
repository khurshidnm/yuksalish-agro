import { DEFAULT_TIMEZONE } from '@yap/shared';
import i18n from './i18n';

const DASH = '—';

/**
 * Do not format with an `uz` locale. Browsers report it as supported but ship almost no data for it:
 * real Chrome turns 2100000.5 into "2,100,000.5", billions into "2.1G" and November into "M11".
 * Uzbek writes numbers and dates the way Russian does, and every browser ships Russian data, so
 * ru-RU formats the digits. Words (months, mln, mlrd) come from our own dictionaries.
 */
const INTL_LOCALE: Record<string, string> = {
  uz: 'ru-RU',
  'uz-Cyrl': 'ru-RU',
  ru: 'ru-RU',
  en: 'en-GB',
};

let defaultCurrency = 'UZS';

/** Called when the session loads, so formatMoney defaults to the tenant's currency. */
export function setDefaultCurrency(currency: string | null | undefined): void {
  defaultCurrency = currency || 'UZS';
}

export function intlLocale(): string {
  return INTL_LOCALE[i18n.language] ?? 'ru-RU';
}

type Num = number | string | null | undefined;

function toNumber(value: Num): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatNumber(value: Num, maxDigits = 2): string {
  const n = toNumber(value);
  if (n === null) return DASH;
  return new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: maxDigits }).format(n);
}

const SCALES = [
  [1e12, 'trillion'],
  [1e9, 'billion'],
  [1e6, 'million'],
  [1e3, 'thousand'],
] as const;

/** 2 100 000 000 → "2,1 mlrd": the short form for axes and tiles. */
export function formatCompact(value: Num, maxDigits = 1): string {
  const n = toNumber(value);
  if (n === null) return DASH;
  const digits = new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: maxDigits });
  for (const [size, key] of SCALES) {
    if (Math.abs(n) >= size) return i18n.t(`common:number.${key}`, { value: digits.format(n / size) });
  }
  return digits.format(n);
}

export function currencyLabel(currency: string = defaultCurrency): string {
  return i18n.t(`enums:currency.${currency}`, { defaultValue: currency });
}

export interface MoneyOptions {
  currency?: string;
  /** Short form such as "2,1 mlrd", for tiles and charts. */
  compact?: boolean;
  /** Fraction digits; defaults to 0 for UZS and 2 for other currencies. */
  digits?: number;
  /** Omit the currency label. */
  plain?: boolean;
}

export function formatMoney(value: Num, opts: MoneyOptions = {}): string {
  const n = toNumber(value);
  if (n === null) return DASH;
  const currency = opts.currency ?? defaultCurrency;
  const digits = opts.digits ?? (currency === 'UZS' ? 0 : 2);
  const number = opts.compact
    ? formatCompact(n, 1)
    : new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
  return opts.plain ? number : `${number} ${currencyLabel(currency)}`;
}

/** Quantity with its unit label: formatQty(1200, 'kg') → "1 200 kg". */
export function formatQty(value: Num, unit?: string | null, maxDigits = 3): string {
  const n = toNumber(value);
  if (n === null) return DASH;
  const number = new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: maxDigits }).format(n);
  if (!unit) return number;
  return `${number} ${i18n.t(`enums:unit.${unit}`, { defaultValue: unit })}`;
}

/** `value` is already a percentage: 124 → "124%". */
export function formatPercent(value: Num, maxDigits = 1): string {
  const n = toNumber(value);
  if (n === null) return DASH;
  return new Intl.NumberFormat(intlLocale(), { style: 'percent', maximumFractionDigits: maxDigits }).format(n / 100);
}

function parseDate(value: string | Date): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  // A plain business date has no time zone: read it as a calendar date, or it can shift a day.
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (plain) return new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date only: "04.11.2026". */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return DASH;
  const d = parseDate(value);
  if (!d) return DASH;
  const isPlain = typeof value === 'string' && value.length === 10;
  return new Intl.DateTimeFormat(intlLocale(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: isPlain ? undefined : DEFAULT_TIMEZONE,
  }).format(d);
}

function monthName(index: number, list: 'months' | 'monthsOf' | 'monthsShort'): string {
  const names = i18n.t(`common:date.${list}`, { returnObjects: true }) as unknown as string[];
  return names[index] ?? '';
}

/** Calendar parts of a date, read in farm time for timestamps. */
function dateParts(value: string | Date): { year: number; month: number; day: number } | null {
  const d = parseDate(value);
  if (!d) return null;
  if (typeof value === 'string' && value.length === 10) {
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
  }
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d)
    .split('-')
    .map(Number);
  return { year, month: month - 1, day };
}

/** Date with month name: "4 noyabr 2026". */
export function formatDateLong(value: string | Date | null | undefined): string {
  if (!value) return DASH;
  const parts = dateParts(value);
  if (!parts) return DASH;
  return `${parts.day} ${monthName(parts.month, 'monthsOf')} ${parts.year}`;
}

/** Timestamp in farm time: "04.11.2026, 14:30". */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return DASH;
  const d = parseDate(value);
  if (!d) return DASH;
  return new Intl.DateTimeFormat(intlLocale(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: DEFAULT_TIMEZONE,
  }).format(d);
}

/**
 * How long ago, for live data: "hozirgina", "5 daq. oldin", "3 soat oldin", "2 kun oldin", and the
 * date and time once it is more than a week old. The words come from our dictionaries, because
 * Uzbek borrows Russian number formats from Intl.
 */
export function formatAgo(value: string | Date | null | undefined, now: number = Date.now()): string {
  if (!value) return DASH;
  const d = parseDate(value);
  if (!d) return DASH;
  const minutes = Math.floor((now - d.getTime()) / 60_000);
  if (minutes < 1) return i18n.t('common:date.justNow');
  if (minutes < 60) return i18n.t('common:date.minutesAgo', { count: minutes });
  if (minutes < 24 * 60) return i18n.t('common:date.hoursAgo', { count: Math.floor(minutes / 60) });
  if (minutes < 7 * 24 * 60) return i18n.t('common:date.daysAgo', { count: Math.floor(minutes / (24 * 60)) });
  return formatDateTime(d);
}

/** "YYYY-MM" → "Noyabr 2026". */
export function formatMonth(month: string | null | undefined): string {
  if (!month) return DASH;
  const parts = dateParts(`${month.slice(0, 7)}-01`);
  if (!parts) return DASH;
  return `${monthName(parts.month, 'months')} ${parts.year}`;
}

/** "YYYY-MM" → "Noy", for chart axes. `withYear` gives "Noy 2026". */
export function formatMonthShort(month: string | null | undefined, withYear = false): string {
  if (!month) return DASH;
  const parts = dateParts(`${month.slice(0, 7)}-01`);
  if (!parts) return DASH;
  const name = monthName(parts.month, 'monthsShort');
  return withYear ? `${name} ${parts.year}` : name;
}
