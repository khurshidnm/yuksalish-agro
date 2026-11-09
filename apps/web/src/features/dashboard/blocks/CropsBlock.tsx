import { Cloud, CloudFog, CloudLightning, CloudRain, CloudSun, type LucideIcon, Snowflake, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Meter } from '@/components';
import { formatDate, formatMonthShort, formatNumber } from '@/lib/format';
import { FigureRow, type LinkTo } from '../shared';
import type { CropsData, WeatherDay } from '../types';

/** WMO weather codes, grouped into what a person plans around. */
function weatherKind(code: number | null): { icon: LucideIcon; key: string } {
  if (code === null) return { icon: Cloud, key: 'cloudy' };
  if (code === 0) return { icon: Sun, key: 'clear' };
  if (code <= 2) return { icon: CloudSun, key: 'partly' };
  if (code === 3) return { icon: Cloud, key: 'cloudy' };
  if (code === 45 || code === 48) return { icon: CloudFog, key: 'fog' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: Snowflake, key: 'snow' };
  if (code >= 95) return { icon: CloudLightning, key: 'storm' };
  return { icon: CloudRain, key: 'rain' };
}

const temperature = (value: number | null) => (value === null ? '—' : `${formatNumber(value, 0)}°`);

function WeatherStrip({ days }: { days: WeatherDay[] }) {
  const { t } = useTranslation('dashboard');
  return (
    <ul className="grid grid-cols-7 gap-1">
      {days.map((day) => {
        const { icon: Icon, key } = weatherKind(day.weatherCode);
        return (
          <li key={day.date} className="flex min-w-0 flex-col items-center gap-1 rounded-lg bg-muted px-0.5 py-2 text-center">
            <span className="text-xs leading-tight text-muted-foreground">
              <span className="block font-medium">{Number(day.date.slice(8, 10))}</span>
              {formatMonthShort(day.date)}
            </span>
            <Icon className="size-5 text-muted-foreground" aria-label={t(`crops.weather.${key}`)} />
            <span className="text-sm font-semibold tabular-nums">{temperature(day.tempMax)}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{temperature(day.tempMin)}</span>
            {day.frost && <span className="sr-only">{t('crops.frost')}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function StatusLine({ label, value, total }: { label: string; value: number; total: number }) {
  const { t } = useTranslation('dashboard');
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">{t('crops.ofTotal', { value: formatNumber(value, 0), total: formatNumber(total, 0) })}</span>
      </div>
      <Meter value={total > 0 ? (value / total) * 100 : 0} label={label} ticks />
    </div>
  );
}

export function CropsBlock({ data, link }: { data: CropsData; link: LinkTo }) {
  const { t } = useTranslation('dashboard');
  const { status, weather } = data;
  const frostDays = weather.filter((day) => day.frost).length;
  const operations = link('/crops/operations', 'crops.view');

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <Card className="lg:col-span-3">
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle>{t('crops.weatherTitle')}</CardTitle>
          {frostDays > 0 && <Badge variant="warning">{t('crops.frostDays', { value: frostDays })}</Badge>}
        </CardHeader>
        <CardContent>
          {weather.length === 0 ? (
            <EmptyState title={t('crops.noWeather')} className="py-4" />
          ) : (
            <>
              <WeatherStrip days={weather} />
              {/* The forecast is MET Norway's, under CC BY 4.0: its credit goes wherever it is shown. */}
              <p className="mt-2 text-xs text-muted-foreground">{t('farm:weather.credit')}</p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('crops.fields')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <StatusLine label={t('crops.sown')} value={status.sown} total={status.total} />
          <StatusLine label={t('crops.irrigated')} value={status.irrigated} total={status.total} />
          <StatusLine label={t('crops.harvested')} value={status.harvested} total={status.total} />
          <ul>
            <FigureRow
              label={t('crops.harvest')}
              value={t('crops.harvestValue', { actual: formatNumber(data.harvest.actualT, 1), planned: formatNumber(data.harvest.plannedT, 1) })}
              to={link('/crops/harvests', 'crops.view')}
            />
          </ul>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>{t('crops.overdueTitle', { value: formatNumber(data.overdueCount, 0) })}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.overdue.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('crops.noOverdue')}</p>
          ) : (
            <ul>
              {data.overdue.map((operation) => (
                <FigureRow
                  key={operation.id}
                  label={t('crops.operationField', { type: t(`enums:operationType.${operation.type}`), field: operation.fieldNumber })}
                  value={formatDate(operation.date)}
                  to={operations}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
