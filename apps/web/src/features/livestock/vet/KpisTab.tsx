import { Baby, HeartHandshake, Percent, Scale, Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable, ErrorCard, StatCard } from '@/components';
import { formatNumber, formatPercent, formatQty } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { BREEDING_PATH } from './options';
import type { EwePerformance, ReproductionKpis } from './types';

export function KpisTab() {
  const { t } = useTranslation('vet');
  const kpis = useDetail<ReproductionKpis>(`${BREEDING_PATH}/kpis`);

  if (kpis.error) return <ErrorCard error={kpis.error} onRetry={() => void kpis.refetch()} />;
  const data = kpis.data;

  const columns: Column<EwePerformance>[] = [
    {
      key: 'tag',
      header: t('common.ewe'),
      sortable: true,
      mobile: 'title',
      cell: (row) => (
        <Link className="font-medium text-primary hover:underline" to={`/livestock/animals/${row.id}`}>
          {row.tag}
        </Link>
      ),
    },
    { key: 'lambings', header: t('kpis.lambings'), align: 'right', cell: (row) => row.lambings },
    { key: 'lambsBorn', header: t('kpis.lambsBorn'), align: 'right', mobile: 'subtitle', cell: (row) => row.lambsBorn },
    { key: 'survival', header: t('kpis.survival'), align: 'right', cell: (row) => formatPercent(row.survivalPercent) },
    { key: 'weight', header: t('kpis.weight100'), align: 'right', cell: (row) => formatQty(row.avgWeight100Kg, 'kg') },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t('kpis.lambingPercent')}
          value={formatPercent(data?.lambingPercent ?? null)}
          hint={data && t('kpis.lambingPercentHint', { born: data.lambsBorn, ewes: data.ewesWithOutcome })}
          icon={Percent}
          loading={kpis.isLoading}
        />
        <StatCard label={t('kpis.survival')} value={formatPercent(data?.survivalPercent ?? null)} hint={t('kpis.survivalHint')} icon={HeartHandshake} loading={kpis.isLoading} />
        <StatCard
          label={t('kpis.lambsPerEwe')}
          value={formatNumber(data?.lambsPerEwe ?? null, 2)}
          hint={data && t('kpis.lambingsCount', { count: data.lambings })}
          icon={Baby}
          loading={kpis.isLoading}
        />
        <StatCard label={t('kpis.weight100')} value={formatQty(data?.avgWeight100Kg ?? null, 'kg')} hint={t('kpis.weight100Hint')} icon={Scale} loading={kpis.isLoading} />
      </div>
      <h2 className="text-lg font-semibold">{t('kpis.byEwe')}</h2>
      <DataTable<EwePerformance>
        path={`${BREEDING_PATH}/ewes`}
        urlPrefix="k"
        columns={columns}
        defaultSort="tag"
        searchPlaceholder={t('common.searchTag')}
        empty={{ icon: Trophy, title: t('kpis.emptyTitle'), description: t('kpis.emptyBody') }}
      />
    </div>
  );
}
