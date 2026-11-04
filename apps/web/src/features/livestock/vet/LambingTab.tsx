import { Baby } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components';
import { Badge } from '@/components/ui';
import { usePermission } from '@/lib/auth';
import { formatDate, formatQty } from '@/lib/format';
import { LambingForm } from './LambingForm';
import { LAMBINGS_PATH } from './options';
import type { Lambing } from './types';

export function LambingTab() {
  const { t } = useTranslation('vet');
  const canRecord = usePermission('livestock.create');
  const canRecordVet = usePermission('health.update');
  const [params, setParams] = useSearchParams();

  const eweId = params.get('ewe');
  const tag = params.get('tag');
  const preset = useMemo(() => (eweId && tag ? { id: eweId, tag } : null), [eweId, tag]);

  const clearPreset = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('ewe');
        next.delete('tag');
        return next;
      },
      { replace: true },
    );

  const columns: Column<Lambing>[] = [
    {
      key: 'tag',
      header: t('common.ewe'),
      mobile: 'title',
      cell: (row) => (
        <Link className="font-medium text-primary hover:underline" to={`/livestock/animals/${row.eweId}`}>
          {row.eweTag}
        </Link>
      ),
    },
    { key: 'date', header: t('common.date'), sortable: true, mobile: 'subtitle', cell: (row) => formatDate(row.date) },
    {
      key: 'lambs',
      header: t('lambing.lambs'),
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          {row.lambs.map((lamb, index) =>
            lamb.animalId ? (
              <Link key={lamb.animalId} to={`/livestock/animals/${lamb.animalId}`} className="text-primary hover:underline">
                {lamb.tag}
                {lamb.birthWeightKg ? ` (${formatQty(lamb.birthWeightKg, 'kg')})` : ''}
              </Link>
            ) : (
              <Badge key={index} variant="danger">
                {t('lambing.stillborn')}
              </Badge>
            ),
          )}
        </span>
      ),
    },
    { key: 'born', header: t('lambing.bornAlive'), align: 'right', cell: (row) => `${row.lambsAlive} / ${row.lambsBorn}` },
    { key: 'complications', header: t('lambing.complications'), mobile: 'hidden', cell: (row) => row.complications ?? '—' },
    { key: 'herd', header: t('common.herd'), mobile: 'hidden', cell: (row) => row.herdName ?? '—' },
  ];

  return (
    <div className="space-y-4">
      {(canRecord || canRecordVet) && <LambingForm presetEwe={preset} onDone={clearPreset} />}
      <h2 className="text-lg font-semibold">{t('lambing.recent')}</h2>
      <DataTable<Lambing>
        path={LAMBINGS_PATH}
        urlPrefix="l"
        columns={columns}
        defaultSort="-date"
        searchPlaceholder={t('common.searchTag')}
        empty={{ icon: Baby, title: t('lambing.emptyTitle'), description: t('lambing.emptyBody') }}
      />
    </div>
  );
}
