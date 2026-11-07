import type { Permission } from '@yap/shared';
import { monthOf, todayIso } from '@yap/shared';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, ErrorCard, Label, Select, Skeleton, useUrlParam } from '@/components';
import { formatCompact, formatMoney, formatNumber, formatPercent } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { BlockUnavailable, daysNumber, FigureRow, useLinkTo } from './shared';
import type { KpiData, KpiGroupKey } from './types';

type Format = 'percent' | 'money' | 'ratio' | 'grams' | 'tHa' | 'm3t' | 'days' | 'perPerson' | 'count';

interface KpiRow {
  key: string;
  format: Format;
  source: [string, Permission];
}

/** Spec 14.3. A money row the reader may not see is absent from the response, so it never shows. */
const GROUPS: { key: KpiGroupKey; rows: KpiRow[] }[] = [
  {
    key: 'finance',
    rows: [
      { key: 'profitabilityPercent', format: 'percent', source: ['/finance/costs', 'finance.view'] },
      { key: 'profitPerEwe', format: 'money', source: ['/finance/costs', 'finance.view'] },
      { key: 'operatingRatio', format: 'ratio', source: ['/finance/transactions', 'finance.view'] },
      { key: 'netCashflow', format: 'money', source: ['/finance/cashflow', 'finance.view'] },
      { key: 'budgetDeviationPercent', format: 'percent', source: ['/finance/budget', 'finance.view'] },
    ],
  },
  {
    key: 'livestock',
    rows: [
      { key: 'lambingPercent', format: 'percent', source: ['/livestock/breeding?tab=kpis', 'livestock.view'] },
      { key: 'survivalPercent', format: 'percent', source: ['/livestock/breeding?tab=kpis', 'livestock.view'] },
      { key: 'adgG', format: 'grams', source: ['/livestock/herds', 'livestock.view'] },
      { key: 'costPerKgLive', format: 'money', source: ['/finance/costs', 'finance.view'] },
      { key: 'feedConversion', format: 'ratio', source: ['/livestock/herds', 'livestock.view'] },
      { key: 'mortalityPercent', format: 'percent', source: ['/livestock/exits', 'livestock.view'] },
    ],
  },
  {
    key: 'crops',
    rows: [
      { key: 'yieldTHa', format: 'tHa', source: ['/crops/harvests', 'crops.view'] },
      { key: 'costPerTon', format: 'money', source: ['/finance/costs', 'finance.view'] },
      { key: 'onTimePercent', format: 'percent', source: ['/crops/operations', 'crops.view'] },
      { key: 'waterM3PerTon', format: 'm3t', source: ['/crops/operations', 'crops.view'] },
    ],
  },
  {
    key: 'feed',
    rows: [
      { key: 'stockDays', format: 'days', source: ['/feed/balance', 'feed.view'] },
      { key: 'costPerHeadDay', format: 'money', source: ['/feed/rations', 'feed.view'] },
      { key: 'lossPercent', format: 'percent', source: ['/inventory/counts', 'inventory.view'] },
    ],
  },
  {
    key: 'staff',
    rows: [
      { key: 'headPerEmployee', format: 'perPerson', source: ['/hr/employees', 'hr.view'] },
      { key: 'haPerEmployee', format: 'perPerson', source: ['/hr/employees', 'hr.view'] },
      { key: 'attendancePercent', format: 'percent', source: ['/hr/timesheet', 'hr.view'] },
    ],
  },
  {
    key: 'machinery',
    rows: [
      { key: 'utilizationPercent', format: 'percent', source: ['/assets', 'assets.view'] },
      { key: 'costPerHa', format: 'money', source: ['/assets', 'assets.view'] },
      { key: 'unplannedStops', format: 'count', source: ['/assets', 'assets.view'] },
    ],
  },
];

/** Withheld by the API until most of the herd has been weighed twice. */
const WEIGHT_BASED = new Set(['feedConversion', 'costPerKgLive']);

function shiftMonth(month: string, by: number): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m - 1 + by, 1)).toISOString().slice(0, 7);
}

function periodParams(period: string): { from?: string; to?: string } {
  const month = monthOf(todayIso());
  if (period === 'month') return { from: month, to: month };
  if (period === 'last12') return { from: shiftMonth(month, -11), to: month };
  return {};
}

export function KpiPanel() {
  const { t } = useTranslation('dashboard');
  const link = useLinkTo();
  const [period, setPeriod] = useUrlParam('period', 'ytd');
  const query = useDetail<KpiData>('/dashboard/kpis', periodParams(period));

  const format = (kind: Format, value: number): string => {
    switch (kind) {
      case 'percent':
        return formatPercent(value, 1);
      case 'money':
        return formatMoney(value, { compact: Math.abs(value) >= 1_000_000 });
      case 'ratio':
        return formatNumber(value, 2);
      case 'grams':
        return t('kpi.units.grams', { value: formatNumber(value, 0) });
      case 'tHa':
        return t('kpi.units.tHa', { value: formatNumber(value, 2) });
      case 'm3t':
        return t('kpi.units.m3t', { value: formatNumber(value, 1) });
      case 'days':
        return t('days', { value: daysNumber(value) });
      case 'perPerson':
        return formatNumber(value, 1);
      case 'count':
        return formatCompact(value, 0);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-xs">
        <Label htmlFor="kpi-period">{t('kpi.period')}</Label>
        <Select
          id="kpi-period"
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
          options={['ytd', 'month', 'last12'].map((value) => ({ value, label: t(`kpi.periods.${value}`) }))}
        />
      </div>

      {query.isPending && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-busy>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-56" />
          ))}
        </div>
      )}
      {query.isError && !query.data && <ErrorCard error={query.error} onRetry={() => query.refetch()} />}

      {query.data && (
        <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
          {GROUPS.map(({ key, rows }) => {
            const group = query.data.groups[key];
            if (!group) return null;
            return (
              <Card key={key} className="min-w-0">
                <CardHeader>
                  <CardTitle>{t(`kpi.groups.${key}`)}</CardTitle>
                </CardHeader>
                <CardContent>
                  {group.status === 'unavailable' ? (
                    <BlockUnavailable onRetry={() => query.refetch()} />
                  ) : (
                    <ul>
                      {rows
                        .filter((row) => row.key in group.data)
                        .map((row) => {
                          const value = group.data[row.key];
                          const missing = value === null;
                          const partlyWeighed = missing && WEIGHT_BASED.has(row.key) && Number(group.data.weighedAnimals) > 0;
                          const missingHint = partlyWeighed ? t('kpi.partlyWeighed', { value: formatNumber(group.data.weighedAnimals, 0) }) : t('noData');
                          return (
                            <FigureRow
                              key={row.key}
                              label={t(`kpi.labels.${row.key}`)}
                              hint={missing ? missingHint : row.key === 'stockDays' ? group.data.limitingItem : row.key === 'yieldTHa' ? (group.data.yieldSeason ?? undefined) : undefined}
                              value={missing ? '—' : format(row.format, Number(value))}
                              to={link(row.source[0], row.source[1])}
                            />
                          );
                        })}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
