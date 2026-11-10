import { addDays, todayIso } from '@yap/shared';
import { CalendarClock, CalendarDays, Clock4, Sprout } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTableView, ErrorCard, StatCard, useUrlParam } from '@/components';
import { Select } from '@/components/ui';
import { ChartCard } from '@/components/ChartCard';
import { formatDate, formatNumber } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { BREEDING_PATH } from './options';
import type { LambingCalendar } from './types';

const dayMonth = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

export function CalendarTab() {
  const { t } = useTranslation('vet');
  const calendar = useDetail<LambingCalendar>(`${BREEDING_PATH}/calendar`);
  const [view, setView] = useUrlParam('cView', 'weeks');

  if (calendar.error) return <ErrorCard error={calendar.error} onRetry={() => void calendar.refetch()} />;

  const data = calendar.data;
  const today = todayIso();
  const nextWeek = addDays(today, 7);
  const soon = data?.days.filter((d) => d.date <= nextWeek).reduce((sum, d) => sum + d.expected, 0) ?? 0;

  const byDay = view === 'days';
  // Lambing spreads over weeks, so a row per day is a long scroll on a phone unless asked for.
  const rows = byDay ? (data?.days ?? []) : (data?.weeks ?? []).map((w) => ({ date: w.week, expected: w.expected }));

  const columns: Column<{ date: string; expected: number }>[] = [
    {
      key: 'date',
      header: byDay ? t('calendar.date') : t('calendar.week'),
      mobile: 'title',
      cell: (row) => (byDay ? formatDate(row.date) : t('calendar.weekOf', { date: formatDate(row.date) })),
    },
    { key: 'expected', header: t('calendar.expectedEwes'), align: 'right', mobile: 'subtitle', cell: (row) => t('common.head', { count: row.expected }) },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('calendar.totalEwes')} value={formatNumber(data?.totalEwes ?? null)} icon={CalendarDays} loading={calendar.isLoading} />
        <StatCard label={t('calendar.nextWeek')} value={formatNumber(data ? soon : null)} tone={soon > 0 ? 'warning' : 'neutral'} icon={CalendarClock} loading={calendar.isLoading} />
        <StatCard
          label={t('calendar.overdue')}
          value={formatNumber(data?.overdue ?? null)}
          hint={t('calendar.overdueHint')}
          tone={data && data.overdue > 0 ? 'danger' : 'neutral'}
          icon={Clock4}
          loading={calendar.isLoading}
        />
        {/* Before the farm's own first lambing, the outlook's stated assumption gives an estimate, marked as one. */}
        <StatCard
          label={t('calendar.expectedLambs')}
          value={
            data?.expectedLambs != null
              ? formatNumber(data.expectedLambs)
              : data?.assumedLambs != null
                ? `≈${formatNumber(data.assumedLambs)}`
                : formatNumber(null)
          }
          hint={
            data && data.expectedLambs === null && data.assumedLambs != null
              ? t('calendar.expectedLambsHint', { perEwe: formatNumber(data.assumedLambsPerEwe ?? null, 1) })
              : data?.scannedEwes
                ? t('calendar.scannedHint', { ewes: data.scannedEwes, fetuses: data.scannedFetuses ?? 0 })
                : undefined
          }
          icon={Sprout}
          loading={calendar.isLoading}
        />
      </div>

      <ChartCard
        title={t('calendar.byWeek')}
        description={t('calendar.byWeekHint')}
        kind="bar"
        data={data?.weeks ?? []}
        xKey="week"
        series={[{ key: 'expected', label: t('calendar.expectedEwes') }]}
        formatX={(week) => dayMonth(String(week))}
        formatLabel={(week) => t('calendar.weekOf', { date: formatDate(String(week)) })}
        loading={calendar.isLoading}
        emptyText={t('calendar.empty')}
      />

      {/* In a flex row the select's wrapper shrinks to the box, so its arrow stays inside it. */}
      <div className="flex flex-col gap-2 md:flex-row">
        <Select
          aria-label={t('calendar.viewLabel')}
          value={view}
          onChange={(e) => setView(e.target.value)}
          options={[
            { value: 'weeks', label: t('calendar.viewWeeks') },
            { value: 'days', label: t('calendar.viewDays') },
          ]}
          className="md:w-48"
        />
      </div>

      <DataTableView
        rows={rows}
        rowKey={(row) => row.date}
        columns={columns}
        loading={calendar.isLoading}
        empty={{ icon: CalendarDays, title: t('calendar.empty') }}
      />
    </div>
  );
}
