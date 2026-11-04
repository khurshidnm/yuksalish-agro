/**
 * Reading values that people typed by hand. Pure functions, no database.
 * Each parser returns null for "I cannot read this", so the caller can name the cell and the
 * reason. Nothing here guesses a value silently: an ambiguous input is refused, not reinterpreted.
 */
import { latinToCyrillic } from '@yap/shared/i18n';

/** A cell after reading: dates are already YYYY-MM-DD strings. */
export type Cell = string | number | null;

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MIN_YEAR = 1950;
const MAX_YEAR = 2100;

function isoFrom(year: number, month: number, day: number): string | null {
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date rolls 31.02 over into March. A date that moved was not a real date.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** Excel stores dates as days since 1899-12-30; a time of day is the fraction. */
export function serialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 18_264 || serial > 73_415) return null;
  return new Date(EXCEL_EPOCH_UTC + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

const MONTH_NAMES: [number, string[]][] = [
  [1, ['yanvar', 'январь', 'января', 'january', 'jan', 'янв']],
  [2, ['fevral', 'февраль', 'февраля', 'february', 'feb', 'фев']],
  [3, ['mart', 'март', 'марта', 'march', 'mar']],
  [4, ['aprel', 'апрель', 'апреля', 'april', 'apr', 'апр']],
  [5, ['may', 'май', 'мая']],
  [6, ['iyun', 'июнь', 'июня', 'june', 'jun', 'июн']],
  [7, ['iyul', 'июль', 'июля', 'july', 'jul', 'июл']],
  [8, ['avgust', 'август', 'августа', 'august', 'aug', 'авг']],
  [9, ['sentabr', 'sentyabr', 'сентябрь', 'сентября', 'september', 'sep', 'сен']],
  [10, ['oktabr', 'oktyabr', 'октябрь', 'октября', 'october', 'oct', 'окт']],
  [11, ['noyabr', 'ноябрь', 'ноября', 'november', 'nov', 'ноя']],
  [12, ['dekabr', 'декабрь', 'декабря', 'december', 'dec', 'дек']],
];

const MONTHS = new Map(MONTH_NAMES.flatMap(([n, names]) => names.map((name) => [name, n] as const)));

const WORD = /\d+|[\p{L}]+/gu;
const YEAR_WORDS = new Set(['yil', 'yili', 'йил', 'йили', 'г', 'год', 'года', 'y', 'year']);

interface DateWords {
  year?: number;
  month?: number;
  day?: number;
}

/** "4-noyabr 2026", "2026 yil 4 noyabr", "ноября 2026": one month word and its numbers. */
function readDateWords(text: string): DateWords | null {
  const tokens = text.toLowerCase().match(WORD);
  if (!tokens) return null;
  const out: DateWords = {};
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (token.length === 4 && out.year === undefined) out.year = n;
      else if (token.length <= 2 && out.day === undefined) out.day = n;
      else return null;
    } else if (MONTHS.has(token) && out.month === undefined) {
      out.month = MONTHS.get(token);
    } else if (!YEAR_WORDS.has(token)) {
      return null;
    }
  }
  return out.month === undefined ? null : out;
}

/**
 * dd.mm.yyyy, dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd, two-digit years, Excel serials, and dates
 * written in words. Day comes first, as it does in Uzbekistan. mm/dd/yyyy is accepted only when
 * it cannot be anything else (10/28/2026), because 03.04.2026 must never silently mean March.
 */
export function parseDate(raw: Cell): string | null {
  if (raw === null) return null;
  if (typeof raw === 'number') return serialToIso(raw);
  const text = raw.trim();

  const iso = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (iso) return isoFrom(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dayFirst = /^(\d{1,2})[-./\s](\d{1,2})[-./\s](\d{4}|\d{2})(?:[T\s,].*)?$/.exec(text);
  if (dayFirst) {
    const [a, b, yearText] = [Number(dayFirst[1]), Number(dayFirst[2]), dayFirst[3]];
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    if (b > 12 && a <= 12) return isoFrom(year, a, b);
    return isoFrom(year, b, a);
  }

  if (/^\d{5}(\.\d+)?$/.test(text)) return serialToIso(Number(text));

  const words = readDateWords(text);
  if (words?.year !== undefined && words.day !== undefined) return isoFrom(words.year, words.month!, words.day);
  return null;
}

function monthOf(year: number, month: number): string | null {
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** "2026-11", "11.2026", "Noyabr 2026", or any full date. A month with no year is refused. */
export function parseMonth(raw: Cell): string | null {
  if (raw === null) return null;
  if (typeof raw === 'number') return serialToIso(raw)?.slice(0, 7) ?? null;
  const text = raw.trim();

  const yearFirst = /^(\d{4})[-./](\d{1,2})$/.exec(text);
  if (yearFirst) return monthOf(Number(yearFirst[1]), Number(yearFirst[2]));
  const monthFirst = /^(\d{1,2})[-./\s](\d{4})$/.exec(text);
  if (monthFirst) return monthOf(Number(monthFirst[2]), Number(monthFirst[1]));

  const words = readDateWords(text);
  if (words?.year !== undefined) return monthOf(words.year, words.month!);
  return parseDate(text)?.slice(0, 7) ?? null;
}

const SUFFIX = /(so['ʻ’‘`]?m|сўм|сум|uzs|gektar|ga|га|kg|кг|tonna|тонна|tn|т|t|litr|литр|l|л|bosh|бош|dona|дона|шт|%)\.?$/iu;
const MILLION = /(mln|млн|million|миллион)\.?$/iu;
const THOUSAND = /(ming|минг|тыс|тысяч)\.?$/iu;

export type NumberKind = 'money' | 'quantity';

/**
 * Accepts 1 200,5 and 1,200.50 and 1.200,50 and "4 200 000 so'm" and "4,2 mln".
 * A lone separator followed by exactly three digits is a thousands separator in money, and a
 * decimal point everywhere else: 1.250 t is one and a quarter tonnes, not 1250.
 */
export function parseNumber(raw: Cell, kind: NumberKind = 'quantity'): number | null {
  if (raw === null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  let text = raw.replace(/[\s  ]/g, '');
  if (!text) return null;

  let factor = 1;
  if (MILLION.test(text)) {
    factor = 1_000_000;
    text = text.replace(MILLION, '');
  } else if (THOUSAND.test(text)) {
    factor = 1000;
    text = text.replace(THOUSAND, '');
  } else {
    text = text.replace(SUFFIX, '');
  }
  // Swiss style 4'200'000. An apostrophe never means anything else in a number.
  text = text.replace(/['ʼ’‘`]/g, '');

  const negative = /^[-−–]/.test(text);
  if (negative) text = text.slice(1);
  if (!/^[\d.,]*\d[\d.,]*$/.test(text)) return null;

  const dots = (text.match(/\./g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  let normal: string;
  if (dots && commas) {
    const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    const thousand = decimal === '.' ? ',' : '.';
    if ((text.split(decimal).length - 1) > 1) return null;
    normal = text.split(thousand).join('').replace(',', '.');
  } else if (dots + commas > 1) {
    const separator = dots ? '.' : ',';
    if (!new RegExp(`^\\d{1,3}(\\${separator}\\d{3})+$`).test(text)) return null;
    normal = text.split(separator).join('');
  } else if (dots + commas === 1) {
    const separator = dots ? '.' : ',';
    const thousands = kind === 'money' && new RegExp(`^\\d{1,3}\\${separator}\\d{3}$`).test(text);
    normal = thousands ? text.replace(separator, '') : text.replace(',', '.');
  } else {
    normal = text;
  }

  const value = Number(normal);
  if (!Number.isFinite(value)) return null;
  return (negative ? -value : value) * factor;
}

const YEAR_UNITS = new Set(['yosh', 'yoshli', 'yil', 'йош', 'йошли', 'йил', 'год', 'года', 'лет', 'г', 'y', 'yr', 'yrs', 'year', 'years']);
const MONTH_UNITS = new Set(['oy', 'oylik', 'ой', 'ойлик', 'мес', 'месяц', 'месяца', 'месяцев', 'm', 'mo', 'month', 'months']);

/**
 * An age in months from "3", "3 yosh", "2,5 года", "18 oy", "2 yosh 6 oy".
 * A bare number means years. Null when it is not an age.
 */
export function parseAgeMonths(raw: Cell): number | null {
  if (raw === null) return null;
  if (typeof raw === 'number') return raw > 0 && raw <= 40 ? Math.round(raw * 12) : null;

  const tokens = raw
    .toLowerCase()
    .replace(/,/g, '.')
    .match(/\d+(?:\.\d+)?|[\p{L}]+/gu);
  if (!tokens) return null;

  let months = 0;
  let matched = false;
  for (let i = 0; i < tokens.length; i++) {
    const n = Number(tokens[i]);
    if (!Number.isFinite(n)) return null;
    const unit = tokens[i + 1];
    if (unit !== undefined && !/^\d/.test(unit)) {
      i += 1;
      if (YEAR_UNITS.has(unit)) months += n * 12;
      else if (MONTH_UNITS.has(unit)) months += n;
      else return null;
    } else {
      months += n * 12;
    }
    matched = true;
  }
  if (!matched || months <= 0 || months > 480) return null;
  return Math.round(months);
}

/**
 * Comparison form of a name: case, spacing and punctuation do not matter, apostrophes may be
 * missing, and Uzbek Cyrillic letters fold onto their Russian look-alikes, because people type
 * "бугдой" on a Russian keyboard for "буғдой".
 */
export function matchKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ʻʼ‘’'`´]/g, '')
    .replace(/ғ/g, 'г')
    .replace(/ў/g, 'у')
    .replace(/қ/g, 'к')
    .replace(/ҳ/g, 'х')
    .replace(/ъ/g, '')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Finds a value by any of its names, in Latin or Cyrillic. */
export class Lookup<T> {
  private readonly byKey = new Map<string, T>();
  /** Keys that two different values share, which must be refused rather than picked at random. */
  private readonly ambiguous = new Set<string>();
  /** Names to show when a value is not found. */
  readonly labels: string[] = [];

  add(value: T, names: (string | null | undefined)[]): this {
    let labelled = false;
    for (const name of names) {
      if (!name) continue;
      if (!labelled) {
        this.labels.push(name);
        labelled = true;
      }
      for (const form of [name, latinToCyrillic(name)]) {
        const key = matchKey(form);
        if (!key) continue;
        const existing = this.byKey.get(key);
        if (existing !== undefined && existing !== value) this.ambiguous.add(key);
        else this.byKey.set(key, value);
      }
    }
    return this;
  }

  get(name: string): T | undefined {
    const key = matchKey(name);
    return this.ambiguous.has(key) ? undefined : this.byKey.get(key);
  }
}

export type Geometry = { type: 'Polygon'; coordinates: number[][][] };

export type CoordinatesResult =
  | { kind: 'polygon'; geometry: unknown }
  | { kind: 'point' }
  | { kind: 'invalid' };

/** Uzbekistan's box, used only to notice lat and lng written the other way round. */
const looksSwapped = (a: number, b: number) => a >= 55 && a <= 74 && b >= 37 && b <= 46;

/**
 * Outline as "lat, lng; lat, lng; lat, lng" (what Google Maps shows) or pasted GeoJSON.
 * A single point carries no area, so it is reported separately for a friendlier message.
 */
export function parseCoordinates(raw: string): CoordinatesResult {
  const text = raw.trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { type?: string; geometry?: unknown };
      const geometry = parsed.type === 'Feature' ? parsed.geometry : parsed;
      return { kind: 'polygon', geometry };
    } catch {
      return { kind: 'invalid' };
    }
  }

  const points: [number, number][] = [];
  for (const part of text.split(/[;\n]+/)) {
    const pieces = part.trim().match(/-?\d+(?:[.,]\d+)?/g);
    if (!pieces) continue;
    if (pieces.length !== 2) return { kind: 'invalid' };
    const [a, b] = pieces.map((p) => Number(p.replace(',', '.')));
    const [lat, lng] = looksSwapped(a, b) ? [b, a] : [a, b];
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { kind: 'invalid' };
    points.push([lng, lat]);
  }
  if (points.length === 0) return { kind: 'invalid' };
  if (points.length === 1) return { kind: 'point' };
  if (points.length < 3) return { kind: 'invalid' };

  const [first] = points;
  const last = points[points.length - 1];
  const ring = first[0] === last[0] && first[1] === last[1] ? points : [...points, first];
  if (ring.length < 4) return { kind: 'invalid' };
  return { kind: 'polygon', geometry: { type: 'Polygon', coordinates: [ring] } };
}

export interface BankDetails {
  bankName?: string;
  account?: string;
  mfo?: string;
}

/** Splits one free-text cell: "Agrobank, h/r 20208000900123456001, MFO 00394". */
export function parseBankDetails(raw: string): BankDetails | null {
  let text = raw.trim();
  if (!text) return null;
  const out: BankDetails = {};

  const account = /(?<!\d)\d(?:[\s-]?\d){19}(?!\d)/.exec(text);
  if (account) {
    out.account = account[0].replace(/\D/g, '');
    text = text.replace(account[0], ' ');
  }
  const mfo = /(?<!\d)\d{5}(?!\d)/.exec(text);
  if (mfo) {
    out.mfo = mfo[0];
    text = text.replace(mfo[0], ' ');
  }
  const name = text
    .replace(/(?<![\p{L}\p{N}])(h\/?r|х\/?р|р\/?с|mfo|мфо|hisob raqam[i]?|счет|счёт|account)(?![\p{L}\p{N}])\.?:?/giu, ' ')
    .replace(/[\s,;:]+/g, ' ')
    .trim();
  if (name) out.bankName = name.slice(0, 120);
  return out;
}

/** The stored text of a cell, for keys and messages. */
export function cellText(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return '';
  return typeof cell === 'number' ? String(cell) : cell.trim();
}
