import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Meter } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { useSession } from '@/lib/auth';
import { formatNumber, formatQty } from '@/lib/format';
import { consumptionToChart, feedNotInUse } from '../figures';
import { dayMonth, daysNumber, FigureRow, type LinkTo, NoData } from '../shared';
import type { FeedData, FeedItem } from '../types';

function FeedMeter({ item, horizon, to }: { item: FeedItem; horizon: number; to?: string }) {
  const { t } = useTranslation('dashboard');
  const label = t('feed.daysOf', { item: item.name });
  const body = (
    <>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="min-w-0 break-words">{item.name}</span>
        <span className="shrink-0 font-semibold tabular-nums">{item.days === null ? '—' : t('days', { value: daysNumber(item.days) })}</span>
      </div>
      {feedNotInUse(item) ? (
        <p className="text-sm text-muted-foreground">
          {t('feed.notInUse')} · {t('feed.stock', { value: formatQty(item.stockQty, item.unit, 0) })}
        </p>
      ) : item.days === null ? (
        <NoData />
      ) : (
        <>
          <Meter value={(item.days / horizon) * 100} tone={item.belowMinimum ? 'danger' : 'primary'} label={label} ticks />
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {t('feed.stock', { value: formatQty(item.stockQty, item.unit, 0) })}
            {item.basis && <span>· {t(`feed.basis.${item.basis}`)}</span>}
            {item.belowMinimum && <Badge variant="danger">{t('feed.belowMinimumBadge', { days: formatNumber(item.minDays, 0) })}</Badge>}
          </p>
        </>
      )}
    </>
  );
  return (
    <li>
      {to ? (
        <Link to={to} className="focus-ring -mx-2 block min-h-11 rounded px-2 py-1.5 hover:bg-muted">
          {body}
        </Link>
      ) : (
        <div className="py-1.5">{body}</div>
      )}
    </li>
  );
}

export function FeedBlock({ data, asOf, link }: { data: FeedData; asOf: string; link: LinkTo }) {
  const { t } = useTranslation('dashboard');
  const session = useSession();
  const winterDays = (session.settings as { feed?: { winterDays?: number } }).feed?.winterDays ?? 120;
  // A full bar means the feed lasts the winter; the scale grows if one lasts longer.
  const longest = data.items.reduce((max, item) => Math.max(max, item.days ?? 0), 0);
  const horizon = Math.max(winterDays, longest);
  const balance = link('/feed/balance', 'feed.view') ?? link('/inventory/stock', 'inventory.view');
  const stock = link('/inventory/stock', 'inventory.view') ?? balance;
  const consumption = consumptionToChart(data.consumption, asOf);

  return (
    // Side by side only from 1280 px: beside the menu at 1024 px the feed names would be cut.
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle>{t('feed.daysTitle')}</CardTitle>
          <CardDescription>{t('feed.daysNote', { days: formatNumber(horizon, 0) })}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.items.length === 0 ? (
            <NoData />
          ) : (
            <ul className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
              {data.items.map((item) => (
                <FeedMeter key={item.itemId} item={item} horizon={horizon} to={balance} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('feed.belowMinimum')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.lowStock.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('feed.nothingLow')}</p>
          ) : (
            <ul>
              {data.lowStock.map((row) => (
                <FigureRow
                  key={row.itemId}
                  label={row.name}
                  hint={row.reason === 'days' && row.days !== null ? t('days', { value: daysNumber(row.days) }) : undefined}
                  value={formatQty(row.stockQty, row.unit, 0)}
                  to={stock}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ChartCard
        className="xl:col-span-3"
        title={t('feed.consumption')}
        description={data.avgDailyKg === null ? undefined : t('feed.averagePerDay', { value: formatQty(data.avgDailyKg, 'kg', 0) })}
        kind="block-bar"
        data={consumption.some((day) => day.qty > 0) ? consumption : []}
        xKey="date"
        series={[{ key: 'qty', label: t('feed.fed') }]}
        formatValue={(v) => formatQty(v, 'kg', 0)}
        formatAxis={(v) => formatNumber(v, 0)}
        formatX={dayMonth}
        emptyText={t('noData')}
        height={200}
      />
    </div>
  );
}
