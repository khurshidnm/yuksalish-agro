import { todayIso } from '@yap/shared';
import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog, FormGrid, SelectField, Separator, TextareaField, apiOptions } from '@/components';
import { useCenterName } from '@/features/finance/lib';
import { api } from '@/lib/api';
import { zDate, zEnum, zOptionalText, zPositive, zRef } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import i18n from '@/lib/i18n';
import { EMPTY_LINE, QtyLines, STOCK_PATHS, downloadDocument, useWarehouseOptions } from './shared';
import type { DocumentResult } from './types';

export const ISSUE_REASONS = ['ration', 'field_operation', 'fuel', 'treatment', 'repair', 'write_off', 'manual'] as const;

const schema = z.object({
  warehouseId: zRef(),
  date: zDate(),
  costCenterId: zRef(),
  // Starts empty: the storekeeper names the purpose, which the requisition prints.
  reason: z.string().min(1).pipe(zEnum(ISSUE_REASONS)),
  notes: zOptionalText(1000),
  lines: z.array(z.object({ itemId: zRef(), unit: z.string().nullish(), qty: zPositive() })).min(1),
});

type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

interface CostCenterOption {
  id: string;
  name: string;
  type: string;
}

function Fields({ form }: { form: UseFormReturn<FormIn, unknown, FormOut> }) {
  const { t } = useTranslation('inventory');
  const centerName = useCenterName();
  const warehouses = useWarehouseOptions();
  const warehouseId = form.watch('warehouseId');

  return (
    <>
      <FormGrid>
        <SelectField form={form} name="warehouseId" label={t('document.warehouse')} required options={warehouses} />
        <DateField form={form} name="date" label={t('document.date')} required max={todayIso()} />
      </FormGrid>
      <ComboboxField
        form={form}
        name="costCenterId"
        label={t('issue.costCenter')}
        hint={t('issue.costCenterHint')}
        required
        loadOptions={apiOptions<CostCenterOption>('/finance/cost-centers/lookup', (c) => ({
          value: c.id,
          label: centerName(c.name, c.type),
          // The farm-wide center's label already is its type.
          hint: c.type === 'general' ? undefined : i18n.t(`enums:costCenterType.${c.type}`),
        }))}
      />
      <SelectField
        form={form}
        name="reason"
        label={t('issue.reason')}
        required
        options={ISSUE_REASONS.map((value) => ({ value, label: t(`reason.${value}`) }))}
      />
      <Separator />
      <QtyLines form={form} warehouseId={warehouseId} />
      <TextareaField form={form} name="notes" label={t('document.notes')} rows={2} />
    </>
  );
}

export function IssueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('inventory');
  const mutation = useApiMutation<FormOut, DocumentResult>({
    mutationFn: ({ lines, ...values }) =>
      api.postOnce('/inventory/issues', { ...values, lines: lines.map(({ itemId, qty }) => ({ itemId, qty })) }),
    invalidate: STOCK_PATHS,
    silentError: true,
    onSuccess: (result) =>
      toast.success(t('issue.done', { docNo: result.docNo }), {
        action: { label: t('document.pdf'), onClick: () => void downloadDocument(result.docNo) },
      }),
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('issue.title')}
      description={t('issue.description')}
      schema={schema}
      defaultValues={{ warehouseId: '', date: todayIso(), costCenterId: '', reason: '', notes: '', lines: [EMPTY_LINE] }}
      onSubmit={(values) => mutation.mutateAsync(values)}
      submitLabel={t('issue.submit')}
      size="lg"
    >
      {(form) => <Fields form={form} />}
    </FormDialog>
  );
}
