import { diffDays, todayIso } from '@yap/shared';
import { Check, ChevronRight, CloudOff, MapPin, Moon, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Badge } from '@/components/ui';
import { EmptyState, ErrorCard } from '@/components';
import { formatDate, formatDateTime } from '@/lib/format';
import { useOutbox } from '@/lib/outbox';
import { cn } from '@/lib/utils';
import { useAnimalDirectory, useNightWatch, type WatchEwe } from './data';
import { FieldScreen, FieldSkeleton } from './field-ui';
import { ewesLambed } from './logic';

function EweCard({ ewe, date, lambed }: { ewe: WatchEwe; date: string; lambed: boolean }) {
  const { t } = useTranslation('today');
  // Counted on the phone: the stored list may be from yesterday evening.
  const daysLeft = diffDays(date, ewe.expectedDate);
  const overdue = ewe.expectedLatest < date;
  const place = [ewe.herdName, ewe.barnName, ewe.facilityName].filter(Boolean).join(' · ');

  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-2xl leading-tight font-bold break-words">{ewe.tag}</p>
          {lambed ? (
            <Badge variant="success">{t('watch.lambed')}</Badge>
          ) : overdue ? (
            <Badge variant="danger">{t('watch.overdue')}</Badge>
          ) : daysLeft <= 0 ? (
            <Badge variant="warning">{daysLeft === 0 ? t('watch.dueToday') : t('watch.pastDays', { n: -daysLeft })}</Badge>
          ) : (
            <Badge variant="neutral">{t('watch.inDays', { n: daysLeft })}</Badge>
          )}
        </div>
        <p className="text-base">
          {t('watch.due', { date: formatDate(ewe.expectedDate) })}
          {' · '}
          {ewe.fetusCount === null ? t('watch.notScanned') : t('watch.fetuses', { n: ewe.fetusCount })}
        </p>
        {(ewe.firstLambing || ewe.inPen) && (
          <span className="mt-1 flex flex-wrap gap-1">
            {ewe.firstLambing && <Badge variant="warning">{t('watch.first')}</Badge>}
            {ewe.inPen && <Badge variant="neutral">{t('watch.inPen')}</Badge>}
          </span>
        )}
        {ewe.complications.map((item) => (
          <p key={`${item.date}-${item.text}`} className="mt-1 flex items-start gap-1.5 text-base font-semibold text-danger">
            <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{t('watch.earlier', { date: formatDate(item.date), text: item.text })}</span>
          </p>
        ))}
        {ewe.stillborn > 0 && <p className="mt-1 text-base font-semibold text-danger">{t('watch.stillborn', { n: ewe.stillborn })}</p>}
        {place && (
          <p className="mt-1 flex items-start gap-1.5 text-base text-muted-foreground">
            <MapPin className="mt-0.5 size-5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{place}</span>
          </p>
        )}
      </div>
      {lambed ? <Check className="size-8 shrink-0 text-success" aria-hidden /> : <ChevronRight className="size-8 shrink-0 text-muted-foreground" aria-hidden />}
    </>
  );

  const frame = 'flex min-h-24 items-center gap-3 rounded-2xl border bg-card p-4 text-card-foreground';
  if (lambed) return <li className={cn(frame, 'border-border opacity-70')}>{body}</li>;
  return (
    <li>
      <Link
        to={`/today/lambing?ewe=${ewe.eweId}`}
        aria-label={t('watch.open', { tag: ewe.tag })}
        data-testid={`watch-${ewe.eweId}`}
        className={cn(frame, 'focus-ring hover:bg-muted', overdue ? 'border-2 border-danger' : 'border-border')}
      >
        {body}
      </Link>
    </li>
  );
}

/** Who is about to lamb, soonest first. One tap on a ewe opens the lambing form with her chosen. */
export default function NightWatchPage() {
  const { t } = useTranslation('today');
  const { data, offline, savedAt, loading, error, refetch } = useNightWatch();
  const { records, sent } = useOutbox();
  const date = todayIso();
  // The lambing form finds the ewe in this list, so it has to be on the phone by then.
  useAnimalDirectory();

  if (loading) return <FieldSkeleton />;

  if (!data) {
    return (
      <FieldScreen title={t('actions.night_watch')}>
        {error ? (
          <ErrorCard title={t('data.firstTimeTitle')} error={error} onRetry={() => void refetch()} />
        ) : (
          <EmptyState icon={CloudOff} title={t('data.firstTimeTitle')} description={t('data.firstTimeBody')} />
        )}
      </FieldScreen>
    );
  }

  const lambed = ewesLambed(records, sent);
  const stale = data.today !== date;
  const overdue = data.ewes.filter((ewe) => ewe.expectedLatest < date && !lambed.has(ewe.eweId)).length;

  return (
    <FieldScreen title={t('actions.night_watch')} subtitle={t('watch.subtitle', { n: data.days })}>
      {(offline || stale) && savedAt !== null && (
        <div role="status" data-testid="stale-data" className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-base text-warning">
          <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          {t('data.stale', { time: formatDateTime(new Date(savedAt).toISOString()) })}
        </div>
      )}
      {data.ewes.length === 0 ? (
        <EmptyState icon={Moon} title={t('watch.emptyTitle')} description={t('watch.emptyBody', { n: data.days })} />
      ) : (
        <>
          <p className="text-base font-semibold">{t('watch.counts', { total: data.ewes.length, overdue })}</p>
          <ul className="flex flex-col gap-2.5">
            {data.ewes.map((ewe) => (
              <EweCard key={ewe.breedingId} ewe={ewe} date={date} lambed={lambed.has(ewe.eweId)} />
            ))}
          </ul>
        </>
      )}
    </FieldScreen>
  );
}
