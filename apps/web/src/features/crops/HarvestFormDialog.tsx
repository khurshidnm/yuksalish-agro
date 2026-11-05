import { todayIso } from '@yap/shared';
import { useState } from 'react';
import { type UseFormReturn, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog, FormGrid, NumberField, TextField, TextareaField } from '@/components';
import { Alert, Separator } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { zDate, zOptionalNumber, zOptionalRef, zOptionalText, zPositive, zRef } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import {
  AFFECTED_BY_WORK,
  type FieldOption,
  HARVESTS,
  type ItemOption,
  assetOptions,
  employeeOptions,
  fieldOptions,
  itemOptions,
  warehouseOptions,
} from './options';
import type { Harvest, Operation } from './types';

const schema = z.object({
  fieldId: zRef(),
  date: zDate(),
  grossT: zPositive(),
  moisturePct: zOptionalNumber(),
  quality: zOptionalText(120),
  assetId: zOptionalRef(),
  employeeId: zOptionalRef(),
  areaDoneHa: zOptionalNumber(),
  itemId: zOptionalRef(),
  warehouseId: zOptionalRef(),
  stockQty: zOptionalNumber(),
  notes: zOptionalText(1000),
});

type Values = z.input<typeof schema>;

const loadProducts = itemOptions();

interface HarvestFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  harvest?: Harvest | null;
  /** A planned harvest from the journal that this record closes. */
  planned?: Operation | null;
}

export function HarvestFormDialog({ open, onOpenChange, harvest, planned }: HarvestFormDialogProps) {
  const { t } = useTranslation('crops');
  const [unit, setUnit] = useState<string | null>(harvest?.unit ?? null);
  const needsCount = unit !== null && unit !== 'kg' && unit !== 't';

  const save = useApiMutation<z.output<typeof schema>, Harvest>({
    mutationFn: (values) =>
      harvest
        ? api.patch<Harvest>(`${HARVESTS}/${harvest.id}`, {
            date: values.date,
            grossT: values.grossT,
            moisturePct: values.moisturePct,
            quality: values.quality,
            assetId: values.assetId,
            employeeId: values.employeeId,
            areaDoneHa: values.areaDoneHa,
            notes: values.notes,
            ...(values.stockQty ? { stockQty: values.stockQty } : {}),
          })
        : api.postOnce<Harvest>(HARVESTS, { ...values, operationId: planned?.id ?? null }),
    invalidate: AFFECTED_BY_WORK,
    silentError: true,
    onSuccess: (result) => {
      if (result.withdrawalWarning) {
        toast.warning(t('harvests.withdrawalWarning', { date: formatDate(result.withdrawalWarning.safeFrom) }), { duration: 12_000 });
      }
    },
  });

  const defaults: Values = {
    fieldId: harvest?.fieldId ?? planned?.fieldId ?? '',
    date: harvest?.date ?? todayIso(),
    grossT: harvest?.grossT ?? (undefined as unknown as number),
    moisturePct: harvest?.moisturePct ?? null,
    quality: harvest?.quality ?? '',
    assetId: harvest?.assetId ?? planned?.assetId ?? null,
    employeeId: harvest?.employeeId ?? planned?.employeeId ?? null,
    areaDoneHa: harvest?.areaDoneHa ?? planned?.areaDoneHa ?? null,
    itemId: harvest?.itemId ?? null,
    warehouseId: harvest?.warehouseId ?? null,
    stockQty: null,
    notes: harvest?.notes ?? '',
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={harvest ? t('harvests.edit') : t('harvests.add')}
      description={harvest ? undefined : t('harvests.formHint')}
      schema={schema}
      defaultValues={defaults}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={harvest ? 'common:toast.updated' : 'common:toast.created'}
      size="lg"
    >
      {(form) => (
        <>
          <FormGrid>
            <ComboboxField
              form={form}
              name="fieldId"
              label={t('operations.fields.field')}
              required
              disabled={Boolean(harvest || planned)}
              loadOptions={fieldOptions}
              selectedLabel={harvest ? `№${harvest.fieldNumber}` : planned ? `№${planned.fieldNumber}` : undefined}
              onSelect={(_, option) => {
                const field = option?.raw as FieldOption | undefined;
                if (field) form.setValue('areaDoneHa', field.areaHa);
              }}
            />
            <DateField form={form} name="date" label={t('operations.fields.date')} required />
            <NumberField form={form} name="grossT" label={t('harvests.fields.grossT')} suffix={t('unit.tons')} required />
            <NumberField form={form} name="moisturePct" label={t('harvests.fields.moisture')} suffix="%" />
            <NumberField form={form} name="areaDoneHa" label={t('operations.fields.area')} suffix={t('unit.ha')} />
            <TextField form={form} name="quality" label={t('harvests.fields.quality')} />
          </FormGrid>
          <ComboboxField form={form} name="assetId" label={t('operations.fields.machine')} loadOptions={assetOptions} selectedLabel={harvest?.assetName} clearable />
          <ComboboxField form={form} name="employeeId" label={t('operations.fields.responsible')} loadOptions={employeeOptions} selectedLabel={harvest?.employeeName} clearable />
          <Separator />
          <p className="text-sm font-medium">{t('harvests.receipt')}</p>
          {harvest?.batchId ? (
            <>
              <Alert tone="info">{t('harvests.receivedInto', { warehouse: harvest.warehouseName, item: harvest.itemName })}</Alert>
              {needsCount && <NumberField form={form} name="stockQty" label={t('harvests.fields.stockQty')} required />}
            </>
          ) : (
            <Destination form={form} harvest={harvest} needsCount={needsCount} onUnit={setUnit} />
          )}
          <TextareaField form={form} name="notes" label={t('operations.fields.notes')} />
        </>
      )}
    </FormDialog>
  );
}

function Destination({
  form,
  harvest,
  needsCount,
  onUnit,
}: {
  form: UseFormReturn<Values, unknown, z.output<typeof schema>>;
  harvest?: Harvest | null;
  needsCount: boolean;
  onUnit: (unit: string | null) => void;
}) {
  const { t } = useTranslation('crops');
  const itemId = useWatch({ control: form.control, name: 'itemId' });
  return (
    <>
      <p className="text-sm text-muted-foreground">{t('harvests.receiptHint')}</p>
      <FormGrid>
        <ComboboxField
          form={form}
          name="itemId"
          label={t('harvests.fields.item')}
          loadOptions={loadProducts}
          selectedLabel={harvest?.itemName}
          clearable
          onSelect={(_, option) => {
            const item = option?.raw as ItemOption | undefined;
            onUnit(item?.unit ?? null);
            if (item?.defaultWarehouseId) form.setValue('warehouseId', item.defaultWarehouseId, { shouldValidate: true });
          }}
        />
        <ComboboxField
          form={form}
          name="warehouseId"
          label={t('operations.materials.warehouse')}
          required={Boolean(itemId)}
          loadOptions={warehouseOptions}
          selectedLabel={harvest?.warehouseName}
          clearable
        />
      </FormGrid>
      {needsCount && <NumberField form={form} name="stockQty" label={t('harvests.fields.stockQty')} required />}
    </>
  );
}
