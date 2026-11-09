import { latinToCyrillic } from '@yap/shared/i18n';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { BadgeVariant } from '@/components/ui/badge';
import { formatNumber, formatQty } from '@/lib/format';
import i18n from '@/lib/i18n';
import type { I18nName } from './types';

/**
 * One colour per crop plan status on every screen: planned is an outline, sown blue, growing green,
 * harvested grey (the season is closed, nothing to act on), cancelled red.
 */
export const CROP_STATUS_VARIANT: Record<string, BadgeVariant> = {
  planned: 'outline',
  sown: 'info',
  growing: 'success',
  harvested: 'neutral',
  cancelled: 'danger',
};

/** Hectares with their unit. Two decimals is what a farmer reads; the card shows all four. */
export function formatHa(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '—';
  return i18n.t('farm:unit.ha', { value: formatNumber(value, digits) });
}

/** Capacity units as people type them, in either script, read as the shared unit they mean. */
const CAPACITY_UNITS: Record<string, string> = {
  bosh: 'head',
  бош: 'head',
  head: 'head',
  гол: 'head',
  'гол.': 'head',
  t: 't',
  т: 't',
  tonna: 't',
  тонна: 't',
  kg: 'kg',
  кг: 'kg',
  l: 'l',
  л: 'l',
};

/** "500 t" in the reader's language when the typed unit is one the app knows; any other unit as typed. */
export function formatCapacity(value: number | null | undefined, unit: string | null | undefined): string {
  const known = unit ? CAPACITY_UNITS[unit.trim().toLowerCase()] : undefined;
  return formatQty(value, known ?? unit, 0);
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
