import { useTranslation } from 'react-i18next';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components';
import { formatDateTime, formatNumber } from '@/lib/format';
import { FigureRow, type LinkTo } from '../shared';
import type { CamerasData } from '../types';

export function CamerasBlock({ data, link }: { data: CamerasData; link: LinkTo }) {
  const { t } = useTranslation('dashboard');
  const cameras = link('/cameras', 'cameras.view');
  const { fleet } = data;
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>{t('cameras.fleet')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul>
            <FigureRow label={t('cameras.online')} value={formatNumber(fleet.online, 0)} to={cameras} />
            <FigureRow label={t('cameras.offline')} value={formatNumber(fleet.offline, 0)} to={cameras} />
            <FigureRow label={t('cameras.planned')} value={formatNumber(fleet.planned, 0)} to={cameras} />
          </ul>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>{t('cameras.events')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('cameras.noEvents')}</p>
          ) : (
            <ul>
              {data.events.map((event) => (
                <FigureRow
                  key={event.id}
                  label={t(`cameras:eventTypes.${event.type.split('.').pop()}`, { defaultValue: event.type })}
                  hint={
                    <>
                      {event.deviceName ?? '—'}
                      {event.sample && (
                        <Badge variant="neutral" className="ml-2">
                          {t('cameras.sample')}
                        </Badge>
                      )}
                    </>
                  }
                  value={<span className="text-sm font-normal text-muted-foreground">{formatDateTime(event.occurredAt)}</span>}
                  to={cameras}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
