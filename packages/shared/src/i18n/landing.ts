/**
 * Copy for the public website. Kept out of the app's dictionaries on purpose: the landing page must
 * not load the whole app's translations, and the app must not carry marketing text.
 */
import en from './locales/en/landing.json';
import ru from './locales/ru/landing.json';
import uz from './locales/uz/landing.json';
import { latinToCyrillic } from './translit';

export { PRODUCT_NAME } from '../brand';

export type LandingCopy = typeof uz;
export type LandingLanguage = 'uz' | 'uz-Cyrl' | 'ru' | 'en';

export const LANDING_LANGUAGES: readonly LandingLanguage[] = ['uz', 'uz-Cyrl', 'ru', 'en'];

/** Names that stay in Latin letters inside Cyrillic text. */
const NAMES = /(Yuksalish Agro|Excel|Telegram)/;

function toCyrillic(text: string): string {
  return text
    .split(NAMES)
    .map((part, index) => (index % 2 === 1 ? part : latinToCyrillic(part)))
    .join('');
}

/** `key` fields are identifiers for icons and pictures, not words. */
function convert<T>(value: T, field?: string): T {
  if (typeof value === 'string') return (field === 'key' ? value : toCyrillic(value)) as T;
  if (Array.isArray(value)) return value.map((item) => convert(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, convert(item, name)])) as T;
  }
  return value;
}

export const landingCopy: Record<LandingLanguage, LandingCopy> = { uz, 'uz-Cyrl': convert(uz), ru, en };
