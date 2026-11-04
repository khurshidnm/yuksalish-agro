import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable } from '@/components';
import { Alert, Badge } from '@/components/ui';
import { formatDate } from '@/lib/format';
import { HEALTH_PATH } from './options';
import type { WithdrawalRow } from './types';

export function WithdrawalTab() {
  const { t } = useTranslation('vet');

  const columns: Column<WithdrawalRow>[] = [
    {
      key: 'tag',
      header: t('common.animal'),
      mobile: 'title',
      cell: (row) => (
        <Link className="font-medium text-primary hover:underline" to={`/livestock/animals/${row.animalId}`}>
          {row.tag}
        </Link>
      ),
    },
    { key: 'until', header: t('withdrawal.until'), mobile: 'subtitle', cell: (row) => formatDate(row.withdrawalUntil) },
    { key: 'left', header: t('withdrawal.left'), cell: (row) => <Badge variant={row.daysLeft <= 3 ? 'warning' : 'info'}>{t('quarantine.daysLeft', { count: row.daysLeft })}</Badge> },
    { key: 'drug', header: t('journal.drug'), cell: (row) => row.drug ?? '—' },
    { key: 'herd', header: t('common.herd'), mobile: 'hidden', cell: (row) => row.herdName ?? '—' },
  ];

  return (
    <div className="space-y-3">
      <Alert tone="warning">{t('withdrawal.explain')}</Alert>
      <DataTable<WithdrawalRow>
        path={`${HEALTH_PATH}/withdrawal`}
        urlPrefix="w"
        columns={columns}
        rowKey={(row) => row.animalId}
        searchPlaceholder={t('common.searchTag')}
        empty={{ icon: ShieldCheck, title: t('withdrawal.emptyTitle'), description: t('withdrawal.emptyBody') }}
      />
    </div>
  );
}
