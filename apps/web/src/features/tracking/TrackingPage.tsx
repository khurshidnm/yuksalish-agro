/**
 * The flock map (docs/tracking.md): where every sheep wearing a collar is, which ones need someone
 * to walk over, and the trackers themselves. It refreshes itself every minute, because collars
 * report every 10 to 15 minutes.
 */
import { DEFAULT_TIMEZONE } from '@yap/shared';
import { BatteryLow, MapPin, RefreshCw, ShieldCheck, TriangleAlert, WifiOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EmptyState, ErrorCard, PageHeader, StatCard, UrlTabs, useUrlParam } from '@/components';
import { Badge, type BadgeVariant, Button, Card, CardContent, Skeleton } from '@/components/ui';
import type { FarmMapData } from '@/features/farm/types';
import { useCan, useModuleEnabled } from '@/lib/auth';
import { formatAgo, formatNumber, intlLocale } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { cn } from '@/lib/utils';
import { TrackersTab, BatteryCell } from './TrackersTab';
import { TrackingMap, type MapAnimal } from './TrackingMap';
import { FLAGS, LIVE, isStale, type LiveAnimal, type LiveData, type TrackingFlag } from './types';

const REFRESH_MS = 60_000;

export const FLAG_TONE: Record<TrackingFlag, BadgeVariant> = { fever: 'danger', isolated: 'warning', inactive: 'info' };

export const firstFlag = (flags: LiveAnimal['flags']): TrackingFlag | null => FLAGS.find((f) => flags[f]) ?? null;

function clock(timestamp: number): string {
  return new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: DEFAULT_TIMEZONE }).format(timestamp);
}

export function FlagBadges({ flags }: { flags: LiveAnimal['flags'] }) {
  const { t } = useTranslation('tracking');
  const raised = FLAGS.filter((f) => flags[f]);
  if (raised.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {raised.map((f) => (
        <Badge key={f} variant={FLAG_TONE[f]}>
          {t(`flag.${f}`)}
        </Badge>
      ))}
    </div>
  );
}

/** One sheep, as a card a gloved finger can hit: tap shows her on the map, the link opens her passport. */
function AnimalCard({ animal, now, silentMinutes, selected, onSelect }: { animal: LiveAnimal; now: number; silentMinutes: number; selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation('tracking');
  const stale = isStale(animal.lastReadingAt, now, silentMinutes);
  return (
    <Card className={cn('transition-colors', selected && 'border-accent ring-2 ring-accent/40')}>
      <CardContent className="space-y-2 p-3">
        <div className="flex items-start gap-2">
          <button type="button" onClick={onSelect} className="focus-ring flex min-h-11 min-w-0 flex-1 flex-col items-start rounded-md text-left" disabled={animal.lat === null}>
            <span className="font-semibold whitespace-nowrap">{animal.tag}</span>
            <span className={cn('text-sm text-muted-foreground', stale && 'text-warning')}>
              {animal.herdName ? `${animal.herdName} · ` : ''}
              {animal.lastReadingAt ? formatAgo(animal.lastReadingAt, now) : t('live.noReading')}
            </span>
          </button>
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link to={`/livestock/animals/${animal.animalId}?tab=location`}>{t('live.passport')}</Link>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <FlagBadges flags={animal.flags} />
          {animal.temperatureC !== null && <span className="text-sm tabular-nums">{t('live.temperature', { value: formatNumber(animal.temperatureC, 1) })}</span>}
          <BatteryCell value={animal.batteryPct} />
        </div>
      </CardContent>
    </Card>
  );
}

function FlockSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-[55dvh] min-h-80 w-full" />
    </div>
  );
}

function FlockTab() {
  const { t } = useTranslation('tracking');
  const can = useCan();
  const moduleEnabled = useModuleEnabled();
  const [herd, setHerd] = useUrlParam('herd');
  const [selected, setSelected] = useState<string | null>(null);
  const live = useDetail<LiveData>(LIVE, undefined, { refetchInterval: REFRESH_MS });
  // Shepherds and vets have no farm.view: they get the imagery without field outlines.
  const farm = useDetail<FarmMapData>(can('farm.view') && moduleEnabled('farm') ? '/farm/map' : null);
  const outlines = useMemo(() => farm.data?.features.map((f) => f.geometry), [farm.data]);
  const retry = () => void live.refetch();

  const data = live.data;
  const now = data ? Date.parse(data.now) : Date.now();
  const silentMinutes = data?.silentAfterMinutes ?? 120;
  const shown = useMemo(() => (data?.animals ?? []).filter((a) => !herd || a.herdId === herd), [data, herd]);
  const mapAnimals = useMemo<MapAnimal[]>(
    () =>
      shown.flatMap((a) =>
        a.lat !== null && a.lng !== null
          ? [{ id: a.animalId, lat: a.lat, lng: a.lng, flag: firstFlag(a.flags), stale: isStale(a.positionAt, now, silentMinutes), label: a.tag }]
          : [],
      ),
    [shown, now, silentMinutes],
  );

  if (!data) return live.isError ? <ErrorCard error={live.error} onRetry={retry} /> : <FlockSkeleton />;

  if (data.summary.tracked === 0) {
    return (
      <EmptyState
        icon={MapPin}
        title={t('empty.title')}
        description={t('empty.description')}
        action={
          can('livestock.update') ? (
            <Button asChild>
              <Link to="?tab=trackers">{t('empty.action')}</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }

  const flagged = shown
    .filter((a) => firstFlag(a.flags))
    .sort((a, b) => FLAGS.indexOf(firstFlag(a.flags)!) - FLAGS.indexOf(firstFlag(b.flags)!) || a.tag.localeCompare(b.tag));
  const silent = shown.filter((a) => !firstFlag(a.flags) && a.silent);
  const chosen = shown.find((a) => a.animalId === selected) ?? null;
  const pick = (id: string) => setSelected((current) => (current === id ? null : id));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label={t('stats.located')} value={`${formatNumber(data.summary.located, 0)} / ${formatNumber(data.summary.tracked, 0)}`} icon={MapPin} />
        <StatCard label={t('stats.flagged')} value={formatNumber(data.summary.flagged, 0)} icon={TriangleAlert} tone={data.summary.flagged ? 'danger' : 'success'} />
        <StatCard label={t('stats.silent')} value={formatNumber(data.summary.silent, 0)} icon={WifiOff} tone={data.summary.silent ? 'warning' : 'neutral'} />
        <StatCard label={t('stats.lowBattery')} value={formatNumber(data.summary.lowBattery, 0)} icon={BatteryLow} tone={data.summary.lowBattery ? 'warning' : 'neutral'} />
      </div>

      <div className="space-y-2">
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label={t('live.herdFilter')}>
          <Button size="sm" variant={!herd ? 'primary' : 'outline'} aria-pressed={!herd} onClick={() => setHerd('')} className="shrink-0">
            {t('live.allHerds')}
          </Button>
          {data.herds.map((h) => (
            <Button key={h.id} size="sm" variant={herd === h.id ? 'primary' : 'outline'} aria-pressed={herd === h.id} onClick={() => setHerd(h.id)} className="shrink-0">
              {h.name ?? t('live.unnamedHerd')} · {formatNumber(h.tracked, 0)}
            </Button>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          {live.dataUpdatedAt > 0 && <span>{t('live.updatedAt', { time: clock(live.dataUpdatedAt) })}</span>}
          <Button variant="outline" size="icon" aria-label={t('live.refresh')} loading={live.isFetching} onClick={retry}>
            <RefreshCw aria-hidden />
          </Button>
        </div>
      </div>

      <div className="relative isolate">
        <TrackingMap
          animals={mapAnimals}
          outlines={outlines}
          selectedId={selected}
          onSelect={pick}
          fitKey={herd || 'all'}
          className="h-[55dvh] min-h-80 w-full overflow-hidden rounded-lg border border-border"
        />
        {mapAnimals.length === 0 && (
          <div className="pointer-events-none absolute inset-x-3 top-3 z-[500]">
            <div className="rounded-md bg-card/95 p-3 text-sm shadow">{t('live.noPositions')}</div>
          </div>
        )}
      </div>
      <Legend />

      {chosen && <AnimalCard animal={chosen} now={now} silentMinutes={silentMinutes} selected onSelect={() => setSelected(null)} />}

      <section className="space-y-2" aria-labelledby="attention-heading">
        <h2 id="attention-heading" className="text-base font-semibold">
          {t('live.attention')}
        </h2>
        {flagged.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg bg-success-soft p-3 text-sm text-success">
            <ShieldCheck className="size-4 shrink-0" aria-hidden />
            {t('live.allWell')}
          </div>
        ) : (
          flagged.map((a) => (
            <AnimalCard key={a.animalId} animal={a} now={now} silentMinutes={silentMinutes} selected={a.animalId === selected} onSelect={() => pick(a.animalId)} />
          ))
        )}
        {silent.length > 0 && (
          <p className="text-sm text-warning">
            {t('live.silentCount', { count: silent.length, hours: Math.round(silentMinutes / 60) })}{' '}
            <Link className="underline underline-offset-4" to="?tab=trackers&fitted=yes&sort=lastReadingAt">
              {t('live.seeTrackers')}
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}

function Legend() {
  const { t } = useTranslation('tracking');
  const item = (dot: string, label: string) => (
    <li className="flex items-center gap-1.5">
      <span className={cn('inline-block size-3 rounded-full border-2 border-card', dot)} aria-hidden />
      {label}
    </li>
  );
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t('legend.title')}>
      {item('bg-primary', t('legend.ok'))}
      {item('bg-destructive', t('flag.fever'))}
      {item('bg-warning-fill', t('flag.isolated'))}
      {item('bg-info', t('flag.inactive'))}
      {item('bg-muted-foreground', t('legend.stale'))}
    </ul>
  );
}

export default function TrackingPage() {
  const { t } = useTranslation('tracking');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <UrlTabs
        tabs={[
          { value: 'map', label: t('tabs.map'), content: <FlockTab /> },
          { value: 'trackers', label: t('tabs.trackers'), content: <TrackersTab /> },
        ]}
      />
    </>
  );
}
