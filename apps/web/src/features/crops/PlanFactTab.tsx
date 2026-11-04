import { BarChart3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTableView, MoneyText } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { Badge } from '@/components/ui';
import { useLocalName } from '@/features/farm/utils';
import { useSeesCost } from '@/lib/auth';
import { formatNumber, formatPercent, formatQty } from '@/lib/format';
import { useDetail } from '@/lib/query';
import type { PlanFact, PlanFactRow } from './types';

export function PlanFactTab({ seasonId }: { seasonId: string }) {
  const { t } = useTranslation('crops');
  const localName = useLocalName();
  const seesMoney = useSeesCost('crops.approve');
  const { data, isLoading, error, refetch } = useDetail<PlanFact>('/crops/plan-fact', { seasonId: seasonId || undefined });
  const rows = data?.rows ?? [];

  const money: Column<PlanFactRow>[] = seesMoney
    ? [
        { key: 'plannedCost', header: t('planFact.plannedCost'), align: 'right', cell: (r) => <MoneyText value={r.plannedCost} compact /> },
        { key: 'actualCost', header: t('planFact.actualCost'), align: 'right', cell: (r) => <MoneyText value={r.actualCost} compact /> },
        { key: 'costPerTon', header: t('planFact.costPerTon'), align: 'right', mobile: 'hidden', cell: (r) => <MoneyText value={r.costPerTon} compact /> },
        { key: 'harvestValue', header: t('planFact.harvestValue'), align: 'right', mobile: 'hidden', cell: (r) => <MoneyText value={r.harvestValue} compact /> },
      ]
    : [];

  const columns: Column<PlanFactRow>[] = [
    { key: 'field', header: t('operations.fields.field'), mobile: 'title', cell: (r) => `№${r.fieldNumber} · ${localName(r.cropName)}` },
    { key: 'status', header: t('plans.fields.status'), mobile: 'subtitle', cell: (r) => <Badge>{t(`enums:cropPlanStatus.${r.status}`)}</Badge> },
    { key: 'area', header: t('plans.fields.area'), align: 'right', cell: (r) => `${formatNumber(r.areaHa)} ${t('unit.ha')}` },
    { key: 'expected', header: t('planFact.expected'), align: 'right', cell: (r) => formatQty(r.expectedHarvestT, 't') },
    { key: 'harvested', header: t('planFact.harvested'), align: 'right', cell: (r) => (r.harvestedT > 0 ? formatQty(r.harvestedT, 't') : '—') },
    { key: 'yield', header: t('planFact.yield'), align: 'right', cell: (r) => (r.actualYieldTHa === null ? '—' : `${formatNumber(r.actualYieldTHa, 2)} ${t('unit.tPerHa')}`) },
    { key: 'deviation', header: t('planFact.deviation'), align: 'right', mobile: 'hidden', cell: (r) => formatPercent(r.yieldDeviationPercent) },
    { key: 'water', header: t('planFact.water'), align: 'right', mobile: 'hidden', cell: (r) => `${formatNumber(r.waterM3)} ${t('unit.m3')}` },
    ...money,
  ];

  return (
    <div className="space-y-4">
      {rows.length > 0 && (
        <ChartCard
          title={t('planFact.chartTitle')}
          kind="bar"
          data={rows.map((r) => ({ field: `№${r.fieldNumber}`, expected: r.expectedHarvestT ?? 0, harvested: r.harvestedT }))}
          xKey="field"
          series={[
            { key: 'expected', label: t('planFact.expected') },
            { key: 'harvested', label: t('planFact.harvested') },
          ]}
          formatValue={(v) => formatQty(v, 't')}
          height={240}
        />
      )}
      <DataTableView<PlanFactRow>
        rows={rows}
        columns={columns}
        rowKey={(r) => r.planId}
        loading={isLoading}
        error={error ?? undefined}
        onRetry={() => void refetch()}
        empty={{ icon: BarChart3, title: t('planFact.emptyTitle'), description: t('planFact.emptyBody') }}
      />
      {!seesMoney && rows.length > 0 && <p className="text-sm text-muted-foreground">{t('planFact.noMoney')}</p>}
    </div>
  );
}
