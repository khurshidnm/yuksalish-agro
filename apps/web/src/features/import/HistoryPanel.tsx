import { History } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable } from '@/components';
import { Badge } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import type { JobListItem, JobStatus } from './types';

const STATE_BADGE: Record<JobStatus, 'warning' | 'success' | 'neutral'> = {
  preview: 'warning',
  confirmed: 'success',
  discarded: 'neutral',
};

export function HistoryPanel() {
  const { t } = useTranslation('import');

  const columns: Column<JobListItem>[] = [
    { key: 'template', header: t('history.template'), cell: (row) => t(`templates.${row.template}.title`), mobile: 'title' },
    {
      key: 'status',
      header: t('history.status'),
      cell: (row) => <Badge variant={STATE_BADGE[row.status]}>{t(`history.state.${row.status}`)}</Badge>,
      mobile: 'subtitle',
    },
    { key: 'createdAt', header: t('history.date'), cell: (row) => formatDateTime(row.createdAt) },
    { key: 'fileName', header: t('history.file'), cell: (row) => <span className="break-all">{row.fileName}</span> },
    { key: 'totalRows', header: t('history.rows'), cell: (row) => formatNumber(row.totalRows), align: 'right' },
    { key: 'importedRows', header: t('history.imported'), cell: (row) => formatNumber(row.importedRows), align: 'right' },
    { key: 'createdByName', header: t('history.by'), cell: (row) => row.createdByName ?? '—', mobile: 'hidden' },
  ];

  return (
    <DataTable<JobListItem>
      path="/import/jobs"
      columns={columns}
      searchable={false}
      urlPrefix="history"
      rowHref={(row) => `/import?job=${row.id}`}
      empty={{ icon: History, title: t('history.empty'), description: t('history.emptyHint') }}
    />
  );
}
