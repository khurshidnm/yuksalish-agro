import { todayIso } from '@yap/shared';
import { Beef, Coins, Scale, Sprout, TrendingUp } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTableView, ErrorCard, MoneyText, PageHeader, StatCard, UrlTabs, useUrlParam } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, DateInput, Label, Meter, Select, Skeleton } from '@/components/ui';
import { formatMoney, formatNumber, formatPercent } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { FINANCE_PATHS, budgetYear, useCenterName, useLocalName } from './lib';
import type { CategoryAmount, CategoryReport, CostCenterCost, FieldCost, HerdCost } from './types';

const PATH = FINANCE_PATHS.costs;

function usePeriod() {
  const today = todayIso();
  const [from, setFrom] = useUrlParam('from', `${budgetYear(today)}-10-01`);
  const [to, setTo] = useUrlParam('to', today);
  return { from, to, setFrom, setTo };
}

function PeriodFilter({ period }: { period: ReturnType<typeof usePeriod> }) {
  const { t } = useTranslation('finance');
  return (
    <div className="grid grid-cols-2 gap-2 sm:w-96">
      <div className="flex flex-col gap-1">
        <Label htmlFor="cost-from">{t('journal.from')}</Label>
        <DateInput id="cost-from" value={period.from} onChange={(e) => period.setFrom(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="cost-to">{t('journal.to')}</Label>
        <DateInput id="cost-to" value={period.to} onChange={(e) => period.setTo(e.target.value)} />
      </div>
    </div>
  );
}

function Percent({ value }: { value: number | null }) {
  if (value === null) return <>—</>;
  return <span className={value < 0 ? 'text-danger' : 'text-success'}>{`${value > 0 ? '+' : ''}${formatPercent(value)}`}</span>;
}

function HerdsTab() {
  const { t } = useTranslation('finance');
  const costs = useDetail<{ herds: HerdCost[]; total: HerdCost }>(`${PATH}/herds`);
  const total = costs.data?.total;

  const breakdown = useMemo(
    () =>
      total
        ? (['feed', 'vet', 'labor', 'overhead', 'other'] as const).map((key) => ({
            label: t(`costs.bucket.${key}`),
            amount: total.breakdown[key],
          }))
        : [],
    [total, t],
  );

  const columns: Column<HerdCost>[] = [
    { key: 'name', header: t('costs.herd'), mobile: 'title', cell: (row) => row.name },
    { key: 'head', header: t('costs.head'), align: 'right', mobile: 'subtitle', cell: (row) => formatNumber(row.head) },
    { key: 'purchase', header: t('costs.purchaseCost'), align: 'right', cell: (row) => formatMoney(row.purchaseCost) },
    { key: 'accumulated', header: t('costs.accumulated'), align: 'right', cell: (row) => formatMoney(row.accumulated) },
    { key: 'perHead', header: t('costs.costPerHead'), align: 'right', cell: (row) => <MoneyText value={row.costPerHead} className="font-medium" /> },
    { key: 'perKg', header: t('costs.costPerKg'), align: 'right', mobile: 'hidden', cell: (row) => <MoneyText value={row.costPerKg} /> },
  ];

  if (costs.error) return <ErrorCard error={costs.error} onRetry={() => void costs.refetch()} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('costs.costPerHead')}
          value={formatMoney(total?.costPerHead)}
          hint={t('costs.costPerHeadHint')}
          icon={Beef}
          loading={costs.isLoading}
        />
        <StatCard label={t('costs.head')} value={formatNumber(total?.head)} loading={costs.isLoading} />
        <StatCard label={t('costs.purchaseCost')} value={formatMoney(total?.purchaseCost)} icon={Coins} loading={costs.isLoading} />
        <StatCard
          label={t('costs.costPerKg')}
          value={formatMoney(total?.costPerKg)}
          hint={total?.costPerKg === null ? t('costs.noWeights') : t('costs.weightGain', { kg: formatNumber(total?.weightGainKg) })}
          icon={Scale}
          loading={costs.isLoading}
        />
      </div>
      <ChartCard
        title={t('costs.breakdownTitle')}
        description={t('costs.breakdownHint', { amount: formatMoney(total?.accumulated) })}
        kind="bar"
        data={breakdown}
        xKey="label"
        series={[{ key: 'amount', label: t('costs.amount'), slot: 1 }]}
        formatValue={(value) => formatMoney(value)}
        loading={costs.isLoading}
      />
      <DataTableView<HerdCost>
        rows={costs.data?.herds ?? []}
        columns={columns}
        loading={costs.isLoading}
        rowKey={(row) => row.herdId ?? ''}
        empty={{ icon: Beef, title: t('costs.noHerds'), description: t('costs.noHerdsBody') }}
      />
    </div>
  );
}

interface Season {
  id: string;
  name: string;
  isCurrent: boolean;
}

function FieldsTab() {
  const { t } = useTranslation('finance');
  const localName = useLocalName();
  const seasons = useDetail<Season[]>('/crops/seasons');
  const [seasonId, setSeasonId] = useUrlParam('season');
  const fields = useDetail<FieldCost[]>(`${PATH}/fields`, { seasonId: seasonId || undefined });

  const rows = fields.data ?? [];
  const chart = useMemo(
    () => rows.map((row) => ({ label: `№${row.number} ${localName(row.crop)}`, planned: row.planned ?? 0, actual: row.actual })),
    [rows, localName],
  );
  const totalActual = rows.reduce((sum, row) => sum + row.actual, 0);
  const totalPlanned = rows.reduce((sum, row) => sum + (row.planned ?? 0), 0);
  const totalArea = rows.reduce((sum, row) => sum + row.areaHa, 0);

  const columns: Column<FieldCost>[] = [
    { key: 'field', header: t('costs.field'), mobile: 'title', cell: (row) => `№${row.number} · ${localName(row.crop)}` },
    { key: 'area', header: t('costs.area'), align: 'right', mobile: 'subtitle', cell: (row) => t('costs.hectares', { value: formatNumber(row.areaHa) }) },
    { key: 'planned', header: t('costs.planned'), align: 'right', cell: (row) => formatMoney(row.planned) },
    { key: 'actual', header: t('costs.actual'), align: 'right', cell: (row) => <MoneyText value={row.actual} className="font-medium" /> },
    {
      key: 'deviation',
      header: t('budget.views.diff'),
      align: 'right',
      mobile: 'hidden',
      cell: (row) =>
        row.deviation === null ? '—' : (
          <span className={row.deviation > 0 ? 'text-danger' : 'text-success'}>
            {row.deviation > 0 ? '+' : ''}
            {formatMoney(row.deviation)}
          </span>
        ),
    },
    { key: 'harvest', header: t('costs.harvest'), align: 'right', cell: (row) => (row.harvestT > 0 ? t('costs.tons', { value: formatNumber(row.harvestT) }) : '—') },
    { key: 'yield', header: t('costs.yield'), align: 'right', mobile: 'hidden', cell: (row) => formatNumber(row.yieldTHa) },
    { key: 'perTon', header: t('costs.costPerTon'), align: 'right', cell: (row) => <MoneyText value={row.costPerTon} /> },
    { key: 'profit', header: t('costs.profitability'), align: 'right', mobile: 'hidden', cell: (row) => <Percent value={row.profitabilityPercent} /> },
  ];

  if (fields.error) return <ErrorCard error={fields.error} onRetry={() => void fields.refetch()} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 sm:w-72">
        <Label htmlFor="cost-season">{t('costs.season')}</Label>
        <Select
          id="cost-season"
          value={seasonId}
          onChange={(e) => setSeasonId(e.target.value)}
          options={(seasons.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
          placeholder={t('costs.currentSeason')}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t('costs.fieldsActual')} value={formatMoney(totalActual)} icon={Sprout} loading={fields.isLoading} />
        <StatCard label={t('costs.fieldsPlanned')} value={formatMoney(totalPlanned)} loading={fields.isLoading} />
        <StatCard
          label={t('costs.perHectare')}
          value={formatMoney(totalArea > 0 ? totalActual / totalArea : null)}
          hint={t('costs.fieldArea', { ha: formatNumber(totalArea) })}
          loading={fields.isLoading}
        />
      </div>
      <ChartCard
        title={t('costs.fieldChart')}
        kind="bar"
        data={chart}
        xKey="label"
        series={[
          { key: 'planned', label: t('costs.planned'), slot: 1 },
          { key: 'actual', label: t('costs.actual'), slot: 2 },
        ]}
        formatValue={(value) => formatMoney(value)}
        loading={fields.isLoading}
        emptyText={t('costs.noFields')}
      />
      <DataTableView<FieldCost>
        rows={rows}
        columns={columns}
        loading={fields.isLoading}
        rowKey={(row) => row.cropPlanId}
        empty={{ icon: Sprout, title: t('costs.noFields'), description: t('costs.noFieldsBody') }}
      />
    </div>
  );
}

function CentersTab() {
  const { t } = useTranslation('finance');
  const centerName = useCenterName();
  const period = usePeriod();
  const centers = useDetail<CostCenterCost[]>(`${PATH}/centers`, { from: period.from, to: period.to });

  const rows = (centers.data ?? []).filter((row) => row.total !== 0 || row.income !== 0 || row.direct !== 0 || row.materials !== 0);
  // The asset and general rows are negative where they hand cost on, so the chart shows who carries it.
  const carriers = rows.filter((row) => row.type === 'herd' || row.type === 'field');

  const columns: Column<CostCenterCost>[] = [
    { key: 'name', header: t('costs.center'), mobile: 'title', cell: (row) => centerName(row.name, row.type) },
    { key: 'type', header: t('costs.type'), mobile: 'subtitle', cell: (row) => <Badge>{t(`enums:costCenterType.${row.type}`)}</Badge> },
    { key: 'direct', header: t('costs.direct'), align: 'right', mobile: 'hidden', cell: (row) => formatMoney(row.direct, { compact: true }) },
    { key: 'materials', header: t('costs.materials'), align: 'right', mobile: 'hidden', cell: (row) => formatMoney(row.materials, { compact: true }) },
    { key: 'machinery', header: t('costs.machinery'), align: 'right', mobile: 'hidden', cell: (row) => formatMoney(row.machinery, { compact: true }) },
    { key: 'overhead', header: t('costs.overhead'), align: 'right', mobile: 'hidden', cell: (row) => formatMoney(row.overhead, { compact: true }) },
    { key: 'total', header: t('costs.total'), align: 'right', cell: (row) => <MoneyText value={row.total} compact className="font-medium" /> },
    { key: 'income', header: t('costs.income'), align: 'right', cell: (row) => formatMoney(row.income, { compact: true }) },
    { key: 'profit', header: t('costs.profit'), align: 'right', cell: (row) => <MoneyText value={row.profit} signed compact /> },
    { key: 'percent', header: t('costs.profitability'), align: 'right', cell: (row) => <Percent value={row.profitabilityPercent} /> },
  ];

  if (centers.error) return <ErrorCard error={centers.error} onRetry={() => void centers.refetch()} />;

  return (
    <div className="flex flex-col gap-4">
      <PeriodFilter period={period} />
      <ChartCard
        title={t('costs.centerChart')}
        description={t('costs.centerChartHint')}
        kind="stacked-bar"
        data={carriers}
        xKey="name"
        series={[
          { key: 'direct', label: t('costs.direct'), slot: 1 },
          { key: 'materials', label: t('costs.materials'), slot: 2 },
          { key: 'machinery', label: t('costs.machinery'), slot: 3 },
          { key: 'overhead', label: t('costs.overhead'), slot: 4 },
        ]}
        formatValue={(value) => formatMoney(value)}
        loading={centers.isLoading}
        emptyText={t('costs.noData')}
      />
      <DataTableView<CostCenterCost>
        rows={rows}
        columns={columns}
        loading={centers.isLoading}
        rowKey={(row) => row.costCenterId}
        empty={{ icon: Coins, title: t('costs.noData'), description: t('costs.noDataBody') }}
      />
      <Alert tone="info">{t('costs.internalNote')}</Alert>
    </div>
  );
}

function CategoryList({ title, rows, total }: { title: string; rows: CategoryAmount[]; total: number }) {
  const { t } = useTranslation('finance');
  const localName = useLocalName();
  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <MoneyText value={total} className="font-semibold" />
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('costs.noData')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((row) => {
              const share = total > 0 ? (row.amount / total) * 100 : 0;
              return (
                <li key={row.categoryId} className="flex flex-col gap-1">
                  <div className="flex justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">{localName(row.name)}</span>
                    <span className="shrink-0 tabular-nums">
                      {formatMoney(row.amount)} <span className="text-muted-foreground">({formatPercent(share, 0)})</span>
                    </span>
                  </div>
                  <Meter value={share} label={localName(row.name)} />
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function CategoriesTab() {
  const { t } = useTranslation('finance');
  const period = usePeriod();
  const report = useDetail<CategoryReport>(`${PATH}/categories`, { from: period.from, to: period.to });

  if (report.error) return <ErrorCard error={report.error} onRetry={() => void report.refetch()} />;
  const data = report.data;

  return (
    <div className="flex flex-col gap-4">
      <PeriodFilter period={period} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t('journal.totalIncome')} value={formatMoney(data?.income)} loading={report.isLoading} />
        <StatCard label={t('journal.totalExpense')} value={formatMoney(data?.expense)} loading={report.isLoading} />
        <StatCard label={t('journal.totalNet')} value={formatMoney(data?.net)} icon={TrendingUp} loading={report.isLoading} />
      </div>
      {report.isLoading || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <CategoryList title={t('budget.section.expense')} rows={data.rows.filter((row) => row.kind === 'expense')} total={data.expense} />
          <CategoryList title={t('budget.section.income')} rows={data.rows.filter((row) => row.kind === 'income')} total={data.income} />
        </div>
      )}
    </div>
  );
}

export default function CostsPage() {
  const { t } = useTranslation('finance');
  return (
    <>
      <PageHeader title={t('costs.title')} description={t('costs.description')} />
      <UrlTabs
        tabs={[
          { value: 'herds', label: t('costs.herdsTab'), content: <HerdsTab /> },
          { value: 'fields', label: t('costs.fieldsTab'), content: <FieldsTab /> },
          { value: 'centers', label: t('costs.centersTab'), content: <CentersTab /> },
          { value: 'categories', label: t('costs.categoriesTab'), content: <CategoriesTab /> },
        ]}
      />
    </>
  );
}
