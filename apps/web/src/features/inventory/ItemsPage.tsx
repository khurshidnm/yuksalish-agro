import { ITEM_CATEGORIES, UNITS } from '@yap/shared';
import { TYPICAL_FEED_KEYS, TYPICAL_FEEDS, type TypicalFeedKey } from '@yap/shared/formulas/nutrition';
import { latinToCyrillic } from '@yap/shared/i18n';
import { PackageSearch, Pencil, Plus, QrCode, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { z } from 'zod';
import { type Column, Alert, Badge, Button, DataTable, FormDialog, FormField, FormGrid, Input, Label, NumberField, PageHeader, Select, SelectField, ScanButton, TextField, TextareaField, useConfirm, useUrlParam } from '@/components';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { currencyLabel, formatQty } from '@/lib/format';
import { zEnum, zOptionalEnum, zOptionalNumber, zOptionalRef, zOptionalText, zText } from '@/lib/forms';
import i18n, { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { STOCK_PATHS, useWarehouseOptions } from './shared';
import type { ItemRow } from './types';

const PATH = '/inventory/items';

/** Roughage or not, as the form holds it: a select cannot hold true, false and "not said". */
const FEED_CLASSES = ['roughage', 'concentrate'] as const;

function feedClassOf(isRoughage: boolean | null | undefined): FormIn['feedClass'] {
  if (isRoughage === null || isRoughage === undefined) return '';
  return isRoughage ? 'roughage' : 'concentrate';
}

/** A share of the product, 0 to 100, or not said. */
const zOptionalPercent = () =>
  z
    .number()
    .min(0)
    .max(100)
    .nullish()
    .transform((v) => v ?? null);

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
  meMjPerKgDm: zOptionalNumber(),
  crudeProteinPctDm: zOptionalNumber(),
  calciumGPerKgDm: zOptionalNumber(),
  phosphorusGPerKgDm: zOptionalNumber(),
  feedClass: zOptionalEnum(FEED_CLASSES),
  kgPerUnit: zOptionalNumber(),
  cropId: zOptionalRef(),
  withdrawalDays: zOptionalNumber(),
  nPct: zOptionalPercent(),
  p2o5Pct: zOptionalPercent(),
  k2oPct: zOptionalPercent(),
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
  meMjPerKgDm: null,
  crudeProteinPctDm: null,
  calciumGPerKgDm: null,
  phosphorusGPerKgDm: null,
  feedClass: '',
  kgPerUnit: null,
  cropId: null,
  withdrawalDays: null,
  nPct: null,
  p2o5Pct: null,
  k2oPct: null,
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

/**
 * What the feed holds, per kg of dry matter. A typical feed can be applied and then corrected: those
 * figures are table averages, and the form says so.
 */
function NutrientFields({ form }: { form: UseFormReturn<FormIn, unknown, FormOut> }) {
  const { t } = useTranslation('inventory');
  const id = useId();
  const [applied, setApplied] = useState<TypicalFeedKey | null>(null);

  const apply = (key: TypicalFeedKey) => {
    const feed = TYPICAL_FEEDS[key];
    const set = { shouldDirty: true, shouldValidate: true };
    form.setValue('dryMatterPct', feed.dryMatterPct, set);
    form.setValue('meMjPerKgDm', feed.meMjPerKgDm, set);
    form.setValue('crudeProteinPctDm', feed.crudeProteinPctDm, set);
    form.setValue('calciumGPerKgDm', feed.calciumGPerKgDm, set);
    form.setValue('phosphorusGPerKgDm', feed.phosphorusGPerKgDm, set);
    form.setValue('feedClass', feedClassOf(feed.isRoughage), set);
    setApplied(key);
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div>
        <p className="font-medium">{t('items.nutrients.title')}</p>
        <p className="text-sm text-muted-foreground">{t('items.nutrients.hint')}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor={id}>{t('items.nutrients.typical')}</Label>
        <Select
          id={id}
          value=""
          onChange={(e) => e.target.value && apply(e.target.value as TypicalFeedKey)}
          options={TYPICAL_FEED_KEYS.map((key) => ({ value: key, label: t(`items.nutrients.feeds.${key}`) }))}
          placeholder={t('items.nutrients.typicalPlaceholder')}
        />
        <p className="text-sm text-muted-foreground">{t('items.nutrients.typicalHint')}</p>
      </div>
      {applied && <Alert tone="warning">{t('items.nutrients.typicalApplied', { feed: t(`items.nutrients.feeds.${applied}`) })}</Alert>}
      <FormGrid>
        <NumberField form={form} name="meMjPerKgDm" label={t('items.nutrients.energy')} suffix={t('items.nutrients.energyUnit')} />
        <NumberField form={form} name="crudeProteinPctDm" label={t('items.nutrients.protein')} suffix={t('items.nutrients.proteinUnit')} />
        <NumberField form={form} name="calciumGPerKgDm" label={t('items.nutrients.calcium')} suffix={t('items.nutrients.mineralUnit')} />
        <NumberField form={form} name="phosphorusGPerKgDm" label={t('items.nutrients.phosphorus')} suffix={t('items.nutrients.mineralUnit')} />
        <SelectField
          form={form}
          name="feedClass"
          label={t('items.nutrients.feedClass')}
          hint={t('items.nutrients.feedClassHint')}
          options={FEED_CLASSES.map((value) => ({ value, label: t(`items.nutrients.class.${value}`) }))}
          placeholder={t('items.nutrients.classUnknown')}
        />
      </FormGrid>
    </div>
  );
}

/** Chemical notation reads the same in every script, so it stays out of the dictionaries. */
const FERTILISER_CONTENT = [
  ['nPct', 'N'],
  ['p2o5Pct', 'P₂O₅'],
  ['k2oPct', 'K₂O'],
] as const;

/** What a fertiliser holds, as printed on the bag. The field card turns a nutrient rate into kilograms of it. */
function FertiliserFields({ form }: { form: UseFormReturn<FormIn, unknown, FormOut> }) {
  const { t } = useTranslation('inventory');
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div>
        <p className="font-medium">{t('items.fertiliser.title')}</p>
        <p className="text-sm text-muted-foreground">{t('items.fertiliser.hint')}</p>
      </div>
      <FormGrid>
        {FERTILISER_CONTENT.map(([name, formula]) => (
          <NumberField key={name} form={form} name={name} label={t('items.fertiliser.content', { formula })} suffix="%" maxDigits={1} />
        ))}
      </FormGrid>
    </div>
  );
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
      {isFeed && <NutrientFields form={form} />}
      {category === 'fertilizer' && <FertiliserFields form={form} />}
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
        {/* The code on the pack, typed or read off it with the camera. Receipts and issues find the item by it. */}
        <FormField form={form} name="barcode" label={t('items.fields.barcode')} hint={t('scan:item.barcodeHint')}>
          {(field) => (
            <div className="flex gap-2">
              <Input {...field} className="min-w-0 flex-1" inputMode="numeric" value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value)} />
              <ScanButton
                className="shrink-0"
                disabled={field.disabled}
                title={t('scan:item.barcodeTitle')}
                onResult={(code) => form.setValue('barcode', code, { shouldDirty: true, shouldValidate: true })}
              />
            </div>
          )}
        </FormField>
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
  const navigate = useNavigate();

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: STOCK_PATHS,
    successMessage: 'common:toast.deleted',
  });
  const save = useApiMutation<FormOut>({
    mutationFn: ({ feedClass, ...values }) => {
      const body = { ...values, isRoughage: feedClass === null ? null : feedClass === 'roughage' };
      return editing ? api.patch(`${PATH}/${editing.id}`, body) : api.post(PATH, body);
    },
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
  const headerActions = (
    <>
      <Button variant="outline" asChild>
        <Link to={category ? `/inventory/items/labels?category=${category}` : '/inventory/items/labels'}>
          <QrCode aria-hidden />
          {t('scan:itemLabels.print')}
        </Link>
      </Button>
      {addButton}
    </>
  );

  return (
    <>
      <PageHeader title={t('items.title')} description={t('items.description')} actions={headerActions} />

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
          { label: t('scan:itemLabels.printOne'), icon: QrCode, onClick: () => void navigate(`/inventory/items/labels?item=${row.id}`) },
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
        defaultValues={
          editing
            ? { ...EMPTY, ...editing, category: editing.category as FormIn['category'], unit: editing.unit as FormIn['unit'], feedClass: feedClassOf(editing.isRoughage) }
            : EMPTY
        }
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
        size="lg"
      >
        {(form) => <Fields form={form} canSeeMoney={canSeeMoney} />}
      </FormDialog>
    </>
  );
}
