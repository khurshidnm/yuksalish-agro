import { CURRENCIES, todayIso } from '@yap/shared';
import { useFieldArray, type UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog, FormGrid, NumberField, SelectField, Separator, SwitchField, TextField, TextareaField, apiOptions } from '@/components';
import { api } from '@/lib/api';
import { usePermission, useSession } from '@/lib/auth';
import { formatMoney } from '@/lib/format';
import { zDate, zEnum, zNonNegative, zOptionalDate, zOptionalNumber, zOptionalRef, zOptionalText, zPositive, zRef } from '@/lib/forms';
import i18n, { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { LineCard, LinesSection, STOCK_PATHS, downloadDocument, itemOptions, useWarehouseOptions } from './shared';
import type { DocumentResult, ItemOption } from './types';

const SOURCES = ['purchase', 'opening', 'return'] as const;
const METHODS = ['cash', 'bank', 'card', 'debt'] as const;

const schema = z
  .object({
    warehouseId: zRef(),
    date: zDate(),
    source: zEnum(SOURCES),
    counterpartyId: zOptionalRef(),
    invoiceNo: zOptionalText(60),
    currency: z.string(),
    fxRate: zOptionalNumber(),
    notes: zOptionalText(1000),
    lines: z
      .array(
        z.object({
          itemId: zRef(),
          unit: z.string().nullish(),
          qty: zPositive(),
          unitCost: zNonNegative(),
          batchNo: zOptionalText(60),
          expiryDate: zOptionalDate(),
        }),
      )
      .min(1),
    pay: z.boolean(),
    paymentMethod: zEnum(METHODS),
    accountId: zOptionalRef(),
    dueDate: zOptionalDate(),
  })
  .superRefine((values, ctx) => {
    const required = (path: string) => ctx.addIssue({ code: 'custom', path: [path], message: i18n.t('common:validation.required') });
    // Payment fields only show for a purchase, so a hidden one must never block saving.
    if (values.source !== 'purchase') return;
    if (!values.counterpartyId) required('counterpartyId');
    if (values.pay && values.paymentMethod !== 'debt' && !values.accountId) required('accountId');
  });

type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

/** Numbers stay blank until typed, and zod reports them as required on submit. */
const EMPTY_LINE = { itemId: '' } as FormIn['lines'][number];

function toPayload({ pay, paymentMethod, accountId, dueDate, lines, currency, fxRate, counterpartyId, invoiceNo, ...rest }: FormOut, baseCurrency: string) {
  // Supplier, currency and payment apply to a purchase only. They keep their values if the
  // user switched the type after filling them in, so they are dropped here.
  const purchase = rest.source === 'purchase';
  return {
    ...rest,
    lines: lines.map(({ unit: _unit, ...line }) => line),
    ...(purchase ? { counterpartyId, invoiceNo } : {}),
    ...(purchase && currency !== baseCurrency ? { currency, fxRate } : {}),
    ...(purchase && pay ? { payment: { paymentMethod, accountId: paymentMethod === 'debt' ? null : accountId, dueDate } } : {}),
  };
}

function Fields({ form, canPay, baseCurrency }: { form: UseFormReturn<FormIn, unknown, FormOut>; canPay: boolean; baseCurrency: string }) {
  const { t } = useTranslation('inventory');
  const warehouses = useWarehouseOptions();
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lines' });
  const source = form.watch('source');
  const currency = form.watch('currency');
  const pay = form.watch('pay');
  const method = form.watch('paymentMethod');
  const lines = form.watch('lines');
  const isPurchase = source === 'purchase';
  const total = lines.reduce((sum, line) => sum + (line?.qty ?? 0) * (line?.unitCost ?? 0), 0);

  return (
    <>
      <FormGrid>
        <SelectField form={form} name="source" label={t('receipt.source')} required options={enumOptions('receiptSource', SOURCES)} />
        <DateField form={form} name="date" label={t('document.date')} required max={todayIso()} />
      </FormGrid>
      <SelectField form={form} name="warehouseId" label={t('document.warehouse')} required options={warehouses} />
      {isPurchase && (
        <FormGrid>
          <ComboboxField
            form={form}
            name="counterpartyId"
            label={t('receipt.supplier')}
            required
            loadOptions={apiOptions<{ id: string; name: string }>('/finance/counterparties/lookup', (c) => ({ value: c.id, label: c.name }))}
          />
          <TextField form={form} name="invoiceNo" label={t('receipt.invoice')} />
        </FormGrid>
      )}
      {canPay && isPurchase && (
        <FormGrid>
          <SelectField form={form} name="currency" label={t('receipt.currency')} required options={enumOptions('currency', CURRENCIES)} />
          {currency !== baseCurrency && <NumberField form={form} name="fxRate" label={t('receipt.fxRate')} required hint={t('receipt.fxRateHint', { currency: baseCurrency })} />}
        </FormGrid>
      )}

      <Separator />

      <LinesSection
        addLabel={t('document.addLine')}
        onAdd={() => append(EMPTY_LINE)}
        rows={fields.map((field, index) => {
          const unit = lines[index]?.unit;
          return (
            <LineCard key={field.id} index={index} canRemove={fields.length > 1} onRemove={() => remove(index)}>
              <ComboboxField
                form={form}
                name={`lines.${index}.itemId`}
                label={t('document.item')}
                required
                clearable={false}
                loadOptions={itemOptions()}
                onSelect={(_value, option) => {
                  const item = option?.raw as ItemOption | undefined;
                  form.setValue(`lines.${index}.unit`, item?.unit ?? null);
                  if (item?.defaultWarehouseId && !form.getValues('warehouseId')) form.setValue('warehouseId', item.defaultWarehouseId);
                }}
              />
              <div className="grid grid-cols-2 gap-3">
                <NumberField form={form} name={`lines.${index}.qty`} label={t('document.qty')} required suffix={unit ? t(`enums:unit.${unit}`) : undefined} />
                <NumberField form={form} name={`lines.${index}.unitCost`} label={t('receipt.unitCost')} required hint={unit ? t('receipt.perUnit', { unit: t(`enums:unit.${unit}`) }) : undefined} />
                <TextField form={form} name={`lines.${index}.batchNo`} label={t('receipt.batchNo')} />
                <DateField form={form} name={`lines.${index}.expiryDate`} label={t('receipt.expiry')} />
              </div>
            </LineCard>
          );
        })}
      />
      <p className="text-right font-medium">
        {t('document.total')}: {formatMoney(total, { currency })}
      </p>

      {canPay && isPurchase && (
        <>
          <Separator />
          <SwitchField form={form} name="pay" label={t('receipt.payNow')} hint={t('receipt.payNowHint')} />
          {pay && (
            <FormGrid>
              <SelectField form={form} name="paymentMethod" label={t('receipt.paymentMethod')} required options={enumOptions('paymentMethod', METHODS)} />
              {method === 'debt' ? (
                <DateField form={form} name="dueDate" label={t('receipt.dueDate')} />
              ) : (
                <ComboboxField
                  form={form}
                  name="accountId"
                  label={t('receipt.account')}
                  required
                  loadOptions={apiOptions<{ id: string; name: string }>('/finance/accounts/lookup', (a) => ({ value: a.id, label: a.name }))}
                />
              )}
            </FormGrid>
          )}
        </>
      )}
      <TextareaField form={form} name="notes" label={t('document.notes')} rows={2} />
    </>
  );
}

export function ReceiptDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('inventory');
  const canPay = usePermission('finance.create');
  const baseCurrency = useSession().tenant?.currency ?? 'UZS';

  const mutation = useApiMutation<FormOut, DocumentResult>({
    mutationFn: (values) => api.post('/inventory/receipts', toPayload(values, baseCurrency)),
    invalidate: [...STOCK_PATHS, '/finance'],
    silentError: true,
    onSuccess: (result) => {
      const pending = result.transactions?.some((p) => p.status === 'pending');
      toast.success(t('receipt.done', { docNo: result.docNo }), {
        description: pending ? t('receipt.pendingApproval') : undefined,
        action: { label: t('document.pdf'), onClick: () => void downloadDocument(result.docNo) },
      });
    },
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('receipt.title')}
      description={t('receipt.description')}
      schema={schema}
      defaultValues={{
        warehouseId: '',
        date: todayIso(),
        source: 'purchase',
        counterpartyId: null,
        invoiceNo: '',
        currency: baseCurrency,
        notes: '',
        lines: [EMPTY_LINE],
        pay: false,
        paymentMethod: 'cash',
        accountId: null,
        dueDate: null,
      }}
      onSubmit={(values) => mutation.mutateAsync(values)}
      submitLabel={t('receipt.submit')}
      size="lg"
    >
      {(form) => <Fields form={form} canPay={canPay} baseCurrency={baseCurrency} />}
    </FormDialog>
  );
}
