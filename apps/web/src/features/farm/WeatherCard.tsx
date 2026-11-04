import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, RefreshCw, Snowflake, Sun, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { EmptyState, ErrorCard } from '@/components';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber } from '@/lib/format';
import { useApiMutation, useDetail } from '@/lib/query';
import type { WeatherDay } from './types';

/** WMO weather codes, as Open-Meteo reports them. */
function iconFor(code: number | null): LucideIcon {
  if (code === null) return Cloud;
  if (code === 0) return Sun;
  if (code <= 2) return CloudSun;
  if (code === 3) return Cloud;
  if (code <= 48) return CloudFog;
  if (code <= 57) return CloudDrizzle;
  if (code <= 67 || (code >= 80 && code <= 82)) return CloudRain;
  if (code <= 77 || code === 85 || code === 86) return CloudSnow;
  return CloudLightning;
}

interface RefreshResult {
  updated: number;
  unavailable: boolean;
}

/** Seven days ahead for the farm's coordinates. */
export function WeatherCard() {
  const { t } = useTranslation('farm');
  const canRefresh = usePermission('farm.update');
  const query = useDetail<WeatherDay[]>('/farm/weather/forecast', { days: 7 });

  const refresh = useApiMutation<void, RefreshResult>({
    mutationFn: () => api.post('/farm/weather/refresh'),
    invalidate: ['/farm/weather'],
    onSuccess: (result) => {
      if (result.unavailable) toast.warning(t('weather.unavailable'));
    },
  });

  const refreshButton = canRefresh && (
    <Button variant="outline" size="sm" loading={refresh.isPending} onClick={() => refresh.mutate()}>
      <RefreshCw aria-hidden />
      {t('common:actions.refresh')}
    </Button>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{t('weather.title')}</CardTitle>
        {refreshButton}
      </CardHeader>
      <CardContent>
        {query.error ? (
          <ErrorCard error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isPending ? (
          <Skeleton className="h-28" />
        ) : query.data?.length === 0 ? (
          <EmptyState icon={CloudSun} title={t('weather.emptyTitle')} description={t('weather.emptyBody')} className="py-6" />
        ) : (
          <ul className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
            {query.data?.map((day) => {
              const Icon = iconFor(day.weatherCode);
              return (
                <li key={day.date} className="flex min-w-24 flex-1 snap-start flex-col items-center gap-1 rounded-lg bg-muted p-2 text-center">
                  <span className="text-xs text-muted-foreground">{formatDate(day.date).slice(0, 5)}</span>
                  <Icon className="size-6 text-secondary-foreground" aria-hidden />
                  <span className="text-sm font-medium tabular-nums">
                    {formatNumber(day.tempMax, 0)}° / {formatNumber(day.tempMin, 0)}°
                  </span>
                  <span className="text-xs text-muted-foreground">{day.precipitationMm == null ? '—' : t('weather.rain', { value: formatNumber(day.precipitationMm, 1) })}</span>
                  {day.frost && (
                    <Badge variant="info">
                      <Snowflake aria-hidden />
                      {t('weather.frost')}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
