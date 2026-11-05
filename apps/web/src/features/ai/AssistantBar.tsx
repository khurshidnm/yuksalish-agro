import { SendHorizontal, Sparkles } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { useCan, useModuleEnabled } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { openAssistant } from './assistant-launch';

/** Ready-made questions. Each stays hidden from people who could not see the answer anyway. */
const CHIPS = [
  { key: 'attention', question: 'chat.suggestions.attention', permission: 'ai.view' },
  { key: 'lambing', question: 'chat.suggestions.lambingThisWeek', permission: 'livestock.view' },
  { key: 'feed', question: 'chat.suggestions.feedDays', permission: 'feed.view' },
] as const;

export interface AssistantBarProps {
  /** Without the ready-made questions, for tight spots such as over the map. */
  compact?: boolean;
  className?: string;
}

/** The assistant's front door: type a question or a record here, the answer opens in the sheet. */
export function AssistantBar({ compact, className }: AssistantBarProps) {
  const { t } = useTranslation('ai');
  const can = useCan();
  const moduleEnabled = useModuleEnabled();
  const [text, setText] = useState('');

  if (!can('ai.view') || !moduleEnabled('ai')) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const question = text.trim();
    if (!question) return;
    openAssistant({ text: question });
    setText('');
  };

  return (
    <form
      onSubmit={submit}
      data-testid="assistant-bar"
      className={cn('rounded-2xl border border-border bg-popover p-2 text-popover-foreground shadow-card focus-within:border-ring', className)}
    >
      <div className="flex items-center gap-2">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles className="size-5" aria-hidden />
        </span>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label={t('bar.label')}
          placeholder={t('bar.placeholder')}
          className="min-h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
        <Button type="submit" variant="accent" size="icon" aria-label={t('bar.send')} title={t('bar.send')}>
          <SendHorizontal aria-hidden />
        </Button>
      </div>
      {!compact && (
        <ul className="mt-1 flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {CHIPS.filter((chip) => can(chip.permission)).map((chip) => (
            <li key={chip.key} className="shrink-0">
              <button
                type="button"
                onClick={() => openAssistant({ text: t(chip.question) })}
                className="focus-ring min-h-11 rounded-lg bg-muted px-3 text-sm font-medium whitespace-nowrap text-foreground hover:bg-secondary md:min-h-9"
              >
                {t(`bar.chips.${chip.key}`)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
