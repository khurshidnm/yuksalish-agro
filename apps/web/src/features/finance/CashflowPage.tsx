import { todayIso } from '@yap/shared';
import { OctagonAlert, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTableView, ErrorCard, MoneyText, PageHeader, StatCard, UrlTabs, useUrlParam } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { Alert, Badge, Label, Select, Sheet, SheetContent, SheetDescription, SheetTitle, Skeleton } from '@/components/ui';
import { formatMoney, formatMonth, formatMonthShort } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { FINANCE_PATHS, budgetYear } from './lib';
import { shortfallPeriod } from './shortfall';
import type { ActualMonth, Forecast, ForecastMonth, ForecastParts } from './types';

const PATH = FINANCE_PATHS.cashflow;
const HORIZONS = [3, 6, 12, 24];

const INFLOW_PARTS: (keyof ForecastParts)[] = ['budgetIncome', 'recurringIncome', 'receivables', 'plannedSales', 'plannedHarvest', 'plannedLambs'];
const OUTFLOW_PARTS: (keyof ForecastParts)[] = ['budgetExpense', 'recurringExpense', 'payables', 'loans'];

function PartsList({ row, parts }: { row: ForecastMonth; parts: (keyof ForecastParts)[] }) {
  const { t } = useTranslation('finance');
  const visible = parts.filter((part) => row.parts[part] > 0);
  if (visible.length === 0) return <p className="text-sm text-muted-foreground">{t('cashflow.nothing')}</p>;
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
      {visible.map((part) => (
        <div key={part} className="contents">
          <dt className="text-muted-foreground">{t(`cashflow.parts.${part}`)}</dt>
          <dd className="text-right tabular-nums">{formatMoney(row.parts[part])}</dd>
        </div>
      ))}
    </dl>
  );
}

function ForecastTab() {
  const { t } = useTranslation('finance');
  const [monthsParam, setMonths] = useUrlParam('months', '12');
  const months = Number(monthsParam) || 12;
  const forecast = useDetail<Forecast>(`${PATH}/forecast`, { months });
  const [selected, setSelected] = useState<ForecastMonth | null>(null);

  const data = forecast.data;
  const rows = data?.rows ?? [];
  const shortfall = shortfallPeriod(rows);
  const lowest = useMemo(() => rows.reduce<ForecastMonth | null>((low, row) => (!low || row.closing < low.closing ? row : low), null), [rows]);
  const negative = rows.filter((row) => row.negative);

  const columns: Column<ForecastMonth>[] = [
    { key: 'month', header: t('cashflow.month'), mobile: 'title', cell: (row) => formatMonth(row.month) },
    { key: 'inflow', header: t('cashflow.inflow'), align: 'right', cell: (row) => formatMoney(row.inflow) },
    { key: 'outflow', header: t('cashflow.outflow'), align: 'right', cell: (row) => formatMoney(row.outflow) },
    { key: 'net', header: t('cashflow.net'), align: 'right', mobile: 'hidden', cell: (row) => <MoneyText value={row.net} signed /> },
    {
      key: 'closing',
      header: t('cashflow.closing'),
      align: 'right',
      cell: (row) =>
        row.negative ? (
          <span className="inline-flex flex-wrap items-center justify-end gap-1.5 font-medium text-danger">
            <OctagonAlert className="size-4" aria-hidden />
            <MoneyText value={row.closing} />
            <Badge variant="danger">{t('cashflow.shortfall')}</Badge>
          </span>
        ) : (
          <MoneyText value={row.closing} className="font-medium" />
        ),
    },
  ];

  if (forecast.error) return <ErrorCard error={forecast.error} onRetry={() => void forecast.refetch()} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t('cashflow.opening')} value={formatMoney(data?.opening)} icon={Wallet} loading={forecast.isLoading} />
        <StatCard
          label={t('cashflow.lowest')}
          value={formatMoney(lowest?.closing)}
          hint={lowest ? formatMonth(lowest.month) : undefined}
          tone={lowest && lowest.closing < 0 ? 'danger' : 'neutral'}
          icon={TrendingDown}
          loading={forecast.isLoading}
        />
        <StatCard
          label={t('cashflow.end')}
          value={formatMoney(rows.at(-1)?.closing)}
          hint={rows.length ? formatMonth(rows[rows.length - 1].month) : undefined}
          icon={TrendingUp}
          loading={forecast.isLoading}
        />
      </div>

      {data?.firstNegativeMonth && (
        <Alert tone="danger" title={t('cashflow.gapTitle', { month: formatMonth(data.firstNegativeMonth) })}>
          {t('cashflow.gapBody', { n: negative.length, amount: formatMoney(lowest?.closing ? -lowest.closing : 0) })}
        </Alert>
      )}
      {data?.lowConfidence ? (
        <Alert tone="warning" title={t('cashflow.lowConfidenceTitle')}>
          {t('cashflow.lowConfidenceBody')}
        </Alert>
      ) : (
        <Alert tone="info">{t('cashflow.methodNote', { months: data?.historyMonths ?? 0 })}</Alert>
      )}

      <div className="flex flex-col gap-1 sm:w-48">
        <Label htmlFor="cf-months">{t('cashflow.horizon')}</Label>
        <Select
          id="cf-months"
          value={String(months)}
          onChange={(e) => setMonths(e.target.value)}
          options={HORIZONS.map((value) => ({ value: String(value), label: t('cashflow.monthsCount', { n: value }) }))}
        />
      </div>

      <ChartCard
        title={t('cashflow.balanceChart')}
        description={t('cashflow.balanceChartHint')}
        kind="area"
        data={rows}
        xKey="month"
        series={[{ key: 'closing', label: t('cashflow.closing'), slot: 1, dashed: true }]}
        highlight={shortfall && { ...shortfall, tone: 'danger' }}
        formatValue={(value) => formatMoney(value)}
        formatX={(month) => formatMonthShort(month)}
        formatLabel={formatMonth}
        loading={forecast.isLoading}
      />
      <ChartCard
        title={t('cashflow.flowChart')}
        kind="bar"
        data={rows}
        xKey="month"
        series={[
          { key: 'inflow', label: t('cashflow.inflow'), slot: 1 },
          { key: 'outflow', label: t('cashflow.outflow'), slot: 2 },
        ]}
        formatValue={(value) => formatMoney(value)}
        formatX={(month) => formatMonthShort(month)}
        formatLabel={formatMonth}
        loading={forecast.isLoading}
      />

      <DataTableView<ForecastMonth>
        rows={rows}
        columns={columns}
        loading={forecast.isLoading}
        rowKey={(row) => row.month}
        onRowClick={setSelected}
      />

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full max-w-md overflow-y-auto p-5">
          <SheetTitle className="text-lg font-semibold">{selected && formatMonth(selected.month)}</SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">{t('cashflow.detailHint')}</SheetDescription>
          {selected && (
            <div className="mt-4 flex flex-col gap-4">
              <section>
                <h3 className="mb-2 flex justify-between text-sm font-medium">
                  <span>{t('cashflow.inflow')}</span>
                  <span className="tabular-nums">{formatMoney(selected.inflow)}</span>
                </h3>
                <PartsList row={selected} parts={INFLOW_PARTS} />
              </section>
              <section>
                <h3 className="mb-2 flex justify-between text-sm font-medium">
                  <span>{t('cashflow.outflow')}</span>
                  <span className="tabular-nums">{formatMoney(selected.outflow)}</span>
                </h3>
                <PartsList row={selected} parts={OUTFLOW_PARTS} />
              </section>
              <p className="flex justify-between border-t border-border pt-3 font-medium">
                <span>{t('cashflow.closing')}</span>
                <span className="tabular-nums">{formatMoney(selected.closing)}</span>
              </p>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ActualTab() {
  const { t } = useTranslation('finance');
  const today = todayIso();
  const actual = useDetail<ActualMonth[]>(`${PATH}/actual`, { from: `${budgetYear(today)}-10-01`, to: today });

  const columns: Column<ActualMonth>[] = [
    { key: 'month', header: t('cashflow.month'), mobile: 'title', cell: (row) => formatMonth(row.month) },
    { key: 'inflow', header: t('cashflow.inflow'), align: 'right', cell: (row) => formatMoney(row.inflow) },
    { key: 'outflow', header: t('cashflow.outflow'), align: 'right', cell: (row) => formatMoney(row.outflow) },
    { key: 'net', header: t('cashflow.net'), align: 'right', cell: (row) => <MoneyText value={row.net} signed /> },
  ];

  if (actual.isLoading) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="flex flex-col gap-4">
      <ChartCard
        title={t('cashflow.actualChart')}
        description={t('cashflow.actualHint')}
        kind="bar"
        data={actual.data ?? []}
        xKey="month"
        series={[
          { key: 'inflow', label: t('cashflow.inflow'), slot: 1 },
          { key: 'outflow', label: t('cashflow.outflow'), slot: 2 },
        ]}
        formatValue={(value) => formatMoney(value)}
        formatX={(month) => formatMonthShort(month)}
        formatLabel={formatMonth}
        error={actual.error}
        onRetry={() => void actual.refetch()}
      />
      <DataTableView<ActualMonth>
        rows={actual.data ?? []}
        columns={columns}
        error={actual.error}
        rowKey={(row) => row.month}
        empty={{ title: t('cashflow.emptyTitle'), description: t('cashflow.emptyBody') }}
      />
    </div>
  );
}

export default function CashflowPage() {
  const { t } = useTranslation('finance');
  return (
    <>
      <PageHeader title={t('cashflow.title')} description={t('cashflow.description')} />
      <UrlTabs
        tabs={[
          { value: 'forecast', label: t('cashflow.forecastTab'), content: <ForecastTab /> },
          { value: 'actual', label: t('cashflow.actualTab'), content: <ActualTab /> },
        ]}
      />
    </>
  );
}
