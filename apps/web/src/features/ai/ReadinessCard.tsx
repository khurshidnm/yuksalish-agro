import { CheckCircle2, Hourglass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ErrorCard } from '@/components';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Meter, Skeleton } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { useDetail } from '@/lib/query';
import type { Coverage } from './types';

/** Which analyses have enough data yet. Below the minimum they stay silent, and this says why. */
export function ReadinessCard() {
  const { t } = useTranslation('ai');
  const { data, error, isLoading, refetch } = useDetail<{ coverage: Coverage[]; failed: string[] }>('/ai/coverage');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('coverage.title')}</CardTitle>
        <CardDescription>{t('coverage.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-40" />}
        {error != null && <ErrorCard error={error} onRetry={() => void refetch()} />}
        {data && (
          <ul className="flex flex-col gap-3">
            {data.coverage.map((item) => (
              <li key={item.key} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {item.enough ? (
                      <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
                    ) : (
                      <Hourglass className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <span className="truncate">{t(`types.${item.key}`, { defaultValue: item.key })}</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {item.enough
                      ? t('coverage.enough')
                      : `${formatNumber(item.have)} / ${formatNumber(item.need)} ${t(`coverage.units.${item.unit}`)}`}
                  </span>
                </div>
                {!item.enough && (
                  <Meter
                    value={(item.have / item.need) * 100}
                    label={t(`types.${item.key}`, { defaultValue: item.key })}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
