import { useTranslation } from 'react-i18next';
import { Alert, Card, CardContent, CardHeader, CardTitle } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { formatMonth, formatMonthShort, formatNumber, formatPercent, formatQty } from '@/lib/format';
import { expectedLambsText, signedKg, weightDomain } from '../figures';
import { dayMonth, FigureRow, type LinkTo, NoData } from '../shared';
import type { LivestockData } from '../types';

/** One weighing is a dot, not a trend. */
const MIN_TREND_POINTS = 2;

export function LivestockBlock({ data, link }: { data: LivestockData; link: LinkTo }) {
  const { t } = useTranslation('dashboard');
  const { lambing } = data;
  const animals = link('/livestock/animals', 'livestock.view');
  // Months before the first weighing are not a gap in the record, so the axis starts at the first.
  const firstWeighed = data.weightTrend.findIndex((m) => m.avgKg !== null);
  const trend = firstWeighed < 0 ? [] : data.weightTrend.slice(firstWeighed);
  const weights = trend.flatMap((m) => (m.avgKg === null ? [] : [m.avgKg]));
  const hasTrend = weights.length >= MIN_TREND_POINTS;
  const categories = Object.entries(data.byCategory).sort(([, a], [, b]) => b - a);

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-3 lg:col-span-2">
        {lambing.overdue > 0 && (
          <Alert tone="warning">{t('livestock.lambingOverdue', { value: formatNumber(lambing.overdue, 0) })}</Alert>
        )}
        <ChartCard
          title={t('livestock.lambingByWeek')}
          description={
            lambing.totalEwes > 0
              ? t('livestock.lambingTotal', { ewes: formatNumber(lambing.totalEwes, 0), lambs: expectedLambsText(lambing, t) })
              : undefined
          }
          kind="block-bar"
          data={lambing.weeks}
          xKey="week"
          series={[{ key: 'expected', label: t('livestock.ewes') }]}
          formatValue={(v) => t('head', { value: formatNumber(v, 0) })}
          formatAxis={(v) => formatNumber(v, 0)}
          formatX={dayMonth}
          emptyText={t('livestock.noLambing')}
          height={220}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('livestock.composition')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.total === 0 ? (
            <NoData />
          ) : (
            <ul>
              {categories.map(([category, head]) => (
                <FigureRow
                  key={category}
                  label={t(`enums:animalCategory.${category}`)}
                  value={formatNumber(head, 0)}
                  to={animals ? `${animals}?category=${category}` : undefined}
                />
              ))}
              <FigureRow label={t('enums:animalStatus.pregnant')} value={formatNumber(data.pregnant, 0)} to={animals ? `${animals}?status=pregnant` : undefined} />
              <FigureRow label={t('enums:animalStatus.sick')} value={formatNumber(data.sick, 0)} to={animals ? `${animals}?status=sick` : undefined} />
              <FigureRow label={t('enums:animalStatus.quarantine')} value={formatNumber(data.quarantine, 0)} to={animals ? `${animals}?status=quarantine` : undefined} />
              <FigureRow
                label={t('livestock.deaths30')}
                hint={data.mortality.percent === null ? undefined : formatPercent(data.mortality.percent, 2)}
                value={formatNumber(data.mortality.dead, 0)}
                to={link('/livestock/exits', 'livestock.view')}
              />
            </ul>
          )}
        </CardContent>
      </Card>

      <ChartCard
        className="lg:col-span-3"
        title={t('livestock.weightTrend')}
        description={
          hasTrend
            ? t('livestock.weightChange', {
                from: formatQty(weights[0], 'kg', 1),
                to: formatQty(weights[weights.length - 1], 'kg', 1),
                change: signedKg(weights[weights.length - 1] - weights[0]),
              })
            : undefined
        }
        kind="line"
        data={hasTrend ? trend : []}
        xKey="month"
        series={[{ key: 'avgKg', label: t('livestock.avgWeight') }]}
        yDomain={weightDomain(weights)}
        formatValue={(v) => formatQty(v, 'kg', 1)}
        formatAxis={(v) => formatNumber(v, 0)}
        formatX={(m) => formatMonthShort(m)}
        formatLabel={formatMonth}
        emptyText={t('noData')}
        height={180}
      />
    </div>
  );
}
