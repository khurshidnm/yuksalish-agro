import { ITEM_CATEGORIES, UNITS } from '@yap/shared';
import { latinToCyrillic } from '@yap/shared/i18n';
import { PackageSearch, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, Badge, Button, DataTable, FormDialog, FormGrid, NumberField, PageHeader, Select, SelectField, TextField, TextareaField, useConfirm, useUrlParam } from '@/components';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { currencyLabel, formatQty } from '@/lib/format';
import { zEnum, zOptionalNumber, zOptionalRef, zOptionalText, zText } from '@/lib/forms';
import i18n, { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { STOCK_PATHS, useWarehouseOptions } from './shared';
import type { ItemRow } from './types';

const PATH = '/inventory/items';

const schema = z.object({
  name: zText(200),
  category: zEnum(ITEM_CATEGORIES),
  unit: zEnum(UNITS),
  sku: zOptionalText(60),
  barcode: zOptionalText(60),
  defaultWarehouseId: zOptionalRef(),
  minQty: zOptionalNumber(),
  minDays: zOptionalNumber(),
  dryMatterPct: zOptionalNumber(),
  kgPerUnit: zOptionalNumber(),
  cropId: zOptionalRef(),
  withdrawalDays: zOptionalNumber(),
  transferPrice: zOptionalNumber(),
  notes: zOptionalText(1000),
});

type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

const EMPTY: FormIn = {
  name: '',
  category: 'feed',
  unit: 'kg',
  sku: '',
  barcode: '',
  defaultWarehouseId: null,
  minQty: null,
  minDays: null,
  dryMatterPct: null,
  kgPerUnit: null,
  cropId: null,
  withdrawalDays: null,
  transferPrice: null,
  notes: '',
};

interface CropOption {
  id: string;
  key: string;
  name: { uz: string; ru: string; en: string };
}

function cropLabel(crop: CropOption): string {
  const lang = i18n.language;
  if (lang === 'uz-Cyrl') return latinToCyrillic(crop.name.uz);
  return crop.name[lang as 'uz' | 'ru' | 'en'] ?? crop.name.uz;
}

function Fields({ form, canSeeMoney }: { form: UseFormReturn<FormIn, unknown, FormOut>; canSeeMoney: boolean }) {
  const { t } = useTranslation('inventory');
  const warehouses = useWarehouseOptions();
  const crops = useDetail<CropOption[]>('/crops/crops');
  const category = form.watch('category');
  const unit = form.watch('unit');
  const isFeed = category === 'feed';
  const isDrug = category === 'vet_drug' || category === 'vaccine';
  const hasTransferPrice = canSeeMoney && (isFeed || category === 'product');

  return (
    <>
      <TextField form={form} name="name" label={t('items.fields.name')} required autoFocus />
      <FormGrid>
        <SelectField form={form} name="category" label={t('items.fields.category')} required options={enumOptions('itemCategory', ITEM_CATEGORIES)} />
        <SelectField form={form} name="unit" label={t('items.fields.unit')} required options={enumOptions('unit', UNITS)} />
        <SelectField form={form} name="defaultWarehouseId" label={t('items.fields.defaultWarehouse')} options={warehouses} />
        <NumberField form={form} name="minQty" label={t('items.fields.minQty')} hint={t('items.fields.minQtyHint')} suffix={t(`enums:unit.${unit}`)} />
      </FormGrid>
      {isFeed && (
        <FormGrid>
          <NumberField form={form} name="minDays" label={t('items.fields.minDays')} hint={t('items.fields.minDaysHint')} maxDigits={0} />
          <NumberField form={form} name="dryMatterPct" label={t('items.fields.dryMatterPct')} suffix="%" />
          {unit !== 'kg' && unit !== 't' && <NumberField form={form} name="kgPerUnit" label={t('items.fields.kgPerUnit')} hint={t('items.fields.kgPerUnitHint')} suffix="kg" />}
          <SelectField
            form={form}
            name="cropId"
            label={t('items.fields.crop')}
            hint={t('items.fields.cropHint')}
            options={(crops.data ?? []).map((crop) => ({ value: crop.id, label: cropLabel(crop) }))}
          />
        </FormGrid>
      )}
      {(isDrug || hasTransferPrice) && (
        <FormGrid>
          {isDrug && <NumberField form={form} name="withdrawalDays" label={t('items.fields.withdrawalDays')} hint={t('items.fields.withdrawalDaysHint')} maxDigits={0} />}
          {hasTransferPrice && (
            <NumberField
              money
              form={form}
              name="transferPrice"
              label={t('items.fields.transferPrice')}
              hint={t('items.fields.transferPriceHint', { unit: t(`enums:unit.${unit}`) })}
              suffix={t('items.fields.transferPriceUnit', { currency: currencyLabel(), unit: t(`enums:unit.${unit}`) })}
            />
          )}
        </FormGrid>
      )}
      <FormGrid>
        <TextField form={form} name="sku" label={t('items.fields.sku')} />
        <TextField form={form} name="barcode" label={t('items.fields.barcode')} hint={t('items.fields.barcodeHint')} inputMode="numeric" />
      </FormGrid>
      <TextareaField form={form} name="notes" label={t('items.fields.notes')} rows={2} />
    </>
  );
}

export default function ItemsPage() {
  const { t } = useTranslation('inventory');
  const canSave = usePermission('inventory.update');
  const canDelete = usePermission('inventory.delete');
  const canSeeMoney = usePermission('finance.view');
  const confirm = useConfirm();

  const [category, setCategory] = useUrlParam('category');
  const [editing, setEditing] = useState<ItemRow | null>(null);
  const [creating, setCreating] = useState(false);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: STOCK_PATHS,
    successMessage: 'common:toast.deleted',
  });
  const save = useApiMutation<FormOut>({
    mutationFn: (values) => (editing ? api.patch(`${PATH}/${editing.id}`, values) : api.post(PATH, values)),
    invalidate: STOCK_PATHS,
    silentError: true,
  });

  const columns: Column<ItemRow>[] = [
    { key: 'name', header: t('items.fields.name'), cell: (row) => row.name, sortable: true, mobile: 'title' },
    { key: 'category', header: t('items.fields.category'), cell: (row) => <Badge>{t(`enums:itemCategory.${row.category}`)}</Badge>, sortable: true, mobile: 'subtitle' },
    { key: 'qty', header: t('items.onHand'), align: 'right', cell: (row) => formatQty(row.qtyOnHand, row.unit) },
    { key: 'min', header: t('items.fields.minQty'), align: 'right', cell: (row) => formatQty(row.minQty, row.unit), mobile: 'hidden' },
    { key: 'warehouse', header: t('items.fields.defaultWarehouse'), cell: (row) => row.defaultWarehouseName ?? '—', mobile: 'hidden' },
  ];

  const addButton = canSave && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('items.add')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('items.title')} description={t('items.description')} actions={addButton} />

      <DataTable<ItemRow>
        path={PATH}
        params={{ category: category || undefined }}
        columns={columns}
        defaultSort="name"
        searchPlaceholder={t('items.searchPlaceholder')}
        filters={
          <Select
            aria-label={t('stock.categoryFilter')}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            options={enumOptions('itemCategory', ITEM_CATEGORIES)}
            placeholder={t('stock.allCategories')}
            className="md:w-56"
          />
        }
        empty={{ icon: PackageSearch, title: t('items.emptyTitle'), description: t('items.emptyBody'), action: addButton }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canSave, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({ title: t('items.deleteTitle'), description: t('items.deleteBody', { name: row.name }), destructive: true });
              if (ok) remove.mutate(row.id);
            },
          },
        ]}
      />

      <FormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        title={editing ? t('items.edit') : t('items.add')}
        schema={schema}
        defaultValues={editing ? { ...EMPTY, ...editing, category: editing.category as FormIn['category'], unit: editing.unit as FormIn['unit'] } : EMPTY}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
        size="lg"
      >
        {(form) => <Fields form={form} canSeeMoney={canSeeMoney} />}
      </FormDialog>
    </>
  );
}
