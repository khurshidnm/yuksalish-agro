import { Bell, BellRing, CheckCheck, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useOpenableLink } from '@/app/canOpen';
import { EmptyState, ErrorCard, PageHeader, UrlTabs, useUrlParam } from '@/components';
import { Button, Card, Pagination, Skeleton, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useApiMutation, useList } from '@/lib/query';
import { cn } from '@/lib/utils';
import { NotificationSettings } from './NotificationSettings';
import type { NotificationRow } from './types';

const PATH = '/notifications';
const PAGE_SIZE = 25;

const SEVERITY_ICON = { urgent: OctagonAlert, attention: TriangleAlert, info: Info };
const SEVERITY_TEXT = { urgent: 'text-danger', attention: 'text-warning', info: 'text-info' };

function Inbox() {
  const { t, i18n } = useTranslation('alerts');
  const navigate = useNavigate();
  const openable = useOpenableLink();
  const [page, setPage] = useUrlParam('page', '1');
  const [unread, setUnread] = useUrlParam('unread');

  const { data, isLoading, error, refetch } = useList<NotificationRow>(PATH, {
    page: Number(page),
    pageSize: PAGE_SIZE,
    unread: unread === '1' ? true : undefined,
    lang: i18n.language,
  });

  const read = useApiMutation<string>({
    mutationFn: (id) => api.post(`${PATH}/${id}/read`),
    invalidate: [PATH],
  });
  const readAll = useApiMutation<void, { updated: number }>({
    mutationFn: () => api.post(`${PATH}/read-all`),
    invalidate: [PATH],
  });

  const open = (row: NotificationRow) => {
    if (!row.readAt) read.mutate(row.id);
    const to = openable(row.link);
    if (to) navigate(to);
  };

  const rows = data?.data ?? [];

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <Switch checked={unread === '1'} onCheckedChange={(on) => setUnread(on ? '1' : '')} />
          {t('inbox.unreadOnly')}
        </label>
        <Button variant="outline" loading={readAll.isPending} onClick={() => readAll.mutate()}>
          <CheckCheck aria-hidden />
          {t('inbox.markAll')}
        </Button>
      </div>

      {isLoading && <Skeleton className="h-64 w-full" />}
      {error && <ErrorCard error={error} onRetry={() => void refetch()} />}

      {data && rows.length === 0 && (
        <Card>
          <EmptyState icon={Bell} title={t('inbox.emptyTitle')} description={t('inbox.emptyBody')} />
        </Card>
      )}

      {rows.length > 0 && (
        <Card className="divide-y divide-border overflow-hidden">
          {rows.map((row) => {
            const Icon = SEVERITY_ICON[row.severity];
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => open(row)}
                className={cn('focus-ring flex min-h-14 w-full items-start gap-3 p-3 text-left hover:bg-muted', !row.readAt && 'bg-secondary/50')}
              >
                <Icon className={cn('mt-0.5 size-5 shrink-0', SEVERITY_TEXT[row.severity])} aria-label={t(`enums:severity.${row.severity}`)} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block break-words', !row.readAt && 'font-semibold')}>{row.title}</span>
                  {row.body && <span className="block text-sm whitespace-pre-line text-muted-foreground">{row.body}</span>}
                  <span className="mt-0.5 block text-xs text-muted-foreground">{formatDateTime(row.createdAt)}</span>
                </span>
                {!row.readAt && <span className="mt-2 size-2.5 shrink-0 rounded-full bg-primary" aria-label={t('inbox.unread')} />}
              </button>
            );
          })}
        </Card>
      )}

      {data && data.meta.total > PAGE_SIZE && (
        <div className="mt-3">
          <Pagination page={Number(page)} pageSize={PAGE_SIZE} total={data.meta.total} onPageChange={(next) => setPage(String(next))} />
        </div>
      )}
    </>
  );
}

export default function NotificationsPage() {
  const { t } = useTranslation('alerts');
  return (
    <>
      <PageHeader title={t('inbox.title')} description={t('inbox.description')} />
      <UrlTabs
        tabs={[
          { value: 'inbox', label: t('inbox.tab'), content: <Inbox /> },
          {
            value: 'settings',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <BellRing className="size-4" aria-hidden />
                {t('settings.tab')}
              </span>
            ),
            content: <NotificationSettings />,
          },
        ]}
      />
    </>
  );
}
