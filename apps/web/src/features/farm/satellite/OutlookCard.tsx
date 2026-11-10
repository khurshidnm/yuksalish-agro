import { useTranslation } from 'react-i18next';
import { StatCard } from '@/components';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { formatDate, formatNumber } from '@/lib/format';
import type { FieldHealth, YieldOutlook } from './types';

/** Smaller than this, a change in NDVI is the noise between two images, not a difference. */
const FLAT_CHANGE = 0.02;

function yieldHint(outlook: YieldOutlook, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (outlook.forecast) {
    const range = t('satellite.outlook.range', {
      low: formatNumber(outlook.forecast.lowTHa, 2),
      high: formatNumber(outlook.forecast.highTHa, 2),
      unit: t('unit.tHa'),
      count: outlook.forecast.seasons,
    });
    return outlook.forecast.extrapolated ? `${range} ${t('satellite.outlook.extrapolated')}` : range;
  }
  if (outlook.reason === 'too_few_seasons') return t('satellite.outlook.tooFew', { have: outlook.seasons, need: outlook.seasonsNeeded });
  if (outlook.reason === 'no_relation') return t('satellite.outlook.noRelation', { count: outlook.seasons });
  return t('satellite.outlook.noPeak');
}

/**
 * What the season looks like against the farm's own past: a yield forecast fitted on its finished
 * seasons, the same week a year ago, and how wet the canopy is. Each figure says what it rests on,
 * and shows a dash where the farm's data cannot carry it.
 */
export function OutlookCard({ health }: { health: FieldHealth }) {
  const { t } = useTranslation('farm');
  const latest = health.latest;
  if (!latest) return null;
  const outlook = health.yieldOutlook;
  const last = health.lastSeason;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('satellite.outlook.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('satellite.outlook.hint')}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {outlook && (
            <StatCard
              label={t('satellite.outlook.yield')}
              value={outlook.forecast ? `${formatNumber(outlook.forecast.estimateTHa, 2)} ${t('unit.tHa')}` : t('satellite.outlook.notEnough')}
              hint={yieldHint(outlook, t)}
            />
          )}
          <StatCard
            label={t('satellite.outlook.lastSeason')}
            value={last ? formatNumber(last.mean, 2) : '—'}
            hint={last ? t('satellite.outlook.lastSeasonHint', { date: formatDate(last.date), now: formatNumber(latest.ndviMean, 2) }) : t('satellite.outlook.lastSeasonNone')}
            delta={
              last
                ? {
                    value: formatNumber(Math.abs(last.change), 2),
                    direction: Math.abs(last.change) < FLAT_CHANGE ? 'flat' : last.change > 0 ? 'up' : 'down',
                    goodWhen: 'up',
                    label: t('satellite.outlook.sinceLastSeason'),
                  }
                : undefined
            }
          />
          <StatCard
            label={t('satellite.moisture')}
            value={formatNumber(latest.ndmiMean, 2)}
            hint={latest.ndmiMean === null ? t('satellite.moistureNone') : t('satellite.moistureHint', { date: formatDate(latest.date) })}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('satellite.outlook.note')}</p>
      </CardContent>
    </Card>
  );
}
