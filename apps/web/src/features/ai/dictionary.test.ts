/**
 * Every warning and question the assistant can put on a card must read in all three languages.
 * The codes are read from the API's own source, so a new one fails here until it has words.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resources } from '@yap/shared/i18n';
import { acknowledgeBodyKey, listedWarnings, needsYes, questionKeys, warningKeys } from './proposals';
import type { ProposalView } from './types';

const RECORDS = new URL('../../../../api/src/modules/ai/records/', import.meta.url);
const source = readdirSync(RECORDS)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => readFileSync(new URL(file, RECORDS), 'utf8'))
  .join('\n');

const LANGUAGES = ['uz', 'ru', 'en'] as const;

const matches = (pattern: RegExp) => [...source.matchAll(pattern)];
const unique = (values: string[]) => [...new Set(values)].sort();

function text(language: (typeof LANGUAGES)[number], key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], resources[language].ai);
}
const hasText = (language: (typeof LANGUAGES)[number], key: string) => typeof text(language, key) === 'string';

const warningCodes = unique([...matches(/\bwarn\(\s*'([A-Z_]+)'/g), ...matches(/code:\s*'([A-Z_]+)',\s*params/g)].map((m) => m[1]));
const acknowledged = unique(
  (/ACKNOWLEDGE_WARNINGS = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? '').match(/[A-Z_]+/g) ?? [],
);
const asked = matches(/\bask\(\s*(?:'([a-zA-Z]+)'|[a-zA-Z.]+)\s*,\s*'([A-Z_]+)'/g).map((m) => ({ field: m[1] as string | undefined, code: m[2] }));
const pickedFields = unique(matches(/\bpick\(\s*'[a-z_]+'\s*,\s*'([a-zA-Z]+)'/g).map((m) => m[1]));

describe('codes read from the API', () => {
  it('finds them, so a change in how the API writes them cannot pass unnoticed', () => {
    expect(warningCodes.length).toBeGreaterThanOrEqual(10);
    expect(acknowledged).toEqual(expect.arrayContaining(['AMOUNT_FROM_DOCUMENT', 'OTHER_AMOUNT', 'POSSIBLE_DUPLICATE']));
    expect(asked.length).toBeGreaterThanOrEqual(30);
    expect(pickedFields).toEqual(expect.arrayContaining(['account', 'category', 'counterparty', 'item', 'target', 'toAccount', 'warehouse']));
  });
});

describe('warnings on a card', () => {
  it('asks for the explicit yes for exactly the warnings the server waits on', () => {
    for (const code of warningCodes) expect(needsYes({ code, params: {} }), code).toBe(acknowledged.includes(code));
  });

  it.each(LANGUAGES)('%s: each warning has its own text, and each yes has a title, a body and a button', (language) => {
    for (const code of warningCodes) {
      const warning = { code, params: {} };
      if (needsYes(warning)) {
        const bodies = code === 'POSSIBLE_DUPLICATE' ? [{ transactionId: 't' }, { proposalId: 'p' }] : [{}];
        for (const params of bodies) expect(hasText(language, acknowledgeBodyKey({ code, params })), `${code} body`).toBe(true);
        expect(hasText(language, `records.acknowledge.${code}.title`), `${code} title`).toBe(true);
        expect(hasText(language, `records.acknowledge.${code}.yes`), `${code} yes`).toBe(true);
        continue;
      }
      // The target row and the approval note show these in their own place.
      if (listedWarnings({ warnings: [warning] } as ProposalView).length === 0) continue;
      const own = warningKeys(warning).filter((key) => key !== 'records.warnings.generic');
      expect(own.some((key) => hasText(language, key)), code).toBe(true);
    }
    expect(hasText(language, 'records.acknowledge.several')).toBe(true);
  });
});

describe('questions on a card and in the chat', () => {
  it.each(LANGUAGES)('%s: each question has words of its own, not only the generic line', (language) => {
    for (const { field, code } of asked) {
      // A field passed in a variable is unknown here, so the code must carry the wording itself.
      const keys = questionKeys({ field: field ?? '?', code, options: [] }).filter((key) => key !== 'records.question.generic');
      expect(keys.some((key) => hasText(language, key)), `${field ?? '?'} ${code}`).toBe(true);
    }
    for (const field of pickedFields) expect(hasText(language, `records.questions.field.${field}`), field).toBe(true);
  });

  it.each(LANGUAGES)('%s: options that are words, not records, read in the language', (language) => {
    const wordings = unique(matches(/\{ id: '([a-z_]+)', label: '[^']+' \}/g).map((m) => m[1]));
    expect(wordings.length).toBeGreaterThan(0);
    for (const id of wordings) {
      const known = hasText(language, `records.options.${id}`) || hasText(language, `records.direction.${id}`);
      const enumLabel = typeof (resources[language].enums as { paymentMethod: Record<string, string> }).paymentMethod[id] === 'string';
      expect(known || enumLabel, id).toBe(true);
    }
  });
});
