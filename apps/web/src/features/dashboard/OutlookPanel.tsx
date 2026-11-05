import { CalendarClock, Coins, PawPrint, Wheat } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, ErrorCard, Skeleton, StatCard } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { useLocalName } from '@/features/finance/lib';
import { formatCompact, formatDate, formatMoney, formatMonth, formatMonthShort, formatNumber } from '@/lib/format';
import { useDetail } from '@/lib/query';
import type { OutlookData, OutlookFeedRow } from './types';

const tons = (kg: number) => formatNumber(kg / 1000, 1);

function Conclusions({ data }: { data: OutlookData }) {
  const { t } = useTranslation('dashboard');
  const { herd, feed, money } = data;
  const lines: string[] = [];
  if (herd && herd.lambing.from && herd.lambing.to) {
    lines.push(
      t('outlook.conclusions.lambing', {
        from: formatDate(herd.lambing.from),
        to: formatDate(herd.lambing.to),
        ewes: formatNumber(herd.pregnant, 0),
        lambs: formatNumber(herd.lambsBorn, 0),
      }),
    );
    lines.push(t('outlook.conclusions.herd', { peak: formatNumber(herd.peakHead, 0), sold: formatNumber(herd.lambsSold, 0), kept: formatNumber(herd.lambsKept, 0) }));
  }
  if (feed) {
    const own = feed.filter((row) => row.ownCrop);
    const short = own.filter((row) => row.runsOutMonth);
    lines.push(
      short.length === 0
        ? t('outlook.conclusions.feedOk', { count: own.length })
        : t('outlook.conclusions.feedShort', { names: short.map((row) => row.name).join(', ') }),
    );
    const toBuy = feed.filter((row) => !row.ownCrop && row.runsOutMonth).sort((a, b) => a.runsOutMonth!.localeCompare(b.runsOutMonth!));
    if (toBuy.length > 0) lines.push(t('outlook.conclusions.feedBuy', { name: toBuy[0].name, month: formatMonth(toBuy[0].runsOutMonth!) }));
  }
  if (money) {
    if (money.lambIncome !== null && herd) {
      lines.push(t('outlook.conclusions.lambIncome', { amount: formatMoney(money.lambIncome), head: formatNumber(herd.lambsSold, 0) }));
    }
    if (money.firstNegativeMonth) lines.push(t('outlook.conclusions.cashShort', { month: formatMonth(money.firstNegativeMonth) }));
    else if (money.lowest) lines.push(t('outlook.conclusions.cashOk', { amount: formatMoney(money.lowest.closing), month: formatMonth(money.lowest.month) }));
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('outlook.conclusions.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function FeedStatus({ row }: { row: OutlookFeedRow }) {
  const { t } = useTranslation('dashboard');
  if (!row.runsOutMonth) return <Badge variant="success">{t('outlook.feed.enough')}</Badge>;
  return <Badge variant={row.ownCrop ? 'danger' : 'warning'}>{t('outlook.feed.until', { month: formatMonthShort(row.runsOutMonth) })}</Badge>;
}

function FeedCard({ rows }: { rows: OutlookFeedRow[] }) {
  const { t } = useTranslation('dashboard');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('outlook.feed.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((row) => (
            <li key={row.itemId} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block text-sm font-medium break-words">{row.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {t('outlook.feed.line', { stock: tons(row.stockKg), need: tons(row.needKg) })}
                  {row.nextHarvest ? ` · ${t('outlook.feed.harvest', { month: formatMonthShort(row.nextHarvest) })}` : ''}
                </span>
              </span>
              <FeedStatus row={row} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function CropsCard({ data }: { data: NonNullable<OutlookData['crops']> }) {
  const { t } = useTranslation('dashboard');
  const localName = useLocalName();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('outlook.crops.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border">
          {data.rows.map((row) => (
            <li key={row.crop} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block text-sm font-medium break-words">{localName(row.name)}</span>
                <span className="block text-xs text-muted-foreground">
                  {t('outlook.crops.area', { area: formatNumber(row.areaHa, 1) })}
                  {row.expectedYieldTHa !== null ? ` · ${t('outlook.crops.yield', { value: formatNumber(row.expectedYieldTHa, 1) })}` : ''}
                </span>
              </span>
              <span className="text-right">
                <span className="block text-sm font-medium tabular-nums">{row.expectedT === null ? '—' : t('outlook.crops.tons', { value: formatNumber(row.expectedT, 0) })}</span>
                {row.lastYearT !== null && <span className="block text-xs text-muted-foreground">{t('outlook.crops.lastYear', { value: formatNumber(row.lastYearT, 0) })}</span>}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function OutlookPanel() {
  const { t } = useTranslation('dashboard');
  const query = useDetail<OutlookData>('/dashboard/outlook');
  if (query.isError) return <ErrorCard error={query.error} onRetry={() => void query.refetch()} />;
  const data = query.data;
  if (!data) {
    return (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const { herd, feed, crops, money } = data;
  const a = herd?.assumptions;
  const feedOk = feed ? feed.filter((row) => row.ownCrop && !row.runsOutMonth).length : 0;
  const feedOwn = feed ? feed.filter((row) => row.ownCrop).length : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {herd && <StatCard icon={PawPrint} label={t('outlook.stats.lambs')} value={formatNumber(herd.lambsBorn, 0)} hint={t('outlook.stats.lambsHint', { ewes: formatNumber(herd.pregnant, 0) })} />}
        {herd && <StatCard icon={CalendarClock} label={t('outlook.stats.head')} value={formatNumber(herd.peakHead, 0)} hint={t('outlook.stats.headHint')} />}
        {feed && <StatCard icon={Wheat} label={t('outlook.stats.feed')} value={`${feedOk} / ${feedOwn}`} hint={t('outlook.stats.feedHint')} tone={feedOk === feedOwn ? 'success' : 'warning'} />}
        {money && <StatCard icon={Coins} label={t('outlook.stats.cash')} value={formatMoney(money.closing, { compact: true })} hint={t('outlook.stats.cashHint')} />}
      </div>

      <Conclusions data={data} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {herd && (
          <ChartCard
            title={t('outlook.charts.herd')}
            description={t('outlook.charts.herdHint')}
            kind="area"
            data={herd.rows}
            xKey="month"
            series={[{ key: 'head', label: t('outlook.charts.headSeries'), dashed: true }]}
            formatValue={(v) => formatNumber(v, 0)}
            formatX={formatMonthShort}
            formatLabel={formatMonth}
          />
        )}
        {money && (
          <ChartCard
            title={t('outlook.charts.cash')}
            description={t('outlook.charts.cashHint')}
            kind="line"
            data={money.rows}
            xKey="month"
            series={[{ key: 'closing', label: t('outlook.charts.closing'), dashed: true }]}
            formatValue={(v) => formatMoney(v)}
            formatAxis={(v) => formatCompact(v)}
            formatX={formatMonthShort}
            formatLabel={formatMonth}
          />
        )}
        {herd && (
          <ChartCard
            title={t('outlook.charts.lambs')}
            kind="bar"
            data={herd.rows}
            xKey="month"
            series={[
              { key: 'lambsBorn', label: t('outlook.charts.born') },
              { key: 'lambsSold', label: t('outlook.charts.sold') },
            ]}
            formatValue={(v) => formatNumber(v, 0)}
            formatX={formatMonthShort}
            formatLabel={formatMonth}
          />
        )}
        {money && (
          <ChartCard
            title={t('outlook.charts.flow')}
            kind="bar"
            data={money.rows}
            xKey="month"
            series={[
              { key: 'inflow', label: t('outlook.charts.inflow') },
              { key: 'outflow', label: t('outlook.charts.outflow') },
            ]}
            formatValue={(v) => formatMoney(v)}
            formatAxis={(v) => formatCompact(v)}
            formatX={formatMonthShort}
            formatLabel={formatMonth}
          />
        )}
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {feed && <FeedCard rows={feed} />}
        {crops && <CropsCard data={crops} />}
      </div>

      {a && (
        <Alert tone="info">
          {t('outlook.assumptions', {
            lambs: formatNumber(a.lambsPerEwe, 1),
            survival: formatNumber(a.survival * 100, 0),
            months: a.monthsToSale,
            kept: formatNumber(a.keepShare * 100, 0),
            weight: formatNumber(a.saleWeightKg, 0),
          })}
        </Alert>
      )}
    </div>
  );
}
