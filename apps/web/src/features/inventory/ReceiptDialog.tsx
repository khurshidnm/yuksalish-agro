import { CURRENCIES, todayIso } from '@yap/shared';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useFieldArray, type UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button, ComboboxField, DateField, FormDialog, FormGrid, NumberField, SelectField, Separator, SwitchField, TextField, TextareaField, apiOptions } from '@/components';
import { useLocalName } from '@/features/finance/lib';
import type { CategoryOption } from '@/features/finance/types';
import { ApiError, api } from '@/lib/api';
import { usePermission, useSession } from '@/lib/auth';
import { zOptionalText, zText } from '@/lib/forms';
import { formatMoney } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { METHODS, type ReceiptFormIn, type ReceiptFormOut, SOURCES, needsCategory, receiptSchema, supplierRequired, toPayload } from './receiptForm';
import { LineCard, LinesSection, STOCK_PATHS, downloadDocument, itemOptions, useWarehouseOptions } from './shared';
import type { DocumentResult, ItemOption } from './types';

/** Numbers stay blank until typed, and zod reports them as required on submit. */
const EMPTY_LINE = { itemId: '' } as ReceiptFormIn['lines'][number];

const supplierSchema = z.object({ name: zText(200), phone: zOptionalText(30) });

interface Supplier {
  id: string;
  name: string;
}

/** Rendered beside the receipt form: inside it, this form's submit would bubble through React to the receipt's. */
function SupplierDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (supplier: Supplier) => void }) {
  const { t } = useTranslation('inventory');
  const save = useApiMutation<z.output<typeof supplierSchema>, Supplier>({
    mutationFn: (values) => api.postOnce('/finance/counterparties', { ...values, type: 'supplier' }),
    invalidate: ['/finance'],
    silentError: true,
    onSuccess: onCreated,
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('receipt.addSupplier')}
      schema={supplierSchema}
      defaultValues={{ name: '', phone: '' }}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage="common:toast.created"
    >
      {(form) => (
        <>
          <TextField form={form} name="name" label={t('finance:counterparties.fields.name')} required autoFocus />
          <TextField form={form} name="phone" label={t('finance:counterparties.fields.phone')} type="tel" inputMode="tel" />
        </>
      )}
    </FormDialog>
  );
}

function CategoryField({ form, required }: { form: UseFormReturn<ReceiptFormIn, unknown, ReceiptFormOut>; required: boolean }) {
  const { t } = useTranslation('inventory');
  const localName = useLocalName();
  const categories = useDetail<CategoryOption[]>('/finance/categories', { kind: 'expense' }).data ?? [];
  return (
    <ComboboxField
      form={form}
      name="categoryId"
      label={t('receipt.category')}
      hint={t('receipt.categoryHint')}
      required={required}
      options={categories.map((c) => ({ value: c.id, label: localName(c.name), hint: t(`enums:expenseGroup.${c.group}`) }))}
    />
  );
}

function Fields({
  form,
  canPay,
  baseCurrency,
  categoryAsked,
  newSupplier,
  onAddSupplier,
}: {
  form: UseFormReturn<ReceiptFormIn, unknown, ReceiptFormOut>;
  canPay: boolean;
  baseCurrency: string;
  categoryAsked: boolean;
  newSupplier: Supplier | null;
  onAddSupplier: () => void;
}) {
  const { t } = useTranslation('inventory');
  const warehouses = useWarehouseOptions();
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lines' });
  const source = form.watch('source');
  const currency = form.watch('currency');
  const pay = form.watch('pay');
  const method = form.watch('paymentMethod');
  const lines = form.watch('lines');
  const categoryId = form.watch('categoryId');
  const counterpartyId = form.watch('counterpartyId');
  const isPurchase = source === 'purchase';
  const categoryRequired = needsCategory(lines) || categoryAsked;
  const total = lines.reduce((sum, line) => sum + (line?.qty ?? 0) * (line?.unitCost ?? 0), 0);

  const { setValue } = form;
  useEffect(() => {
    if (newSupplier) setValue('counterpartyId', newSupplier.id, { shouldValidate: true });
  }, [newSupplier, setValue]);

  return (
    <>
      <FormGrid>
        <SelectField form={form} name="source" label={t('receipt.source')} required options={enumOptions('receiptSource', SOURCES)} />
        <DateField form={form} name="date" label={t('document.date')} required max={todayIso()} />
      </FormGrid>
      <SelectField form={form} name="warehouseId" label={t('document.warehouse')} required options={warehouses} />
      {isPurchase && (
        <FormGrid>
          <div className="flex min-w-0 flex-col gap-1">
            <ComboboxField
              form={form}
              name="counterpartyId"
              label={t('receipt.supplier')}
              required={supplierRequired({ source, pay, paymentMethod: method })}
              emptyText={t(canPay ? 'receipt.supplierAddHere' : 'receipt.supplierAskFinance')}
              selectedLabel={newSupplier?.id === counterpartyId ? newSupplier?.name : undefined}
              loadOptions={apiOptions<{ id: string; name: string }>('/finance/counterparties/lookup', (c) => ({ value: c.id, label: c.name }))}
            />
            {canPay && (
              <Button variant="ghost" className="self-start" onClick={onAddSupplier}>
                <Plus aria-hidden />
                {t('receipt.addSupplier')}
              </Button>
            )}
          </div>
          <TextField form={form} name="invoiceNo" label={t('receipt.invoice')} />
        </FormGrid>
      )}
      {canPay && isPurchase && (
        <FormGrid>
          <SelectField form={form} name="currency" label={t('receipt.currency')} required options={enumOptions('currency', CURRENCIES)} />
          {currency !== baseCurrency && <NumberField money form={form} name="fxRate" label={t('receipt.fxRate')} required hint={t('receipt.fxRateHint', { currency: baseCurrency })} />}
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
                  form.setValue(`lines.${index}.itemCategory`, item?.category ?? null);
                  if (item?.defaultWarehouseId && !form.getValues('warehouseId')) form.setValue('warehouseId', item.defaultWarehouseId);
                }}
              />
              <div className="grid grid-cols-2 gap-3">
                <NumberField form={form} name={`lines.${index}.qty`} label={t('document.qty')} required suffix={unit ? t(`enums:unit.${unit}`) : undefined} />
                <NumberField money form={form} name={`lines.${index}.unitCost`} label={t('receipt.unitCost')} required hint={unit ? t('receipt.perUnit', { unit: t(`enums:unit.${unit}`) }) : undefined} />
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
          {pay && (categoryRequired || categoryId) && <CategoryField form={form} required={categoryRequired} />}
        </>
      )}
      {isPurchase && !pay && <p className="text-sm text-muted-foreground">{t('receipt.financeRecords')}</p>}
      <TextareaField form={form} name="notes" label={t('document.notes')} rows={2} />
    </>
  );
}

export function ReceiptDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('inventory');
  const canPay = usePermission('finance.create');
  const baseCurrency = useSession().tenant?.currency ?? 'UZS';
  const [categoryAsked, setCategoryAsked] = useState(false);
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [newSupplier, setNewSupplier] = useState<Supplier | null>(null);

  const mutation = useApiMutation<ReceiptFormOut, DocumentResult>({
    mutationFn: (values) => api.postOnce('/inventory/receipts', toPayload(values, baseCurrency)),
    invalidate: [...STOCK_PATHS, '/finance'],
    silentError: true,
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'CATEGORY_REQUIRED') setCategoryAsked(true);
    },
    onSuccess: (result) => {
      const pending = result.transactions?.some((p) => p.status === 'pending');
      toast.success(t('receipt.done', { docNo: result.docNo }), {
        description: pending ? t('receipt.pendingApproval') : undefined,
        action: { label: t('document.pdf'), onClick: () => void downloadDocument(result.docNo) },
      });
    },
  });

  return (
    <>
      <FormDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setCategoryAsked(false);
            setNewSupplier(null);
          }
          onOpenChange(next);
        }}
        title={t('receipt.title')}
        description={t('receipt.description')}
        schema={receiptSchema}
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
          categoryId: null,
          dueDate: null,
        }}
        onSubmit={(values) => mutation.mutateAsync(values)}
        submitLabel={t('receipt.submit')}
        size="lg"
      >
        {(form) => (
          <Fields
            form={form}
            canPay={canPay}
            baseCurrency={baseCurrency}
            categoryAsked={categoryAsked}
            newSupplier={newSupplier}
            onAddSupplier={() => setAddingSupplier(true)}
          />
        )}
      </FormDialog>
      <SupplierDialog open={addingSupplier} onOpenChange={setAddingSupplier} onCreated={setNewSupplier} />
    </>
  );
}
