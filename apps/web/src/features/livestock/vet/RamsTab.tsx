import { Medal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTableView, ErrorCard } from '@/components';
import { Alert, Badge, type BadgeVariant } from '@/components/ui';
import { formatNumber, formatQty } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { BREEDING_PATH } from './options';
import type { RamRow } from './types';

interface RamRating {
  farmAvgGainGrams: number | null;
  rams: RamRow[];
}

function indexTone(index: number): BadgeVariant {
  if (index >= 105) return 'success';
  if (index <= 95) return 'warning';
  return 'neutral';
}

export function RamsTab() {
  const { t } = useTranslation('vet');
  const rating = useDetail<RamRating>(`${BREEDING_PATH}/rams`);

  if (rating.error) return <ErrorCard error={rating.error} onRetry={() => void rating.refetch()} />;

  const columns: Column<RamRow>[] = [
    { key: 'rank', header: t('rams.rank'), align: 'right', cell: (row) => row.rank ?? '—' },
    {
      key: 'tag',
      header: t('common.ram'),
      mobile: 'title',
      cell: (row) => (
        <Link className="font-medium text-primary hover:underline" to={`/livestock/animals/${row.ramId}`}>
          {row.tag}
        </Link>
      ),
    },
    {
      key: 'index',
      header: t('rams.index'),
      mobile: 'subtitle',
      cell: (row) =>
        row.index === null ? (
          t('rams.noData')
        ) : (
          <span className="flex flex-wrap items-center gap-1">
            <Badge variant={indexTone(row.index)}>{formatNumber(row.index, 1)}</Badge>
            {row.lowConfidence && <Badge variant="outline">{t('rams.lowConfidence')}</Badge>}
          </span>
        ),
    },
    { key: 'progeny', header: t('rams.progeny'), align: 'right', cell: (row) => t('rams.progenyCount', { count: row.progeny, weighed: row.weighed }) },
    { key: 'gain', header: t('rams.gain'), align: 'right', cell: (row) => (row.avgGainGrams === null ? '—' : t('rams.gainValue', { value: formatNumber(row.avgGainGrams) })) },
    { key: 'weight', header: t('kpis.weight100'), align: 'right', mobile: 'hidden', cell: (row) => formatQty(row.avgWeight100Kg, 'kg') },
  ];

  return (
    <div className="space-y-4">
      <Alert tone="info">
        {t('rams.explain')}
        {rating.data?.farmAvgGainGrams != null && ` ${t('rams.farmAverage', { value: formatNumber(rating.data.farmAvgGainGrams) })}`}
      </Alert>
      <DataTableView
        rows={rating.data?.rams ?? []}
        rowKey={(row) => row.ramId}
        columns={columns}
        loading={rating.isLoading}
        empty={{ icon: Medal, title: t('rams.emptyTitle'), description: t('rams.emptyBody') }}
      />
    </div>
  );
}
