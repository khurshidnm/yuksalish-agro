import { LAMBING_DESK } from '@yap/shared/formulas/lambing';
import { Baby, CalendarClock, Clock4, DoorOpen, Milk, Moon, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { type Column, DataTableView, ErrorCard, StatCard } from '@/components';
import { Badge } from '@/components/ui';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { LambCareDialog, useCanRecordCare } from './LambCare';
import { DESK_PATH } from './options';
import { PensPanel } from './PensPanel';
import type { AttentionLamb, LambingDesk, WatchEwe } from './types';

const LINK = 'relative font-medium text-primary after:absolute after:inset-x-0 after:-inset-y-3 hover:underline';

function DueBadge({ ewe }: { ewe: WatchEwe }) {
  const { t } = useTranslation('vet');
  if (ewe.overdue) return <Badge variant="danger">{t('desk.overdue')}</Badge>;
  if (ewe.daysLeft < 0) return <Badge variant="warning">{t('pregnancies.daysLate', { count: -ewe.daysLeft })}</Badge>;
  if (ewe.daysLeft === 0) return <Badge variant="warning">{t('desk.dueToday')}</Badge>;
  return <Badge variant={ewe.daysLeft <= 7 ? 'warning' : 'info'}>{t('pregnancies.daysLeft', { count: ewe.daysLeft })}</Badge>;
}

/** What she brings from earlier lambings on this farm: nothing on record, or what went wrong. */
function History({ ewe }: { ewe: WatchEwe }) {
  const { t } = useTranslation('vet');
  if (ewe.firstLambing) return <Badge variant="warning">{t('desk.firstLambing')}</Badge>;
  if (ewe.complications.length === 0 && ewe.stillborn === 0) return <>—</>;
  return (
    <span className="flex flex-col gap-0.5">
      {ewe.complications.map((item) => (
        <span key={`${item.date}-${item.text}`} className="flex items-start gap-1 text-danger">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">
            {formatDate(item.date)}: {item.text}
          </span>
        </span>
      ))}
      {ewe.stillborn > 0 && <span className="text-danger">{t('desk.lostBefore', { n: ewe.stillborn })}</span>}
    </span>
  );
}

const place = (parts: (string | null)[]) => parts.filter(Boolean).join(' · ') || '—';

/** The lambing season on one screen: who is due, which lambs need a person, and the pens. */
export function DeskTab() {
  const { t } = useTranslation('vet');
  const navigate = useNavigate();
  const canRecord = usePermission('livestock.create');
  const canRecordVet = usePermission('health.update');
  const canCare = useCanRecordCare();
  const desk = useDetail<LambingDesk>(DESK_PATH);
  const [caring, setCaring] = useState<{ id: string; tag: string } | null>(null);

  if (desk.error && !desk.data) return <ErrorCard error={desk.error} onRetry={() => void desk.refetch()} />;

  const data = desk.data;
  const counts = data?.counts;
  const loading = desk.isLoading;

  const watchColumns: Column<WatchEwe>[] = [
    {
      key: 'tag',
      header: t('common.ewe'),
      mobile: 'title',
      cell: (row) => (
        <Link className={LINK} to={`/livestock/animals/${row.eweId}`}>
          {row.tag}
        </Link>
      ),
    },
    {
      key: 'due',
      header: t('desk.due'),
      mobile: 'subtitle',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          {formatDate(row.expectedDate)}
          <DueBadge ewe={row} />
        </span>
      ),
    },
    { key: 'scan', header: t('desk.scan'), align: 'right', cell: (row) => (row.fetusCount === null ? t('scan.notScanned') : formatNumber(row.fetusCount)) },
    { key: 'history', header: t('desk.history'), cell: (row) => <History ewe={row} /> },
    {
      key: 'where',
      header: t('desk.where'),
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          {place([row.herdName, row.barnName, row.facilityName])}
          {row.inPen && <Badge variant="neutral">{t('desk.inPen')}</Badge>}
        </span>
      ),
    },
  ];

  const attentionColumns: Column<AttentionLamb>[] = [
    {
      key: 'tag',
      header: t('desk.lamb'),
      mobile: 'title',
      cell: (row) => (
        <Link className={LINK} to={`/livestock/animals/${row.lambId}`}>
          {row.tag}
        </Link>
      ),
    },
    {
      key: 'reasons',
      header: t('desk.reason'),
      mobile: 'subtitle',
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          {row.reasons.map((reason) => (
            <Badge key={reason} variant={reason === 'no_colostrum' ? 'danger' : 'warning'}>
              {t(`desk.reasons.${reason}`)}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      key: 'age',
      header: t('desk.age'),
      align: 'right',
      // Hours while they matter, days after: a week-old bottle lamb is not "170 hours".
      cell: (row) => (row.ageDays >= 2 ? t('common.dayCount', { count: row.ageDays }) : t('desk.hours', { n: formatNumber(row.hoursOld) })),
    },
    {
      key: 'dam',
      header: t('desk.dam'),
      cell: (row) =>
        row.damId ? (
          <Link className="text-primary hover:underline" to={`/livestock/animals/${row.damId}`}>
            {row.damTag}
          </Link>
        ) : (
          '—'
        ),
    },
    { key: 'where', header: t('desk.where'), cell: (row) => place([row.herdName, row.facilityName]) },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label={t('desk.dueThisWeek')}
          value={formatNumber(counts?.dueThisWeek ?? null)}
          tone={counts && counts.dueThisWeek > 0 ? 'warning' : 'neutral'}
          icon={CalendarClock}
          loading={loading}
        />
        <StatCard
          label={t('desk.overdue')}
          value={formatNumber(counts?.overdue ?? null)}
          hint={t('calendar.overdueHint')}
          tone={counts && counts.overdue > 0 ? 'danger' : 'neutral'}
          icon={Clock4}
          loading={loading}
        />
        <StatCard
          label={t('desk.lambedToday')}
          value={formatNumber(counts?.lambedToday ?? null)}
          hint={counts ? t('desk.lambsToday', { n: counts.lambsToday }) : undefined}
          tone="success"
          icon={Baby}
          loading={loading}
        />
        <StatCard
          label={t('desk.attention')}
          value={formatNumber(counts?.lambsNeedingAttention ?? null)}
          tone={counts && counts.lambsNeedingAttention > 0 ? 'danger' : 'neutral'}
          icon={Milk}
          loading={loading}
        />
        {/* With no pen marked there is nothing to count: a dash, not "0 free". */}
        <StatCard
          label={t('desk.pensFree')}
          value={formatNumber(counts && counts.pensTotal > 0 ? counts.pensFree : null)}
          hint={counts ? t(counts.pensTotal > 0 ? 'desk.pensOf' : 'desk.noPens', { total: counts.pensTotal }) : undefined}
          icon={DoorOpen}
          loading={loading}
        />
      </div>

      <section className="space-y-3" aria-label={t('desk.watchTitle')}>
        <div>
          <h2 className="text-lg font-semibold">{t('desk.watchTitle')}</h2>
          {data && <p className="text-sm text-muted-foreground">{t('desk.watchHint', { n: data.limits.watchDays })}</p>}
        </div>
        <DataTableView<WatchEwe>
          rows={data?.watch ?? []}
          columns={watchColumns}
          rowKey={(row) => row.breedingId}
          loading={loading}
          rowActions={
            canRecord || canRecordVet
              ? (row) => [
                  {
                    label: t('desk.recordLambing'),
                    icon: Baby,
                    onClick: () => void navigate(`/livestock/breeding?tab=lambing&ewe=${row.eweId}&tag=${encodeURIComponent(row.tag)}`),
                  },
                ]
              : undefined
          }
          empty={{ icon: Moon, title: t('desk.watchEmptyTitle'), description: t('desk.watchEmptyBody', { n: data?.limits.watchDays }) }}
        />
      </section>

      <section className="space-y-3" aria-label={t('desk.attentionTitle')}>
        <div>
          <h2 className="text-lg font-semibold">{t('desk.attentionTitle')}</h2>
          {data && <p className="text-sm text-muted-foreground">{t('desk.attentionHint', { hours: data.limits.colostrumHours })}</p>}
        </div>
        <DataTableView<AttentionLamb>
          rows={data?.attention ?? []}
          columns={attentionColumns}
          rowKey={(row) => row.lambId}
          loading={loading}
          rowActions={canCare ? (row) => [{ label: t('care.record'), icon: Milk, onClick: () => setCaring({ id: row.lambId, tag: row.tag }) }] : undefined}
          empty={{ icon: Milk, title: t('desk.attentionEmptyTitle'), description: t('desk.attentionEmptyBody') }}
        />
      </section>

      <PensPanel pens={data?.pens} penDays={data?.limits.penDays ?? LAMBING_DESK.penDays} />

      <LambCareDialog lamb={caring} onOpenChange={(open) => !open && setCaring(null)} />
    </div>
  );
}
