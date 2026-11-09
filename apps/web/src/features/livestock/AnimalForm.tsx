import { ANIMAL_CATEGORIES, ANIMAL_ON_FARM_STATUSES, ANIMAL_ORIGINS, SEXES, todayIso } from '@yap/shared';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { CheckboxField, ComboboxField, DateField, FormDialog, FormGrid, NumberField, SelectField, TextField, TextareaField } from '@/components';
import { apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { currencyLabel } from '@/lib/format';
import { zEnum, zOptionalDate, zOptionalNumber, zOptionalRef, zOptionalText, zRef, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { categoryLabel } from './category';
import { type Animal, type HerdLookup, type LookupRow, type Species, useLocalName } from './shared';

const PATH = '/livestock/animals';

const schema = z
  .object({
    tag: zText(40),
    speciesId: zRef(),
    breedId: zOptionalRef(),
    sex: zEnum(SEXES),
    category: zEnum(ANIMAL_CATEGORIES),
    status: zEnum(ANIMAL_ON_FARM_STATUSES),
    origin: zEnum(ANIMAL_ORIGINS),
    birthDate: zOptionalDate(),
    birthDateEstimated: z.boolean(),
    purchaseDate: zOptionalDate(),
    purchasePrice: zOptionalNumber(),
    sellerId: zOptionalRef(),
    herdId: zOptionalRef(),
    currentWeightKg: zOptionalNumber(),
    rfid: zOptionalText(60),
    notes: zOptionalText(1000),
  })
  .superRefine((v, ctx) => {
    if (v.origin === 'born' && !v.birthDate) ctx.addIssue({ code: 'custom', path: ['birthDate'], message: 'required' });
    if (v.origin === 'purchased' && !v.purchaseDate) ctx.addIssue({ code: 'custom', path: ['purchaseDate'], message: 'required' });
  });

type FormValues = z.input<typeof schema>;
type Output = z.output<typeof schema>;

export interface AnimalFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editing this animal; empty registers a new one. */
  animal?: Animal | null;
  /** Herd to preselect when registering from a herd page. */
  herdId?: string;
}

export function AnimalForm({ open, onOpenChange, animal, herdId }: AnimalFormProps) {
  const { t } = useTranslation('livestock');
  const localName = useLocalName();
  const canSeeMoney = usePermission('finance.view');
  const { data: species = [], isLoading: speciesLoading } = useDetail<Species[]>(open ? '/livestock/species' : null);
  const sheep = species.find((s) => s.key === 'sheep') ?? species[0];

  const defaults: FormValues = animal
    ? {
        tag: animal.tag,
        speciesId: animal.speciesId,
        breedId: animal.breedId,
        sex: animal.sex,
        category: animal.category as FormValues['category'],
        status: (ANIMAL_ON_FARM_STATUSES as readonly string[]).includes(animal.status) ? (animal.status as FormValues['status']) : 'active',
        origin: animal.origin,
        birthDate: animal.birthDate ?? '',
        birthDateEstimated: animal.birthDateEstimated,
        purchaseDate: animal.purchaseDate ?? '',
        purchasePrice: animal.purchasePrice,
        sellerId: animal.sellerId,
        herdId: animal.herdId,
        currentWeightKg: null,
        rfid: '',
        notes: animal.notes ?? '',
      }
    : {
        tag: '',
        speciesId: sheep?.id ?? '',
        breedId: sheep?.breeds.find((b) => b.key === 'hisori')?.id ?? null,
        sex: 'female',
        category: 'ewe',
        status: 'active',
        origin: 'purchased',
        birthDate: '',
        birthDateEstimated: true,
        purchaseDate: todayIso(),
        purchasePrice: null,
        sellerId: null,
        herdId: herdId ?? null,
        currentWeightKg: null,
        rfid: '',
        notes: '',
      };

  const save = useApiMutation<Output>({
    mutationFn: (values) => {
      const { rfid, currentWeightKg, speciesId, origin, ...common } = values;
      // Money the user may not see stays out of the request, rather than being sent back as empty.
      const body = canSeeMoney ? common : { ...common, purchasePrice: undefined, sellerId: undefined };
      if (animal) return api.patch(`${PATH}/${animal.id}`, body);
      return api.postOnce(PATH, {
        ...body,
        speciesId,
        origin,
        currentWeightKg,
        identifiers: rfid ? [{ type: 'rfid', value: rfid }] : undefined,
      });
    },
    invalidate: [PATH, '/livestock/summary', '/livestock/herds'],
    silentError: true,
  });

  return (
    <FormDialog
      // The form takes its defaults as it opens, and the default species comes from this list.
      open={open && !speciesLoading}
      onOpenChange={onOpenChange}
      title={animal ? t('animals.edit') : t('animals.add')}
      schema={schema}
      defaultValues={defaults}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={animal ? 'common:toast.updated' : 'common:toast.created'}
      size="lg"
    >
      {(form) => {
        const origin = form.watch('origin');
        const speciesId = form.watch('speciesId');
        const chosen = species.find((s) => s.id === speciesId);
        const breeds = chosen?.breeds ?? [];
        return (
          <>
            <FormGrid>
              <TextField form={form} name="tag" label={t('fields.tag')} hint={t('animals.tagHint')} required autoFocus={!animal} />
              {!animal && <TextField form={form} name="rfid" label={t('fields.rfid')} hint={t('animals.rfidHint')} />}
              {!animal && (
                <SelectField
                  form={form}
                  name="speciesId"
                  label={t('fields.species')}
                  required
                  options={species.map((s) => ({ value: s.id, label: localName(s.name) }))}
                />
              )}
              <SelectField form={form} name="breedId" label={t('fields.breed')} options={breeds.map((b) => ({ value: b.id, label: localName(b.name) }))} />
              <SelectField form={form} name="sex" label={t('fields.sex')} required options={enumOptions('sex', SEXES)} />
              <SelectField form={form} name="category" label={t('fields.category')} required options={ANIMAL_CATEGORIES.map((value) => ({ value, label: categoryLabel(value, chosen?.key) }))} />
              <ComboboxField
                form={form}
                name="herdId"
                label={t('fields.herd')}
                clearable
                loadOptions={apiOptions<HerdLookup>('/livestock/herds/lookup', (h) => ({ value: h.id, label: h.name, hint: t('head', { count: h.headCount }) }))}
                selectedLabel={animal?.herdName ?? undefined}
              />
              {animal && <SelectField form={form} name="status" label={t('fields.status')} required options={enumOptions('animalStatus', ANIMAL_ON_FARM_STATUSES)} />}
              {!animal && <SelectField form={form} name="origin" label={t('fields.origin')} required options={enumOptions('animalOrigin', ANIMAL_ORIGINS)} />}
              <DateField form={form} name="birthDate" label={t('fields.birthDate')} required={origin === 'born'} />
            </FormGrid>
            <CheckboxField form={form} name="birthDateEstimated" label={t('fields.birthDateEstimated')} />
            {origin === 'purchased' && (
              <FormGrid>
                <DateField form={form} name="purchaseDate" label={t('fields.purchaseDate')} required />
                {canSeeMoney && <NumberField money form={form} name="purchasePrice" label={t('fields.purchasePrice')} suffix={currencyLabel()} />}
                {canSeeMoney && (
                  <ComboboxField
                    form={form}
                    name="sellerId"
                    label={t('fields.seller')}
                    clearable
                    loadOptions={apiOptions<LookupRow>('/finance/counterparties/lookup', (c) => ({ value: c.id, label: c.name }))}
                  />
                )}
              </FormGrid>
            )}
            {!animal && <NumberField form={form} name="currentWeightKg" label={t('fields.weight')} suffix={t('enums:unit.kg')} maxDigits={2} />}
            <TextareaField form={form} name="notes" label={t('fields.notes')} />
          </>
        );
      }}
    </FormDialog>
  );
}
