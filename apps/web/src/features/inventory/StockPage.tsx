import { ITEM_CATEGORIES } from '@yap/shared';
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Boxes, CalendarCheck, PackageCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, Badge, Button, DataTable, DataTableView, Label, PageHeader, Select, Switch, UrlTabs, useUrlParam } from '@/components';
import { usePermission } from '@/lib/auth';
import { formatMoney, formatNumber, formatQty } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useDetail } from '@/lib/query';
import { BatchesDialog } from './BatchesDialog';
import { IssueDialog } from './IssueDialog';
import { ReceiptDialog } from './ReceiptDialog';
import { TransferDialog } from './TransferDialog';
import { ExpiryBadge, useWarehouseOptions } from './shared';
import type { ExpiringRow, LowRow, StockRow } from './types';

const EXPIRY_WINDOWS = [30, 60, 90, 180];

function BalancesTab({ canWrite, onReceive }: { canWrite: boolean; onReceive: () => void }) {
  const { t } = useTranslation('inventory');
  const canSeeMoney = usePermission('finance.view');
  const warehouses = useWarehouseOptions();
  const [warehouseId, setWarehouseId] = useUrlParam('warehouse');
  const [category, setCategory] = useUrlParam('category');
  const [includeEmpty, setIncludeEmpty] = useUrlParam('empty');
  const [selected, setSelected] = useState<StockRow | null>(null);

  const columns: Column<StockRow>[] = [
    {
      key: 'name',
      header: t('stock.columns.item'),
      sortable: true,
      mobile: 'title',
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          {row.name}
          {row.belowMinimum && <Badge variant="warning">{t('stock.belowMinimum')}</Badge>}
        </span>
      ),
    },
    { key: 'warehouse', header: t('stock.columns.warehouse'), cell: (row) => row.warehouseName ?? '—', mobile: 'subtitle' },
    { key: 'category', header: t('stock.columns.category'), cell: (row) => t(`enums:itemCategory.${row.category}`), sortable: true, mobile: 'hidden' },
    { key: 'qty', header: t('stock.columns.qty'), align: 'right', sortable: true, cell: (row) => <span className="font-medium">{formatQty(row.qty, row.unit)}</span> },
    ...(canSeeMoney
      ? [
          { key: 'avgCost', header: t('stock.columns.avgCost'), align: 'right' as const, mobile: 'hidden' as const, cell: (row: StockRow) => formatMoney(row.avgCost) },
          { key: 'value', header: t('stock.columns.value'), align: 'right' as const, cell: (row: StockRow) => formatMoney(row.value) },
        ]
      : []),
    { key: 'expiry', header: t('stock.columns.expiry'), cell: (row) => <ExpiryBadge date={row.nearestExpiry} />, mobile: 'hidden' },
  ];

  return (
    <>
      <DataTable<StockRow>
        path="/inventory/stock"
        params={{ warehouseId: warehouseId || undefined, category: category || undefined, includeEmpty: includeEmpty ? true : undefined }}
        columns={columns}
        rowKey={(row) => `${row.itemId}:${row.warehouseId ?? ''}`}
        onRowClick={(row) => row.warehouseId && setSelected(row)}
        defaultSort="name"
        searchPlaceholder={t('stock.searchPlaceholder')}
        filters={
          <>
            <Select
              aria-label={t('stock.warehouseFilter')}
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              options={warehouses}
              placeholder={t('stock.allWarehouses')}
              className="md:w-56"
            />
            <Select
              aria-label={t('stock.categoryFilter')}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              options={enumOptions('itemCategory', ITEM_CATEGORIES)}
              placeholder={t('stock.allCategories')}
              className="md:w-48"
            />
            <div className="flex min-h-11 items-center gap-2">
              <Switch id="stock-include-empty" checked={Boolean(includeEmpty)} onCheckedChange={(on) => setIncludeEmpty(on ? '1' : '')} />
              <Label htmlFor="stock-include-empty">{t('stock.includeEmpty')}</Label>
            </div>
          </>
        }
        empty={{
          icon: Boxes,
          title: t('stock.emptyTitle'),
          description: t('stock.emptyBody'),
          action: canWrite && (
            <Button onClick={onReceive}>
              <ArrowDownToLine aria-hidden />
              {t('stock.receive')}
            </Button>
          ),
        }}
      />
      <BatchesDialog row={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function LowTab({ query }: { query: ReturnType<typeof useDetail<LowRow[]>> }) {
  const { t } = useTranslation('inventory');
  const columns: Column<LowRow>[] = [
    { key: 'name', header: t('stock.columns.item'), cell: (row) => row.name, mobile: 'title' },
    { key: 'reason', header: t('stock.low.reason'), cell: (row) => <Badge variant="warning">{t(row.reason === 'qty' ? 'stock.low.reasonQty' : 'stock.low.reasonDays')}</Badge>, mobile: 'subtitle' },
    { key: 'qty', header: t('stock.columns.qty'), align: 'right', cell: (row) => formatQty(row.stockQty, row.unit) },
    { key: 'min', header: t('stock.low.minimum'), align: 'right', cell: (row) => (row.reason === 'days' ? t('stock.low.daysValue', { days: formatNumber(row.minDays, 0) }) : formatQty(row.minQty, row.unit)) },
    { key: 'days', header: t('stock.low.days'), align: 'right', cell: (row) => (row.days === null ? '—' : t('stock.low.daysValue', { days: formatNumber(row.days, 0) })) },
  ];
  return (
    <DataTableView
      rows={query.data ?? []}
      columns={columns}
      rowKey={(row) => row.itemId}
      loading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      empty={{ icon: PackageCheck, title: t('stock.low.emptyTitle'), description: t('stock.low.emptyBody') }}
    />
  );
}

function ExpiringTab() {
  const { t } = useTranslation('inventory');
  const [days, setDays] = useUrlParam('days', '60');
  const query = useDetail<ExpiringRow[]>('/inventory/stock/expiring', { days });
  const columns: Column<ExpiringRow>[] = [
    { key: 'item', header: t('stock.columns.item'), cell: (row) => row.itemName, mobile: 'title' },
    { key: 'warehouse', header: t('stock.columns.warehouse'), cell: (row) => row.warehouseName, mobile: 'subtitle' },
    { key: 'batch', header: t('batches.batchNo'), cell: (row) => row.batchNo ?? '—' },
    { key: 'qty', header: t('stock.columns.qty'), align: 'right', cell: (row) => formatQty(row.qtyRemaining, row.unit) },
    {
      key: 'expiry',
      header: t('stock.columns.expiry'),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <ExpiryBadge date={row.expiryDate} />
          {row.expired && <span className="text-sm text-danger">{t('stock.expiring.expired')}</span>}
        </span>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <Select
        aria-label={t('stock.expiring.within')}
        value={days}
        onChange={(e) => setDays(e.target.value)}
        options={EXPIRY_WINDOWS.map((value) => ({ value: String(value), label: t('stock.expiring.withinDays', { days: value }) }))}
        className="md:w-56"
      />
      <DataTableView
        rows={query.data ?? []}
        columns={columns}
        rowKey={(row) => row.batchId}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={{ icon: CalendarCheck, title: t('stock.expiring.emptyTitle'), description: t('stock.expiring.emptyBody') }}
      />
    </div>
  );
}

function CountedLabel({ label, count }: { label: string; count?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      {count ? <Badge variant="warning">{count}</Badge> : null}
    </span>
  );
}

export default function StockPage() {
  const { t } = useTranslation('inventory');
  const canWrite = usePermission('inventory.create');
  const [dialog, setDialog] = useState<'receipt' | 'issue' | 'transfer' | null>(null);
  const low = useDetail<LowRow[]>('/inventory/stock/low');
  const expiring = useDetail<ExpiringRow[]>('/inventory/stock/expiring', { days: 30 });

  const openChange = (open: boolean) => !open && setDialog(null);

  return (
    <>
      <PageHeader
        title={t('stock.title')}
        description={t('stock.description')}
        actions={
          canWrite && (
            <>
              <Button onClick={() => setDialog('receipt')}>
                <ArrowDownToLine aria-hidden />
                {t('stock.receive')}
              </Button>
              <Button variant="secondary" onClick={() => setDialog('issue')}>
                <ArrowUpFromLine aria-hidden />
                {t('stock.issue')}
              </Button>
              <Button variant="outline" onClick={() => setDialog('transfer')}>
                <ArrowLeftRight aria-hidden />
                {t('stock.transfer')}
              </Button>
            </>
          )
        }
      />

      <UrlTabs
        tabs={[
          { value: 'balances', label: t('stock.tabs.balances'), content: <BalancesTab canWrite={canWrite} onReceive={() => setDialog('receipt')} /> },
          { value: 'low', label: <CountedLabel label={t('stock.tabs.low')} count={low.data?.length} />, content: <LowTab query={low} /> },
          { value: 'expiring', label: <CountedLabel label={t('stock.tabs.expiring')} count={expiring.data?.length} />, content: <ExpiringTab /> },
        ]}
      />

      <ReceiptDialog open={dialog === 'receipt'} onOpenChange={openChange} />
      <IssueDialog open={dialog === 'issue'} onOpenChange={openChange} />
      <TransferDialog open={dialog === 'transfer'} onOpenChange={openChange} />
    </>
  );
}
