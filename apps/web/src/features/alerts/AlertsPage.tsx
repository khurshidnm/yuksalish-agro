import { ALERT_STATUSES, SEVERITIES } from '@yap/shared';
import { BellOff, Check, CheckCheck, ExternalLink, Info, OctagonAlert, RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useOpenableLink } from '@/app/canOpen';
import { type Column, DataTable, PageHeader, StatCard, useUrlParam } from '@/components';
import { Badge, type BadgeVariant, Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { alertText } from './alertText';
import type { Alert, AlertCounts, EvaluationResult } from './types';

const SEVERITY_TONE: Record<Alert['severity'], BadgeVariant> = { urgent: 'danger', attention: 'warning', info: 'info' };
const SEVERITY_ICON = { urgent: OctagonAlert, attention: TriangleAlert, info: Info };
const STATUS_TONE: Record<Alert['status'], BadgeVariant> = { open: 'neutral', acknowledged: 'info', resolved: 'success' };

/** Default view: everything not yet resolved. */
const ACTIVE = 'active';

export default function AlertsPage() {
  const { t } = useTranslation('alerts');
  const navigate = useNavigate();
  const canAct = usePermission('tasks.update');
  const canEvaluate = usePermission('dashboard.update');
  const openable = useOpenableLink();

  const [status, setStatus] = useUrlParam('status', ACTIVE);
  const [severity, setSeverity] = useUrlParam('severity');

  const counts = useDetail<AlertCounts>('/alerts/counts');

  const acknowledge = useApiMutation<string>({
    mutationFn: (id) => api.post(`/alerts/${id}/acknowledge`),
    invalidate: ['/alerts'],
    successMessage: 'alerts:toast.acknowledged',
  });
  const resolve = useApiMutation<string>({
    mutationFn: (id) => api.post(`/alerts/${id}/resolve`),
    invalidate: ['/alerts'],
    successMessage: 'alerts:toast.resolved',
  });
  const evaluate = useApiMutation<void, EvaluationResult>({
    mutationFn: () => api.post('/alerts/evaluate'),
    invalidate: ['/alerts', '/notifications'],
    onSuccess: (result) => toast.success(t('toast.evaluated', { raised: result.raised, resolved: result.resolved })),
  });

  const columns: Column<Alert>[] = [
    {
      key: 'severity',
      header: t('fields.severity'),
      mobile: 'subtitle',
      cell: (alert) => {
        const Icon = SEVERITY_ICON[alert.severity];
        return (
          <Badge variant={SEVERITY_TONE[alert.severity]}>
            <Icon aria-hidden />
            {t(`enums:severity.${alert.severity}`)}
          </Badge>
        );
      },
    },
    {
      key: 'title',
      header: t('fields.alert'),
      mobile: 'title',
      cell: (alert) => {
        const { title, body } = alertText(alert, t);
        return (
          <div className="min-w-0">
            <p className="font-medium break-words">{title}</p>
            {body && <p className="text-sm font-normal text-muted-foreground">{body}</p>}
          </div>
        );
      },
    },
    { key: 'lastSeenAt', header: t('fields.lastSeen'), sortable: true, cell: (alert) => formatDateTime(alert.lastSeenAt) },
    {
      key: 'status',
      header: t('fields.status'),
      cell: (alert) => <Badge variant={STATUS_TONE[alert.status]}>{t(`enums:alertStatus.${alert.status}`)}</Badge>,
    },
  ];

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          canEvaluate && (
            <Button variant="outline" loading={evaluate.isPending} onClick={() => evaluate.mutate()}>
              <RefreshCw aria-hidden />
              {t('evaluate')}
            </Button>
          )
        }
      />

      {/* Each column takes its word's width: equal thirds leave 72 px at 360, and the word for urgent needs 75. */}
      <div className="mb-4 grid grid-cols-[auto_auto_auto] gap-2 md:grid-cols-3 md:gap-4">
        {SEVERITIES.slice()
          .reverse()
          .map((level) => (
            <StatCard
              key={level}
              label={t(`stat.${level}`)}
              value={counts.data?.[level] ?? '—'}
              loading={counts.isLoading}
              className="max-sm:p-3"
              tone={level === 'urgent' && (counts.data?.urgent ?? 0) > 0 ? 'danger' : level === 'attention' && (counts.data?.attention ?? 0) > 0 ? 'warning' : undefined}
            />
          ))}
      </div>

      <DataTable<Alert>
        path="/alerts"
        params={{
          active: status === ACTIVE ? true : undefined,
          status: status === ACTIVE ? undefined : status,
          severity: severity || undefined,
        }}
        columns={columns}
        searchable={false}
        rowHref={(alert) => openable(alert.link)}
        filters={
          <>
            <Select
              aria-label={t('fields.status')}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={[{ value: ACTIVE, label: t('filters.active') }, ...enumOptions('alertStatus', ALERT_STATUSES)]}
              className="md:w-52"
            />
            <Select
              aria-label={t('fields.severity')}
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              options={enumOptions('severity', SEVERITIES)}
              placeholder={t('filters.allSeverities')}
              className="md:w-48"
            />
          </>
        }
        empty={{ icon: BellOff, title: t('emptyTitle'), description: t('emptyBody') }}
        rowActions={(alert) => [
          { label: t('actions.open'), icon: ExternalLink, hidden: !openable(alert.link), onClick: () => navigate(alert.link!) },
          {
            label: t('actions.acknowledge'),
            icon: Check,
            hidden: !canAct || alert.status !== 'open',
            onClick: () => acknowledge.mutate(alert.id),
          },
          {
            label: t('actions.resolve'),
            icon: CheckCheck,
            hidden: !canAct || alert.status === 'resolved',
            onClick: () => resolve.mutate(alert.id),
          },
        ]}
      />
    </>
  );
}
