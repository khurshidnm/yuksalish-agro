import { useTranslation } from 'react-i18next';
import { FormDialog } from '@/components/FormDialog';
import { api } from '@/lib/api';
import { emptyPasswords, PasswordFields, passwordSchema } from './passwordFields';

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('auth:password.title')}
      schema={passwordSchema}
      size="sm"
      defaultValues={emptyPasswords}
      submitLabel={t('auth:password.submit')}
      successMessage="auth:password.changed"
      onSubmit={({ currentPassword, newPassword }) => api.post('/auth/change-password', { currentPassword, newPassword })}
    >
      {(form) => <PasswordFields form={form} currentLabel={t('auth:password.current')} />}
    </FormDialog>
  );
}
