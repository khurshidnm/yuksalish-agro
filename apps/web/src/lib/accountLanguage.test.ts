import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendChosenLanguage } from './accountLanguage';
import i18n, { CHOSEN_LANGUAGE_KEY, changeLanguage } from './i18n';
import { storageGet } from './utils';

// sonner injects a stylesheet on import, and these tests have no real DOM.
vi.mock('sonner', () => ({ toast: {} }));

const ok = () => new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const chosen = () => storageGet(CHOSEN_LANGUAGE_KEY);

describe('the language chosen by hand reaches the account', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await i18n.changeLanguage('uz');
  });

  const sent = () => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).language as string);

  it('sends a choice once, and then has nothing left to send', async () => {
    changeLanguage('ru');
    await sendChosenLanguage();
    await sendChosenLanguage();

    expect(sent()).toEqual(['ru']);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/notifications/language');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PUT');
    expect(chosen()).toBeNull();
  });

  it('sends nothing when the language was never chosen by hand, as on a shared phone', async () => {
    await i18n.changeLanguage('ru');
    await sendChosenLanguage();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a choice the server did not take, for the next time', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    changeLanguage('en');

    await expect(sendChosenLanguage()).rejects.toBeDefined();
    expect(chosen()).toBe('en');

    await sendChosenLanguage();
    expect(chosen()).toBeNull();
    expect(sent().at(-1)).toBe('en');
  });

  it('does not lose a newer choice made while the first was on its way', async () => {
    changeLanguage('ru');
    fetchMock.mockImplementationOnce(async () => {
      changeLanguage('en');
      return ok();
    });

    await sendChosenLanguage();

    expect(chosen()).toBe('en');
  });
});
