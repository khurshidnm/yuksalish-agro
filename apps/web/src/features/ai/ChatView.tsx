import { Loader2, SendHorizontal, Sparkles } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorCard } from '@/components';
import { Alert, Button, Skeleton, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';
import { MessageBubble, ToolActivity } from './MessageBubble';
import { withoutRepeatedCards } from './proposals';
import { aiErrorMessage } from './text';
import type { ChatMessage } from './types';
import type { AssistantChat } from './useAssistantChat';
import { useOnline } from './useOnline';

const SUGGESTIONS = ['feedSpending', 'lambingThisWeek', 'feedDays', 'attention'] as const;
const MAX_LENGTH = 2000;

const hasProposal = (message: ChatMessage | undefined) => message?.attachments?.some((attachment) => attachment.type === 'proposal') ?? false;

export interface ChatViewProps {
  chat: AssistantChat;
  configured: boolean;
  /** `sheet` scrolls inside its own panel, `page` scrolls with the page. */
  layout?: 'page' | 'sheet';
}

/** The conversation and the box to type in. The /ai page and the floating sheet both show this. */
export function ChatView({ chat, configured, layout = 'page' }: ChatViewProps) {
  const { t } = useTranslation('ai');
  const online = useOnline();
  const bottom = useRef<HTMLDivElement>(null);
  const latest = useRef<HTMLDivElement>(null);
  const { live, sending, draft, setDraft } = chat;
  const messages = useMemo(() => withoutRepeatedCards(chat.messages), [chat.messages]);
  const last = messages[messages.length - 1];
  const inSheet = layout === 'sheet';

  // A card is read from its amount, so it opens at its top rather than at its buttons.
  useEffect(() => {
    if (!sending && hasProposal(last)) latest.current?.scrollIntoView({ block: 'start' });
    else bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, live.length, sending, last]);

  const canSend = configured && online;
  const ask = (text: string) => {
    if (canSend) chat.ask(text);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    ask(draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      ask(draft);
    }
  };

  const body = chat.loadError ? (
    <ErrorCard error={chat.loadError} onRetry={chat.reload} />
  ) : chat.loading ? (
    <Skeleton className="h-40" />
  ) : messages.length === 0 ? (
    <EmptyState
      icon={Sparkles}
      title={t(configured ? 'records.emptyTitle' : 'chat.unavailableTitle')}
      description={t(configured ? 'records.emptyDescription' : 'chat.unavailableDescription')}
      action={
        configured && (
          <div className="flex max-w-xl flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-center">
            {SUGGESTIONS.map((key) => (
              <Button key={key} variant="outline" className="h-auto min-h-11 py-2 whitespace-normal" onClick={() => ask(t(`chat.suggestions.${key}`))}>
                {t(`chat.suggestions.${key}`)}
              </Button>
            ))}
          </div>
        )
      }
    />
  ) : (
    <div className="flex flex-col gap-3" aria-live="polite">
      {messages.map((message) => {
        const isLast = message === last;
        return (
          <div key={message.id} ref={isLast ? latest : undefined} className="min-w-0 scroll-mt-20">
            <MessageBubble message={message} latest={isLast} onAnswer={isLast && canSend ? ask : undefined} busy={sending} />
          </div>
        );
      })}
      {sending && (
        <div data-testid="chat-thinking" className="flex flex-col gap-2 rounded-2xl rounded-bl-sm border border-border bg-card p-4">
          <ToolActivity tools={live} />
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t('chat.thinking')}
          </p>
        </div>
      )}
    </div>
  );

  return (
    <div className={inSheet ? 'flex min-h-0 flex-1 flex-col' : 'flex min-w-0 flex-col gap-4'}>
      <div className={inSheet ? 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3' : 'contents'}>
        {body}
        {chat.sendError != null && <Alert tone="danger">{aiErrorMessage(t, chat.sendError)}</Alert>}
        <div ref={bottom} />
      </div>

      {configured && (
        <form
          onSubmit={onSubmit}
          className={cn(
            'flex items-end gap-2 bg-card p-2',
            inSheet
              ? 'border-t border-border pb-[max(0.5rem,env(safe-area-inset-bottom))]'
              : 'sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] rounded-xl border border-border shadow-pop lg:bottom-3',
          )}
        >
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('records.composerPlaceholder')}
            aria-label={t('records.composerPlaceholder')}
            maxLength={MAX_LENGTH}
            rows={1}
            className="max-h-40 min-h-11 flex-1 resize-none border-0 shadow-none focus-visible:ring-0"
          />
          <Button type="submit" size="icon" aria-label={t('chat.send')} disabled={!draft.trim() || !online} loading={sending}>
            <SendHorizontal aria-hidden />
          </Button>
        </form>
      )}
    </div>
  );
}
