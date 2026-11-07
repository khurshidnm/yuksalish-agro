import { MutationObserver, onlineManager } from '@tanstack/react-query';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import i18n from './i18n';
import { errorMessage, pathKey, queryClient } from './query';

// sonner injects a stylesheet on import, and these tests have no real DOM.
vi.mock('sonner', () => ({ toast: {} }));

describe('errorMessage', () => {
  afterAll(() => {
    void i18n.changeLanguage('uz');
  });

  it('translates a known code instead of showing the English fallback', async () => {
    await i18n.changeLanguage('ru');
    expect(errorMessage(new ApiError(401, 'INVALID_CREDENTIALS', 'Wrong phone number or password'))).toBe('Неверный номер телефона или пароль.');
    await i18n.changeLanguage('uz');
    expect(errorMessage(new ApiError(409, 'IN_USE', 'This record is in use'))).toBe("Bu yozuv ishlatilmoqda, uni o'chirib bo'lmaydi.");
  });

  it('derives Uzbek Cyrillic from the Latin text', async () => {
    await i18n.changeLanguage('uz-Cyrl');
    expect(errorMessage(new ApiError(400, 'INVALID_CODE', 'Wrong code'))).toBe('Код нотўғри.');
  });

  it('falls back to the server message for a code nobody has translated', async () => {
    await i18n.changeLanguage('uz');
    expect(errorMessage(new ApiError(409, 'BRAND_NEW_CODE', 'Something specific'))).toBe('Something specific');
  });

  it('hides server internals and transport details behind friendly text', async () => {
    await i18n.changeLanguage('en');
    expect(errorMessage(new ApiError(500, 'INTERNAL_ERROR', 'stack trace here'))).toBe('Server error. Try again in a moment.');
    expect(errorMessage(new ApiError(0, 'NETWORK_ERROR', 'Network error'))).toBe('Check your internet connection and try again.');
    expect(errorMessage(new ApiError(429, 'RATE_LIMITED', 'Too many'))).toBe('Too many attempts. Try again in a minute.');
    expect(errorMessage(new Error('boom'))).toBe('Something went wrong. Try again.');
    expect(errorMessage('nope')).toBe('Something went wrong. Try again.');
  });
});

describe('a limit on uploads', () => {
  it('says what the limit is and what to do, in place of a bare status', async () => {
    await i18n.changeLanguage('uz');
    const tooBig = new ApiError(413, 'FILE_TOO_LARGE', 'This file is too large', { maxMb: 15 });
    expect(errorMessage(tooBig)).toBe("Fayl juda katta. Eng ko'pi bilan 15 MB yuklash mumkin. Faylni kichraytiring yoki qismlarga bo'ling.");
    const quota = new ApiError(409, 'STORAGE_QUOTA_REACHED', 'Full', { usedMb: 20481, quotaMb: 20480 });
    expect(errorMessage(quota)).toContain('20481 MB, chegara 20480 MB');
    expect(errorMessage(new ApiError(409, 'DAILY_UPLOAD_LIMIT_REACHED', 'Full', { limitMb: 500 }))).toContain('24 soatda 500 MB');
  });

  it('says what is busy when the code has words of its own, and a 429 or 5xx without them stays general', async () => {
    await i18n.changeLanguage('en');
    expect(errorMessage(new ApiError(429, 'UPLOADS_BUSY', 'x'))).toBe('The server is receiving many files right now. Try again in a moment.');
    expect(errorMessage(new ApiError(429, 'READER_BUSY', 'x'))).toBe('Other files are being read right now. Try again in a moment.');
    expect(errorMessage(new ApiError(503, 'READER_UNAVAILABLE', 'x'))).toBe("Files can't be read right now. Try again.");
    expect(errorMessage(new ApiError(429, 'RATE_LIMITED', 'internal words'))).toBe('Too many attempts. Try again in a minute.');
    expect(errorMessage(new ApiError(503, 'NOT_KNOWN', 'internal words'))).toBe('Server error. Try again in a moment.');
  });
});

describe('a refusal that names the new figure', () => {
  afterAll(() => {
    void i18n.changeLanguage('uz');
  });
  const changed = new ApiError(409, 'TRANSACTION_CHANGED', 'This entry changed', { amount: 480_000_000, currency: 'UZS', transaction: {} });

  it('reads the amount the way amounts read on screen, in every language', async () => {
    await i18n.changeLanguage('en');
    expect(errorMessage(changed)).toContain('480,000,000 UZS');
    await i18n.changeLanguage('ru');
    expect(errorMessage(changed).replace(/\s/g, ' ')).toContain('480 000 000 UZS');
    await i18n.changeLanguage('uz');
    expect(errorMessage(changed).replace(/\s/g, ' ')).toContain('480 000 000 UZS');
  });
});

describe('a press with no signal', () => {
  afterEach(() => onlineManager.setOnline(true));

  it('fails at once and is never kept to go out later', async () => {
    onlineManager.setOnline(false);
    const sent = vi.fn(async () => {
      throw new ApiError(0, 'NETWORK_ERROR', 'Network error');
    });
    const press = new MutationObserver(queryClient, { mutationFn: sent });
    await expect(press.mutate()).rejects.toMatchObject({ status: 0 });
    expect(sent).toHaveBeenCalledOnce();
    expect(press.getCurrentResult().isPaused).toBe(false);
    onlineManager.setOnline(true);
    await queryClient.resumePausedMutations();
    expect(sent).toHaveBeenCalledOnce();
  });
});

describe('pathKey', () => {
  it('lets a path invalidate its lists and its records', () => {
    const list = pathKey('/finance/counterparties', { page: 1 });
    const record = pathKey('/finance/counterparties/abc');
    const prefix = pathKey('/finance/counterparties');
    expect(list.slice(0, prefix.length)).toEqual(prefix);
    expect(record.slice(0, prefix.length)).toEqual(prefix);
  });
});
