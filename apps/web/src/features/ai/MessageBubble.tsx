import { CheckCircle2, CircleSlash, Loader2, SearchX, TriangleAlert } from 'lucide-react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui';
import { formatDate, formatNumber } from '@/lib/format';
import { Attachments } from './Attachments';
import { RichText } from './RichText';
import type { AnswerSource, ChatMessage, ToolCall, ToolStatus } from './types';

const STATUS: Record<ToolStatus, { icon: ComponentType<{ className?: string }>; variant: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  ok: { icon: CheckCircle2, variant: 'success' },
  no_data: { icon: SearchX, variant: 'neutral' },
  denied: { icon: CircleSlash, variant: 'warning' },
  invalid: { icon: TriangleAlert, variant: 'warning' },
  error: { icon: TriangleAlert, variant: 'danger' },
};

const HIDDEN_TOOLS = new Set(['present_result']);

export interface LiveTool {
  name: string;
  status: ToolStatus | 'running';
}

/** Which tools ran and how each went. Each entry has an icon and text, never colour alone. */
export function ToolActivity({ tools }: { tools: LiveTool[] }) {
  const { t } = useTranslation('ai');
  const shown = tools.filter((tool) => !HIDDEN_TOOLS.has(tool.name));
  if (shown.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={t('chat.toolActivity')}>
      {shown.map((tool, i) => {
        const label = t(`tools.${tool.name}`, { defaultValue: tool.name });
        if (tool.status === 'running') {
          return (
            <li key={i}>
              <Badge variant="info">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {label}
              </Badge>
            </li>
          );
        }
        const { icon: Icon, variant } = STATUS[tool.status];
        return (
          <li key={i}>
            <Badge variant={variant} title={t(`toolStatus.${tool.status}`)}>
              <Icon className="size-3.5" aria-hidden />
              {label}
              <span className="sr-only"> — {t(`toolStatus.${tool.status}`)}</span>
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

function SourceLine({ source }: { source: AnswerSource }) {
  const { t } = useTranslation('ai');
  const tables = source.tables.map((table) => t(`tables.${table}`, { defaultValue: table })).join(', ');
  const period =
    source.from || source.to
      ? `${source.from ? formatDate(source.from) : ''} — ${source.to ? formatDate(source.to) : ''}`
      : null;
  return (
    <li>
      <span className="font-medium">{t(`tools.${source.tool}`, { defaultValue: source.tool })}</span>
      {`: ${tables}`}
      {period && ` · ${period}`}
      {source.rows !== undefined && ` · ${t('chat.rows', { count: formatNumber(source.rows) })}`}
    </li>
  );
}

const CONFIDENCE_VARIANT = { high: 'success', medium: 'warning', low: 'neutral' } as const;

function Evidence({ message }: { message: ChatMessage }) {
  const { t } = useTranslation('ai');
  const { confidence, sources = [] } = message;
  if (!confidence) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-2 text-sm text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={CONFIDENCE_VARIANT[confidence.level]}>{t(`chat.confidence.${confidence.level}`)}</Badge>
        <span>{t(`chat.basis.${confidence.basis}`)}</span>
      </div>
      {sources.length > 0 && (
        <details>
          <summary className="min-h-11 cursor-pointer content-center">{t('chat.sourcesTitle', { count: sources.length })}</summary>
          <ul className="flex flex-col gap-1 pb-1">
            {sources.map((source, i) => (
              <SourceLine key={i} source={source} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 break-words whitespace-pre-line text-primary-foreground">
          {message.text}
        </p>
      </div>
    );
  }
  const tools: ToolCall[] = message.toolCalls ?? [];
  return (
    <article className="flex flex-col gap-3 rounded-2xl rounded-bl-sm border border-border bg-card p-4">
      <ToolActivity tools={tools} />
      <RichText text={message.text} />
      {message.attachments && message.attachments.length > 0 && <Attachments attachments={message.attachments} />}
      <Evidence message={message} />
    </article>
  );
}
