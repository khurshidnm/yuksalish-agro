import { LANGUAGES, latinToCyrillic, resources, type Namespace } from '@yap/shared/i18n';
import type { Lang } from './types';

const CODES: string[] = LANGUAGES.map((l) => l.code);

export function resolveLang(value: string | null | undefined): Lang {
  return value && CODES.includes(value) ? (value as Lang) : 'uz';
}

function lookup(lang: Lang, ns: Namespace, path: string): string | null {
  let node: unknown = resources[lang][ns];
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : null;
}

function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const value = params[name];
    return value === null || value === undefined ? '' : String(value);
  });
}

/** Text from the reports dictionary. Falls back to the key, which a test forbids for real reports. */
export function t(lang: Lang, path: string, params: Record<string, unknown> = {}): string {
  return interpolate(lookup(lang, 'reports', path) ?? path, params);
}

export function hasText(lang: Lang, path: string): boolean {
  return lookup(lang, 'reports', path) !== null;
}

/** `group` is an enums group, or 'reports:<group>' for labels only reports use. */
export function enumLabel(lang: Lang, group: string, value: unknown): string {
  const raw = String(value);
  if (group.startsWith('reports:')) return lookup(lang, 'reports', `${group.slice(8)}.${raw}`) ?? raw;
  return lookup(lang, 'enums', `${group}.${raw}`) ?? raw;
}

export function isI18nName(value: unknown): value is { uz: string; ru: string; en: string } {
  return typeof value === 'object' && value !== null && 'uz' in value && 'ru' in value && 'en' in value;
}

/** Reference data names are stored as { uz, ru, en }. */
export function localizedName(value: unknown, lang: Lang): string {
  if (!isI18nName(value)) return value === null || value === undefined ? '' : String(value);
  if (lang === 'uz-Cyrl') return latinToCyrillic(value.uz);
  return value[lang];
}

/** Uzbek data is thin in Intl, so Uzbek uses Russian digit grouping, as the web app does. */
const numberLocale = (lang: Lang) => (lang === 'en' ? 'en-US' : 'ru-RU');

export function formatNumber(value: number, digits: number, lang: Lang): string {
  return new Intl.NumberFormat(numberLocale(lang), { maximumFractionDigits: digits }).format(value);
}

export function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

export function formatIsoMonth(iso: string): string {
  const [y, m] = iso.split('-');
  return `${m}.${y}`;
}

export function formatPeriod(period: { from: string; to: string }): string {
  return `${formatIsoDate(period.from)} – ${formatIsoDate(period.to)}`;
}
