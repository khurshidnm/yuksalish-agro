import { CalendarClock, ClipboardCheck, Scale, TriangleAlert, Wheat } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ChartCard } from '@/components/ChartCard';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorCard, Meter, PageHeader, Skeleton, StatCard } from '@/components';
import { useSeesCost, useSession } from '@/lib/auth';
import { formatDate, formatMoney, formatNumber, formatQty } from '@/lib/format';
import { useDetail } from '@/lib/query';
import type { FeedBalanceRow, FeedPlan } from './types';
import { formatKg } from './format';

function tone(row: FeedBalanceRow): 'danger' | 'warning' | 'success' {
  if (row.belowMinimum) return 'danger';
  return row.days !== null && row.days < row.minDays * 2 ? 'warning' : 'success';
}

function FeedRow({ row, horizonDays }: { row: FeedBalanceRow; horizonDays: number }) {
  const { t } = useTranslation('feed');
  const percent = row.days === null ? null : (row.days / horizonDays) * 100;
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="min-w-0 font-medium break-words">{row.name}</p>
        <p className="text-lg font-semibold tabular-nums">
          {row.days === null ? t('balance.noData') : t('balance.days', { days: formatNumber(row.days, 0) })}
        </p>
      </div>
      <Meter value={percent} tone={tone(row)} label={t('balance.daysLabel', { name: row.name })} />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>{t('balance.stock', { qty: formatQty(row.stockQty, row.unit) })}</span>
        {row.basis && <span>{t(row.basis === 'actual' ? 'balance.byActual' : 'balance.byPlan')}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span>{t('balance.planned', { qty: formatQty(row.plannedDaily, row.unit) })}</span>
        <span>{t('balance.actual', { qty: formatQty(row.actualDaily, row.unit) })}</span>
        {row.actualDaysCovered !== null && <span className="text-muted-foreground">{t('balance.covered', { days: row.actualDaysCovered })}</span>}
        {row.belowMinimum && <Badge variant="danger">{t('balance.belowMinimum', { days: formatNumber(row.minDays, 0) })}</Badge>}
      </div>
    </li>
  );
}

function PlanSection({ plan, canSeeMoney }: { plan: FeedPlan; canSeeMoney: boolean }) {
  const { t } = useTranslation('feed');
  if (plan.herds.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{t('plan.title')}</h2>
      <div className="grid gap-4 md:grid-cols-2">
        {plan.herds.map((herd) => (
          <Card key={herd.herdId}>
            <CardHeader>
              <CardTitle className="break-words">{herd.herdName}</CardTitle>
              <CardDescription>{t('plan.summary', { head: formatNumber(herd.head, 0), ration: herd.rationName ?? '—' })}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <ul className="flex flex-col gap-1.5">
                {herd.lines.map((line) => (
                  <li key={line.itemId} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 break-words">{line.itemName}</span>
                    <span className="shrink-0 font-medium tabular-nums">{formatKg(line.dailyKg)}</span>
                  </li>
                ))}
              </ul>
              <dl className="flex flex-col gap-1 border-t border-border pt-3 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('plan.perDay')}</dt>
                  <dd className="font-medium tabular-nums">{formatKg(herd.dailyKg)}</dd>
                </div>
                {canSeeMoney && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('plan.costPerDay')}</dt>
                    <dd className="font-medium tabular-nums">{formatMoney(herd.costPerDay)}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

export default function FeedBalancePage() {
  const { t } = useTranslation('feed');
  const canSeeMoney = useSeesCost('feed.approve');
  const session = useSession();
  const balance = useDetail<FeedBalanceRow[]>('/feed/balance');
  const plan = useDetail<FeedPlan>('/feed/plan');
  const consumption = useDetail<{ date: string; qty: number }[]>('/feed/consumption', { days: 30 });

  const horizonDays = (session.settings as { feed?: { winterDays?: number } }).feed?.winterDays ?? 120;
  const rows = balance.data ?? [];
  const known = rows.filter((row) => row.days !== null);
  const shortest = known.reduce<FeedBalanceRow | null>((min, row) => (min === null || row.days! < min.days! ? row : min), null);
  const below = rows.filter((row) => row.belowMinimum);
  const plannedKg = plan.data?.herds.reduce((sum, herd) => sum + herd.dailyKg, 0) ?? null;

  return (
    <>
      <PageHeader title={t('balance.title')} description={t('balance.description')} />

      <div className="flex flex-col gap-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            label={t('balance.shortest')}
            value={shortest ? t('balance.days', { days: formatNumber(shortest.days, 0) }) : '—'}
            hint={shortest?.name}
            icon={CalendarClock}
            tone={shortest && shortest.belowMinimum ? 'danger' : 'neutral'}
            loading={balance.isLoading}
          />
          <StatCard
            label={t('balance.belowCount')}
            value={formatNumber(below.length, 0)}
            hint={below.length === 0 ? t('balance.allFine') : below.slice(0, 2).map((row) => row.name).join(', ')}
            icon={below.length > 0 ? TriangleAlert : ClipboardCheck}
            tone={below.length > 0 ? 'danger' : 'success'}
            loading={balance.isLoading}
            to="/inventory/stock?tab=low"
          />
          <StatCard label={t('balance.dailyPlan')} value={formatKg(plannedKg)} hint={t('balance.dailyPlanHint')} icon={Scale} loading={plan.isLoading} />
        </div>

        {plan.data && plan.data.withoutRation.length > 0 && (
          <Alert tone="warning" title={t('plan.withoutRationTitle')}>
            {t('plan.withoutRationBody', { herds: plan.data.withoutRation.map((h) => `${h.herdName} (${h.head})`).join(', ') })}
          </Alert>
        )}

        {balance.error && <ErrorCard error={balance.error} onRetry={() => void balance.refetch()} />}
        {balance.isLoading && <Skeleton className="h-64" />}
        {balance.data && rows.length === 0 && (
          <EmptyState
            icon={Wheat}
            title={t('balance.emptyTitle')}
            description={t('balance.emptyBody')}
            action={
              <Link className="text-primary underline" to="/inventory/items">
                {t('balance.emptyAction')}
              </Link>
            }
          />
        )}
        {rows.length > 0 && (
          <Card>
            <CardContent>
              <ul className="flex flex-col divide-y divide-border">
                {[...rows]
                  .sort((a, b) => (a.days ?? Number.POSITIVE_INFINITY) - (b.days ?? Number.POSITIVE_INFINITY))
                  .map((row) => (
                    <FeedRow key={row.itemId} row={row} horizonDays={horizonDays} />
                  ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {plan.data && <PlanSection plan={plan.data} canSeeMoney={canSeeMoney} />}

        <ChartCard
          title={t('consumption.title')}
          description={t('consumption.description')}
          kind="bar"
          data={consumption.data ?? []}
          xKey="date"
          series={[{ key: 'qty', label: t('consumption.series') }]}
          formatValue={(value) => formatQty(value, 'kg')}
          formatX={(date) => date.slice(8)}
          formatLabel={formatDate}
          loading={consumption.isLoading}
          error={consumption.error}
          onRetry={() => void consumption.refetch()}
          emptyText={t('consumption.empty')}
        />
      </div>
    </>
  );
}
