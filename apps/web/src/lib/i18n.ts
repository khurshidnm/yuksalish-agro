/**
 * Dictionaries live in packages/shared/src/i18n/locales/{uz,ru,en}/<namespace>.json.
 * Uzbek Cyrillic is derived from `uz` at runtime; never write it by hand.
 * Enum labels: t('enums:<group>.<value>'), where <group> is the camelCase singular of the constant in
 * packages/shared/src/enums.ts (ANIMAL_STATUSES → enums:animalStatus.pregnant, UNITS → enums:unit.kg),
 * plus enums:role.<key>, enums:module.<key> and enums:action.<key>. Build option lists with enumOptions().
 */
import { LANGUAGES, NAMESPACES, resources } from '@yap/shared/i18n';
import i18n, { type Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { z } from 'zod';
import { storageGet, storageSet } from './utils';

const STORAGE_KEY = 'yap.language';
/** Set by a choice made by hand, until the account has it (lib/accountLanguage). */
export const CHOSEN_LANGUAGE_KEY = 'yap.language.chosen';

const supported = (code: string | null): code is string => code !== null && LANGUAGES.some((l) => l.code === code);

/**
 * `?lang=` from the public pages (/login?lang=ru): the visitor was reading that language, so sign-in
 * speaks it too. Taken out of the address once read, so a reload never undoes a language picked later.
 */
export function languageAsked(
  location: Pick<Location, 'href'> | undefined = globalThis.location,
  history: Pick<History, 'state' | 'replaceState'> | undefined = globalThis.history,
): string | null {
  if (!location) return null;
  try {
    const url = new URL(location.href);
    const asked = url.searchParams.get('lang');
    if (asked === null) return null;
    url.searchParams.delete('lang');
    history?.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    return supported(asked) ? asked : null;
  } catch {
    return null;
  }
}

function initialLanguage(): string {
  const asked = languageAsked();
  if (asked) {
    storageSet(STORAGE_KEY, asked);
    return asked;
  }
  const saved = storageGet(STORAGE_KEY);
  return supported(saved) ? saved : 'uz';
}

void i18n.use(initReactI18next).init({
  resources: resources as Resource,
  lng: initialLanguage(),
  fallbackLng: { 'uz-Cyrl': ['uz'], default: ['uz'] },
  supportedLngs: LANGUAGES.map((l) => l.code),
  load: 'currentOnly',
  ns: [...NAMESPACES],
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
});

document.documentElement.lang = i18n.language;

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
  storageSet(STORAGE_KEY, lng);
});

/** All zod validation messages follow the UI language. */
z.config({
  customError: (issue) => {
    const t = i18n.t.bind(i18n);
    switch (issue.code) {
      case 'invalid_type':
        if (issue.input === undefined || issue.input === null || issue.input === '') return t('common:validation.required');
        return t(Number.isNaN(issue.input) ? 'common:validation.unreadableNumber' : 'common:validation.invalid');
      case 'too_small': {
        const min = Number(issue.minimum);
        if (issue.origin === 'string') {
          return min <= 1 ? t('common:validation.required') : t('common:validation.minLength', { min });
        }
        return issue.inclusive === false
          ? t('common:validation.greaterThan', { min })
          : t('common:validation.min', { min });
      }
      case 'too_big': {
        const max = Number(issue.maximum);
        return issue.origin === 'string' ? t('common:validation.maxLength', { max }) : t('common:validation.max', { max });
      }
      case 'invalid_format':
        return issue.input === '' ? t('common:validation.required') : t('common:validation.format');
      default:
        return t('common:validation.invalid');
    }
  },
});

export interface EnumOption {
  value: string;
  label: string;
}

/** Translated options for a Select from a shared enum: enumOptions('unit', UNITS). */
export function enumOptions(group: string, values: readonly string[]): EnumOption[] {
  return values.map((value) => ({ value, label: i18n.t(`enums:${group}.${value}`) }));
}

export function changeLanguage(code: string): void {
  storageSet(CHOSEN_LANGUAGE_KEY, code);
  void i18n.changeLanguage(code);
}

export { LANGUAGES };
export default i18n;
