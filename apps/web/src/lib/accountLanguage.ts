import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { useSession } from './auth';
import { CHOSEN_LANGUAGE_KEY } from './i18n';
import { storageGet, storageRemove } from './utils';

/**
 * Telegram has no screen, so it speaks the account's language. A language picked by hand goes to
 * the account; one picked on the sign-in page or offline waits in storage until it can.
 */
export async function sendChosenLanguage(): Promise<void> {
  const language = storageGet(CHOSEN_LANGUAGE_KEY);
  if (!language) return;
  await api.put('/notifications/language', { language });
  // A newer choice made while this one travelled still has to go.
  if (storageGet(CHOSEN_LANGUAGE_KEY) === language) storageRemove(CHOSEN_LANGUAGE_KEY);
}

export function useAccountLanguage(): void {
  const { i18n } = useTranslation();
  const inWorkspace = Boolean(useSession().tenant);
  useEffect(() => {
    if (inWorkspace) sendChosenLanguage().catch(() => {});
  }, [inWorkspace, i18n.language]);
}
