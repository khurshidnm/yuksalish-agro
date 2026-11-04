/**
 * Server-side reading of the `import` namespace. The workbook and the row messages are written
 * here in the user's language, from the same dictionaries the web app uses.
 */
import { LANGUAGES, latinToCyrillic, resources, type LanguageCode } from '@yap/shared/i18n';
import type { I18nName } from '../../db/schema';
import { Lookup } from './values';

export const LANG_CODES = LANGUAGES.map((l) => l.code) as [LanguageCode, ...LanguageCode[]];
export type { LanguageCode };

function walk(root: unknown, path: string): unknown {
  let node = root;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

type Vars = Record<string, string | number>;

const interpolate = (text: string, vars?: Vars) =>
  text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(vars?.[name] ?? ''));

/** A string from the `import` namespace, falling back to Uzbek. */
export function tr(lang: LanguageCode, key: string, vars?: Vars): string {
  const value = walk(resources[lang].import, key) ?? walk(resources.uz.import, key);
  return typeof value === 'string' ? interpolate(value, vars) : key;
}

export function trOptional(lang: LanguageCode, key: string): string | undefined {
  const value = walk(resources[lang].import, key);
  return typeof value === 'string' ? value : undefined;
}

export function enumLabel(lang: LanguageCode, group: string, value: string): string {
  const label = walk(resources[lang].enums, `${group}.${value}`);
  return typeof label === 'string' ? label : value;
}

export const localized = (name: I18nName, lang: LanguageCode): string =>
  lang === 'uz-Cyrl' ? latinToCyrillic(name.uz) : name[lang];

/** A set of allowed values: how to find one, and what to offer in a dropdown or an error. */
export interface Choice<T> {
  lookup: Lookup<T>;
  labels: string[];
}

/** Enum values findable by their label in every language, by key, and by everyday aliases. */
export function enumChoice<T extends string>(
  lang: LanguageCode,
  group: string,
  values: readonly T[],
  aliases: Partial<Record<T, string[]>> = {},
): Choice<T> {
  const lookup = new Lookup<T>();
  for (const value of values) {
    lookup.add(value, [
      enumLabel('uz', group, value),
      enumLabel('ru', group, value),
      enumLabel('en', group, value),
      value,
      ...(aliases[value] ?? []),
    ]);
  }
  return { lookup, labels: values.map((value) => enumLabel(lang, group, value)) };
}
