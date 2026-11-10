import { diffDays, todayIso } from '@yap/shared';
import { Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useFieldArray, type UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Badge, type BadgeVariant, Button, ComboboxField, NumberField, apiOptions } from '@/components';
import { api } from '@/lib/api';
import { formatDate, formatQty } from '@/lib/format';
import i18n from '@/lib/i18n';
import { useDetail } from '@/lib/query';
import { ScanItemButton, useScannedItemNames } from './ScanItem';
import type { ItemOption, WarehouseOption } from './types';

/** Everything that shows stock: each posting refreshes all of it. */
export const STOCK_PATHS = ['/inventory/stock', '/inventory/items', '/inventory/warehouses', '/inventory/movements', '/inventory/counts', '/feed'];

/** Items for a Combobox, with the balance as a hint, optionally for one warehouse. */
export function itemOptions(params?: { category?: string; warehouseId?: string }) {
  return apiOptions<ItemOption>(
    '/inventory/items/lookup',
    (item) => ({ value: item.id, label: item.name, hint: formatQty(item.qtyOnHand, item.unit) }),
    params,
  );
}

export function useWarehouseOptions() {
  const { data } = useDetail<WarehouseOption[]>('/inventory/warehouses/lookup');
  return (data ?? []).map((w) => ({ value: w.id, label: w.name }));
}

export function downloadDocument(docNo: string) {
  return api.download(`/inventory/documents/${encodeURIComponent(docNo)}/pdf`, `${docNo}.pdf`, { lang: i18n.language });
}

/** Expired batches read as danger, the coming month as a warning. */
export function ExpiryBadge({ date }: { date: string | null }) {
  if (!date) return <>—</>;
  const left = diffDays(todayIso(), date);
  const variant: BadgeVariant = left < 0 ? 'danger' : left <= 30 ? 'warning' : 'neutral';
  return <Badge variant={variant}>{formatDate(date)}</Badge>;
}

export interface LineValues {
  itemId: string;
  unit?: string | null;
  qty: number;
}

/** Numbers stay blank until typed, and zod reports them as required on submit. */
export const EMPTY_LINE = { itemId: '' } as LineValues;

/**
 * Item and quantity rows for issue and transfer documents. `form` is typed loosely because
 * react-hook-form cannot express "any form with a lines array"; each dialog's schema validates it.
 */
// biome-ignore lint: see above.
export function QtyLines({ form, warehouseId }: { form: UseFormReturn<any, any, any>; warehouseId?: string | null }) {
  const { t } = useTranslation('inventory');
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lines' });
  const units = form.watch('lines') as (LineValues | undefined)[];
  const [scannedNames, rememberScanned] = useScannedItemNames();

  return (
    <LinesSection
      addLabel={t('document.addLine')}
      onAdd={() => append(EMPTY_LINE)}
      rows={fields.map((field, index) => (
        <LineCard
          key={field.id}
          index={index}
          canRemove={fields.length > 1}
          onRemove={() => remove(index)}
          action={
            <ScanItemButton
              size="icon-sm"
              variant="ghost"
              onPick={(item) => {
                rememberScanned(item);
                form.setValue(`lines.${index}.itemId`, item.id, { shouldDirty: true, shouldValidate: true });
                form.setValue(`lines.${index}.unit`, item.unit);
              }}
            />
          }
        >
          <ComboboxField
            form={form}
            name={`lines.${index}.itemId`}
            label={t('document.item')}
            required
            clearable={false}
            selectedLabel={scannedNames[units[index]?.itemId ?? '']}
            loadOptions={itemOptions(warehouseId ? { warehouseId } : undefined)}
            onSelect={(_value, option) => form.setValue(`lines.${index}.unit`, (option?.raw as ItemOption | undefined)?.unit ?? null)}
          />
          <NumberField
            form={form}
            name={`lines.${index}.qty`}
            label={t('document.qty')}
            required
            suffix={units[index]?.unit ? t(`enums:unit.${units[index]?.unit}`) : undefined}
          />
        </LineCard>
      ))}
    />
  );
}

export function LinesSection({ rows, onAdd, addLabel }: { rows: ReactNode; onAdd: () => void; addLabel: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      {rows}
      <Button variant="outline" onClick={onAdd}>
        <Plus aria-hidden />
        {addLabel}
      </Button>
    </div>
  );
}

export function LineCard({
  index,
  canRemove,
  onRemove,
  action,
  children,
}: {
  index: number;
  canRemove: boolean;
  onRemove: () => void;
  /** A further button in the line's heading, e.g. "scan the item". */
  action?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation('inventory');
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex min-h-9 items-center justify-between gap-2">
        <span className="me-auto text-sm font-medium text-muted-foreground">{t('document.line', { number: index + 1 })}</span>
        {action}
        {canRemove && (
          <Button variant="ghost" size="icon-sm" aria-label={t('document.removeLine')} onClick={onRemove}>
            <Trash2 aria-hidden />
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}
