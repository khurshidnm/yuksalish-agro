import { ArrowLeft, CircleCheck, Download, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable, ErrorCard, StatCard, useConfirm } from '@/components';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useApiMutation, useDetail } from '@/lib/query';
import { UploadButton } from './UploadButton';
import type { ImportCatalog, ImportJob, JobRow, ProblemGroup, RowStatus } from './types';

const STATUS_BADGE: Record<RowStatus, 'success' | 'info' | 'neutral' | 'danger'> = {
  new: 'success',
  update: 'info',
  skip: 'neutral',
  error: 'danger',
};

/** Columns shown in the rows table, so a row can be recognised without opening the file. */
const SHOWN_COLUMNS = 4;

function Problems({ title, groups, tone }: { title: string; groups: ProblemGroup[]; tone: 'danger' | 'warning' }) {
  const { t } = useTranslation('import');
  if (groups.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {groups.map((group) => {
            const rows = group.rows.join(', ');
            return (
              <li key={`${group.column}|${group.message}`} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
                <Badge variant={tone} className="w-fit shrink-0">
                  {t('job.times', { count: group.count })}
                </Badge>
                <div className="min-w-0 text-sm">
                  <p className="break-words">{group.message}</p>
                  <p className="text-muted-foreground">
                    {t('job.rowsList', { rows: group.count > group.rows.length ? t('job.andMore', { rows }) : rows })}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function RowsTable({ job, catalog }: { job: ImportJob; catalog: ImportCatalog }) {
  const { t } = useTranslation('import');
  const counts = job.summary;
  const hasErrors = (counts.error ?? 0) > 0;
  const [status, setStatus] = useState<RowStatus | ''>(hasErrors ? 'error' : '');

  const template = catalog.templates.find((entry) => entry.key === job.template);
  const shown = (template?.columns ?? []).slice(0, SHOWN_COLUMNS);

  const columns: Column<JobRow>[] = [
    {
      key: 'row',
      header: t('job.rowNumber'),
      cell: (row) => (
        <>
          {/* On a phone the number is a card title with no column header above it. */}
          <span className="md:hidden">{t('job.rowNumber')} </span>
          {row.row}
        </>
      ),
      mobile: 'title',
    },
    {
      key: 'status',
      header: t('job.status'),
      cell: (row) => <Badge variant={STATUS_BADGE[row.status]}>{t(`status.${row.status}`)}</Badge>,
      mobile: 'subtitle',
    },
    ...shown.map(
      (column): Column<JobRow> => ({
        key: column.key,
        header: t(`templates.${job.template}.columns.${column.key}.label`),
        cell: (row) => row.values[column.key] ?? '—',
      }),
    ),
    {
      key: 'reason',
      header: t('job.reason'),
      className: 'min-w-64 whitespace-normal',
      cell: (row) => {
        const lines = [...row.errors, ...row.warnings].map((item) => item.message);
        if (row.note) lines.push(row.note);
        return lines.length ? lines.map((line) => <p key={line}>{line}</p>) : '—';
      },
    },
  ];

  const filters: { value: RowStatus | ''; label: string; count?: number }[] = [
    { value: '', label: t('job.filterAll'), count: job.totalRows },
    { value: 'error', label: t('status.error'), count: counts.error },
    { value: 'new', label: t('status.new'), count: counts.new },
    { value: 'update', label: t('status.update'), count: counts.update },
    { value: 'skip', label: t('status.skip'), count: counts.skip },
  ];

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">{t('job.rowsTitle')}</h2>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('job.status')}>
        {filters
          .filter((filter) => filter.value === '' || (filter.count ?? 0) > 0)
          .map((filter) => (
            <Button
              key={filter.value || 'all'}
              size="sm"
              variant={status === filter.value ? 'primary' : 'outline'}
              aria-pressed={status === filter.value}
              onClick={() => setStatus(filter.value)}
            >
              {filter.label} ({formatNumber(filter.count ?? 0)})
            </Button>
          ))}
      </div>
      <DataTable<JobRow>
        path={`/import/jobs/${job.id}/rows`}
        params={{ status: status || undefined }}
        columns={columns}
        rowKey={(row) => String(row.row)}
        searchable={false}
        pageSize={50}
        urlPrefix="rows"
        empty={{ title: t('job.noRows') }}
      />
    </div>
  );
}

function ResultNotice({ job }: { job: ImportJob }) {
  const { t } = useTranslation('import');
  const { skip = 0, error = 0, pendingApproval = 0, pregnancies = 0 } = job.summary;
  return (
    <Alert tone="success" title={t('job.doneTitle', { count: job.importedRows })}>
      {skip > 0 && <p>{t('job.doneSkipped', { count: skip })}</p>}
      {pregnancies > 0 && <p>{t('job.donePregnancies', { count: pregnancies })}</p>}
      {pendingApproval > 0 && <p>{t('job.donePending', { count: pendingApproval })}</p>}
      {error > 0 && <p>{t('job.doneErrors', { count: error })}</p>}
    </Alert>
  );
}

interface JobPanelProps {
  jobId: string;
  catalog: ImportCatalog;
  onClose: () => void;
  onReplaced: (job: ImportJob) => void;
}

export function JobPanel({ jobId, catalog, onClose, onReplaced }: JobPanelProps) {
  const { t } = useTranslation('import');
  const confirm = useConfirm();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const path = `/import/jobs/${jobId}`;
  const { data: job, isLoading, error, refetch } = useDetail<ImportJob>(path);

  const importRows = useApiMutation<void>({
    mutationFn: () => api.post(`${path}/confirm`),
    invalidate: ['/import/jobs'],
  });
  const discard = useApiMutation<void>({
    mutationFn: () => api.post(`${path}/discard`),
    invalidate: ['/import/jobs'],
    onSuccess: onClose,
  });
  const downloadErrors = useApiMutation<void>({ mutationFn: () => api.download(`${path}/errors.xlsx`) });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !job) return <ErrorCard error={error} onRetry={refetch} />;

  const { new: fresh = 0, update = 0, skip = 0, error: failed = 0 } = job.summary;
  const writable = fresh + update;
  const open = job.status === 'preview';

  const askConfirm = async () => {
    const yes = await confirm({
      title: t('job.confirmTitle'),
      description: t('job.confirmText', { count: writable }),
      confirmLabel: t('job.confirm', { count: writable }),
    });
    if (yes) importRows.mutate();
  };

  const askDiscard = async () => {
    const yes = await confirm({
      title: t('job.discardTitle'),
      description: t('job.discardText'),
      confirmLabel: t('job.discard'),
      destructive: true,
    });
    if (yes) discard.mutate();
  };

  return (
    <div className="space-y-4">
      <div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeft aria-hidden />
          {t('job.back')}
        </Button>
        <h2 className="mt-2 text-xl font-semibold">{t('job.title', { template: t(`templates.${job.template}.title`) })}</h2>
        <p className="break-all text-sm text-muted-foreground">{t('job.file', { name: job.fileName })}</p>
      </div>

      {job.status === 'discarded' && <Alert tone="info">{t('job.discardedTitle')}</Alert>}
      {job.status === 'confirmed' && <ResultNotice job={job} />}

      {open && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label={t('job.count.new')} value={formatNumber(fresh)} hint={t('job.countHint.new')} tone="success" />
          <StatCard label={t('job.count.update')} value={formatNumber(update)} hint={t('job.countHint.update')} />
          <StatCard label={t('job.count.skip')} value={formatNumber(skip)} hint={t('job.countHint.skip')} />
          <StatCard
            label={t('job.count.error')}
            value={formatNumber(failed)}
            hint={t('job.countHint.error')}
            tone={failed > 0 ? 'danger' : 'neutral'}
          />
        </div>
      )}

      {open && failed > 0 && (
        <Alert tone="danger" title={t('job.hasErrorsTitle', { count: failed })}>
          {t('job.hasErrors')}
        </Alert>
      )}
      {open && writable === 0 && failed === 0 && <Alert tone="info">{t('job.nothing')}</Alert>}
      {uploadError && <Alert tone="danger">{uploadError}</Alert>}

      <div className="flex flex-wrap gap-2">
        {open && writable > 0 && (
          <Button loading={importRows.isPending} onClick={askConfirm}>
            <CircleCheck aria-hidden />
            {t('job.confirm', { count: writable })}
          </Button>
        )}
        {job.status !== 'discarded' && failed > 0 && (
          <>
            <UploadButton
              template={job.template}
              label={t('job.uploadAgain')}
              variant={open ? 'secondary' : 'primary'}
              onUploaded={onReplaced}
              onError={setUploadError}
            />
            <Button variant="outline" loading={downloadErrors.isPending} onClick={() => downloadErrors.mutate()}>
              <Download aria-hidden />
              {t('job.downloadErrors')}
            </Button>
          </>
        )}
        {job.status === 'confirmed' && (
          <>
            <Button variant={failed > 0 ? 'outline' : 'primary'} asChild>
              <Link to={job.link}>{t('job.openResult')}</Link>
            </Button>
            <Button variant="outline" onClick={onClose}>
              {t('job.another')}
            </Button>
          </>
        )}
        {open && (
          <Button variant="ghost" loading={discard.isPending} onClick={askDiscard}>
            <Trash2 aria-hidden />
            {t('job.discard')}
          </Button>
        )}
      </div>

      <Problems title={t('job.problems')} groups={job.errors} tone="danger" />
      <Problems title={t('job.notes')} groups={job.warnings} tone="warning" />
      {job.status !== 'discarded' && (open || failed > 0) && <RowsTable key={job.status} job={job} catalog={catalog} />}
    </div>
  );
}
