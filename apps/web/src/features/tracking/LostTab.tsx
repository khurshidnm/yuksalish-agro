/**
 * "Last seen" (docs/tracking.md): the sheep to go and look for. Each card says where she was last
 * heard, how long ago, how far that is from her flock, and opens the way there in the phone's maps.
 */
import { Navigation, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EmptyState, ErrorCard } from '@/components';
import { Alert, Badge, type BadgeVariant, Button, Card, CardContent, Skeleton } from '@/components/ui';
import { formatAgo, formatNumber } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { BatteryCell } from './TrackersTab';
import { LOST, type LostAnimal, type LostData, type LostReason } from './types';

const REFRESH_MS = 60_000;

const REASON_TONE: Record<LostReason, BadgeVariant> = { both: 'danger', silent: 'warning', isolated: 'warning' };

/** Opens the phone's own maps with the walk or drive to the place. No key, no map of ours. */
const directionsUrl = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function LostCard({ animal, now }: { animal: LostAnimal; now: number }) {
  const { t } = useTranslation('tracking');
  const located = animal.lat !== null && animal.lng !== null;
  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-semibold whitespace-nowrap">{animal.tag}</p>
            {animal.herdName && <p className="text-sm text-muted-foreground">{animal.herdName}</p>}
          </div>
          <Badge variant={REASON_TONE[animal.reason]} className="shrink-0">
            {t(`lost.reason.${animal.reason}`)}
          </Badge>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          <Fact label={t('lost.lastHeard')}>{animal.lastReadingAt ? formatAgo(animal.lastReadingAt, now) : t('live.noReading')}</Fact>
          <Fact label={t('lost.lastPosition')}>{animal.positionAt ? formatAgo(animal.positionAt, now) : '—'}</Fact>
          <Fact label={t('lost.fromHerd')}>
            {animal.distanceFromHerdM === null ? '—' : <span className="tabular-nums">{t('lost.metres', { value: formatNumber(animal.distanceFromHerdM, 0) })}</span>}
          </Fact>
          <Fact label={t('fields.battery')}>
            <BatteryCell value={animal.batteryPct} />
          </Fact>
        </dl>
        {!located && <p className="text-sm text-warning">{t('lost.noPosition')}</p>}
        <div className="flex flex-wrap gap-2">
          {located && (
            <Button asChild className="flex-1">
              <a href={directionsUrl(animal.lat!, animal.lng!)} target="_blank" rel="noopener noreferrer">
                <Navigation aria-hidden />
                {t('lost.directions')}
              </a>
            </Button>
          )}
          <Button asChild variant="outline" className={located ? undefined : 'flex-1'}>
            <Link to={`/livestock/animals/${animal.animalId}?tab=location`}>{t('live.passport')}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function LostTab() {
  const { t } = useTranslation('tracking');
  const lost = useDetail<LostData>(LOST, undefined, { refetchInterval: REFRESH_MS });
  const data = lost.data;

  if (!data) {
    return lost.isError ? (
      <ErrorCard error={lost.error} onRetry={() => void lost.refetch()} />
    ) : (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-44" />
        ))}
      </div>
    );
  }

  const now = Date.parse(data.now);
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">{t('lost.intro')}</p>
      {data.allSilent && <Alert tone="danger">{t('lost.allSilent')}</Alert>}
      {data.animals.length === 0 ? (
        <EmptyState icon={ShieldCheck} title={t('lost.emptyTitle')} description={t('lost.emptyDescription')} />
      ) : (
        <>
          <p className="text-sm font-semibold">{t('lost.count', { count: data.total })}</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.animals.map((a) => (
              <LostCard key={a.animalId} animal={a} now={now} />
            ))}
          </div>
          {data.total > data.animals.length && <p className="text-sm text-muted-foreground">{t('lost.more', { shown: data.animals.length, total: data.total })}</p>}
        </>
      )}
    </div>
  );
}
