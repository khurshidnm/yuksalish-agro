import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Alert, Skeleton } from '@/components';
import { formatNumber } from '@/lib/format';
import { AlertsBlock } from './blocks/AlertsBlock';
import { CamerasBlock } from './blocks/CamerasBlock';
import { CropsBlock } from './blocks/CropsBlock';
import { FeedBlock } from './blocks/FeedBlock';
import { FinanceBlock } from './blocks/FinanceBlock';
import { LivestockBlock } from './blocks/LivestockBlock';
import { StaffBlock } from './blocks/StaffBlock';
import { headlineTiles } from './headline';
import { BlockUnavailable, type LinkTo, Section, Tile, useLinkTo } from './shared';
import type { AlertsData, BlockKey, DashboardData } from './types';

/** The first sentence of the page: is anything wrong right now? */
function StatusBanner({ counts, to }: { counts: AlertsData['counts']; to?: string }) {
  const { t } = useTranslation('dashboard');
  const tone = counts.urgent > 0 ? 'danger' : counts.attention > 0 ? 'warning' : 'success';
  const title =
    counts.urgent > 0
      ? t('banner.urgent', { value: formatNumber(counts.urgent, 0) })
      : counts.attention > 0
        ? t('banner.attention', { value: formatNumber(counts.attention, 0) })
        : t('banner.clear');
  return (
    <Alert tone={tone} title={title}>
      {to && tone !== 'success' && (
        <Link to={to} className="focus-ring inline-flex min-h-11 items-center rounded font-medium underline underline-offset-2 sm:min-h-0">
          {t('banner.open')}
        </Link>
      )}
    </Alert>
  );
}

const SECTION_LINK: Partial<Record<BlockKey, [string, Parameters<LinkTo>[1]]>> = {
  finance: ['/finance/transactions', 'finance.view'],
  livestock: ['/livestock/animals', 'livestock.view'],
  crops: ['/crops/plans', 'crops.view'],
  feed: ['/feed/balance', 'feed.view'],
  alerts: ['/alerts', 'dashboard.view'],
  cameras: ['/cameras', 'cameras.view'],
};

function BlockBody({ blockKey, data, link }: { blockKey: BlockKey; data: DashboardData; link: LinkTo }) {
  const { t } = useTranslation('dashboard');
  const { blocks } = data;
  switch (blockKey) {
    case 'finance':
      return blocks.finance?.data ? <FinanceBlock data={blocks.finance.data} link={link} /> : null;
    case 'livestock':
      return blocks.livestock?.data ? <LivestockBlock data={blocks.livestock.data} link={link} /> : null;
    case 'crops':
      return blocks.crops?.data ? <CropsBlock data={blocks.crops.data} link={link} /> : null;
    case 'feed':
      return blocks.feed?.data ? <FeedBlock data={blocks.feed.data} link={link} /> : null;
    case 'staff':
      return <StaffBlock dashboard={data} t={t} link={link} />;
    case 'alerts':
      return blocks.alerts?.data ? <AlertsBlock data={blocks.alerts.data} /> : null;
    case 'cameras':
      return blocks.cameras?.data ? <CamerasBlock data={blocks.cameras.data} link={link} /> : null;
  }
}

export function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <Skeleton className="h-14 w-full" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function Overview({ data, onRetry }: { data: DashboardData; onRetry: () => void }) {
  const { t } = useTranslation('dashboard');
  const link = useLinkTo();
  const alerts = data.blocks.alerts?.data;
  const tiles = headlineTiles(data, t, link);

  return (
    <div className="flex flex-col gap-5">
      {alerts && <StatusBanner counts={alerts.counts} to={link('/alerts', 'dashboard.view')} />}

      {tiles.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map(({ key, ...tile }) => (
            <Tile key={key} {...tile} />
          ))}
        </div>
      )}

      {data.order.map((key) => {
        const target = SECTION_LINK[key];
        const unavailable = data.blocks[key]?.status === 'unavailable';
        return (
          <Section key={key} title={t(`sections.${key}`)} to={target ? link(target[0], target[1]) : undefined}>
            {unavailable ? <BlockUnavailable onRetry={onRetry} /> : <BlockBody blockKey={key} data={data} link={link} />}
          </Section>
        );
      })}
    </div>
  );
}
