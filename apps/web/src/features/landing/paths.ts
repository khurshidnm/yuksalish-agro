import type { LandingLanguage } from '@yap/shared/landing';

/**
 * Where the public pages live. Kept apart from the copy, so the app links to them without
 * downloading any of it.
 */
export const LANDING_PATHS: Record<LandingLanguage, string> = {
  uz: '/',
  'uz-Cyrl': '/uz-cyrl',
  ru: '/ru',
  en: '/en',
};

/** The public page in a language of the app. */
export const landingPath = (language: string): string => LANDING_PATHS[language as LandingLanguage] ?? LANDING_PATHS.uz;

/**
 * Sign-in in the language of the page the visitor is reading. The Latin Uzbek page is the default,
 * not a choice, so it leaves a language saved in this browser alone.
 */
export const loginHref = (language: LandingLanguage): string => (language === 'uz' ? '/login' : `/login?lang=${language}`);
