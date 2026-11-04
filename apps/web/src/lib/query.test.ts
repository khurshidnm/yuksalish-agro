import { afterAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import i18n from './i18n';
import { errorMessage, pathKey } from './query';

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

describe('pathKey', () => {
  it('lets a path invalidate its lists and its records', () => {
    const list = pathKey('/finance/counterparties', { page: 1 });
    const record = pathKey('/finance/counterparties/abc');
    const prefix = pathKey('/finance/counterparties');
    expect(list.slice(0, prefix.length)).toEqual(prefix);
    expect(record.slice(0, prefix.length)).toEqual(prefix);
  });
});
