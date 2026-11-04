import { useTranslation } from 'react-i18next';
import { ErrorCard } from '@/components';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, Meter, Skeleton } from '@/components/ui';
import { useDetail } from '@/lib/query';
import type { CameraZone } from './types';

interface PlanZone {
  zone: CameraZone;
  min: number;
  max: number;
  registered: number;
  online: number;
}

const range = (min: number, max: number) => (min === max ? String(min) : `${min}–${max}`);

/** The layout from spec 25.3 against what actually exists. */
export function PlanTab() {
  const { t } = useTranslation('cameras');
  const query = useDetail<PlanZone[]>('/devices/plan');

  if (query.error) return <ErrorCard error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <Skeleton className="h-64 w-full rounded-xl" />;

  const zones = query.data;
  const total = zones.reduce((sum, z) => ({ min: sum.min + z.min, max: sum.max + z.max, online: sum.online + z.online }), { min: 0, max: 0, online: 0 });

  return (
    <div className="flex flex-col gap-3">
      <Alert tone="info" title={t('plan.summary', { range: range(total.min, total.max), online: total.online })}>
        {t('plan.archive')}
      </Alert>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {zones.map((zone) => (
          <Card key={zone.zone}>
            <CardHeader>
              <CardTitle>{t(`zones.${zone.zone}`)}</CardTitle>
              <CardDescription>{t(`plan.purpose.${zone.zone}`)}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">{t('plan.planned')}</span>
                <span className="font-medium">{range(zone.min, zone.max)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">{t('plan.registered')}</span>
                <span className="font-medium">{zone.registered}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">{t('plan.working')}</span>
                <span className="font-medium">{zone.online}</span>
              </div>
              <Meter value={(zone.online / zone.min) * 100} tone="success" label={t('plan.progress', { zone: t(`zones.${zone.zone}`) })} />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
