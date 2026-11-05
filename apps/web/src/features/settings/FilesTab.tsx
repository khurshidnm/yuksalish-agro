import { MAX_UPLOAD_BYTES } from '@yap/shared';
import { FileCheck, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable, ErrorCard, useConfirm } from '@/components';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Meter, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useApiMutation, useDetail } from '@/lib/query';

const USAGE = '/files/usage';
const UNUSED = '/files/unused';
const MB = 1024 * 1024;

interface Usage {
  usedMb: number;
  quotaMb: number;
  uploadedTodayMb: number;
  dailyUploadMb: number;
}

interface UnusedFile {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
}

function UsageLine({ label, used, limit }: { label: string; used: number; limit: number }) {
  const { t } = useTranslation('settings');
  const percent = (used / limit) * 100;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">{t('files.usedOf', { used: formatNumber(used, 0), limit: formatNumber(limit, 0) })}</span>
      </div>
      <Meter value={percent} label={label} tone={percent >= 100 ? 'danger' : percent >= 80 ? 'warning' : 'primary'} />
    </div>
  );
}

/** What the "storage is full" message sends people to: how full it is, and what can go. */
export function FilesTab() {
  const { t } = useTranslation('settings');
  const canManageAll = useCan()('settings.update');
  const confirm = useConfirm();
  const usage = useDetail<Usage>(USAGE);
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`/files/${id}`),
    invalidate: [UNUSED, USAGE],
    successMessage: 'settings:files.deleted',
  });

  const columns: Column<UnusedFile>[] = [
    { key: 'name', header: t('files.name'), cell: (row) => <span className="break-all">{row.name}</span>, mobile: 'title' },
    { key: 'sizeBytes', header: t('files.size'), cell: (row) => t('files.sizeMb', { size: formatNumber(row.sizeBytes / MB) }), align: 'right', mobile: 'subtitle' },
    { key: 'createdAt', header: t('files.uploaded'), cell: (row) => formatDateTime(row.createdAt) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('files.usageTitle')}</CardTitle>
          <CardDescription>{t('files.usageHint', { maxMb: MAX_UPLOAD_BYTES / MB })}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {usage.error ? (
            <ErrorCard error={usage.error} onRetry={() => void usage.refetch()} />
          ) : usage.data ? (
            <>
              <UsageLine label={t('files.stored')} used={usage.data.usedMb} limit={usage.data.quotaMb} />
              <UsageLine label={t('files.uploadedToday')} used={usage.data.uploadedTodayMb} limit={usage.data.dailyUploadMb} />
            </>
          ) : (
            <Skeleton className="h-20 w-full rounded-xl" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('files.unusedTitle')}</CardTitle>
          <CardDescription>{t(canManageAll ? 'files.unusedHintAll' : 'files.unusedHintOwn')}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable<UnusedFile>
            path={UNUSED}
            columns={columns}
            searchable={false}
            urlPrefix="f"
            empty={{ icon: FileCheck, title: t('files.emptyTitle'), description: t('files.emptyBody') }}
            rowActions={(row) => [
              {
                label: t('files.delete'),
                icon: Trash2,
                destructive: true,
                onClick: () =>
                  void confirm({ title: t('files.deleteTitle'), description: row.name, destructive: true }).then((ok) => ok && remove.mutate(row.id)),
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
