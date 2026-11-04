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

function initialLanguage(): string {
  const saved = storageGet(STORAGE_KEY);
  return saved && LANGUAGES.some((l) => l.code === saved) ? saved : 'uz';
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
        return t('common:validation.invalid');
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
  void i18n.changeLanguage(code);
}

export { LANGUAGES };
export default i18n;
