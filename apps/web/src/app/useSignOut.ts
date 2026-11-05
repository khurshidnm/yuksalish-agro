import { useTranslation } from 'react-i18next';
import { useConfirm } from '@/components/ConfirmDialog';
import { signOutWarning } from '@/features/today/logic';
import { useAuth } from '@/lib/auth';
import { outbox, serverAnswers } from '@/lib/outbox';

/**
 * Sign out, saying so first when this person's records are still on the phone, where they wait for that person,
 * or when there is no signal, because signing in needs the server and nobody could get back in here.
 */
export function useSignOut(): () => Promise<void> {
  const { t } = useTranslation('auth');
  const { logout } = useAuth();
  const confirm = useConfirm();

  return async () => {
    await outbox.load();
    const count = outbox.getState().records.length;
    const warning = signOutWarning(count, !(await serverAnswers()));
    const sure =
      warning === null ||
      (await confirm({
        title: t(warning.title, { count }),
        description: warning.body.map((key) => t(key)).join(' '),
        confirmLabel: t('twoFactor.signOutInstead'),
        destructive: true,
      }));
    if (sure) await logout();
  };
}
