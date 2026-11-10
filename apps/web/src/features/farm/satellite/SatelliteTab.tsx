import { addDays, todayIso } from '@yap/shared';
import { CalendarPlus, Crosshair, ExternalLink, LocateFixed, RefreshCw, Satellite, Sprout } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, ErrorCard, StatCard } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Select, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';
import { useApiMutation, useDetail } from '@/lib/query';
import type { FieldCard } from '../types';
import { fieldTitle, formatHa, useLocalName } from '../utils';
import { HealthMap, type Position } from './HealthMap';
import { HealthLegend } from './HealthLegend';
import { compassPoint, distanceAndBearing, ndviBand } from './ndvi';
import { OutlookCard } from './OutlookCard';
import { PastureCard } from './PastureCard';
import type { FieldHealth, SatelliteRefresh, VegetationReading, WeakZone } from './types';

/** The data provider's name, kept out of the dictionaries so it reads the same in every script. */
const SENTINEL_CREDIT = 'Copernicus Sentinel';

function useWatchPosition(active: boolean): { position: Position | null; error: string | null } {
  const [position, setPosition] = useState<Position | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) {
      setPosition(null);
      setError(null);
      return;
    }
    if (!('geolocation' in navigator)) {
      setError('unsupported');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setError(null);
        setPosition({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy });
      },
      (e) => setError(e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [active]);
  return { position, error };
}

function ZoneList({
  field,
  zones,
  date,
  selected,
  onSelect,
  position,
  walking,
  onWalk,
}: {
  field: FieldCard;
  zones: WeakZone[];
  date: string;
  selected: number | null;
  onSelect: (index: number) => void;
  position: Position | null;
  walking: boolean;
  onWalk: (index: number) => void;
}) {
  const { t } = useTranslation('farm');
  const canTask = usePermission('tasks.create');
  const createTask = useApiMutation<{ zone: WeakZone; index: number }>({
    mutationFn: ({ zone, index }) =>
      api.post('/tasks', {
        title: t('satellite.taskTitle', { field: fieldTitle(field), n: index + 1 }),
        description: t('satellite.taskBody', {
          date: formatDate(date),
          area: formatHa(zone.areaHa),
          ndvi: formatNumber(zone.meanNdvi, 2),
          lat: zone.lat.toFixed(6),
          lng: zone.lng.toFixed(6),
          link: mapsLink(zone),
        }),
        priority: 'high',
        entityType: 'field',
        entityId: field.id,
        dueDate: addDays(todayIso(), 1),
      }),
    invalidate: ['/tasks'],
    successMessage: 'farm:satellite.taskCreated',
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('satellite.zonesTitle', { count: zones.length })}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('satellite.zonesHint')}</p>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col divide-y divide-border">
          {zones.map((zone, index) => {
            const way = position ? distanceAndBearing(position, zone) : null;
            const active = index === selected;
            return (
              <li key={`${zone.lat},${zone.lng}`} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-3">
                  <span
                    className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${active ? 'bg-heading text-card' : 'bg-destructive text-primary-foreground'}`}
                    aria-hidden
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {t('satellite.zoneLine', { area: formatHa(zone.areaHa), ndvi: formatNumber(zone.meanNdvi, 2) })}
                    </p>
                    {way && active && (
                      <p className="text-sm text-info" aria-live="polite">
                        {t('satellite.distance', { metres: formatNumber(Math.round(way.metres), 0), direction: t(`satellite.compass.${compassPoint(way.bearing)}`) })}
                      </p>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                  <Button variant="outline" onClick={() => onSelect(index)} aria-pressed={active}>
                    <Crosshair aria-hidden />
                    {t('satellite.showZone')}
                  </Button>
                  <Button variant={walking && active ? 'primary' : 'outline'} onClick={() => onWalk(index)} aria-pressed={walking && active}>
                    <LocateFixed aria-hidden />
                    {walking && active ? t('satellite.stopWalking') : t('satellite.walkThere')}
                  </Button>
                  <Button variant="outline" asChild>
                    <a href={mapsLink(zone)} target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden />
                      {t('satellite.openInMaps')}
                    </a>
                  </Button>
                  {canTask && (
                    <Button variant="outline" loading={createTask.isPending && createTask.variables?.index === index} onClick={() => createTask.mutate({ zone, index })}>
                      <CalendarPlus aria-hidden />
                      {t('satellite.createTask')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

/** Directions in the phone's map app. A plain link: no key, nothing sent but the destination. */
function mapsLink(zone: WeakZone): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${zone.lat.toFixed(6)},${zone.lng.toFixed(6)}`;
}

function Checks({ health }: { health: FieldHealth }) {
  const { t } = useTranslation('farm');
  if (health.checks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {health.checks.map((check) => (
        <Alert key={`${check.kind}:${check.date}`} tone="warning" title={t(`satellite.check.${check.kind}.title`)}>
          {t(`satellite.check.${check.kind}.body`, { date: formatDate(check.date) })}
        </Alert>
      ))}
    </div>
  );
}

export function SatelliteTab({ field }: { field: FieldCard }) {
  const { t } = useTranslation('farm');
  const localName = useLocalName();
  const canRefresh = usePermission('farm.update');
  const base = `/farm/satellite/fields/${field.id}`;
  const query = useDetail<FieldHealth>(field.boundary ? base : null);
  const [date, setDate] = useState<string | null>(null);
  const reading = useDetail<VegetationReading | null>(date ? `${base}/reading` : null, date ? { date } : undefined);
  const [selected, setSelected] = useState<number | null>(null);
  const [walking, setWalking] = useState(false);
  const { position, error: positionError } = useWatchPosition(walking);
  // One curve at a time: greenness runs 0 to 1, moisture can go below zero, and a chart has one axis.
  const [index, setIndex] = useState<'ndvi' | 'ndmi'>('ndvi');

  const refresh = useApiMutation<void, SatelliteRefresh>({
    mutationFn: () => api.post('/farm/satellite/refresh'),
    invalidate: ['/farm/satellite'],
    onSuccess: (result) => {
      if (result.unavailable) toast.warning(t('satellite.unavailable'));
      else if (result.readings > 0) toast.success(t('satellite.refreshed', { count: result.readings }));
      else toast.info(t(result.pending > 0 ? 'satellite.refreshPending' : 'satellite.refreshNothing'));
    },
  });

  const health = query.data;
  const shown = date ? (reading.data ?? null) : (health?.latest ?? null);
  const zones = useMemo(() => shown?.weakZones ?? [], [shown]);
  useEffect(() => setSelected(null), [shown]);

  const refreshButton = canRefresh && (
    <Button variant="outline" loading={refresh.isPending} onClick={() => refresh.mutate()}>
      <RefreshCw aria-hidden />
      {t('satellite.refresh')}
    </Button>
  );

  if (!field.boundary) {
    return (
      <EmptyState
        icon={Satellite}
        title={t('satellite.noBoundaryTitle')}
        description={t('satellite.noBoundaryBody')}
        action={
          <Button asChild>
            <Link to="/farm/map">{t('fields.showOnMap')}</Link>
          </Button>
        }
      />
    );
  }
  if (query.error) return <ErrorCard error={query.error} onRetry={() => void query.refetch()} />;
  if (!health) return <Skeleton className="h-96" />;

  if (!health.latest) {
    return (
      <EmptyState
        icon={Satellite}
        title={t('satellite.emptyTitle')}
        description={health.lastSceneDate ? t('satellite.emptyCloudy', { date: formatDate(health.lastSceneDate) }) : t('satellite.emptyBody')}
        action={refreshButton || undefined}
      />
    );
  }

  const latest = health.latest;
  const delta = latest.ndviMean !== null && health.previousMean !== null && !date ? latest.ndviMean - health.previousMean : null;
  const band = ndviBand(shown?.ndviMean);
  const dates = [...health.series].reverse().map((p) => p.date);
  const zonesHa = zones.reduce((sum, z) => sum + z.areaHa, 0);
  // Images read before the moisture index was stored have none, and are left out rather than drawn as zero.
  const moisture = health.series.filter((point) => point.ndmi !== null);
  const onWalk = (index: number) => {
    if (walking && selected === index) {
      setWalking(false);
      return;
    }
    setSelected(index);
    setWalking(true);
  };

  return (
    <div className="flex flex-col gap-4">
      <Checks health={health} />
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <CardTitle>{field.landUse === 'arable' ? t('satellite.title') : t('satellite.vegetationTitle')}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {health.crop
                ? t('satellite.cropLine', { crop: localName(health.crop.cropName), status: t(`enums:cropPlanStatus.${health.crop.status}`) })
                : t(`enums:landUse.${health.landUse}`)}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
            <Select
              aria-label={t('satellite.date')}
              value={date ?? latest.date}
              onChange={(e) => setDate(e.target.value === latest.date ? null : e.target.value)}
              options={dates.map((d) => ({ value: d, label: formatDate(d) }))}
              className="sm:w-44"
            />
            {refreshButton}
          </div>
        </CardHeader>
        <div className="relative isolate">
          {date && reading.isPending && <Skeleton className="absolute inset-0 z-10 rounded-none" />}
          <HealthMap
            boundary={field.boundary}
            grid={shown?.grid ?? null}
            zones={zones}
            selectedZone={selected}
            onSelectZone={setSelected}
            position={position}
            zoneLabel={(index) => t('satellite.zoneMarker', { n: index + 1 })}
            className="h-80 w-full md:h-[28rem]"
          />
        </div>
        <CardContent className="flex flex-col gap-4 pt-4 md:pt-5">
          {walking && positionError && <Alert tone="warning">{t(`satellite.position.${positionError}`)}</Alert>}
          {walking && !position && !positionError && <p className="text-sm text-muted-foreground">{t('satellite.locating')}</p>}
          <HealthLegend />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label={t('satellite.ndvi')}
              value={formatNumber(shown?.ndviMean ?? null, 2)}
              hint={band ? t(`satellite.band.${band}`) : undefined}
              delta={
                delta === null
                  ? undefined
                  : { value: formatNumber(Math.abs(delta), 2), direction: Math.abs(delta) < 0.02 ? 'flat' : delta > 0 ? 'up' : 'down', goodWhen: 'up', label: t('satellite.sincePrevious') }
              }
            />
            <StatCard
              label={t('satellite.spread')}
              value={shown?.ndviP10 != null && shown.ndviP90 != null ? `${formatNumber(shown.ndviP10, 2)}–${formatNumber(shown.ndviP90, 2)}` : '—'}
              hint={t('satellite.spreadHint')}
            />
            <StatCard
              label={t('satellite.weakZones')}
              value={zones.length === 0 ? t('satellite.noZones') : formatHa(zonesHa, 1)}
              tone={zones.length === 0 ? 'success' : 'warning'}
              hint={zones.length > 0 ? t('satellite.zoneCount', { count: zones.length }) : undefined}
            />
            <StatCard label={t('satellite.clearShare')} value={formatPercent(shown?.clearPct ?? null, 0)} hint={t('satellite.clearHint', { date: formatDate(shown?.date ?? latest.date) })} />
          </div>
          <p className="text-xs text-muted-foreground">{t('satellite.credit', { year: (shown?.date ?? latest.date).slice(0, 4) })}</p>
        </CardContent>
      </Card>

      {zones.length > 0 && shown && (
        <ZoneList field={field} zones={zones} date={shown.date} selected={selected} onSelect={setSelected} position={position} walking={walking} onWalk={onWalk} />
      )}

      {health.series.length > 1 && (
        <div className="flex flex-col gap-2">
          <div role="group" aria-label={t('satellite.indexSwitch')} className="grid grid-cols-2 gap-2 sm:flex">
            {(['ndvi', 'ndmi'] as const).map((value) => (
              <Button key={value} variant={index === value ? 'primary' : 'outline'} aria-pressed={index === value} onClick={() => setIndex(value)}>
                {t(value === 'ndvi' ? 'satellite.ndvi' : 'satellite.moistureShort')}
              </Button>
            ))}
          </div>
          <ChartCard
            title={index === 'ndvi' ? t('satellite.curveTitle') : t('satellite.moistureCurveTitle')}
            description={index === 'ndvi' ? t('satellite.curveHint') : t('satellite.moistureCurveHint', { year: latest.date.slice(0, 4), provider: SENTINEL_CREDIT })}
            kind="line"
            data={index === 'ndvi' ? health.series : moisture}
            xKey="date"
            series={index === 'ndvi' ? [{ key: 'mean', label: t('satellite.ndvi') }] : [{ key: 'ndmi', label: t('satellite.moistureShort'), slot: 2 }]}
            yDomain={index === 'ndvi' ? [0, 1] : ['auto', 'auto']}
            emptyText={t('satellite.moistureEmpty')}
            formatValue={(value) => formatNumber(value, 2)}
            formatX={(value) => formatDate(value)}
            height={220}
            action={
              health.events.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5" aria-label={t('satellite.events')}>
                  {health.events.slice(-4).map((event) => (
                    <li key={`${event.type}:${event.date}`}>
                      <Badge variant={event.type === 'green_up' ? 'success' : 'outline'}>
                        <Sprout aria-hidden />
                        {t(`satellite.event.${event.type}`, { date: formatDate(event.date) })}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : undefined
            }
          />
        </div>
      )}

      <OutlookCard health={health} />

      {health.pasture && <PastureCard fieldId={field.id} areaHa={health.areaHa} pasture={health.pasture} />}
    </div>
  );
}
