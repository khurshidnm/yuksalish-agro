/** Server-side text for insights and summaries, from the same dictionaries the web app uses. */
import { resources, type LanguageCode } from '@yap/shared/i18n';

export const DEFAULT_LANGUAGE: LanguageCode = 'uz';

/** How a prompt names the language to write in. */
export const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  uz: 'Uzbek in Latin script',
  'uz-Cyrl': 'Uzbek in Cyrillic script',
  ru: 'Russian',
  en: 'English',
};

export function asLanguage(value: string | null | undefined): LanguageCode {
  return value === 'ru' || value === 'en' || value === 'uz' || value === 'uz-Cyrl' ? value : DEFAULT_LANGUAGE;
}

function lookup(dictionary: unknown, path: string): string | null {
  let node = dictionary;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : null;
}

export type TextParams = Record<string, string | number>;

/** Text from the `ai` namespace. A missing key returns the key, which tests catch. */
export function aiText(language: LanguageCode, key: string, params: TextParams = {}): string {
  const template = lookup(resources[language].ai, key) ?? lookup(resources.uz.ai, key) ?? key;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** A business date as people here write it, and as the web tables show it: 26.11.2026. */
export function dayText(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

/** "2026-10" as 10.2026. */
export function monthText(isoMonth: string): string {
  const [year, month] = isoMonth.split('-');
  return `${month}.${year}`;
}

/** Whole numbers with a space between thousands: 12 500 000. */
export function groupDigits(value: number, digits = 0): string {
  const fixed = value.toFixed(digits);
  const [whole, fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return fraction ? `${grouped}.${fraction}` : grouped;
}
