import { latinToCyrillic } from '@yap/shared/i18n';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/format';
import i18n from '@/lib/i18n';
import type { I18nName } from './types';

/** Hectares with their unit. Two decimals is what a farmer reads; the card shows all four. */
export function formatHa(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '—';
  return i18n.t('farm:unit.ha', { value: formatNumber(value, digits) });
}

/** "№1 Shimoliy dala", or "№1" for a contour with no name. */
export function fieldTitle(field: { number: string; name?: string | null }): string {
  return field.name ? `№${field.number} ${field.name}` : `№${field.number}`;
}

/** Reference data carries its own translations; Cyrillic Uzbek is derived, like the dictionaries. */
export function useLocalName(): (name: I18nName | null | undefined) => string {
  const { i18n: instance } = useTranslation();
  const language = instance.language;
  return useCallback(
    (name) => {
      if (!name) return '—';
      if (language === 'uz-Cyrl') return latinToCyrillic(name.uz);
      return name[language as keyof I18nName] ?? name.uz;
    },
    [language],
  );
}
