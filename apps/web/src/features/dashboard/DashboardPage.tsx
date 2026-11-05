import { DEFAULT_TIMEZONE } from '@yap/shared';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, ErrorCard, PageHeader, UrlTabs } from '@/components';
import { useSession } from '@/lib/auth';
import { formatDateLong, intlLocale } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { KpiPanel } from './KpiPanel';
import { OutlookPanel } from './OutlookPanel';
import { Overview, OverviewSkeleton } from './Overview';
import { SetupChecklist } from './SetupChecklist';
import type { DashboardData } from './types';

/** Figures come straight from the journal, so a minute old is fresh enough (spec 14). */
const REFRESH_MS = 60_000;

function clock(timestamp: number): string {
  return new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: DEFAULT_TIMEZONE }).format(timestamp);
}

export default function DashboardPage() {
  const { t } = useTranslation('dashboard');
  const session = useSession();
  const query = useDetail<DashboardData>('/dashboard', undefined, { refetchInterval: REFRESH_MS });
  const retry = () => void query.refetch();

  const overview = query.data ? (
    <Overview data={query.data} onRetry={retry} />
  ) : query.isError ? (
    <ErrorCard error={query.error} onRetry={retry} />
  ) : (
    <OverviewSkeleton />
  );

  return (
    <>
      <PageHeader
        title={t('title')}
        description={[
          session.farm?.name,
          query.data && formatDateLong(query.data.asOf),
          query.dataUpdatedAt > 0 && t('updatedAt', { time: clock(query.dataUpdatedAt) }),
        ]
          .filter(Boolean)
          .join(' · ')}
        // The page refreshes itself, so on a phone this would only push the figures down.
        actions={
          <Button className="hidden md:inline-flex" variant="outline" size="icon" aria-label={t('refresh')} loading={query.isFetching} onClick={retry}>
            <RefreshCw aria-hidden />
          </Button>
        }
      />
      <SetupChecklist />
      <UrlTabs
        tabs={[
          { value: 'overview', label: t('tabs.overview'), content: overview },
          { value: 'kpi', label: t('tabs.kpi'), content: <KpiPanel /> },
          { value: 'outlook', label: t('tabs.outlook'), content: <OutlookPanel /> },
        ]}
      />
    </>
  );
}
