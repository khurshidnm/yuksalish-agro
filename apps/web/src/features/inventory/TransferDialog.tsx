import { todayIso } from '@yap/shared';
import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { DateField, FormDialog, FormGrid, SelectField, Separator, TextareaField } from '@/components';
import { api } from '@/lib/api';
import { zDate, zOptionalText, zPositive, zRef } from '@/lib/forms';
import i18n from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { EMPTY_LINE, QtyLines, STOCK_PATHS, downloadDocument, useWarehouseOptions } from './shared';
import type { DocumentResult } from './types';

const schema = z
  .object({
    fromWarehouseId: zRef(),
    toWarehouseId: zRef(),
    date: zDate(),
    notes: zOptionalText(1000),
    lines: z.array(z.object({ itemId: zRef(), unit: z.string().nullish(), qty: zPositive() })).min(1),
  })
  .refine((values) => values.fromWarehouseId !== values.toWarehouseId, {
    path: ['toWarehouseId'],
    error: () => i18n.t('inventory:errors.SAME_WAREHOUSE'),
  });

type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

function Fields({ form }: { form: UseFormReturn<FormIn, unknown, FormOut> }) {
  const { t } = useTranslation('inventory');
  const warehouses = useWarehouseOptions();
  const fromWarehouseId = form.watch('fromWarehouseId');

  return (
    <>
      <FormGrid>
        <SelectField form={form} name="fromWarehouseId" label={t('transfer.from')} required options={warehouses} />
        <SelectField form={form} name="toWarehouseId" label={t('transfer.to')} required options={warehouses} />
      </FormGrid>
      <DateField form={form} name="date" label={t('document.date')} required max={todayIso()} />
      <Separator />
      <QtyLines form={form} warehouseId={fromWarehouseId} />
      <TextareaField form={form} name="notes" label={t('document.notes')} rows={2} />
    </>
  );
}

export function TransferDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('inventory');
  const mutation = useApiMutation<FormOut, DocumentResult>({
    mutationFn: ({ lines, ...values }) =>
      api.postOnce('/inventory/transfers', { ...values, lines: lines.map(({ itemId, qty }) => ({ itemId, qty })) }),
    invalidate: STOCK_PATHS,
    silentError: true,
    onSuccess: (result) =>
      toast.success(t('transfer.done', { docNo: result.docNo }), {
        action: { label: t('document.pdf'), onClick: () => void downloadDocument(result.docNo) },
      }),
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('transfer.title')}
      description={t('transfer.description')}
      schema={schema}
      defaultValues={{ fromWarehouseId: '', toWarehouseId: '', date: todayIso(), notes: '', lines: [EMPTY_LINE] }}
      onSubmit={(values) => mutation.mutateAsync(values)}
      submitLabel={t('transfer.submit')}
      size="lg"
    >
      {(form) => <Fields form={form} />}
    </FormDialog>
  );
}
