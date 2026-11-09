import { ANIMAL_EXIT_TYPES, PAYMENT_METHODS, todayIso } from '@yap/shared';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog, FormGrid, NumberField, SelectField, TextField, TextareaField } from '@/components';
import { apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { zDate, zEnum, zOptionalDate, zOptionalNumber, zOptionalRef, zOptionalText, zRef } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { PhotoPicker } from './PhotoPicker';
import { type AnimalLookup, type LookupRow, newClientId } from './shared';
import { accountLabel } from '@/features/finance/lib';

type ExitType = (typeof ANIMAL_EXIT_TYPES)[number];

const schema = z
  .object({
    animalId: zRef(),
    type: zEnum(ANIMAL_EXIT_TYPES),
    date: zDate(),
    liveWeightKg: zOptionalNumber(),
    carcassWeightKg: zOptionalNumber(),
    pricePerKg: zOptionalNumber(),
    amount: zOptionalNumber(),
    counterpartyId: zOptionalRef(),
    paymentMethod: zEnum(PAYMENT_METHODS),
    accountId: zOptionalRef(),
    dueDate: zOptionalDate(),
    meatItemId: zOptionalRef(),
    warehouseId: zOptionalRef(),
    reason: zOptionalText(500),
    vetConclusion: zOptionalText(1000),
    notes: zOptionalText(1000),
  })
  .superRefine((v, ctx) => {
    const require = (path: string, ok: unknown) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [path], message: 'required' });
    };
    if (v.type === 'sale') {
      require('counterpartyId', v.counterpartyId);
      if (v.paymentMethod !== 'debt') require('accountId', v.accountId);
      if (!v.amount) require(v.pricePerKg ? 'liveWeightKg' : 'pricePerKg', v.pricePerKg && v.liveWeightKg);
    }
    if (v.type === 'slaughter') {
      require('liveWeightKg', v.liveWeightKg);
      require('carcassWeightKg', v.carcassWeightKg);
      require('meatItemId', v.meatItemId);
      require('warehouseId', v.warehouseId);
    }
    if (v.type === 'death' || v.type === 'loss') require('reason', v.reason);
  });

type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

export interface ExitFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fixed when recording from an animal's card. */
  animal?: { id: string; tag: string; currentWeightKg: number | null };
  defaultType?: ExitType;
}

const PAYMENT_OPTIONS = PAYMENT_METHODS.filter((m) => m !== 'non_cash');

export function ExitForm({ open, onOpenChange, animal, defaultType }: ExitFormProps) {
  const { t } = useTranslation('livestock');
  const can = useCan();
  const photos = useRef<string[]>([]);
  const clientId = useRef(newClientId());

  // Each type is offered only to people who may record it; the server checks the same rule.
  const allowed = ANIMAL_EXIT_TYPES.filter((type) => {
    if (type === 'sale') return can('sales.create');
    if (type === 'slaughter') return can('livestock.update');
    return can('livestock.create');
  });

  const defaults: Values = {
    animalId: animal?.id ?? '',
    type: defaultType && allowed.includes(defaultType) ? defaultType : (allowed.find((a) => a === 'death') ?? allowed[0] ?? 'death'),
    date: todayIso(),
    liveWeightKg: animal?.currentWeightKg ?? null,
    carcassWeightKg: null,
    pricePerKg: null,
    amount: null,
    counterpartyId: null,
    paymentMethod: 'debt',
    accountId: null,
    dueDate: '',
    meatItemId: null,
    warehouseId: null,
    reason: '',
    vetConclusion: '',
    notes: '',
  };

  const save = useApiMutation<Output>({
    mutationFn: (values) =>
      api.postOnce('/livestock/exits', { ...values, id: clientId.current, photoFileIds: photos.current }),
    invalidate: ['/livestock/exits', '/livestock/animals', '/livestock/herds', '/livestock/summary'],
    silentError: true,
    onSuccess: () => {
      clientId.current = newClientId();
      photos.current = [];
    },
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={animal ? t('exits.addFor', { tag: animal.tag }) : t('exits.add')}
      schema={schema}
      defaultValues={defaults}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage="common:toast.saved"
      size="lg"
    >
      {(form) => {
        const type = form.watch('type');
        const method = form.watch('paymentMethod');
        const animalId = form.watch('animalId');
        return (
          <>
            <SelectField form={form} name="type" label={t('exits.type')} required options={enumOptions('animalExitType', allowed)} />
            {!animal && (
              <ComboboxField
                form={form}
                name="animalId"
                label={t('fields.animal')}
                required
                placeholder={t('exits.findAnimal')}
                loadOptions={apiOptions<AnimalLookup>('/livestock/animals/lookup', (a) => ({
                  value: a.id,
                  label: a.tag,
                  hint: t(`enums:animalCategory.${a.category}`),
                }))}
              />
            )}
            <DateField form={form} name="date" label={t('fields.date')} required max={todayIso()} />

            {type === 'sale' && (
              <>
                <ComboboxField
                  form={form}
                  name="counterpartyId"
                  label={t('exits.buyer')}
                  required
                  loadOptions={apiOptions<LookupRow>('/finance/counterparties/lookup', (c) => ({ value: c.id, label: c.name }))}
                />
                <FormGrid>
                  <NumberField form={form} name="liveWeightKg" label={t('exits.liveWeight')} suffix="kg" maxDigits={2} />
                  <NumberField money form={form} name="pricePerKg" label={t('exits.pricePerKg')} />
                </FormGrid>
                <NumberField money form={form} name="amount" label={t('exits.amount')} hint={t('exits.amountHint')} />
                <FormGrid>
                  <SelectField form={form} name="paymentMethod" label={t('exits.paymentMethod')} required options={enumOptions('paymentMethod', PAYMENT_OPTIONS)} />
                  {method === 'debt' ? (
                    <DateField form={form} name="dueDate" label={t('exits.dueDate')} />
                  ) : (
                    <ComboboxField
                      form={form}
                      name="accountId"
                      label={t('exits.account')}
                      required
                      loadOptions={apiOptions<LookupRow>('/finance/accounts/lookup', (a) => ({ value: a.id, label: accountLabel(a) }))}
                    />
                  )}
                </FormGrid>
              </>
            )}

            {type === 'slaughter' && (
              <>
                <FormGrid>
                  <NumberField form={form} name="liveWeightKg" label={t('exits.liveWeight')} suffix="kg" maxDigits={2} required />
                  <NumberField form={form} name="carcassWeightKg" label={t('exits.carcassWeight')} suffix="kg" maxDigits={2} required />
                  <ComboboxField
                    form={form}
                    name="meatItemId"
                    label={t('exits.meatItem')}
                    required
                    loadOptions={apiOptions<LookupRow>('/inventory/items/lookup', (i) => ({ value: i.id, label: i.name }), { category: 'product' })}
                  />
                  <ComboboxField
                    form={form}
                    name="warehouseId"
                    label={t('exits.warehouse')}
                    required
                    loadOptions={apiOptions<LookupRow>('/inventory/warehouses/lookup', (w) => ({ value: w.id, label: w.name }), { type: 'finished_goods' })}
                  />
                </FormGrid>
              </>
            )}

            {(type === 'death' || type === 'loss') && (
              <>
                <TextField form={form} name="reason" label={t('exits.reason')} required />
                {type === 'death' && <TextareaField form={form} name="vetConclusion" label={t('exits.vetConclusion')} />}
                <PhotoPicker key={animalId} onChange={(ids) => (photos.current = ids)} />
              </>
            )}

            <TextareaField form={form} name="notes" label={t('fields.notes')} />
          </>
        );
      }}
    </FormDialog>
  );
}
