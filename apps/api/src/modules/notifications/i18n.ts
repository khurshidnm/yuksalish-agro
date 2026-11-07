import { latinToCyrillic, resources, type LanguageCode, type Namespace } from '@yap/shared/i18n';

export type Params = Record<string, unknown>;

function language(locale: string | null | undefined): LanguageCode {
  return locale && locale in resources ? (locale as LanguageCode) : 'uz';
}

/** Dictionary entry, or null when the key does not exist. */
export function lookup(locale: string | null | undefined, ns: Namespace, key: string): string | null {
  let node: unknown = resources[language(locale)][ns];
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : null;
}

function isI18nName(value: unknown): value is { uz: string; ru: string; en: string } {
  return typeof value === 'object' && value !== null && 'uz' in value && 'ru' in value && 'en' in value;
}

/** Reference data names are { uz, ru, en }; pick the recipient's language. */
export function localizeValue(value: unknown, locale: string | null | undefined): unknown {
  if (!isI18nName(value)) return value;
  const lang = language(locale);
  if (lang === 'uz-Cyrl') return latinToCyrillic(value.uz);
  return value[lang];
}

/** The same short date the web app shows; ISO dates are for machines. */
function displayDate(value: string, locale?: string | null): string {
  const [year, month, day] = value.split('-');
  return [day, month, year].join(language(locale) === 'en' ? '/' : '.');
}

/** "2026-11" as the web app says it, in the reader's language. */
function displayMonth(value: string, locale?: string | null): string {
  const [year, month] = value.split('-');
  const name = lookup(locale, 'common', `date.months.${Number(month) - 1}`);
  return name ? `${name} ${year}` : value;
}

export function interpolate(template: string, params: Params, locale?: string | null): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const value = localizeValue(params[name], locale);
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return displayDate(value, locale);
    if (name === 'month' && typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)) return displayMonth(value, locale);
    if (name === 'unit') return lookup(locale, 'enums', `unit.${String(value)}`) ?? String(value);
    return String(value);
  });
}

/** Server-side translation, for text sent outside the web app. */
export function tr(locale: string | null | undefined, ns: Namespace, key: string, params: Params = {}): string {
  const template = lookup(locale, ns, key);
  return template === null ? key : interpolate(template, params, locale);
}
