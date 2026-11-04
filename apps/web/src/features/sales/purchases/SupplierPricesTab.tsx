import { PackageSearch, Trophy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTableView, EmptyState, ErrorCard, MoneyText, useUrlParam } from '@/components';
import { Badge, Combobox, Label } from '@/components/ui';
import { formatDate, formatQty } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { itemOptions } from '../shared';
import type { SupplierPrices } from '../types';

type Supplier = SupplierPrices['suppliers'][number];
type History = SupplierPrices['history'][number];

export function SupplierPricesTab() {
  const { t } = useTranslation('sales');
  const [itemId, setItemId] = useUrlParam('item');
  const [itemLabel, setItemLabel] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useDetail<SupplierPrices>(itemId ? '/sales/purchases/supplier-prices' : null, { itemId });

  const unit = data ? t(`enums:unit.${data.item.unit}`) : '';
  const cheapest = data?.suppliers[0]?.counterpartyId;
  const comparable = (data?.suppliers.length ?? 0) > 1 && data?.suppliers[0]?.avgPrice !== null;

  const columns: Column<Supplier>[] = [
    {
      key: 'name',
      header: t('suppliers.supplier'),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          {row.name}
          {comparable && row.counterpartyId === cheapest && (
            <Badge variant="success">
              <Trophy className="size-3.5" aria-hidden />
              {t('suppliers.cheapest')}
            </Badge>
          )}
        </span>
      ),
      mobile: 'title',
    },
    { key: 'avgPrice', header: t('suppliers.avgPrice'), cell: (row) => <MoneyText value={row.avgPrice} />, align: 'right', mobile: 'subtitle' },
    { key: 'lastPrice', header: t('suppliers.lastPrice'), cell: (row) => <MoneyText value={row.lastPrice} />, align: 'right' },
    { key: 'lastDate', header: t('suppliers.lastDate'), cell: (row) => formatDate(row.lastDate) },
    {
      key: 'range',
      header: t('suppliers.range'),
      cell: (row) => (
        <>
          <MoneyText value={row.minPrice} plain /> – <MoneyText value={row.maxPrice} plain />
        </>
      ),
      align: 'right',
      mobile: 'hidden',
    },
    { key: 'purchases', header: t('suppliers.purchases'), cell: (row) => row.purchases, align: 'right', mobile: 'hidden' },
    { key: 'totalQty', header: t('suppliers.totalQty'), cell: (row) => formatQty(row.totalQty, unit), align: 'right' },
  ];

  const historyColumns: Column<History>[] = [
    { key: 'date', header: t('suppliers.date'), cell: (row) => formatDate(row.date), mobile: 'title' },
    { key: 'name', header: t('suppliers.supplier'), cell: (row) => row.name, mobile: 'subtitle' },
    { key: 'qty', header: t('suppliers.qty'), cell: (row) => formatQty(row.qty, unit), align: 'right' },
    { key: 'unitCost', header: t('suppliers.price'), cell: (row) => <MoneyText value={row.unitCost} />, align: 'right' },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-md flex-col gap-1.5">
        <Label htmlFor="supplier-item">{t('suppliers.pickItem')}</Label>
        <Combobox
          id="supplier-item"
          value={itemId || null}
          onChange={(value, option) => {
            setItemId(value ?? '');
            setItemLabel(option?.label ?? null);
          }}
          loadOptions={itemOptions}
          selectedLabel={itemLabel ?? data?.item.name}
        />
      </div>

      {!itemId && <EmptyState icon={PackageSearch} title={t('suppliers.emptyTitle')} description={t('suppliers.emptyBody')} />}
      {error && <ErrorCard error={error} onRetry={() => void refetch()} />}

      {itemId && !error && (
        <>
          <DataTableView<Supplier>
            rows={data?.suppliers ?? []}
            columns={columns}
            rowKey={(row) => row.counterpartyId}
            loading={isLoading}
            empty={{ icon: PackageSearch, title: t('suppliers.noPurchasesTitle'), description: t('suppliers.noPurchasesBody') }}
          />
          {(data?.history.length ?? 0) > 0 && (
            <section className="flex flex-col gap-2" aria-label={t('suppliers.historyTitle')}>
              <h2 className="text-base font-semibold">{t('suppliers.historyTitle')}</h2>
              <DataTableView<History> rows={[...(data?.history ?? [])].reverse()} columns={historyColumns} rowKey={(row) => row.batchId} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
