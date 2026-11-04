import { todayIso } from '@yap/shared';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog, TextField } from '@/components';
import { apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { zDate, zOptionalText, zRef } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import type { HerdLookup } from './shared';

const schema = z.object({ toHerdId: zRef(), date: zDate(), reason: zOptionalText(300) });
type Values = z.output<typeof schema>;

export interface TransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** These animals; or `fromHerdId` to move everything in a herd. */
  animalIds?: string[];
  fromHerdId?: string;
  /** Shown in the description: how many animals are about to move. */
  count: number;
  onDone?: () => void;
}

export function TransferDialog({ open, onOpenChange, animalIds, fromHerdId, count, onDone }: TransferDialogProps) {
  const { t } = useTranslation('livestock');
  const move = useApiMutation<Values, { moved: number }>({
    mutationFn: (values) => api.post('/livestock/transfers', { ...values, animalIds, fromHerdId }),
    invalidate: ['/livestock/animals', '/livestock/herds', '/livestock/summary'],
    silentError: true,
    onSuccess: (result) => {
      toast.success(t('transfer.done', { count: result.moved }));
      onDone?.();
    },
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('transfer.title')}
      description={t('transfer.description', { count })}
      schema={schema}
      defaultValues={{ toHerdId: '', date: todayIso(), reason: '' }}
      onSubmit={(values) => move.mutateAsync(values)}
      submitLabel={t('transfer.submit')}
    >
      {(form) => (
        <>
          <ComboboxField
            form={form}
            name="toHerdId"
            label={t('transfer.toHerd')}
            required
            loadOptions={apiOptions<HerdLookup>('/livestock/herds/lookup', (h) => ({ value: h.id, label: h.name, hint: t('head', { count: h.headCount }) }))}
          />
          <DateField form={form} name="date" label={t('fields.date')} required max={todayIso()} />
          <TextField form={form} name="reason" label={t('transfer.reason')} hint={t('transfer.reasonHint')} />
        </>
      )}
    </FormDialog>
  );
}
