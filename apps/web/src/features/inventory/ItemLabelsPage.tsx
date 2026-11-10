import { ITEM_CATEGORIES } from '@yap/shared';
import { itemLabelCode } from '@yap/shared/formulas/scan-code';
import { QrCode } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, EmptyState, ErrorCard, PageHeader, Select, Skeleton, useUrlParam } from '@/components';
import { LabelSheet, type LabelSize, LabelToolbar, type PrintLabel } from '@/components/scan/LabelSheet';
import { formatNumber } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useDetail, useList } from '@/lib/query';
import type { ItemRow } from './types';

const PATH = '/inventory/items';
/** The most one request gives. A farm with more items prints them a category at a time. */
const PAGE = 200;

/**
 * What goes on an item's label: the name to read, and under it the barcode or the item's own code
 * when it has one. Stock and prices stay off the paper.
 */
export function itemPrintLabels(items: Pick<ItemRow, 'id' | 'name' | 'sku' | 'barcode'>[]): PrintLabel[] {
  return items.map((item) => ({ key: item.id, code: itemLabelCode(item), title: item.name, subtitle: item.barcode ?? item.sku }));
}

/** A sheet of QR labels for shelves and sacks: one item, or every item of a category. */
export default function ItemLabelsPage() {
  const { t } = useTranslation('scan');
  const [itemId] = useUrlParam('item');
  const [category, setCategory] = useUrlParam('category');
  const [size, setSize] = useState<LabelSize>('large');

  const one = useDetail<ItemRow>(itemId ? `${PATH}/${itemId}` : null);
  const many = useList<ItemRow>(PATH, { pageSize: PAGE, sort: 'name', category: category || undefined }, { enabled: !itemId });

  const { error, isLoading } = itemId ? one : many;
  const refetch = () => void (itemId ? one.refetch() : many.refetch());
  const items = itemId ? (one.data ? [one.data] : null) : (many.data?.data ?? null);
  const total = itemId ? 1 : (many.data?.meta.total ?? 0);
  const labels = itemPrintLabels(items ?? []);

  return (
    <>
      <PageHeader className="print:hidden" title={t('itemLabels.title')} description={t('itemLabels.description')} back={{ to: '/inventory/items', label: t('itemLabels.back') }} />
      <LabelToolbar count={labels.length} size={size} onSize={setSize}>
        {!itemId && (
          <Select
            aria-label={t('itemLabels.category')}
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            options={enumOptions('itemCategory', ITEM_CATEGORIES)}
            placeholder={t('itemLabels.allCategories')}
            className="w-full sm:w-56"
          />
        )}
      </LabelToolbar>
      {error ? (
        <ErrorCard error={error} onRetry={refetch} />
      ) : isLoading || !items ? (
        <Skeleton className="h-64 w-full" />
      ) : labels.length === 0 ? (
        <EmptyState icon={QrCode} title={t('itemLabels.emptyTitle')} description={t('itemLabels.emptyBody')} />
      ) : (
        <>
          {total > labels.length && (
            <Alert tone="warning" className="mb-3 print:hidden">
              {t('itemLabels.more', { shown: formatNumber(labels.length), total: formatNumber(total) })}
            </Alert>
          )}
          <LabelSheet labels={labels} size={size} />
        </>
      )}
    </>
  );
}
