import { HEALTH_RECORD_TYPES, todayIso } from '@yap/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog, FormGrid, NumberField, SelectField, TextField, TextareaField } from '@/components';
import { Alert, type ComboboxOption } from '@/components/ui';
import { api } from '@/lib/api';
import { zDate, zEnum, zOptionalDate, zOptionalNumber, zOptionalRef, zOptionalText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { AnimalPickerField } from '../ScanAnimal';
import { ANIMALS_PATH, HEALTH_PATH, animalOptions, drugOptions, employeeOptions, herdOptions, warehouseOptions } from './options';
import type { HealthRecord } from './types';

const PATH = `${HEALTH_PATH}/records`;

/** Quarantine has its own tab: it changes an animal's status and has an end. */
const FORM_TYPES = HEALTH_RECORD_TYPES.filter((type) => type !== 'quarantine');
const DRUG_TYPES: readonly string[] = ['vaccination', 'treatment', 'prophylaxis', 'deworming'];

const schema = z
  .object({
    type: zEnum(HEALTH_RECORD_TYPES),
    targetKind: zEnum(['animal', 'herd'] as const),
    animalId: zOptionalRef(),
    herdId: zOptionalRef(),
    date: zDate(),
    diagnosis: zOptionalText(300),
    itemId: zOptionalRef(),
    warehouseId: zOptionalRef(),
    dose: zOptionalNumber(),
    doseUnit: zOptionalText(20),
    qtyUsed: zOptionalNumber(),
    courseDays: zOptionalNumber(),
    headCount: zOptionalNumber(),
    withdrawalDays: zOptionalNumber(),
    vetEmployeeId: zOptionalRef(),
    vaccinationPlanId: zOptionalRef(),
    result: zOptionalText(300),
    nextDueDate: zOptionalDate(),
    notes: zOptionalText(1000),
  })
  .superRefine((value, ctx) => {
    const field = value.targetKind === 'animal' ? 'animalId' : 'herdId';
    if (!value[field]) ctx.addIssue({ code: 'custom', path: [field], message: 'required' });
  });

export interface RecordPreset {
  type?: (typeof HEALTH_RECORD_TYPES)[number];
  animalId?: string;
  animalTag?: string;
  herdId?: string;
  herdName?: string;
}

interface RecordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set when editing. */
  record?: HealthRecord | null;
  preset?: RecordPreset | null;
}

function defaults(record?: HealthRecord | null, preset?: RecordPreset | null): z.input<typeof schema> {
  return {
    type: (record?.type ?? preset?.type ?? 'treatment') as (typeof HEALTH_RECORD_TYPES)[number],
    targetKind: record?.herdId || preset?.herdId ? 'herd' : 'animal',
    animalId: record?.animalId ?? preset?.animalId ?? null,
    herdId: record?.herdId ?? preset?.herdId ?? null,
    date: record?.date ?? todayIso(),
    diagnosis: record?.diagnosis ?? '',
    itemId: record?.itemId ?? null,
    warehouseId: record?.warehouseId ?? null,
    dose: record?.dose ?? null,
    doseUnit: record?.doseUnit ?? '',
    qtyUsed: record?.qtyUsed ?? null,
    courseDays: record?.courseDays ?? null,
    headCount: record?.headCount ?? null,
    withdrawalDays: record?.withdrawalDays ?? null,
    vetEmployeeId: record?.vetEmployeeId ?? null,
    vaccinationPlanId: record?.vaccinationPlanId ?? null,
    result: record?.result ?? '',
    nextDueDate: record?.nextDueDate ?? '',
    notes: record?.notes ?? '',
  };
}

export function RecordDialog({ open, onOpenChange, record, preset }: RecordDialogProps) {
  const { t } = useTranslation('vet');
  const [unit, setUnit] = useState<string | null>(null);

  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: ({ targetKind, type, ...values }) => {
      const body = {
        ...values,
        animalId: targetKind === 'animal' ? values.animalId : null,
        herdId: targetKind === 'herd' ? values.herdId : null,
      };
      return record ? api.patch(`${PATH}/${record.id}`, body) : api.postOnce(PATH, { ...body, type });
    },
    // A record moves drugs out of stock, and withdrawal dates change what can be sold.
    invalidate: [HEALTH_PATH, ANIMALS_PATH, '/inventory'],
    silentError: true,
  });

  const onItem = (_value: string | null, option: ComboboxOption | null) => {
    setUnit((option?.raw as { unit?: string } | undefined)?.unit ?? null);
  };
  const unitLabel = unit ?? record?.itemUnit;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={record ? t('journal.edit') : t('journal.add')}
      schema={schema}
      defaultValues={defaults(record, preset)}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={record ? 'common:toast.updated' : 'common:toast.created'}
      size="lg"
    >
      {(form) => {
        const type = form.watch('type');
        const targetKind = form.watch('targetKind');
        const itemId = form.watch('itemId');
        const usesDrug = DRUG_TYPES.includes(type);
        const isCourse = type === 'treatment';
        return (
          <>
            <FormGrid>
              <SelectField form={form} name="type" label={t('journal.type')} required disabled={!!record} options={enumOptions('healthRecordType', FORM_TYPES)} />
              <DateField form={form} name="date" label={t('common.date')} required max={todayIso()} />
              <SelectField
                form={form}
                name="targetKind"
                label={t('journal.target')}
                required
                options={[
                  { value: 'animal', label: t('journal.oneAnimal') },
                  { value: 'herd', label: t('journal.wholeHerd') },
                ]}
              />
              {targetKind === 'animal' ? (
                <AnimalPickerField
                  form={form}
                  name="animalId"
                  label={t('common.animal')}
                  required
                  loadOptions={animalOptions()}
                  selectedLabel={record?.animalTag ?? preset?.animalTag}
                />
              ) : (
                <ComboboxField form={form} name="herdId" label={t('common.herd')} required loadOptions={herdOptions()} selectedLabel={record?.herdName ?? preset?.herdName} />
              )}
            </FormGrid>

            {type !== 'vaccination' && <TextField form={form} name="diagnosis" label={t('journal.diagnosis')} />}

            {usesDrug && (
              <>
                <FormGrid>
                  <ComboboxField form={form} name="itemId" label={t('journal.drug')} loadOptions={drugOptions} selectedLabel={record?.itemName} onSelect={onItem} />
                  {itemId ? <ComboboxField form={form} name="warehouseId" label={t('journal.warehouse')} loadOptions={warehouseOptions()} hint={t('journal.warehouseHint')} /> : null}
                </FormGrid>
                {itemId && (
                  <FormGrid>
                    <NumberField form={form} name="dose" label={t('journal.dose')} hint={t('journal.doseHint')} />
                    <TextField form={form} name="doseUnit" label={t('journal.doseUnit')} placeholder={unitLabel ? t(`enums:unit.${unitLabel}`) : undefined} />
                    <NumberField form={form} name="qtyUsed" label={t('journal.qtyUsed')} hint={t('journal.qtyUsedHint')} suffix={unitLabel ? t(`enums:unit.${unitLabel}`) : undefined} />
                    <NumberField form={form} name="withdrawalDays" label={t('journal.withdrawalDays')} hint={t('journal.withdrawalHint')} suffix={t('common.days')} maxDigits={0} />
                  </FormGrid>
                )}
              </>
            )}

            <FormGrid>
              {isCourse && <NumberField form={form} name="courseDays" label={t('journal.courseDays')} suffix={t('common.days')} maxDigits={0} />}
              {targetKind === 'herd' && <NumberField form={form} name="headCount" label={t('journal.headCount')} hint={t('journal.headCountHint')} maxDigits={0} />}
              <ComboboxField form={form} name="vetEmployeeId" label={t('journal.vet')} loadOptions={employeeOptions()} selectedLabel={record?.vetName} />
              {usesDrug && <DateField form={form} name="nextDueDate" label={t('journal.nextDue')} />}
            </FormGrid>

            {(type === 'treatment' || type === 'examination') && <TextField form={form} name="result" label={t('journal.result')} />}
            <TextareaField form={form} name="notes" label={t('common.notes')} />
            {record && itemId && <Alert tone="info">{t('journal.editStockNote')}</Alert>}
          </>
        );
      }}
    </FormDialog>
  );
}
