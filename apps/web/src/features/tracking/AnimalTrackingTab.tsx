/**
 * "Tracker (GPS, temperature)" on the animal passport: where she is, the day's walk, and her temperature
 * and activity against the days before. Loaded only when the tab is opened, with Leaflet and charts.
 */
import { Radio } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EmptyState, ErrorCard, StatCard } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@/components/ui';
import { usePermission } from '@/lib/auth';
import { formatAgo, formatDate, formatDateTime, formatNumber } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { BatteryCell } from './TrackersTab';
import { FlagBadges, firstFlag } from './TrackingPage';
import { TrackingMap } from './TrackingMap';
import { TRACKING, isStale, type AnimalSeries, type AnimalTracking, type TrackPoint } from './types';

const SILENT_MINUTES = 120;

const hourLabel = (iso: string) => formatDateTime(iso).split(', ')[1] ?? iso;

export default function AnimalTrackingTab({ animalId }: { animalId: string }) {
  const { t } = useTranslation('tracking');
  const canUpdate = usePermission('livestock.update');
  const base = `${TRACKING}/animals/${animalId}`;
  const summary = useDetail<AnimalTracking>(base, undefined, { refetchInterval: 60_000 });
  const fitted = (summary.data?.trackers ?? []).some((x) => !x.removedOn);
  const worn = (summary.data?.trackers.length ?? 0) > 0;
  const track = useDetail<{ points: TrackPoint[] }>(worn ? `${base}/track` : null);
  const series = useDetail<AnimalSeries>(worn ? `${base}/series` : null, { days: 7 });

  const state = summary.data?.state ?? null;
  const now = Date.now();
  const position = state?.lat != null && state.lng != null ? { lat: state.lat, lng: state.lng } : null;
  const mapAnimals = useMemo(
    () =>
      position
        ? [{ id: animalId, ...position, flag: firstFlag(state!.flags), stale: isStale(state!.positionAt, now, SILENT_MINUTES), label: summary.data!.tag }]
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [position?.lat, position?.lng, state?.positionAt, animalId],
  );

  if (summary.isError) return <ErrorCard error={summary.error} onRetry={() => void summary.refetch()} />;
  if (!summary.data) return <Skeleton className="h-96 w-full" />;
  if (!worn) {
    return (
      <EmptyState
        icon={Radio}
        title={t('passport.noTracker')}
        description={t('passport.noTrackerHint')}
        action={
          canUpdate ? (
            <Button asChild variant="outline">
              <Link to="/livestock/tracking?tab=trackers">{t('passport.toTrackers')}</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }

  const batteries = summary.data.trackers.filter((x) => !x.removedOn && x.batteryPct !== null).map((x) => x.batteryPct!);
  const hourly = (series.data?.hourly ?? []).map((h) => ({ ...h, label: h.hour }));
  const history = series.data?.history ?? [];

  return (
    <div className="space-y-4">
      {!fitted && <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">{t('passport.removed')}</p>}
      {state && Object.keys(state.flags).length > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-2 p-3 text-sm">
            <FlagBadges flags={state.flags} />
            <span className="text-muted-foreground">{t('passport.flaggedHint')}</span>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label={t('fields.lastReading')}
          value={state?.lastReadingAt ? formatAgo(state.lastReadingAt, now) : t('live.noReading')}
          tone={isStale(state?.lastReadingAt ?? null, now, SILENT_MINUTES) ? 'warning' : 'neutral'}
        />
        <StatCard
          label={t('fields.temperature')}
          value={state?.temperatureC != null ? t('live.temperature', { value: formatNumber(state.temperatureC, 1) }) : '—'}
          hint={state?.temperatureAt ? formatAgo(state.temperatureAt, now) : undefined}
        />
        <StatCard label={t('fields.position')} value={state?.positionAt ? formatAgo(state.positionAt, now) : '—'} />
        <StatCard label={t('fields.battery')} value={batteries.length ? `${formatNumber(Math.min(...batteries), 0)}%` : '—'} />
      </div>

      {position || (track.data?.points.length ?? 0) > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('passport.track')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="relative isolate">
              <TrackingMap animals={mapAnimals} track={track.data?.points} fitKey={animalId} className="h-80 w-full overflow-hidden rounded-lg border border-border" />
            </div>
          </CardContent>
        </Card>
      ) : null}

      <ChartCard
        title={t('passport.temperatureChart')}
        kind="line"
        data={hourly}
        xKey="label"
        series={[{ key: 'temperatureC', label: t('fields.temperature') }]}
        formatValue={(v) => t('live.temperature', { value: formatNumber(v, 1) })}
        yDomain={['auto', 'auto']}
        formatX={hourLabel}
        formatLabel={formatDateTime}
        loading={series.isLoading}
        error={series.error}
        onRetry={() => void series.refetch()}
        emptyText={t('passport.noTemperature')}
      />
      <ChartCard
        title={t('passport.activityChart')}
        kind="bar"
        data={hourly}
        xKey="label"
        series={[{ key: 'activity', label: t('fields.activity'), slot: 2 }]}
        formatValue={(v) => formatNumber(v, 0)}
        formatX={hourLabel}
        formatLabel={formatDateTime}
        loading={series.isLoading}
        error={series.error}
        emptyText={t('passport.noActivity')}
      />
      <ChartCard
        title={t('passport.distanceChart')}
        kind="bar"
        data={history.map((d) => ({ ...d, distanceKm: d.distanceM === null ? null : d.distanceM / 1000 }))}
        xKey="date"
        series={[{ key: 'distanceKm', label: t('fields.distance'), slot: 3 }]}
        formatValue={(v) => t('passport.km', { value: formatNumber(v, 2) })}
        formatX={(d) => formatDate(d).slice(0, 5)}
        formatLabel={formatDate}
        loading={series.isLoading}
        error={series.error}
        emptyText={t('passport.noHistory')}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('passport.trackers')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {summary.data.trackers.map((x) => (
              <li key={x.assignmentId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0">
                <Badge variant={x.removedOn ? 'neutral' : 'outline'}>{t(`kind.${x.kind}`)}</Badge>
                <span className="min-w-0 font-mono text-sm break-all">{x.externalId ?? '—'}</span>
                <span className="text-sm whitespace-nowrap text-muted-foreground">
                  {formatDate(x.fittedOn)}
                  {x.removedOn ? ` – ${formatDate(x.removedOn)}` : ''}
                </span>
                {!x.removedOn && <BatteryCell value={x.batteryPct} />}
                <span className="text-sm whitespace-nowrap text-muted-foreground">
                  {x.lastReadingAt ? formatAgo(x.lastReadingAt, now) : t('trackers.never')}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
