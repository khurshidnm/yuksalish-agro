import { ChevronRight, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Badge } from '@/components/ui';
import { useModuleEnabled, usePermission } from '@/lib/auth';
import { useList } from '@/lib/query';
import { useInsightText } from './InsightCard';
import { plainText } from './markdown';
import type { Insight } from './types';

const SEVERITY_VARIANT = { info: 'info', attention: 'warning', urgent: 'danger' } as const;

/** The newest finding nobody has decided on, placed where people already look. Decisions stay on /ai. */
export function InsightStrip() {
  const { t } = useTranslation('ai');
  const allowed = usePermission('ai.view');
  const moduleEnabled = useModuleEnabled();
  const text = useInsightText();
  const { data } = useList<Insight>('/ai/insights', { decision: 'pending', pageSize: 1 }, { enabled: allowed && moduleEnabled('ai') });
  const insight = data?.data[0];
  if (!insight) return null;

  const { title, body } = text(insight);
  const severity = insight.data.severity ?? 'info';

  return (
    <Link
      to="/ai?tab=insights"
      aria-label={`${t('insightStrip.open')}: ${title}`}
      data-testid="insight-strip"
      className="focus-ring flex items-center gap-3 rounded-xl border border-border bg-gradient-to-r from-secondary to-card p-3 text-card-foreground hover:border-input"
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Sparkles className="size-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{t('insightStrip.title')}</span>
          {severity !== 'info' && <Badge variant={SEVERITY_VARIANT[severity]}>{t(`enums:severity.${severity}`)}</Badge>}
        </span>
        <span className="block font-medium break-words">{title}</span>
        <span className="line-clamp-2 text-sm text-muted-foreground">{plainText(body)}</span>
      </span>
      <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}
