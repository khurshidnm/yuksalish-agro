import { Bug, Clock, HeartPulse, ShieldAlert, Syringe, Timer } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ErrorCard, StatCard } from '@/components';
import { Alert, Badge, Card } from '@/components/ui';
import { formatDate, formatNumber } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { cn } from '@/lib/utils';
import { HEALTH_PATH } from './options';
import type { VetToday } from './types';

function Task({ icon: Icon, to, tone, children, aside }: { icon: LucideIcon; to: string; tone: 'danger' | 'warning' | 'info'; children: ReactNode; aside?: ReactNode }) {
  const colour = { danger: 'text-danger', warning: 'text-warning', info: 'text-info' }[tone];
  return (
    <li>
      <Link to={to} className="focus-ring flex min-h-11 items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted">
        <Icon className={cn('size-5 shrink-0', colour)} aria-hidden />
        <span className="min-w-0 flex-1">{children}</span>
        {aside}
      </Link>
    </li>
  );
}

/** What needs doing today, above the tabs: a vet should not have to open each one to find out. */
export function TodayPanel() {
  const { t } = useTranslation('vet');
  const today = useDetail<VetToday>(`${HEALTH_PATH}/today`);

  if (today.error) return <ErrorCard error={today.error} onRetry={() => void today.refetch()} />;
  const data = today.data;
  const urgentVaccinations = data?.vaccinations.rows.filter((row) => row.state !== 'upcoming') ?? [];
  const nothingToDo =
    data && data.sick.animals === 0 && data.sick.open === 0 && urgentVaccinations.length === 0 && data.quarantine.endingSoon.length === 0 && data.courses.length === 0;

  return (
    <div className="mb-4 space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t('today.sick')}
          value={formatNumber(data?.sick.animals ?? null)}
          hint={data?.sick.open ? t('today.newReports', { count: data.sick.open }) : undefined}
          tone={data?.sick.animals ? 'danger' : 'neutral'}
          icon={HeartPulse}
          loading={today.isLoading}
          to="?tab=sick"
        />
        <StatCard
          label={t('today.vaccinationsOverdue')}
          value={formatNumber(data?.vaccinations.animals ?? null)}
          hint={data?.vaccinations.animals ? t('today.plansHint', { count: data.vaccinations.plans }) : undefined}
          tone={data && data.vaccinations.overdue > 0 ? 'danger' : 'neutral'}
          icon={Syringe}
          loading={today.isLoading}
          to="?tab=vaccinations"
        />
        <StatCard
          label={t('today.quarantine')}
          value={formatNumber(data?.quarantine.active ?? null)}
          tone={data?.quarantine.endingSoon.length ? 'warning' : 'neutral'}
          icon={ShieldAlert}
          loading={today.isLoading}
          to="?tab=quarantine"
        />
        <StatCard
          label={t('today.withdrawal')}
          value={formatNumber(data?.withdrawal.animals ?? null)}
          hint={t('today.withdrawalHint')}
          tone={data?.withdrawal.animals ? 'info' : 'neutral'}
          icon={Timer}
          loading={today.isLoading}
          to="?tab=withdrawal"
        />
      </div>

      {nothingToDo && (
        <Alert tone="success" title={t('today.allClear')}>
          {t('today.allClearBody')}
        </Alert>
      )}

      {data && !nothingToDo && (
        <Card className="p-3">
          <h2 className="px-2 pb-1 font-semibold">{t('today.todo', { date: formatDate(data.date) })}</h2>
          <ul>
            {data.sick.reports.map((report) => (
              <Task key={report.id} icon={HeartPulse} tone="danger" to="?tab=sick" aside={<Badge variant="danger">{t('today.sickBadge')}</Badge>}>
                <span className="font-medium">{report.tag}</span>
                {report.notes && <span className="block truncate text-sm text-muted-foreground">{report.notes}</span>}
              </Task>
            ))}
            {urgentVaccinations.map((row) => (
              <Task
                key={`${row.planId}-${row.herdId}-${row.dueDate}`}
                icon={Syringe}
                tone={row.state === 'overdue' ? 'danger' : 'warning'}
                to="?tab=vaccinations"
                aside={<Badge variant={row.state === 'overdue' ? 'danger' : 'warning'}>{row.state === 'overdue' ? t('vaccinations.daysOverdue', { count: row.daysOverdue }) : t('vaccinations.dueToday')}</Badge>}
              >
                <span className="font-medium">{row.planName}</span>
                <span className="block text-sm text-muted-foreground">
                  {row.herdName ?? t('vaccinations.noHerd')} · {t('common.head', { count: row.head })}
                </span>
              </Task>
            ))}
            {data.courses.map((course) => (
              <Task key={course.id} icon={Clock} tone="info" to="?tab=journal" aside={<Badge variant="info">{t('today.courseDay', { day: course.day, total: course.courseDays })}</Badge>}>
                <span className="font-medium">{course.tag ?? course.herdName}</span>
                <span className="block truncate text-sm text-muted-foreground">{[course.diagnosis, course.itemName].filter(Boolean).join(' · ')}</span>
              </Task>
            ))}
            {data.quarantine.endingSoon.map((row) => (
              <Task
                key={row.id}
                icon={Bug}
                tone="warning"
                to="?tab=quarantine"
                aside={<Badge variant="warning">{(row.daysLeft ?? 0) < 0 ? t('quarantine.expired') : t('quarantine.daysLeft', { count: row.daysLeft ?? 0 })}</Badge>}
              >
                <span className="font-medium">{row.tag}</span>
                <span className="block text-sm text-muted-foreground">{t('today.quarantineEnds')}</span>
              </Task>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
