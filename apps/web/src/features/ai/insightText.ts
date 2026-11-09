import { latinToCyrillic } from '@yap/shared/i18n';
import type { i18n as I18n } from 'i18next';
import type { I18nName } from '@/features/finance/types';
import { formatNumber } from '@/lib/format';
import type { Insight } from './types';

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/** A value the finding carries in every language, such as a crop name, in the reader's. */
function inReaderLanguage(value: I18nName, language: string): string {
  if (language === 'uz-Cyrl') return latinToCyrillic(value.uz);
  return language === 'ru' || language === 'en' ? value[language] : value.uz;
}

/** "18 500 000" as the server groups it, held together so a phone does not break it across lines. */
const keepTogether = (text: string) => text.replace(/(?<=\d) (?=\d{3}(?!\d))/g, ' ');

/** Values for the reader: names in their language, and a fraction written their way, 25,8 in Uzbek and Russian. */
function readerParams(insight: Insight, language: string): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(insight.data.i18n ?? {})) {
    if (typeof value === 'string') params[key] = keepTogether(value);
    else params[key] = Number.isInteger(value) ? value : formatNumber(value);
  }
  for (const [key, value] of Object.entries(insight.data.localized ?? {})) params[key] = inReaderLanguage(value, language);
  return params;
}

/**
 * An insight's title and body in the reader's language, from its dictionary entry and values. Stored text is
 * in the farm's language. A finding stored before its wording changed may lack a value the new wording
 * needs, and then keeps its own text.
 */
export function insightText(insight: Insight, i18n: I18n): { title: string; body: string } {
  const stored = { title: insight.title, body: insight.body };
  if (!insight.data.i18n) return stored;
  const key = `insight.${insight.data.textKey ?? insight.type}`;
  const params = readerParams(insight, i18n.language);
  const fill = (part: 'title' | 'body'): string | null => {
    const path = `${key}.${part}`;
    const template: unknown = i18n.getResource(i18n.language, 'ai', path) ?? i18n.getResource('uz', 'ai', path);
    if (typeof template !== 'string') return null;
    const complete = [...template.matchAll(PLACEHOLDER)].every(([, name]) => params[name] != null);
    return complete ? i18n.t(`ai:${path}`, params) : null;
  };
  const title = fill('title');
  const body = fill('body');
  return title !== null && body !== null ? { title, body } : stored;
}
