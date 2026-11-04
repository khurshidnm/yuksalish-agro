import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { FormDialog } from '@/components/FormDialog';
import { FormField } from '@/components/FormField';
import { PasswordInput } from '@/components/ui';
import { api } from '@/lib/api';
import i18n from '@/lib/i18n';

const schema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
    confirm: z.string().min(1),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], error: () => i18n.t('auth:password.mismatch') });

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('auth:password.title')}
      schema={schema}
      size="sm"
      defaultValues={{ currentPassword: '', newPassword: '', confirm: '' }}
      submitLabel={t('auth:password.submit')}
      successMessage="auth:password.changed"
      onSubmit={({ currentPassword, newPassword }) => api.post('/auth/change-password', { currentPassword, newPassword })}
    >
      {(form) => (
        <>
          <FormField form={form} name="currentPassword" label={t('auth:password.current')}>
            {(field) => <PasswordInput {...field} autoComplete="current-password" value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value)} />}
          </FormField>
          <FormField form={form} name="newPassword" label={t('auth:password.new')} hint={t('auth:password.hint')}>
            {(field) => <PasswordInput {...field} autoComplete="new-password" value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value)} />}
          </FormField>
          <FormField form={form} name="confirm" label={t('auth:password.confirm')}>
            {(field) => <PasswordInput {...field} autoComplete="new-password" value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value)} />}
          </FormField>
        </>
      )}
    </FormDialog>
  );
}
