import { describe, expect, it } from 'vitest';
import { landingCopy } from './landing';

function flatKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => flatKeys(v, prefix ? `${prefix}.${k}` : k));
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

describe('landing copy', () => {
  it('has the same keys in every language', () => {
    const keys = flatKeys(landingCopy.uz);
    expect(flatKeys(landingCopy.ru)).toEqual(keys);
    expect(flatKeys(landingCopy.en)).toEqual(keys);
    expect(flatKeys(landingCopy['uz-Cyrl'])).toEqual(keys);
  });

  it('has no empty text', () => {
    for (const copy of Object.values(landingCopy)) {
      expect(strings(copy).every((text) => text.trim().length > 0)).toBe(true);
    }
  });

  it('keeps titles and descriptions short enough for search results', () => {
    for (const language of ['uz', 'ru', 'en'] as const) {
      expect(landingCopy[language].meta.title.length, language).toBeLessThanOrEqual(70);
      expect(landingCopy[language].meta.description.length, language).toBeLessThanOrEqual(160);
    }
  });

  it('derives Cyrillic but keeps brand names and identifiers', () => {
    const cyrillic = landingCopy['uz-Cyrl'];
    expect(cyrillic.nav.login).toBe('Кириш');
    expect(cyrillic.meta.title).toContain('Agro Panel');
    // The pilot farm is named in the copy, and its name stays in Latin as well.
    expect(JSON.stringify(cyrillic)).toContain('Yuksalish Agro');
    expect(cyrillic.modules.items[0].key).toBe('land');
    expect(cyrillic.roles.items[0].key).toBe('owner');
    expect(strings(cyrillic.how).join(' ')).toContain('Excel');
  });

  it('speaks of livestock in general, not of one animal', () => {
    const titles = { uz: 'Chorvachilik', ru: 'Животноводство', en: 'Livestock' } as const;
    for (const language of ['uz', 'ru', 'en'] as const) {
      const module = landingCopy[language].modules.items.find((item) => item.key === 'livestock');
      expect(module?.title, language).toBe(titles[language]);
    }
    const everything = [...strings(landingCopy.uz), ...strings(landingCopy.ru), ...strings(landingCopy.en)].join(' ').toLowerCase();
    for (const word of ["qo'ychilik", "qo'zilash", 'овцеводств', 'окот', 'lambing', 'flock']) {
      expect(everything, word).not.toContain(word);
    }
  });
});
