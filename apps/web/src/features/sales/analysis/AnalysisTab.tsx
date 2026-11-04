import { addDays, todayIso } from '@yap/shared';
import { Banknote, ChartColumn, Coins, Percent } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTableView, ErrorCard, MoneyText, StatCard, useUrlParam } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { DateInput, Label, Meter } from '@/components/ui';
import { formatMoney, formatMonth, formatMonthShort, formatPercent, formatQty } from '@/lib/format';
import { useDetail } from '@/lib/query';
import type { SalesAnalysis } from '../types';

type ProductRow = SalesAnalysis['byProduct'][number];
type BuyerRow = SalesAnalysis['byBuyer'][number];

export function AnalysisTab() {
  const { t } = useTranslation('sales');
  const [from, setFrom] = useUrlParam('from', addDays(todayIso(), -365));
  const [to, setTo] = useUrlParam('to', todayIso());
  const { data, isLoading, error, refetch } = useDetail<SalesAnalysis>('/sales/analysis', { from, to });

  const totalAmount = data?.totals.amount ?? 0;

  const productColumns: Column<ProductRow>[] = [
    {
      key: 'product',
      header: t('analysis.product'),
      cell: (row) => row.itemName ?? t(`enums:animalCategory.${row.animalCategory}`),
      mobile: 'title',
    },
    { key: 'qty', header: t('analysis.qty'), cell: (row) => formatQty(row.qty, t(`enums:unit.${row.unit}`)), align: 'right', mobile: 'subtitle' },
    { key: 'amount', header: t('analysis.amount'), cell: (row) => <MoneyText value={row.amount} />, align: 'right' },
    { key: 'avgPrice', header: t('analysis.avgPrice'), cell: (row) => <MoneyText value={row.avgPrice} />, align: 'right' },
    { key: 'cost', header: t('analysis.cost'), cell: (row) => <MoneyText value={row.cost} />, align: 'right' },
    { key: 'margin', header: t('analysis.margin'), cell: (row) => <MoneyText value={row.margin} signed />, align: 'right' },
    { key: 'marginPercent', header: t('analysis.marginPercent'), cell: (row) => formatPercent(row.marginPercent), align: 'right', mobile: 'hidden' },
  ];

  const buyerColumns: Column<BuyerRow>[] = [
    { key: 'name', header: t('analysis.buyer'), cell: (row) => row.name, mobile: 'title' },
    { key: 'documents', header: t('analysis.documents'), cell: (row) => row.documents, align: 'right', mobile: 'subtitle' },
    { key: 'amount', header: t('analysis.amount'), cell: (row) => <MoneyText value={row.amount} />, align: 'right' },
    {
      key: 'share',
      header: t('analysis.share'),
      cell: (row) =>
        row.amount === null || totalAmount === 0 ? (
          '—'
        ) : (
          <Meter value={(row.amount / totalAmount) * 100} label={formatPercent((row.amount / totalAmount) * 100)} />
        ),
      className: 'min-w-40',
    },
    { key: 'margin', header: t('analysis.margin'), cell: (row) => <MoneyText value={row.margin} signed />, align: 'right' },
  ];

  if (error) return <ErrorCard error={error} onRetry={() => void refetch()} />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="analysis-from">{t('analysis.from')}</Label>
          <DateInput id="analysis-from" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="analysis-to">{t('analysis.to')}</Label>
          <DateInput id="analysis-to" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t('analysis.totalSales')} value={<MoneyText value={data?.totals.amount} compact />} icon={Banknote} loading={isLoading} />
        <StatCard label={t('analysis.totalCost')} value={<MoneyText value={data?.totals.cost} compact />} icon={Coins} loading={isLoading} />
        <StatCard label={t('analysis.totalMargin')} value={<MoneyText value={data?.totals.margin} compact />} icon={ChartColumn} loading={isLoading} />
        <StatCard label={t('analysis.marginPercent')} value={formatPercent(data?.totals.marginPercent)} icon={Percent} loading={isLoading} hint={t('analysis.marginHint')} />
      </div>

      <ChartCard
        title={t('analysis.byMonthTitle')}
        description={t('analysis.byMonthHint')}
        kind="bar"
        data={data?.byMonth ?? []}
        xKey="month"
        series={[
          { key: 'amount', label: t('analysis.amount'), slot: 1 },
          { key: 'cost', label: t('analysis.cost'), slot: 2 },
        ]}
        formatValue={(v) => formatMoney(v)}
        formatX={(m) => formatMonthShort(String(m))}
        formatLabel={(m) => formatMonth(String(m))}
        loading={isLoading}
        emptyText={t('analysis.empty')}
      />

      <section className="flex flex-col gap-2" aria-label={t('analysis.byProductTitle')}>
        <h2 className="text-base font-semibold">{t('analysis.byProductTitle')}</h2>
        <DataTableView<ProductRow>
          rows={data?.byProduct ?? []}
          columns={productColumns}
          rowKey={(row) => row.key}
          loading={isLoading}
          empty={{ icon: ChartColumn, title: t('analysis.empty') }}
        />
      </section>

      <section className="flex flex-col gap-2" aria-label={t('analysis.byBuyerTitle')}>
        <h2 className="text-base font-semibold">{t('analysis.byBuyerTitle')}</h2>
        <DataTableView<BuyerRow>
          rows={data?.byBuyer ?? []}
          columns={buyerColumns}
          rowKey={(row) => row.counterpartyId}
          loading={isLoading}
          empty={{ icon: ChartColumn, title: t('analysis.empty') }}
        />
      </section>
    </div>
  );
}
