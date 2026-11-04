import { useTranslation } from 'react-i18next';
import { ErrorCard, PageHeader, UrlTabs } from '@/components';
import { Alert, Skeleton } from '@/components/ui';
import { usePermission } from '@/lib/auth';
import { useDetail } from '@/lib/query';
import { AssistantTab } from './AssistantTab';
import { DocumentsTab } from './DocumentsTab';
import { InsightsTab } from './InsightsTab';
import type { AiStatus } from './types';

export default function AiPage() {
  const { t } = useTranslation('ai');
  const canCreate = usePermission('ai.create');
  const { data: status, error, isLoading, refetch } = useDetail<AiStatus>('/ai/status');
  const configured = status?.assistant.configured ?? false;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('page.title')} description={t('page.description')} />

      {isLoading && <Skeleton className="h-16" />}
      {error != null && <ErrorCard error={error} onRetry={() => void refetch()} />}

      {status && (
        <>
          {!configured && (
            <Alert tone="info" title={t('page.notConfiguredTitle')}>
              <p>{t('page.notConfiguredBody')}</p>
              <p>{t('page.notConfiguredHow')}</p>
            </Alert>
          )}
          <UrlTabs
            tabs={[
              { value: 'assistant', label: t('page.tabs.assistant'), content: <AssistantTab configured={configured} /> },
              { value: 'insights', label: t('page.tabs.insights'), content: <InsightsTab /> },
              {
                value: 'documents',
                label: t('page.tabs.documents'),
                hidden: !configured || !canCreate,
                content: <DocumentsTab />,
              },
            ]}
          />
        </>
      )}
    </div>
  );
}
