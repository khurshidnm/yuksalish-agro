import type { TFunction } from 'i18next';
import { ApiError } from '@/lib/api';
import { formatDate, formatNumber } from '@/lib/format';
import { errorMessage } from '@/lib/query';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string' && ISO_DATE.test(value)) return formatDate(value);
  return String(value);
}

/** A column name from the API in the user's language, or readable when none is translated. */
export function fieldLabel(t: TFunction, key: string): string {
  const fallback = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return t(`fields.${key}`, { defaultValue: fallback.charAt(0).toUpperCase() + fallback.slice(1) });
}

/**
 * AI failures have their own explanations. The shared `errorMessage` reduces every 5xx to a generic
 * server error, which would hide "the document could not be read".
 */
export function aiErrorMessage(t: TFunction, error: unknown): string {
  if (error instanceof ApiError && error.code.startsWith('AI_')) {
    return t(`errors.${error.code}`, { defaultValue: errorMessage(error) });
  }
  return errorMessage(error);
}
