import { todayIso } from '@yap/shared';
import { Droplets } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTableView, EmptyState, ErrorCard, PageHeader, StatCard } from '@/components';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Meter, Skeleton } from '@/components/ui';
import { formatDate, formatNumber } from '@/lib/format';
import { useDetail } from '@/lib/query';
import type { WaterAdvice } from '../satellite/types';
import { useLocalName } from '../utils';

/** Crop water use in mm over a field, as cubic metres. */
const m3Of = (mm: number | null, areaHa: number) => (mm === null ? null : Math.round(mm * 10 * areaHa));

function meterTone(pct: number | null): 'success' | 'warning' | 'danger' {
  if (pct === null || pct < 70) return 'success';
  return pct < 100 ? 'warning' : 'danger';
}

function DueText({ advice }: { advice: WaterAdvice }) {
  const { t } = useTranslation('farm');
  if (!advice.dueDate) return <>{advice.depletionMm === null ? '—' : t('water.notSoon')}</>;
  return <>{advice.dueDate <= todayIso() ? t('water.dueNow') : formatDate(advice.dueDate)}</>;
}

/** One field's advice: what the crop used, what is left, and when to water. */
export function WaterAdviceCard({ advice, onEditField }: { advice: WaterAdvice; onEditField?: () => void }) {
  const { t } = useTranslation('farm');
  const localName = useLocalName();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('water.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {localName(advice.cropName)}
          {advice.stage && ` · ${t(`water.stage.${advice.stage}`)}`}
          {advice.kc !== null && ` · Kc ${formatNumber(advice.kc, 2)}`}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {advice.gap && (
          <Alert tone={advice.gap === 'no_soil_texture' ? 'warning' : 'info'} title={t(`water.gap.${advice.gap}.title`)}>
            <p>{t(`water.gap.${advice.gap}.body`)}</p>
            {advice.gap === 'no_soil_texture' && onEditField && (
              <Button variant="outline" size="sm" className="mt-2" onClick={onEditField}>
                {t('water.setSoil')}
              </Button>
            )}
          </Alert>
        )}
        {advice.rawUsedPct !== null && (
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
              <span className="text-muted-foreground">{t('water.rawUsed')}</span>
              <span className="font-semibold tabular-nums">{formatNumber(advice.rawUsedPct, 0)}%</span>
            </div>
            <Meter value={advice.rawUsedPct} tone={meterTone(advice.rawUsedPct)} label={t('water.rawUsed')} />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('water.store', { used: formatNumber(advice.depletionMm, 0), raw: formatNumber(advice.rawMm, 0), taw: formatNumber(advice.tawMm, 0) })}
            </p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label={t('water.due')} value={<DueText advice={advice} />} tone={advice.dueDate && advice.dueDate <= todayIso() ? 'danger' : 'neutral'} />
          <StatCard
            label={t('water.refill')}
            value={advice.refillM3 === null ? '—' : t('water.m3', { value: formatNumber(advice.refillM3, 0) })}
            hint={t('water.efficiency', { value: formatNumber(advice.efficiency * 100, 0) })}
          />
          <StatCard
            label={t('water.used7')}
            value={advice.etcLast7Mm === null ? '—' : t('water.mm', { value: formatNumber(advice.etcLast7Mm, 0) })}
            hint={advice.etcLast7Mm === null ? undefined : t('water.m3', { value: formatNumber(m3Of(advice.etcLast7Mm, advice.areaHa), 0) })}
          />
          <StatCard
            label={t('water.next7')}
            value={advice.etcNext7Mm === null ? '—' : t('water.mm', { value: formatNumber(advice.etcNext7Mm, 0) })}
            hint={advice.et0TodayMm === null ? undefined : t('water.et0Today', { value: formatNumber(advice.et0TodayMm, 1) })}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {advice.lastIrrigation
            ? t('water.lastIrrigation', { date: formatDate(advice.lastIrrigation.date), m3: formatNumber(advice.lastIrrigation.m3, 0) })
            : t('water.noIrrigation')}
        </p>
        <p className="text-xs text-muted-foreground">{t('water.assumptions')}</p>
      </CardContent>
    </Card>
  );
}

/** The water tab of a field card. */
export function WaterTab({ fieldId, onEditField }: { fieldId: string; onEditField?: () => void }) {
  const { t } = useTranslation('farm');
  const query = useDetail<WaterAdvice[]>('/farm/water/advice', { fieldId });
  if (query.error) return <ErrorCard error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <Skeleton className="h-72" />;
  const [advice] = query.data;
  if (!advice) {
    return (
      <EmptyState
        icon={Droplets}
        title={t('water.emptyTitle')}
        description={t('water.emptyBody')}
        action={
          <Button variant="outline" asChild>
            <Link to="/crops/plans">{t('water.toPlans')}</Link>
          </Button>
        }
      />
    );
  }
  return <WaterAdviceCard advice={advice} onEditField={onEditField} />;
}

/** Every growing crop on one screen, most urgent first. */
export default function WaterPage() {
  const { t } = useTranslation('farm');
  const localName = useLocalName();
  const query = useDetail<WaterAdvice[]>('/farm/water/advice');
  const rows = [...(query.data ?? [])].sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || (b.rawUsedPct ?? -1) - (a.rawUsedPct ?? -1));

  const columns: Column<WaterAdvice>[] = [
    {
      key: 'field',
      header: t('water.field'),
      cell: (row) => (
        <Link to={`/farm/fields/${row.fieldId}?tab=water`} className="font-medium text-heading underline-offset-4 hover:underline">
          №{row.number} · {localName(row.cropName)}
        </Link>
      ),
      mobile: 'title',
    },
    { key: 'stage', header: t('water.stageHeader'), cell: (row) => (row.stage ? t(`water.stage.${row.stage}`) : '—') },
    {
      key: 'used',
      header: t('water.rawUsed'),
      cell: (row) =>
        row.rawUsedPct === null ? (
          <Badge variant="neutral">{t(`water.gap.${row.gap ?? 'no_weather'}.short`)}</Badge>
        ) : (
          <span className="flex min-w-28 items-center gap-2">
            <Meter value={row.rawUsedPct} tone={meterTone(row.rawUsedPct)} label={t('water.rawUsed')} className="flex-1" />
            <span className="tabular-nums">{formatNumber(row.rawUsedPct, 0)}%</span>
          </span>
        ),
    },
    { key: 'due', header: t('water.due'), cell: (row) => <DueText advice={row} /> },
    { key: 'refill', header: t('water.refill'), cell: (row) => (row.refillM3 === null ? '—' : t('water.m3', { value: formatNumber(row.refillM3, 0) })), align: 'right' },
    { key: 'used7', header: t('water.used7'), cell: (row) => (row.etcLast7Mm === null ? '—' : t('water.mm', { value: formatNumber(row.etcLast7Mm, 0) })), align: 'right', mobile: 'hidden' },
  ];

  return (
    <>
      <PageHeader title={t('water.pageTitle')} description={t('water.pageDescription')} />
      {query.error ? (
        <ErrorCard error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isPending ? (
        <Skeleton className="h-72" />
      ) : (
        <div className="flex flex-col gap-3">
          <DataTableView<WaterAdvice>
            rows={rows}
            rowKey={(row) => row.fieldId}
            columns={columns}
            empty={{ icon: Droplets, title: t('water.emptyTitle'), description: t('water.emptyBody') }}
          />
          <p className="text-xs text-muted-foreground">{t('water.assumptions')}</p>
        </div>
      )}
    </>
  );
}
