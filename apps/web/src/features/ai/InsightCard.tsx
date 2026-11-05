import { Check, ClipboardCheck, ExternalLink, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Badge, Button, Card, CardContent, Meter } from '@/components/ui';
import { formatDateTime, formatPercent } from '@/lib/format';
import { RichText } from './RichText';
import type { Insight } from './types';

const SEVERITY_VARIANT = { info: 'info', attention: 'warning', urgent: 'danger' } as const;
const DECISION_VARIANT = { pending: 'neutral', accepted: 'success', rejected: 'danger' } as const;

const SIMPLE_SOURCE_KEYS = (sources: Record<string, unknown>) =>
  Object.entries(sources).filter(
    ([key, value]) => key !== 'tables' && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'),
  );

function Evidence({ insight }: { insight: Insight }) {
  const { t } = useTranslation('ai');
  // Sources hold numbers and stable codes. Codes are translated here, numbers pass through.
  const valueText = (value: unknown) => t(`sourceValues.${String(value)}`, { defaultValue: String(value) });
  const tables = (insight.sources.tables as string[] | undefined) ?? [];
  const assumptions = insight.sources.assumptions as Record<string, unknown> | undefined;
  return (
    <details className="text-sm text-muted-foreground">
      <summary className="min-h-11 cursor-pointer content-center">{t('insights.evidence')}</summary>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 pb-1">
        {tables.length > 0 && (
          <>
            <dt>{t('insights.tables')}</dt>
            <dd>{tables.map((table) => t(`tables.${table}`, { defaultValue: table })).join(', ')}</dd>
          </>
        )}
        {SIMPLE_SOURCE_KEYS(insight.sources).map(([key, value]) => (
          <div key={key} className="contents">
            <dt>{t(`sources.${key}`, { defaultValue: key })}</dt>
            <dd className="break-words">{valueText(value)}</dd>
          </div>
        ))}
        {assumptions &&
          Object.entries(assumptions).map(([key, value]) => (
            <div key={key} className="contents">
              <dt>{t(`sources.${key}`, { defaultValue: key })}</dt>
              <dd className="break-words">
                {valueText(value)} <span className="italic">({t('insights.assumption')})</span>
              </dd>
            </div>
          ))}
      </dl>
    </details>
  );
}

export interface InsightCardProps {
  insight: Insight;
  canDecide: boolean;
  onDecide: (insight: Insight, decision: 'accepted' | 'rejected') => void;
  onOutcome: (insight: Insight) => void;
}

/** Stored text is in the farm's language. This re-renders it from the values for a viewer who reads another. */
export function useInsightText() {
  const { i18n, t } = useTranslation('ai');
  return (insight: Insight): { title: string; body: string } => {
    const key = `insight.${insight.data.textKey ?? insight.type}`;
    const translated = insight.data.i18n && i18n.exists(`ai:${key}.title`);
    return translated
      ? { title: t(`${key}.title`, insight.data.i18n), body: t(`${key}.body`, insight.data.i18n) }
      : { title: insight.title, body: insight.body };
  };
}

export function InsightCard({ canDecide, insight, onDecide, onOutcome }: InsightCardProps) {
  const { t } = useTranslation('ai');
  const { title, body } = useInsightText()(insight);
  const severity = insight.data.severity ?? 'info';
  const percent = Math.round(insight.confidence * 100);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={SEVERITY_VARIANT[severity]}>{t(`enums:severity.${severity}`)}</Badge>
          <Badge variant="outline">{t(`types.${insight.type}`, { defaultValue: insight.type })}</Badge>
          {insight.containsMoney && <Badge variant="neutral">{t('insights.money')}</Badge>}
          <span className="ms-auto text-sm text-muted-foreground">{formatDateTime(insight.createdAt)}</span>
        </div>

        <h3 className="font-semibold">{title}</h3>
        <RichText text={body} />

        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="shrink-0">{t('insights.confidence')}</span>
          <Meter value={percent} label={t('insights.confidence')} className="max-w-40" />
          <span className="tabular-nums">{formatPercent(percent, 0)}</span>
        </div>
        <Evidence insight={insight} />

        <div className="flex flex-wrap items-center gap-2">
          {insight.decision === 'pending' ? (
            canDecide ? (
              <>
                <Button variant="primary" onClick={() => onDecide(insight, 'accepted')}>
                  <Check aria-hidden />
                  {t('insights.accept')}
                </Button>
                <Button variant="outline" onClick={() => onDecide(insight, 'rejected')}>
                  <X aria-hidden />
                  {t('insights.reject')}
                </Button>
              </>
            ) : (
              <Badge variant={DECISION_VARIANT.pending}>{t('enums:aiDecision.pending')}</Badge>
            )
          ) : (
            <>
              <Badge variant={DECISION_VARIANT[insight.decision]}>{t(`enums:aiDecision.${insight.decision}`)}</Badge>
              {canDecide && (
                <Button variant="outline" onClick={() => onOutcome(insight)}>
                  <ClipboardCheck aria-hidden />
                  {insight.outcome ? t('insights.editOutcome') : t('insights.addOutcome')}
                </Button>
              )}
            </>
          )}
          {typeof insight.data.link === 'string' && (
            <Button asChild variant="ghost">
              <Link to={insight.data.link}>
                <ExternalLink aria-hidden />
                {t('insights.open')}
              </Link>
            </Button>
          )}
        </div>

        {insight.decisionNote && <p className="text-sm text-muted-foreground">{t('insights.noteLine', { note: insight.decisionNote })}</p>}
        {insight.outcome && <p className="text-sm">{t('insights.outcomeLine', { outcome: insight.outcome })}</p>}
      </CardContent>
    </Card>
  );
}
