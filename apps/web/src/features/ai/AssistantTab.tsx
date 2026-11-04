import { History, Loader2, MessageSquarePlus, SendHorizontal, Sparkles, Trash2 } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorCard, useConfirm, useUrlParam } from '@/components';
import { Alert, Button, Sheet, SheetContent, SheetTitle, Skeleton, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useApiMutation, useDetail, useList } from '@/lib/query';
import { cn } from '@/lib/utils';
import { streamChat } from './chat-stream';
import { type LiveTool, MessageBubble, ToolActivity } from './MessageBubble';
import { aiErrorMessage } from './text';
import type { ChatEvent, ChatMessage, ChatReply, Conversation, ConversationSummary } from './types';

const SUGGESTIONS = ['feedSpending', 'lambingThisWeek', 'feedDays', 'attention'] as const;
const MAX_LENGTH = 2000;

function ConversationList({
  active,
  onOpen,
  onDeleted,
}: {
  active: string;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const { t } = useTranslation('ai');
  const confirm = useConfirm();
  const { data, error, isLoading, refetch } = useList<ConversationSummary>('/ai/conversations', { pageSize: 30 });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`/ai/conversations/${id}`),
    invalidate: ['/ai/conversations'],
    onSuccess: (_result, id) => onDeleted(id),
  });

  if (isLoading) return <Skeleton className="h-24" />;
  if (error) return <ErrorCard error={error} onRetry={() => void refetch()} />;
  if (!data || data.data.length === 0) return <p className="p-2 text-sm text-muted-foreground">{t('chat.historyEmpty')}</p>;

  return (
    <ul className="flex flex-col gap-1">
      {data.data.map((conversation) => (
        <li key={conversation.id} className="group flex items-center gap-1">
          <button
            type="button"
            onClick={() => onOpen(conversation.id)}
            aria-current={conversation.id === active ? 'true' : undefined}
            className={cn(
              'min-h-11 min-w-0 flex-1 truncate rounded-lg px-3 text-left text-sm hover:bg-muted',
              conversation.id === active && 'bg-secondary font-medium text-secondary-foreground',
            )}
          >
            {conversation.title}
          </button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('chat.deleteChat')}
            onClick={async () => {
              const yes = await confirm({ title: t('chat.deleteChatConfirm'), destructive: true, confirmLabel: t('common:actions.delete') });
              if (yes) remove.mutate(conversation.id);
            }}
          >
            <Trash2 aria-hidden />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function applyEvent(tools: LiveTool[], event: ChatEvent): LiveTool[] {
  if (event.type === 'tool_start') return [...tools, { name: event.name, status: 'running' }];
  const index = tools.findLastIndex((tool) => tool.name === event.name && tool.status === 'running');
  return tools.map((tool, i) => (i === index ? { name: tool.name, status: event.status } : tool));
}

export function AssistantTab({ configured }: { configured: boolean }) {
  const { i18n, t } = useTranslation('ai');
  const [conversationId, setConversationId] = useUrlParam('c');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<LiveTool[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const conversation = useDetail<Conversation>(conversationId ? `/ai/conversations/${conversationId}` : null);

  const send = useApiMutation<string, ChatReply>({
    mutationFn: (message) =>
      streamChat(
        { conversationId: conversationId || undefined, message, language: i18n.language },
        (event) => setLive((tools) => applyEvent(tools, event)),
      ),
    invalidate: ['/ai/conversations'],
    silentError: true,
    onSuccess: (reply) => {
      setMessages((current) => [...current, reply.message]);
      setConversationId(reply.conversationId);
      setLive([]);
    },
    onError: (_error, message) => {
      // Give the question back, so a failed send loses nothing.
      setMessages((current) => current.slice(0, -1));
      setDraft(message);
      setLive([]);
    },
  });

  // The server copy wins once loaded, except while an answer is on its way.
  useEffect(() => {
    if (send.isPending) return;
    if (conversation.data) setMessages(conversation.data.messages);
    else if (!conversationId) setMessages([]);
  }, [conversation.data, conversationId, send.isPending]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, live.length, send.isPending]);

  const ask = (text: string) => {
    const message = text.trim();
    if (!message || send.isPending || !configured) return;
    send.reset();
    setDraft('');
    setMessages((current) => [
      ...current,
      { id: `local-${Date.now()}`, role: 'user', createdAt: new Date().toISOString(), text: message },
    ]);
    send.mutate(message);
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

  const startNew = () => {
    setConversationId('');
    setMessages([]);
    send.reset();
  };

  const open = (id: string) => {
    setConversationId(id);
    setHistoryOpen(false);
  };

  const list = (
    <ConversationList active={conversationId} onOpen={open} onDeleted={(id) => id === conversationId && startNew()} />
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="hidden flex-col gap-2 lg:flex">
        <Button variant="outline" onClick={startNew}>
          <MessageSquarePlus aria-hidden />
          {t('chat.newChat')}
        </Button>
        {list}
      </aside>

      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex gap-2 lg:hidden">
          <Button variant="outline" className="flex-1" onClick={startNew}>
            <MessageSquarePlus aria-hidden />
            {t('chat.newChat')}
          </Button>
          <Button variant="outline" className="flex-1" onClick={() => setHistoryOpen(true)}>
            <History aria-hidden />
            {t('chat.history')}
          </Button>
        </div>
        <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
          <SheetContent side="bottom">
            <SheetTitle className="min-h-14 content-center px-4 pr-14 font-semibold">{t('chat.history')}</SheetTitle>
            <div className="max-h-[60dvh] overflow-y-auto px-4 pb-4">{list}</div>
          </SheetContent>
        </Sheet>

        {conversation.error ? (
          <ErrorCard error={conversation.error} onRetry={startNew} />
        ) : conversation.isLoading ? (
          <Skeleton className="h-40" />
        ) : messages.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title={t(configured ? 'chat.emptyTitle' : 'chat.unavailableTitle')}
            description={t(configured ? 'chat.emptyDescription' : 'chat.unavailableDescription')}
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
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {send.isPending && (
              <div className="flex flex-col gap-2 rounded-2xl rounded-bl-sm border border-border bg-card p-4">
                <ToolActivity tools={live} />
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {t('chat.thinking')}
                </p>
              </div>
            )}
          </div>
        )}

        {send.error != null && <Alert tone="danger">{aiErrorMessage(t, send.error)}</Alert>}
        <div ref={bottom} />

        {configured && (
        <form
          onSubmit={onSubmit}
          className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] flex items-end gap-2 rounded-xl border border-border bg-card p-2 shadow-pop lg:bottom-3"
        >
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('chat.placeholder')}
            aria-label={t('chat.placeholder')}
            maxLength={MAX_LENGTH}
            rows={1}
            className="max-h-40 min-h-11 flex-1 resize-none border-0 shadow-none focus-visible:ring-0"
          />
          <Button type="submit" size="icon" aria-label={t('chat.send')} disabled={!draft.trim()} loading={send.isPending}>
            <SendHorizontal aria-hidden />
          </Button>
        </form>
        )}
      </div>
    </div>
  );
}
