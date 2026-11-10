import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ScanLookup } from '@/components';
import type { ButtonProps } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';

/** One stock item that carries a scanned code: GET /inventory/items/by-code. No stock, no price. */
export interface ScannedItem {
  id: string;
  name: string;
  category: string;
  unit: string;
  defaultWarehouseId: string | null;
  sku: string | null;
  barcode: string | null;
  active: boolean;
  matchedBy: 'barcode' | 'sku' | 'id';
  exact: boolean;
}

export const ITEM_BY_CODE_PATH = '/inventory/items/by-code';

export function itemsByCode(code: string): Promise<ScannedItem[]> {
  return api.get<ScannedItem[]>(ITEM_BY_CODE_PATH, { code });
}

/** One line of the "which item?" list. */
export function ScannedItemLine({ item }: { item: ScannedItem }) {
  const { t } = useTranslation('scan');
  return (
    <span className="min-w-0 flex-1">
      <span className="block font-semibold break-words">{item.name}</span>
      <span className="block truncate text-sm text-muted-foreground">
        {[t(`enums:itemCategory.${item.category}`), item.sku, item.active ? null : t('item.switchedOff')].filter(Boolean).join(' · ')}
      </span>
    </span>
  );
}

/**
 * The names of the items scanned into a form. The item dropdown knows only the names it has listed
 * itself, and a scanned item may not be on its first page.
 */
export function useScannedItemNames(): [Record<string, string>, (item: ScannedItem) => void] {
  const [names, setNames] = useState<Record<string, string>>({});
  return [names, (item) => setNames((current) => ({ ...current, [item.id]: item.name }))];
}

export interface ScanItemButtonProps extends Omit<ButtonProps, 'onClick' | 'children' | 'title'> {
  onPick: (item: ScannedItem) => void;
  label?: ReactNode;
}

/**
 * Scans a barcode and hands over the item that carries it. The lookup is exact: an unknown code is
 * said to be unknown, and a code two items share is put to the person. Shown only to those who may
 * see the warehouse.
 */
export function ScanItemButton({ onPick, label, ...props }: ScanItemButtonProps) {
  const { t } = useTranslation('scan');
  const canView = usePermission('inventory.view');
  if (!canView) return null;
  return (
    <ScanLookup<ScannedItem>
      {...props}
      label={label}
      lookup={itemsByCode}
      onPick={(item) => {
        // A switched-off item is not offered in the dropdown either.
        if (!item.active) return void toast.error(t('item.inactive', { name: item.name }));
        onPick(item);
      }}
      matchKey={(item) => item.id}
      renderMatch={(item) => <ScannedItemLine item={item} />}
      scanTitle={t('item.title')}
      hint={t('item.hint')}
      noneTitle={t('item.noneTitle')}
      noneBody={t('item.noneBody')}
      severalTitle={t('item.severalTitle')}
      severalBody={t('item.severalBody')}
    />
  );
}
