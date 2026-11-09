import { todayIso } from '@yap/shared';
import { Beef, Package, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { type UseFormReturn, useFieldArray, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog, FormGrid, NumberField, SelectField, TextareaField } from '@/components';
import { Button, Card, CardContent } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatMoney } from '@/lib/format';
import { zDate, zEnum, zNonNegative, zOptionalDate, zOptionalRef, zOptionalText, zPositive, zRef } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { accountOptions, animalOptions, counterpartyOptions, type ItemLookup, itemOptions, warehouseOptions } from '../shared';
import { type CurrentPrice, SALE_PAYMENT_METHODS, type SaleDetail } from '../types';

const PATH = '/sales/orders';

function buildSchema(t: (key: string) => string) {
  const line = z
    .object({
      kind: z.enum(['item', 'animal']),
      itemId: zOptionalRef(),
      itemName: z.string().nullish(),
      warehouseId: zOptionalRef(),
      warehouseName: z.string().nullish(),
      animalId: zOptionalRef(),
      animalTag: z.string().nullish(),
      qty: zPositive(),
      unit: z.string(),
      price: zNonNegative(),
    })
    .superRefine((l, ctx) => {
      const require = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: [field], message });
      if (l.kind === 'item' && !l.itemId) require('itemId', t('orders.form.pickItem'));
      if (l.kind === 'item' && !l.warehouseId) require('warehouseId', t('orders.form.pickWarehouse'));
      if (l.kind === 'animal' && !l.animalId) require('animalId', t('orders.form.pickAnimal'));
      // Run even while the quantity or price is missing, so one press of Save names every empty field.
    }, { when: () => true });

  return z
    .object({
      date: zDate(),
      counterpartyId: zRef(),
      counterpartyName: z.string().nullish(),
      paymentMethod: zEnum(SALE_PAYMENT_METHODS),
      accountId: zOptionalRef(),
      accountName: z.string().nullish(),
      dueDate: zOptionalDate(),
      deliveryDate: zOptionalDate(),
      notes: zOptionalText(1000),
      lines: z.array(line).min(1),
    })
    .superRefine((v, ctx) => {
      if (v.paymentMethod !== 'debt' && !v.accountId) {
        ctx.addIssue({ code: 'custom', path: ['accountId'], message: t('orders.form.pickAccount') });
      }
    }, { when: () => true });
}

type Schema = ReturnType<typeof buildSchema>;
type Values = z.input<Schema>;
type Output = z.output<Schema>;
type Form = UseFormReturn<Values, unknown, Output>;
type LineValues = Values['lines'][number];

const blankLine = (kind: 'item' | 'animal'): LineValues =>
  ({ kind, itemId: null, warehouseId: null, animalId: null, qty: null, unit: kind === 'animal' ? 'kg' : '', price: null }) as unknown as LineValues;

function toForm(sale: SaleDetail): Values {
  return {
    date: sale.date,
    counterpartyId: sale.counterpartyId,
    counterpartyName: sale.counterpartyName,
    paymentMethod: sale.paymentMethod as Values['paymentMethod'],
    accountId: sale.accountId,
    dueDate: sale.dueDate,
    deliveryDate: sale.deliveryDate,
    notes: sale.notes,
    lines: sale.lines.map((l) => ({
      kind: l.animalId ? 'animal' : 'item',
      itemId: l.itemId,
      itemName: l.itemName,
      warehouseId: l.warehouseId,
      warehouseName: l.warehouseName,
      animalId: l.animalId,
      animalTag: l.animalTag,
      qty: l.qty,
      unit: l.unit,
      price: l.price ?? 0,
    })),
  };
}

function LineEditor({ form, index, onRemove, salePrice }: { form: Form; index: number; onRemove?: () => void; salePrice: (itemId: string) => number | null }) {
  const { t } = useTranslation('sales');
  const line = useWatch({ control: form.control, name: `lines.${index}` });
  const name = <K extends string>(field: K) => `lines.${index}.${field}` as const;
  const amount = (line?.qty ?? 0) * (line?.price ?? 0);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          {/* The line's number: its first field already says "Product" or "Animal". */}
          <p className="text-sm font-medium">{t('orders.form.lineNumber', { n: index + 1 })}</p>
          {onRemove && (
            <Button variant="ghost" size="icon" aria-label={t('orders.form.removeLine')} onClick={onRemove}>
              <Trash2 aria-hidden />
            </Button>
          )}
        </div>

        {line?.kind === 'animal' ? (
          <FormGrid>
            <ComboboxField
              form={form}
              name={name('animalId')}
              label={t('orders.fields.animal')}
              required
              loadOptions={animalOptions}
              selectedLabel={line.animalTag}
              searchPlaceholder={t('orders.form.animalSearch')}
              onSelect={(_, option) => form.setValue(name('animalTag'), option?.label ?? null)}
            />
            <SelectField
              form={form}
              name={name('unit')}
              label={t('orders.fields.soldBy')}
              required
              options={[
                { value: 'kg', label: t('orders.form.byWeight') },
                { value: 'head', label: t('orders.form.byHead') },
              ]}
            />
          </FormGrid>
        ) : (
          <FormGrid>
            <ComboboxField
              form={form}
              name={name('itemId')}
              label={t('orders.fields.item')}
              required
              loadOptions={itemOptions}
              selectedLabel={line?.itemName}
              onSelect={(value, option) => {
                const item = option?.raw as ItemLookup | undefined;
                form.setValue(name('itemName'), option?.label ?? null);
                form.setValue(name('unit'), item?.unit ?? '');
                if (item?.defaultWarehouseId) form.setValue(name('warehouseId'), item.defaultWarehouseId);
                const price = value ? salePrice(value) : null;
                if (price !== null) form.setValue(name('price'), price, { shouldValidate: true });
              }}
            />
            <ComboboxField
              form={form}
              name={name('warehouseId')}
              label={t('orders.fields.warehouse')}
              required
              loadOptions={warehouseOptions}
              selectedLabel={line?.warehouseName}
            />
          </FormGrid>
        )}

        <FormGrid>
          <NumberField
            form={form}
            name={name('qty')}
            label={t(line?.unit === 'head' ? 'orders.fields.head' : 'orders.fields.qty')}
            required
            suffix={line?.unit ? t(`enums:unit.${line.unit}`) : undefined}
          />
          <NumberField money
            form={form}
            name={name('price')}
            label={t(line?.unit === 'head' ? 'orders.fields.pricePerHead' : 'orders.fields.price')}
            required
          />
        </FormGrid>
        <p className="text-right text-sm text-muted-foreground">
          {t('orders.fields.amount')}: <span className="font-medium text-foreground tabular-nums">{formatMoney(amount)}</span>
        </p>
      </CardContent>
    </Card>
  );
}

function LinesEditor({ form }: { form: Form }) {
  const { t } = useTranslation('sales');
  const canSeePrices = usePermission('finance.view');
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const values = useWatch({ control: form.control, name: 'lines' });
  const { data: prices } = useDetail<CurrentPrice[]>('/sales/prices/current', undefined, { enabled: canSeePrices });

  const salePrice = (itemId: string) => prices?.find((p) => p.itemId === itemId && p.kind === 'sale')?.price ?? null;
  const total = (values ?? []).reduce((sum, l) => sum + (l?.qty ?? 0) * (l?.price ?? 0), 0);
  const error = form.formState.errors.lines;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">{t('orders.fields.lines')}</p>
      {lines.fields.map((field, index) => (
        <LineEditor
          key={field.id}
          form={form}
          index={index}
          salePrice={salePrice}
          onRemove={lines.fields.length > 1 ? () => lines.remove(index) : undefined}
        />
      ))}
      {error?.root?.message && <p className="text-sm text-danger">{error.root.message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => lines.append(blankLine('item'))}>
          <Package aria-hidden />
          {t('orders.form.addItem')}
        </Button>
        <Button variant="outline" onClick={() => lines.append(blankLine('animal'))}>
          <Beef aria-hidden />
          {t('orders.form.addAnimal')}
        </Button>
      </div>
      <p className="text-right font-medium">
        {t('orders.fields.total')}: <span className="tabular-nums">{formatMoney(total)}</span>
      </p>
    </div>
  );
}

function PaymentFields({ form }: { form: Form }) {
  const { t } = useTranslation('sales');
  const method = useWatch({ control: form.control, name: 'paymentMethod' });
  const accountName = useWatch({ control: form.control, name: 'accountName' });
  return (
    <FormGrid>
      <SelectField
        form={form}
        name="paymentMethod"
        label={t('orders.fields.paymentMethod')}
        required
        options={enumOptions('paymentMethod', SALE_PAYMENT_METHODS)}
      />
      {method === 'debt' ? (
        <DateField form={form} name="dueDate" label={t('orders.fields.dueDate')} />
      ) : (
        <ComboboxField
          form={form}
          name="accountId"
          label={t('orders.fields.account')}
          required
          loadOptions={accountOptions}
          selectedLabel={accountName}
          onSelect={(_, option) => form.setValue('accountName', option?.label ?? null)}
        />
      )}
    </FormGrid>
  );
}

interface SaleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sale?: SaleDetail | null;
  onSaved?: (id: string) => void;
}

export function SaleFormDialog({ open, onOpenChange, sale, onSaved }: SaleFormDialogProps) {
  const { t } = useTranslation('sales');
  const schema = useMemo(() => buildSchema(t), [t]);

  const save = useApiMutation<Output, SaleDetail>({
    mutationFn: ({ counterpartyName: _c, accountName: _a, lines, ...values }) => {
      const body = {
        ...values,
        lines: lines.map((l) =>
          l.kind === 'animal'
            ? { animalId: l.animalId, qty: l.qty, unit: l.unit, price: l.price }
            : { itemId: l.itemId, warehouseId: l.warehouseId, qty: l.qty, price: l.price },
        ),
      };
      return sale ? api.patch(`${PATH}/${sale.id}`, body) : api.postOnce(PATH, body);
    },
    invalidate: [PATH],
    silentError: true,
    onSuccess: (saved) => onSaved?.(saved.id),
  });

  const defaults: Values = sale
    ? toForm(sale)
    : {
        date: todayIso(),
        counterpartyId: '',
        paymentMethod: 'debt',
        accountId: null,
        dueDate: null,
        deliveryDate: null,
        notes: '',
        lines: [blankLine('item')],
      };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={sale ? t('orders.edit', { number: sale.number }) : t('orders.add')}
      schema={schema}
      defaultValues={defaults}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={sale ? 'common:toast.updated' : 'common:toast.created'}
      size="xl"
    >
      {(form) => (
        <>
          <FormGrid>
            <ComboboxField
              form={form}
              name="counterpartyId"
              label={t('orders.fields.buyer')}
              required
              loadOptions={counterpartyOptions}
              selectedLabel={sale?.counterpartyName}
            />
            <DateField form={form} name="date" label={t('orders.fields.date')} required />
          </FormGrid>
          <PaymentFields form={form} />
          <LinesEditor form={form} />
          <DateField form={form} name="deliveryDate" label={t('orders.fields.deliveryDate')} />
          <TextareaField form={form} name="notes" label={t('orders.fields.notes')} rows={2} />
        </>
      )}
    </FormDialog>
  );
}
