import { FileText, Lightbulb, Play } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { EmptyState, ErrorCard, FormDialog, TextareaField, useUrlParam } from '@/components';
import { Button, Pagination, Select, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { zOptionalText, zText } from '@/lib/forms';
import { useApiMutation, useList } from '@/lib/query';
import { InsightCard } from './InsightCard';
import { ReadinessCard } from './ReadinessCard';
import { aiErrorMessage } from './text';
import { type AnalysisReport, INSIGHT_TYPES, type Insight } from './types';

const PAGE_SIZE = 20;

const decisionSchema = z.object({ note: zOptionalText(1000) });
const outcomeSchema = z.object({ outcome: zText(2000) });

function DecisionDialog({
  decision,
  insight,
  onClose,
}: {
  insight: Insight;
  decision: 'accepted' | 'rejected';
  onClose: () => void;
}) {
  const { t } = useTranslation('ai');
  const save = useApiMutation<z.output<typeof decisionSchema>>({
    mutationFn: (values) => api.post(`/ai/insights/${insight.id}/decision`, { decision, note: values.note }),
    invalidate: ['/ai/insights'],
    silentError: true,
  });
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(decision === 'accepted' ? 'insights.acceptTitle' : 'insights.rejectTitle')}
      description={insight.title}
      schema={decisionSchema}
      defaultValues={{ note: '' }}
      submitLabel={t(decision === 'accepted' ? 'insights.accept' : 'insights.reject')}
      onSubmit={async (values) => {
        await save.mutateAsync(values);
        onClose();
      }}
    >
      {(form) => <TextareaField form={form} name="note" label={t('insights.noteLabel')} hint={t('insights.noteHint')} />}
    </FormDialog>
  );
}

function OutcomeDialog({ insight, onClose }: { insight: Insight; onClose: () => void }) {
  const { t } = useTranslation('ai');
  const save = useApiMutation<z.output<typeof outcomeSchema>>({
    mutationFn: (values) => api.post(`/ai/insights/${insight.id}/outcome`, values),
    invalidate: ['/ai/insights'],
    silentError: true,
  });
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('insights.outcomeTitle')}
      description={insight.title}
      schema={outcomeSchema}
      defaultValues={{ outcome: insight.outcome ?? '' }}
      onSubmit={async (values) => {
        await save.mutateAsync(values);
        onClose();
      }}
    >
      {(form) => <TextareaField form={form} name="outcome" label={t('insights.outcomeLabel')} required />}
    </FormDialog>
  );
}

export function InsightsTab() {
  const { t } = useTranslation('ai');
  const canRun = usePermission('ai.create');
  const canDecide = usePermission('ai.update');
  const [type, setType] = useUrlParam('type');
  const [decision, setDecision] = useUrlParam('decision');
  const [pageParam, setPage] = useUrlParam('page', '1');
  const page = Number(pageParam) || 1;
  const [deciding, setDeciding] = useState<{ insight: Insight; decision: 'accepted' | 'rejected' } | null>(null);
  const [outcomeFor, setOutcomeFor] = useState<Insight | null>(null);

  const { data, error, isLoading, refetch } = useList<Insight>('/ai/insights', {
    type: type || undefined,
    decision: decision || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const run = useApiMutation<void, AnalysisReport>({
    mutationFn: () => api.post('/ai/insights/run'),
    invalidate: ['/ai/insights', '/ai/coverage'],
    silentError: true,
    onSuccess: (report) => {
      if (report.failed.length > 0) toast.warning(t('insights.runPartial', { count: report.failed.length }));
      else if (report.created + report.refreshed === 0) toast.info(t('insights.runNothing'));
      else toast.success(t('insights.runDone', { created: report.created, refreshed: report.refreshed }));
    },
    onError: (failure) => toast.error(aiErrorMessage(t, failure)),
  });

  const summary = useApiMutation<'week' | 'month'>({
    mutationFn: (kind) => api.post('/ai/summaries', { kind }),
    invalidate: ['/ai/insights'],
    silentError: true,
    successMessage: t('insights.summaryDone'),
    onError: (failure) => toast.error(aiErrorMessage(t, failure)),
  });

  const filtered = Boolean(type || decision);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Select
            aria-label={t('insights.filterType')}
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage('1');
            }}
            placeholder={t('insights.allTypes')}
            options={INSIGHT_TYPES.map((value) => ({ value, label: t(`types.${value}`) }))}
            className="sm:w-60"
          />
          <Select
            aria-label={t('insights.filterDecision')}
            value={decision}
            onChange={(event) => {
              setDecision(event.target.value);
              setPage('1');
            }}
            placeholder={t('insights.allDecisions')}
            options={(['pending', 'accepted', 'rejected'] as const).map((value) => ({ value, label: t(`enums:aiDecision.${value}`) }))}
            className="sm:w-48"
          />
          {canRun && (
            <div className="flex flex-wrap gap-2 sm:ms-auto">
              <Button variant="outline" loading={run.isPending} onClick={() => run.mutate()}>
                <Play aria-hidden />
                {t('insights.runNow')}
              </Button>
              <Button variant="outline" loading={summary.isPending && summary.variables === 'week'} onClick={() => summary.mutate('week')}>
                <FileText aria-hidden />
                {t('insights.weeklySummary')}
              </Button>
              <Button variant="outline" loading={summary.isPending && summary.variables === 'month'} onClick={() => summary.mutate('month')}>
                <FileText aria-hidden />
                {t('insights.monthlySummary')}
              </Button>
            </div>
          )}
        </div>

        {isLoading && (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-44" />
            <Skeleton className="h-44" />
          </div>
        )}
        {error != null && <ErrorCard error={error} onRetry={() => void refetch()} />}
        {data && data.data.length === 0 && (
          <EmptyState
            icon={Lightbulb}
            title={filtered ? t('insights.emptyFiltered') : t('insights.emptyTitle')}
            description={filtered ? undefined : t('insights.emptyDescription')}
          />
        )}
        {data && data.data.length > 0 && (
          <>
            <div className="flex flex-col gap-3">
              {data.data.map((insight) => (
                <InsightCard
                  key={insight.id}
                  insight={insight}
                  canDecide={canDecide}
                  onDecide={(item, choice) => setDeciding({ insight: item, decision: choice })}
                  onOutcome={setOutcomeFor}
                />
              ))}
            </div>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.meta.total} onPageChange={(next) => setPage(String(next))} />
          </>
        )}
      </div>

      <aside>
        <ReadinessCard />
      </aside>

      {deciding && <DecisionDialog insight={deciding.insight} decision={deciding.decision} onClose={() => setDeciding(null)} />}
      {outcomeFor && <OutcomeDialog insight={outcomeFor} onClose={() => setOutcomeFor(null)} />}
    </div>
  );
}
