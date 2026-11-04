import { FileSpreadsheet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorCard, PageHeader, UrlTabs, useUrlParam } from '@/components';
import { Skeleton } from '@/components/ui';
import { useDetail } from '@/lib/query';
import { ExportPanel } from './ExportPanel';
import { HistoryPanel } from './HistoryPanel';
import { JobPanel } from './JobPanel';
import { TemplatesPanel } from './TemplatesPanel';
import type { ImportCatalog } from './types';

/**
 * Excel import and export. The job id lives in the URL, so a preview survives a reload while
 * someone goes back to fix their file.
 */
export default function ImportPage() {
  const { t } = useTranslation('import');
  const [jobId, setJobId] = useUrlParam('job');
  const { data: catalog, isLoading, error, refetch } = useDetail<ImportCatalog>('/import/templates');

  const header = <PageHeader title={t('page.title')} description={t('page.description')} />;

  if (isLoading) {
    return (
      <>
        {header}
        <Skeleton className="h-64 w-full" />
      </>
    );
  }
  if (error || !catalog) {
    return (
      <>
        {header}
        <ErrorCard error={error} onRetry={refetch} />
      </>
    );
  }

  const canImport = catalog.templates.some((template) => template.allowed);
  const canExport = catalog.exports.some((entity) => entity.allowed);
  if (!canImport && !canExport) {
    return (
      <>
        {header}
        <EmptyState icon={FileSpreadsheet} title={t('page.noAccess')} description={t('page.noAccessHint')} />
      </>
    );
  }

  return (
    <>
      {header}
      <UrlTabs
        tabs={[
          {
            value: 'import',
            label: t('page.tabs.import'),
            hidden: !canImport,
            content: jobId ? (
              <JobPanel
                key={jobId}
                jobId={jobId}
                catalog={catalog}
                onClose={() => setJobId('')}
                onReplaced={(job) => setJobId(job.id)}
              />
            ) : (
              <TemplatesPanel catalog={catalog} onUploaded={(job) => setJobId(job.id)} />
            ),
          },
          { value: 'history', label: t('page.tabs.history'), hidden: !canImport, content: <HistoryPanel /> },
          {
            value: 'export',
            label: t('page.tabs.export'),
            hidden: !canExport,
            content: <ExportPanel entities={catalog.exports} />,
          },
        ]}
      />
    </>
  );
}
