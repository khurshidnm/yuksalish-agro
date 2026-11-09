import { MAINTENANCE_TYPES, todayIso } from '@yap/shared';
import { Plus, Trash2, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type UseFormReturn, useFieldArray, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, ComboboxField, DataTable, DateField, FormDialog, FormGrid, MoneyText, NumberField, SelectField, TextareaField, useConfirm } from '@/components';
import { Badge, Button, Separator, apiOptions } from '@/components/ui';
import { itemOptions, warehouseOptions } from '@/features/crops/options';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { currencyLabel, formatDate, formatNumber } from '@/lib/format';
import { zDate, zEnum, zOptionalDate, zOptionalEnum, zOptionalNumber, zOptionalRef, zOptionalText, zPositive, zRef } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import type { Maintenance } from './types';
import { accountLabel } from '@/features/finance/lib';

const PAYMENT_METHODS = ['cash', 'bank', 'card', 'debt'] as const;

const accountOptions = apiOptions<{ id: string; name: string | null }>('/finance/accounts/lookup', (a) => ({ value: a.id, label: accountLabel(a) }));
const counterpartyOptions = apiOptions<{ id: string; name: string }>('/finance/counterparties/lookup', (c) => ({ value: c.id, label: c.name }));

const schema = z.object({
  date: zDate(),
  type: zEnum(MAINTENANCE_TYPES),
  description: zOptionalText(1000),
  cost: zOptionalNumber(),
  nextDueDate: zOptionalDate(),
  nextDueMotoHours: zOptionalNumber(),
  downtimeHours: zOptionalNumber(),
  parts: z.array(z.object({ itemId: zRef(), warehouseId: zRef(), qty: zPositive() })),
  paymentMethod: zOptionalEnum(PAYMENT_METHODS),
  accountId: zOptionalRef(),
  counterpartyId: zOptionalRef(),
});

type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;
type Form = UseFormReturn<Values, unknown, Output>;

function PartsEditor({ form }: { form: Form }) {
  const { t } = useTranslation('assets');
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'parts' });
  const loadParts = useMemo(() => itemOptions('spare_part'), []);
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">{t('maintenance.parts')}</legend>
      {fields.map((row, index) => (
        <div key={row.id} className="space-y-3 rounded-lg border border-border p-3">
          <ComboboxField
            form={form}
            name={`parts.${index}.itemId`}
            label={t('maintenance.part')}
            required
            loadOptions={loadParts}
            onSelect={(_, option) => {
              const item = option?.raw as { defaultWarehouseId?: string | null } | undefined;
              if (item?.defaultWarehouseId) form.setValue(`parts.${index}.warehouseId`, item.defaultWarehouseId, { shouldValidate: true });
            }}
          />
          <FormGrid>
            <ComboboxField form={form} name={`parts.${index}.warehouseId`} label={t('maintenance.warehouse')} required loadOptions={warehouseOptions} />
            <NumberField form={form} name={`parts.${index}.qty`} label={t('maintenance.qty')} required />
          </FormGrid>
          <Button type="button" variant="ghost" className="text-destructive" onClick={() => remove(index)}>
            <Trash2 aria-hidden />
            {t('maintenance.removePart')}
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" className="w-full" onClick={() => append({ itemId: '', warehouseId: '', qty: 0 })}>
        <Plus aria-hidden />
        {t('maintenance.addPart')}
      </Button>
    </fieldset>
  );
}

function PaymentFields({ form }: { form: Form }) {
  const { t } = useTranslation('assets');
  const method = useWatch({ control: form.control, name: 'paymentMethod' });
  const cost = useWatch({ control: form.control, name: 'cost' });
  if (!cost) return null;
  return (
    <>
      <SelectField
        form={form}
        name="paymentMethod"
        label={t('maintenance.payment')}
        hint={t('maintenance.paymentHint')}
        placeholder={t('maintenance.noPayment')}
        options={enumOptions('paymentMethod', PAYMENT_METHODS)}
      />
      {method && method !== 'debt' && <ComboboxField form={form} name="accountId" label={t('maintenance.account')} required loadOptions={accountOptions} />}
      {method === 'debt' && <ComboboxField form={form} name="counterpartyId" label={t('maintenance.counterparty')} required loadOptions={counterpartyOptions} />}
    </>
  );
}

export function AssetMaintenanceTab({ assetId }: { assetId: string }) {
  const { t } = useTranslation('assets');
  const canCreate = usePermission('assets.create');
  const canDelete = usePermission('assets.delete');
  const seesMoney = usePermission('finance.view');
  const canPay = usePermission('finance.create');
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const path = `/assets/${assetId}/maintenance`;

  const save = useApiMutation<Output>({
    mutationFn: ({ paymentMethod, accountId, counterpartyId, cost, ...values }) =>
      api.postOnce(path, {
        ...values,
        ...(cost ? { cost } : {}),
        ...(paymentMethod ? { payment: { paymentMethod, accountId, counterpartyId } } : {}),
      }),
    invalidate: [`/assets/${assetId}`, '/assets', '/inventory', '/finance'],
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${path}/${id}`),
    invalidate: [`/assets/${assetId}`, '/assets', '/inventory'],
    successMessage: 'common:toast.deleted',
  });

  const addButton = canCreate && (
    <Button size="lg" onClick={() => setAdding(true)}>
      <Plus aria-hidden />
      {t('maintenance.add')}
    </Button>
  );

  const columns: Column<Maintenance>[] = [
    { key: 'date', header: t('maintenance.date'), sortable: true, mobile: 'title', cell: (row) => formatDate(row.date) },
    { key: 'type', header: t('maintenance.type'), mobile: 'subtitle', cell: (row) => <Badge>{t(`enums:maintenanceType.${row.type}`)}</Badge> },
    { key: 'description', header: t('maintenance.description'), cell: (row) => row.description ?? '—' },
    {
      key: 'next',
      header: t('maintenance.next'),
      mobile: 'hidden',
      cell: (row) => {
        const parts = [row.nextDueDate ? formatDate(row.nextDueDate) : null, row.nextDueMotoHours === null ? null : `${formatNumber(row.nextDueMotoHours)} ${t('unit.hours')}`];
        return parts.filter(Boolean).join(' · ') || '—';
      },
    },
    ...(seesMoney ? [{ key: 'cost', header: t('maintenance.cost'), sortable: true, align: 'right' as const, cell: (row: Maintenance) => <MoneyText value={row.cost} /> }] : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">{addButton}</div>
      <DataTable<Maintenance>
        path={path}
        columns={columns}
        defaultSort="-date"
        searchable={false}
        urlPrefix="service"
        empty={{ icon: Wrench, title: t('maintenance.emptyTitle'), description: t('maintenance.emptyBody') }}
        rowActions={(row) => [
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete || row.transactionId !== null,
            onClick: async () => {
              const ok = await confirm({ title: t('maintenance.deleteTitle'), description: t('maintenance.deleteBody'), destructive: true });
              if (ok) remove.mutate(row.id);
            },
          },
        ]}
      />
      <FormDialog
        open={adding}
        onOpenChange={setAdding}
        title={t('maintenance.add')}
        schema={schema}
        defaultValues={{
          date: todayIso(),
          type: 'planned',
          description: '',
          cost: null,
          nextDueDate: '',
          nextDueMotoHours: null,
          downtimeHours: null,
          parts: [],
          paymentMethod: null,
          accountId: null,
          counterpartyId: null,
        }}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage="common:toast.created"
        size="lg"
      >
        {(form) => (
          <>
            <FormGrid>
              <DateField form={form} name="date" label={t('maintenance.date')} required />
              <SelectField form={form} name="type" label={t('maintenance.type')} required options={enumOptions('maintenanceType', MAINTENANCE_TYPES)} />
            </FormGrid>
            <TextareaField form={form} name="description" label={t('maintenance.description')} />
            <FormGrid>
              <DateField form={form} name="nextDueDate" label={t('maintenance.nextDate')} />
              <NumberField form={form} name="nextDueMotoHours" label={t('maintenance.nextHours')} suffix={t('unit.hours')} />
              <NumberField form={form} name="downtimeHours" label={t('maintenance.downtime')} suffix={t('unit.hours')} />
              {seesMoney && <NumberField money form={form} name="cost" label={t('maintenance.cost')} suffix={currencyLabel()} />}
            </FormGrid>
            <Separator />
            <PartsEditor form={form} />
            {canPay && <PaymentFields form={form} />}
          </>
        )}
      </FormDialog>
    </div>
  );
}
