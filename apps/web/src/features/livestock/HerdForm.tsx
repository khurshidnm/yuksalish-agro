import { PHYSIOLOGICAL_STATES } from '@yap/shared';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, FormDialog, FormGrid, SelectField, TextField, TextareaField } from '@/components';
import { apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { zEnum, zOptionalRef, zOptionalText, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import type { HerdRow, LookupRow } from './shared';

const schema = z.object({
  name: zText(120),
  state: zEnum(PHYSIOLOGICAL_STATES),
  facilityId: zOptionalRef(),
  rationId: zOptionalRef(),
  notes: zOptionalText(1000),
});
type Output = z.output<typeof schema>;

export interface HerdFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  herd?: Pick<HerdRow, 'id' | 'name' | 'state' | 'facilityId' | 'rationId' | 'notes' | 'facilityName' | 'rationName'> | null;
}

export function HerdForm({ open, onOpenChange, herd }: HerdFormProps) {
  const { t } = useTranslation('livestock');
  const save = useApiMutation<Output>({
    mutationFn: (values) => (herd ? api.patch(`/livestock/herds/${herd.id}`, values) : api.post('/livestock/herds', values)),
    invalidate: ['/livestock/herds'],
    silentError: true,
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={herd ? t('herds.edit') : t('herds.add')}
      description={t('herds.formHint')}
      schema={schema}
      defaultValues={{
        name: herd?.name ?? '',
        state: (herd?.state as Output['state']) ?? 'maintenance',
        facilityId: herd?.facilityId ?? null,
        rationId: herd?.rationId ?? null,
        notes: herd?.notes ?? '',
      }}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={herd ? 'common:toast.updated' : 'common:toast.created'}
    >
      {(form) => (
        <>
          <TextField form={form} name="name" label={t('fields.name')} required autoFocus />
          <FormGrid>
            <SelectField form={form} name="state" label={t('herds.state')} required options={enumOptions('physiologicalState', PHYSIOLOGICAL_STATES)} />
            <ComboboxField
              form={form}
              name="facilityId"
              label={t('herds.facility')}
              clearable
              loadOptions={apiOptions<LookupRow>('/farm/facilities/lookup', (f) => ({ value: f.id, label: f.name }), { type: 'barn' })}
              selectedLabel={herd?.facilityName ?? undefined}
            />
          </FormGrid>
          <ComboboxField
            form={form}
            name="rationId"
            label={t('herds.ration')}
            hint={t('herds.rationHint')}
            clearable
            loadOptions={apiOptions<LookupRow>('/feed/rations', (r) => ({ value: r.id, label: r.name }))}
            selectedLabel={herd?.rationName ?? undefined}
          />
          <TextareaField form={form} name="notes" label={t('fields.notes')} />
        </>
      )}
    </FormDialog>
  );
}
