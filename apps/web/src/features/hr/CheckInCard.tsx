/**
 * Self check-in for field staff (spec 11.3). Renders nothing for a user with no employee record,
 * so the /today page can place it for everyone.
 */
import { LogIn, LogOut, MapPinOff } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorCard } from '@/components';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useApiMutation, useDetail } from '@/lib/query';
import { formatTime } from './shared';

interface Shift {
  id: string;
  date: string;
  status: string;
  hours: number | null;
  checkIn: string | null;
  checkOut: string | null;
}

interface MyDay {
  employee: { id: string; fullName: string; position: string } | null;
  today: Shift | null;
  openShift: Shift | null;
}

const PATH = '/hr/me/today';

/** Location helps but must never stop someone from checking in: a refusal or timeout gives null. */
function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8_000, maximumAge: 60_000 },
    );
  });
}

export function CheckInCard({ className }: { className?: string }) {
  const { t } = useTranslation('hr');
  const day = useDetail<MyDay>(PATH);
  const [noLocation, setNoLocation] = useState(false);

  const mark = useApiMutation<'check-in' | 'check-out', Shift>({
    mutationFn: async (action) => {
      const position = await currentPosition();
      setNoLocation(position === null);
      return api.post<Shift>(`/hr/me/${action}`, position ?? {});
    },
    invalidate: [PATH],
  });

  if (day.isLoading) return <Skeleton className={className ?? 'h-36 rounded-xl'} />;
  if (day.error) return <ErrorCard error={day.error} onRetry={() => void day.refetch()} className={className} />;
  if (!day.data?.employee) return null;

  const { today, openShift } = day.data;
  const shift = openShift ?? today;
  const isOpen = Boolean(openShift);
  const finished = Boolean(today?.checkOut) && !isOpen;
  const startedEarlier = isOpen && openShift?.date !== today?.date;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{t('checkIn.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {shift?.checkIn ? (
          <p className="text-sm">
            {finished
              ? t('checkIn.finished', { from: formatTime(shift.checkIn), to: formatTime(shift.checkOut), hours: formatNumber(shift.hours, 1) })
              : t(startedEarlier ? 'checkIn.sinceYesterday' : 'checkIn.since', { time: formatTime(shift.checkIn) })}
          </p>
        ) : today && today.status !== 'present' ? (
          <Badge variant="info">{t(`enums:timesheetStatus.${today.status}`)}</Badge>
        ) : (
          <p className="text-sm text-muted-foreground">{t('checkIn.notYet')}</p>
        )}

        {isOpen || finished ? (
          <Button
            size="lg"
            variant={finished ? 'outline' : 'primary'}
            className="w-full"
            loading={mark.isPending}
            onClick={() => mark.mutate('check-out')}
          >
            <LogOut aria-hidden />
            {t(finished ? 'checkIn.updateLeave' : 'checkIn.leave')}
          </Button>
        ) : (
          <Button size="lg" className="w-full" loading={mark.isPending} onClick={() => mark.mutate('check-in')}>
            <LogIn aria-hidden />
            {t('checkIn.arrive')}
          </Button>
        )}

        {noLocation && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapPinOff className="size-4 shrink-0" aria-hidden />
            {t('checkIn.noLocation')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
