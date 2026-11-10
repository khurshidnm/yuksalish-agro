import { PHYSIOLOGICAL_STATES } from '@yap/shared';
import { useFieldArray, type UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, FormDialog, FormGrid, NumberField, SelectField, Separator, TextField, TextareaField } from '@/components';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { zEnum, zOptionalText, zPositive, zRef, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { LineCard, LinesSection, itemOptions } from '../inventory/shared';
import { RationDraftBalance } from './NutrientBalance';
import type { Ration } from './types';

const schema = z.object({
  name: zText(120),
  state: zEnum(PHYSIOLOGICAL_STATES),
  notes: zOptionalText(1000),
  lines: z.array(z.object({ itemId: zRef(), itemName: z.string().nullish(), kgPerHeadDay: zPositive() })).min(1),
});

type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

/** The amount stays blank until typed, and zod reports it as required on submit. */
const EMPTY_LINE = { itemId: '' } as FormIn['lines'][number];

function Fields({ form, rationId }: { form: UseFormReturn<FormIn, unknown, FormOut>; rationId?: string }) {
  const { t } = useTranslation('feed');
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lines' });
  const lines = form.watch('lines');
  const total = lines.reduce((sum, line) => sum + (line?.kgPerHeadDay ?? 0), 0);

  return (
    <>
      <FormGrid>
        <TextField form={form} name="name" label={t('rations.fields.name')} required autoFocus />
        <SelectField form={form} name="state" label={t('rations.fields.state')} hint={t('rations.fields.stateHint')} required options={enumOptions('physiologicalState', PHYSIOLOGICAL_STATES)} />
      </FormGrid>
      <Separator />
      <LinesSection
        addLabel={t('rations.addLine')}
        onAdd={() => append(EMPTY_LINE)}
        rows={fields.map((field, index) => (
          <LineCard key={field.id} index={index} canRemove={fields.length > 1} onRemove={() => remove(index)}>
            {/* Feed and amount on one row from tablets up, so an eight-feed ration fits without long scrolling. */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <ComboboxField
                form={form}
                name={`lines.${index}.itemId`}
                label={t('rations.fields.feed')}
                required
                clearable={false}
                loadOptions={itemOptions({ category: 'feed' })}
                selectedLabel={lines[index]?.itemName}
                emptyText={t('rations.noFeeds')}
              />
              <NumberField form={form} name={`lines.${index}.kgPerHeadDay`} label={t('rations.fields.amount')} required suffix={t('rations.perHeadDay')} maxDigits={4} />
            </div>
          </LineCard>
        ))}
      />
      <p className="text-right font-medium">{t('rations.total', { kg: formatNumber(total, 3) })}</p>
      <RationDraftBalance rationId={rationId} state={form.watch('state')} lines={lines} />
      <TextareaField form={form} name="notes" label={t('rations.fields.notes')} rows={2} />
    </>
  );
}

export function RationDialog({ open, ration, onOpenChange }: { open: boolean; ration: Ration | null; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('feed');
  const save = useApiMutation<FormOut>({
    mutationFn: ({ lines, ...values }) => {
      const body = { ...values, lines: lines.map(({ itemId, kgPerHeadDay }) => ({ itemId, kgPerHeadDay })) };
      return ration ? api.patch(`/feed/rations/${ration.id}`, body) : api.post('/feed/rations', body);
    },
    invalidate: ['/feed'],
    silentError: true,
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={ration ? t('rations.edit') : t('rations.add')}
      description={t('rations.dialogHint')}
      schema={schema}
      defaultValues={
        ration
          ? {
              name: ration.name,
              state: ration.state as FormIn['state'],
              notes: ration.notes ?? '',
              lines: ration.lines.map((line) => ({ itemId: line.itemId, itemName: line.itemName, kgPerHeadDay: line.kgPerHeadDay })),
            }
          : { name: '', state: 'pregnant', notes: '', lines: [EMPTY_LINE] }
      }
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={ration ? 'common:toast.updated' : 'common:toast.created'}
      size="lg"
    >
      {(form) => <Fields form={form} rationId={ration?.id} />}
    </FormDialog>
  );
}
