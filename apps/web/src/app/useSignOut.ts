import { useTranslation } from 'react-i18next';
import { useConfirm } from '@/components/ConfirmDialog';
import { useAuth } from '@/lib/auth';
import { outbox } from '@/lib/outbox';

/** Sign out, saying so first when this person's records are still on the phone. They wait for that person. */
export function useSignOut(): () => Promise<void> {
  const { t } = useTranslation('auth');
  const { logout } = useAuth();
  const confirm = useConfirm();

  return async () => {
    await outbox.load();
    const count = outbox.getState().records.length;
    const sure =
      count === 0 ||
      (await confirm({ title: t('signOut.unsentTitle', { count }), description: t('signOut.unsentBody'), confirmLabel: t('twoFactor.signOutInstead'), destructive: true }));
    if (sure) await logout();
  };
}
