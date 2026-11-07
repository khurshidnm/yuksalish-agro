import { ASSET_STATUSES, ASSET_TYPES, CURRENCIES, DEPRECIATION_METHODS, toBaseAmount } from '@yap/shared';
import { type UseFormReturn, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog, FormGrid, NumberField, SelectField, SwitchField, TextField, TextareaField } from '@/components';
import { Separator, apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission, useSession } from '@/lib/auth';
import { formatMoney } from '@/lib/format';
import { zEnum, zOptionalDate, zOptionalEnum, zOptionalNumber, zOptionalRef, zOptionalText, zText } from '@/lib/forms';
import i18n, { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { priceBody } from './assetPrice';
import { depreciationGaps } from './depreciationGaps';
import type { Asset } from './types';

const PATH = '/assets';
const RENTAL_UNITS = ['ha', 'hour', 'day'] as const;

const contractorOptions = apiOptions<{ id: string; name: string }>('/finance/counterparties/lookup', (c) => ({ value: c.id, label: c.name }));

const schema = z
  .object({
    name: zText(200),
    type: zEnum(ASSET_TYPES),
    status: zEnum(ASSET_STATUSES),
    inventoryNo: zOptionalText(60),
    purchaseDate: zOptionalDate(),
    purchasePrice: zOptionalNumber(),
    purchaseCurrency: zEnum(CURRENCIES),
    purchaseFxRate: zOptionalNumber(),
    salvageValue: zOptionalNumber(),
    usefulLifeMonths: zOptionalNumber(),
    depreciationMethod: zEnum(DEPRECIATION_METHODS),
    totalUnits: zOptionalNumber(),
    openingDepreciation: zOptionalNumber(),
    openingDepreciationDate: zOptionalDate(),
    motoHours: zOptionalNumber(),
    fuelNormLPerHour: zOptionalNumber(),
    fuelNormLPerHa: zOptionalNumber(),
    rented: z.boolean(),
    rentalCounterpartyId: zOptionalRef(),
    rentalPrice: zOptionalNumber(),
    rentalUnit: zOptionalEnum(RENTAL_UNITS),
    notes: zOptionalText(1000),
  })
  .superRefine((v, ctx) => {
    if (!v.rented && v.openingDepreciation && !v.openingDepreciationDate) {
      ctx.addIssue({ code: 'custom', path: ['openingDepreciationDate'], message: i18n.t('common:validation.required') });
    }
    for (const gap of depreciationGaps(v)) ctx.addIssue({ code: 'custom', path: [gap], message: i18n.t(`assets:depreciation.gap.${gap}`) });
  });

type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;
type Form = UseFormReturn<Values, unknown, Output>;

const MONEY_KEYS = ['purchasePrice', 'purchaseAmount', 'purchaseCurrency', 'purchaseFxRate', 'salvageValue', 'rentalPrice', 'openingDepreciation', 'openingDepreciationDate'] as const;

function OwnershipFields({ form, seesMoney }: { form: Form; seesMoney: boolean }) {
  const { t } = useTranslation('assets');
  const rented = useWatch({ control: form.control, name: 'rented' });
  const method = useWatch({ control: form.control, name: 'depreciationMethod' });
  const price = useWatch({ control: form.control, name: 'purchasePrice' });
  const currency = useWatch({ control: form.control, name: 'purchaseCurrency' });
  const rate = useWatch({ control: form.control, name: 'purchaseFxRate' });
  const priced = Boolean(price);
  const baseCurrency = useSession().tenant?.currency ?? 'UZS';
  const foreign = currency !== baseCurrency;
  // Salvage and opening depreciation stay in the base currency, so the figure they are held against is shown.
  const baseSuffix = foreign ? baseCurrency : undefined;

  if (rented) {
    return (
      <>
        <ComboboxField form={form} name="rentalCounterpartyId" label={t('fields.contractor')} loadOptions={contractorOptions} clearable />
        <FormGrid>
          {seesMoney && <NumberField money form={form} name="rentalPrice" label={t('fields.rentalPrice')} />}
          <SelectField
            form={form}
            name="rentalUnit"
            label={t('fields.rentalUnit')}
            placeholder={t('common:form.selectPlaceholder')}
            options={RENTAL_UNITS.map((value) => ({ value, label: t(`rentalUnit.${value}`) }))}
          />
        </FormGrid>
      </>
    );
  }
  return (
    <FormGrid>
      <DateField form={form} name="purchaseDate" label={t('fields.purchaseDate')} required={priced} />
      {seesMoney && (
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <NumberField money form={form} name="purchasePrice" label={t('fields.purchasePrice')} />
          <SelectField form={form} name="purchaseCurrency" label={t('fields.currency')} options={enumOptions('currency', CURRENCIES)} />
        </div>
      )}
      {seesMoney && foreign && (
        <NumberField
          money
          form={form}
          name="purchaseFxRate"
          label={t('fields.fxRate')}
          hint={price && rate ? t('fields.inBase', { amount: formatMoney(toBaseAmount(Number(price), Number(rate))) }) : t('fields.fxHint')}
          maxDigits={4}
        />
      )}
      {seesMoney && <NumberField money form={form} name="salvageValue" label={t('fields.salvageValue')} hint={t('fields.salvageHint')} suffix={baseSuffix} />}
      <SelectField form={form} name="depreciationMethod" label={t('fields.depreciationMethod')} options={enumOptions('depreciationMethod', DEPRECIATION_METHODS)} />
      {method === 'units' ? (
        <NumberField form={form} name="totalUnits" label={t('fields.totalUnits')} suffix={t('unit.hours')} hint={t('fields.totalUnitsHint')} required={priced} />
      ) : (
        <NumberField form={form} name="usefulLifeMonths" label={t('fields.usefulLife')} suffix={t('unit.months')} maxDigits={0} required={priced} />
      )}
      {seesMoney && <NumberField money form={form} name="openingDepreciation" label={t('fields.openingDepreciation')} hint={t('fields.openingDepreciationHint')} suffix={baseSuffix} />}
      {seesMoney && <DateField form={form} name="openingDepreciationDate" label={t('fields.openingDepreciationDate')} hint={t('fields.openingDepreciationDateHint')} />}
    </FormGrid>
  );
}

interface AssetFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset?: Asset | null;
}

export function AssetFormDialog({ open, onOpenChange, asset }: AssetFormDialogProps) {
  const { t } = useTranslation('assets');
  const seesMoney = usePermission('finance.view');
  const baseCurrency = useSession().tenant?.currency ?? 'UZS';

  const save = useApiMutation<Output>({
    mutationFn: ({ motoHours, salvageValue, openingDepreciation, ...values }) => {
      const body: Record<string, unknown> = { ...values, ...priceBody(values, baseCurrency), salvageValue: salvageValue ?? 0, openingDepreciation: openingDepreciation ?? 0, motoHours: motoHours ?? 0 };
      // Hidden fields come back empty: sending them would erase values this user cannot see.
      if (!seesMoney) for (const key of MONEY_KEYS) delete body[key];
      return asset ? api.patch(`${PATH}/${asset.id}`, body) : api.postOnce(PATH, body);
    },
    invalidate: [PATH],
    silentError: true,
  });

  const defaults: Values = {
    name: asset?.name ?? '',
    type: (asset?.type as Values['type']) ?? 'tractor',
    status: (asset?.status as Values['status']) ?? 'working',
    inventoryNo: asset?.inventoryNo ?? '',
    purchaseDate: asset?.purchaseDate ?? '',
    purchasePrice: asset?.purchaseAmount ?? asset?.purchasePrice ?? null,
    purchaseCurrency: (asset?.purchaseCurrency ?? baseCurrency) as Values['purchaseCurrency'],
    purchaseFxRate: asset?.purchaseFxRate ?? null,
    salvageValue: asset?.salvageValue ?? null,
    usefulLifeMonths: asset?.usefulLifeMonths ?? null,
    depreciationMethod: (asset?.depreciationMethod as Values['depreciationMethod']) ?? 'straight_line',
    totalUnits: asset?.totalUnits ?? null,
    openingDepreciation: asset?.openingDepreciation ?? null,
    openingDepreciationDate: asset?.openingDepreciationDate ?? '',
    motoHours: asset?.motoHours ?? null,
    fuelNormLPerHour: asset?.fuelNormLPerHour ?? null,
    fuelNormLPerHa: asset?.fuelNormLPerHa ?? null,
    rented: asset?.rented ?? false,
    rentalCounterpartyId: asset?.rentalCounterpartyId ?? null,
    rentalPrice: asset?.rentalPrice ?? null,
    rentalUnit: asset?.rentalUnit ?? null,
    notes: asset?.notes ?? '',
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={asset ? t('edit') : t('add')}
      schema={schema}
      defaultValues={defaults}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={asset ? 'common:toast.updated' : 'common:toast.created'}
      size="lg"
    >
      {(form) => (
        <>
          <TextField form={form} name="name" label={t('fields.name')} required autoFocus />
          <FormGrid>
            <SelectField form={form} name="type" label={t('fields.type')} required options={enumOptions('assetType', ASSET_TYPES)} />
            <TextField form={form} name="inventoryNo" label={t('fields.inventoryNo')} />
            <SelectField form={form} name="status" label={t('fields.status')} options={enumOptions('assetStatus', ASSET_STATUSES)} />
            <NumberField form={form} name="motoHours" label={t('fields.motoHours')} suffix={t('unit.hours')} hint={t('fields.motoHoursHint')} />
            <NumberField form={form} name="fuelNormLPerHour" label={t('fields.fuelNormHour')} suffix={t('unit.lPerHour')} />
            <NumberField form={form} name="fuelNormLPerHa" label={t('fields.fuelNormHa')} suffix={t('unit.lPerHa')} />
          </FormGrid>
          <Separator />
          <SwitchField form={form} name="rented" label={t('fields.rented')} hint={t('fields.rentedHint')} />
          <OwnershipFields form={form} seesMoney={seesMoney} />
          <TextareaField form={form} name="notes" label={t('fields.notes')} />
        </>
      )}
    </FormDialog>
  );
}
