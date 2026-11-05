/**
 * Every error the API can send must read in all three languages, and read whole.
 * The codes are read from the API's own source, so a new one fails here until it has words.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { NAMESPACES, resources } from '@yap/shared/i18n';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import i18n from './i18n';
import { errorMessage } from './query';

// sonner adds its styles to the page as it loads, and there is no page here.
vi.mock('sonner', () => ({ toast: {} }));

const API = new URL('../../../api/src/', import.meta.url);
const source = readdirSync(API, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts'))
  .map((file) => readFileSync(new URL(file, API), 'utf8'))
  .join('\n');

const LANGUAGES = ['uz', 'ru', 'en'] as const;
const CODE = `'([A-Z][A-Z0-9_]+)'`;
const OTHER_ARGUMENT = `(?:'[^'\\n]*'|"[^"\\n]*"|\`[^\`\\n]*\`|\\w+)`;

const unique = (values: string[]) => [...new Set(values)].sort();
const found = (pattern: string) => [...source.matchAll(new RegExp(pattern, 'g'))];

/** Status first, so the answers the web reduces to a line of its own can be told apart. */
const withStatus = [
  ...found(`\\b(?:new AppError|wrap)\\(\\s*(\\d+)\\s*,\\s*${CODE}`),
  ...found(`reply\\.code\\((\\d+)\\)\\.send\\(\\{ error: \\{ code: ${CODE}`),
].map(([, status, code]) => ({ status: Number(status), code }));
const reducedByStatus = (status: number) => status === 429 || status >= 500;

/** Raised through a variable, so no pattern here can see them. */
const THROUGH_A_VARIABLE = ['ALREADY_IN_QUARANTINE', 'ANIMAL_NOT_ON_FARM'];

/** These answer machines, which read the code: a device, or a client with an API key. */
const FOR_MACHINES = ['API_KEY_REQUIRED', 'INSUFFICIENT_SCOPE', 'INVALID_API_KEY'];

const shownByCode = unique([
  ...found(`\\b(?:badRequest|conflict)\\(\\s*${CODE}`).map(([, code]) => code),
  ...found(`\\bunauthorized\\(\\s*${CODE}`).map(([, code]) => code),
  ...found(`\\bforbidden\\(\\s*${OTHER_ARGUMENT}\\s*,\\s*${CODE}`).map(([, code]) => code),
  ...withStatus.filter(({ status }) => !reducedByStatus(status)).map(({ code }) => code),
  ...THROUGH_A_VARIABLE,
]).filter((code) => !FOR_MACHINES.includes(code));

/** The assistant's screens spell these out: see aiErrorMessage. */
const assistantFailures = unique(withStatus.filter(({ code }) => code.startsWith('AI_')).map(({ code }) => code));

function wording(language: (typeof LANGUAGES)[number], code: string): unknown {
  return NAMESPACES.map((ns) => (resources[language][ns] as { errors?: Record<string, unknown> }).errors?.[code]).find((text) => typeof text === 'string');
}

describe('codes read from the API', () => {
  it('finds them, so a change in how the API writes them cannot pass unnoticed', () => {
    expect(shownByCode.length).toBeGreaterThanOrEqual(250);
    expect(shownByCode).toEqual(
      expect.arrayContaining([
        'ACCOUNT_CLOSED',
        'ACCOUNT_CURRENCY_LOCKED',
        'ACCOUNT_CURRENCY_MISMATCH',
        'AVERAGE_COST_USED',
        'BATCH_ALREADY_USED',
        'CATEGORY_REQUIRED',
        'COST_CENTER_CLOSED',
        'DEBT_ALREADY_SETTLED',
        'DOCUMENT_NUMBER_AMBIGUOUS',
        'FX_RATE_OUT_OF_RANGE',
        'IDEMPOTENCY_KEY_REUSED',
        'INVALID_CREDENTIALS',
        'SAME_MAKER_CHECKER',
        'VALIDATION_ERROR',
      ]),
    );
    expect(assistantFailures).toEqual(expect.arrayContaining(['AI_DOCUMENT_UNREADABLE', 'AI_PROVIDER_BUSY', 'AI_RATE_LIMITED']));
  });
});

describe('error wording', () => {
  it.each(LANGUAGES)('%s: each code has text of its own', (language) => {
    const missing = [...shownByCode, ...assistantFailures].filter((code) => !wording(language, code));
    expect(missing).toEqual([]);
  });
});

describe('errorMessage', () => {
  const message = (code: string, details?: unknown, status = 400) => errorMessage(new ApiError(status, code, 'From the server', details));
  const english = i18n.changeLanguage('en');
  afterAll(() => i18n.changeLanguage('uz'));

  it('skips a wording whose value this error does not carry', async () => {
    await english;
    expect(message('INVALID_PERIOD', { max: 36 })).toContain('36');
    expect(message('INVALID_PERIOD')).not.toContain('months');
    expect(message('INVALID_PERIOD')).not.toBe('From the server');
    expect(message('ANIMAL_NOT_ON_FARM', { tag: 'UZ-7' })).toContain('UZ-7');
    expect(message('ANIMAL_NOT_ON_FARM', { skipped: [] })).toBe('This animal is no longer on the farm');
  });

  it('keeps the words the server sent when no wording fits', async () => {
    await english;
    expect(message('NO_SUCH_CODE')).toBe('From the server');
    expect(message('TAG_TAKEN')).toBe('From the server');
  });

  it('does not show a server failure as if it were the person\'s mistake', async () => {
    await english;
    expect(message('ANY', undefined, 500)).toBe(i18n.t('common:errors.server'));
    expect(message('ANY', undefined, 429)).toBe(i18n.t('common:errors.rateLimit'));
  });
});
