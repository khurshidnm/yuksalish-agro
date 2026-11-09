import { PRODUCT_NAME, type LandingLanguage } from '@yap/shared/landing';

/**
 * Public details of the website, set at build time. Each is optional so a build never publishes
 * a made-up phone number: without a value, that part of the page is simply left out.
 */
export const SITE_URL = String(import.meta.env.VITE_SITE_URL ?? '').replace(/\/$/, '');
export const CONTACT_PHONE = String(import.meta.env.VITE_CONTACT_PHONE ?? '').trim();
/** A Telegram username without the @. */
export const CONTACT_TELEGRAM = String(import.meta.env.VITE_CONTACT_TELEGRAM ?? '').replace(/^@/, '').trim();

export const SITE_NAME = PRODUCT_NAME;

export { LANDING_PATHS, loginHref } from './paths';

export const LANGUAGE_NAMES: Record<LandingLanguage, string> = {
  uz: "O'zbekcha",
  'uz-Cyrl': 'Ўзбекча',
  ru: 'Русский',
  en: 'English',
};

/** Short labels for the header. Not 'ЎЗ': in the site's font its З reads as the digit 3. */
export const LANGUAGE_CODES: Record<LandingLanguage, string> = { uz: 'UZ', 'uz-Cyrl': 'Ўзб', ru: 'RU', en: 'EN' };

/** The Open Graph locale of each page. */
export const OG_LOCALES: Record<LandingLanguage, string> = { uz: 'uz_UZ', 'uz-Cyrl': 'uz_UZ', ru: 'ru_RU', en: 'en_US' };

/** "+998 90 123 45 67" as a tel: link target. */
export const telHref = (phone: string): string => `tel:${phone.replace(/[^\d+]/g, '')}`;
