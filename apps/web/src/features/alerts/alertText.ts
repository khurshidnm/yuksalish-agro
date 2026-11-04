import { latinToCyrillic } from '@yap/shared/i18n';
import type { TFunction } from 'i18next';
import { formatDate, formatMonth } from '@/lib/format';
import i18n from '@/lib/i18n';
import type { Alert } from './types';

type I18nName = { uz: string; ru: string; en: string };

function isName(value: unknown): value is I18nName {
  return typeof value === 'object' && value !== null && 'uz' in value && 'ru' in value && 'en' in value;
}

function localizedName(name: I18nName): string {
  const lang = i18n.language;
  if (lang === 'uz-Cyrl') return latinToCyrillic(name.uz);
  if (lang === 'ru' || lang === 'en') return name[lang];
  return name.uz;
}

/** Facts as stored by the rule engine, made readable for the current language. */
function displayParams(alert: Pick<Alert, 'data'>, t: TFunction): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(alert.data)) {
    if (isName(value)) out[key] = localizedName(value);
    else if (key === 'eventType' && typeof value === 'string') {
      // Named in the cameras dictionary; a type no one has named shows as sent.
      out[key] = t(`cameras:eventTypes.${value.split('.').pop()}`, { defaultValue: value });
    }
    else if (key === 'date' && typeof value === 'string') out[key] = formatDate(value);
    else if (key === 'month' && typeof value === 'string') out[key] = formatMonth(value);
    else if (key === 'unit' && typeof value === 'string') out[key] = t(`enums:unit.${value}`);
    else out[key] = value;
  }
  return out;
}

function fill(ns: string, key: string, params: Record<string, unknown>, t: TFunction): string | null {
  const template = i18n.getResource(i18n.language, ns, key) as string | undefined;
  if (!template) return null;
  // A rule key shared with text raised elsewhere may lack the values: keep the stored text then.
  const complete = [...template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].every(([, name]) => params[name] != null);
  return complete ? t(`${ns}:${key}`, params) : null;
}

/** The alert in the reader's language, falling back to the text it was raised with. */
export function alertText(alert: Alert, t: TFunction): { title: string; body: string | null } {
  const { insightKey, i18n: insightParams } = alert.data;

  // An AI alert is a finding, and the `ai` dictionary already words every finding.
  if (typeof insightKey === 'string') {
    const params = (insightParams ?? {}) as Record<string, unknown>;
    return {
      title: fill('ai', `insight.${insightKey}.title`, params, t) ?? alert.title,
      body: fill('ai', `insight.${insightKey}.body`, params, t) ?? alert.body,
    };
  }

  const params = displayParams(alert, t);
  // A rule may word one state differently, e.g. an expired rather than an expiring document.
  const text = (alert.data.textKey as string | undefined) ?? alert.ruleKey;
  return {
    title: fill('alerts', `rules.${text}.title`, params, t) ?? alert.title,
    body: fill('alerts', `rules.${text}.body`, params, t) ?? alert.body,
  };
}
