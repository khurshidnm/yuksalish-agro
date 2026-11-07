import type { ReactNode } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { FormField } from '@/components/FormField';
import { PasswordInput } from '@/components/ui';
import i18n from '@/lib/i18n';

/** The server decides what counts as too easy to guess. This catches only what needs no round trip. */
export const passwordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(10),
    confirm: z.string().min(1),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], error: () => i18n.t('auth:password.mismatch') });

export const emptyPasswords = { currentPassword: '', newPassword: '', confirm: '' };

type PasswordForm = UseFormReturn<z.input<typeof passwordSchema>, unknown, z.output<typeof passwordSchema>>;

export function PasswordFields({ form, currentLabel }: { form: PasswordForm; currentLabel: ReactNode }) {
  const { t } = useTranslation();
  return (
    <>
      <FormField form={form} name="currentPassword" label={currentLabel}>
        {(field) => <PasswordInput {...field} autoComplete="current-password" value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value)} />}
      </FormField>
      <FormField form={form} name="newPassword" label={t('auth:password.new')} hint={t('auth:password.hint')}>
        {(field) => <PasswordInput {...field} autoComplete="new-password" value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value)} />}
      </FormField>
      <FormField form={form} name="confirm" label={t('auth:password.confirm')}>
        {(field) => <PasswordInput {...field} autoComplete="new-password" value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value)} />}
      </FormField>
    </>
  );
}
