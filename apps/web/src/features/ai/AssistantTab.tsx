import { CircleHelp, History, MessageSquarePlus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorCard, useConfirm, useUrlParam } from '@/components';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Sheet,
  SheetContent,
  SheetTitle,
  Skeleton,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useApiMutation, useList } from '@/lib/query';
import { cn } from '@/lib/utils';
import { ChatView } from './ChatView';
import { useLastConversation } from './conversation-store';
import { HelpPanel } from './HelpPanel';
import type { ConversationSummary } from './types';
import { useAssistantChat } from './useAssistantChat';

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

export function AssistantTab({ configured }: { configured: boolean }) {
  const { t } = useTranslation('ai');
  // An answer writes the conversation into the address, and that must not jump the view back to the top.
  const [conversationId, setUrlConversation] = useUrlParam('c', '', { keepScroll: true });
  const last = useLastConversation();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const setConversation = useCallback(
    (id: string) => {
      setUrlConversation(id);
      last.write(id);
    },
    [setUrlConversation, last],
  );
  const chat = useAssistantChat({ conversationId, onConversation: setConversation });

  // Pick up the conversation in progress, including one started in the floating sheet.
  useEffect(() => {
    if (conversationId) last.write(conversationId);
    else if (last.read()) setUrlConversation(last.read());
    // Only on arrival: "New conversation" must stay empty afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = (id: string) => {
    setConversation(id);
    setHistoryOpen(false);
  };

  const list = (
    <ConversationList active={conversationId} onOpen={open} onDeleted={(id) => id === conversationId && chat.startNew()} />
  );

  const helpButton = (
    <Button variant="outline" onClick={() => setHelpOpen(true)}>
      <CircleHelp aria-hidden />
      {t('records.help.open')}
    </Button>
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="hidden flex-col gap-2 lg:flex">
        <Button variant="outline" onClick={chat.startNew}>
          <MessageSquarePlus aria-hidden />
          {t('chat.newChat')}
        </Button>
        {helpButton}
        {list}
      </aside>

      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex gap-2 lg:hidden">
          {/* The words of all three do not fit a 360 px row in any language. */}
          <Button variant="outline" className="min-w-0 flex-1" onClick={chat.startNew}>
            <MessageSquarePlus aria-hidden />
            <span className="max-sm:sr-only">{t('chat.newChat')}</span>
          </Button>
          <Button variant="outline" className="min-w-0 flex-1" onClick={() => setHistoryOpen(true)}>
            <History aria-hidden />
            <span className="max-sm:sr-only">{t('chat.history')}</span>
          </Button>
          <Button variant="outline" size="icon" aria-label={t('records.help.open')} onClick={() => setHelpOpen(true)}>
            <CircleHelp aria-hidden />
          </Button>
        </div>
        <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
          <SheetContent side="bottom">
            <SheetTitle className="min-h-14 content-center px-4 pr-14 font-semibold">{t('chat.history')}</SheetTitle>
            <div className="max-h-[60dvh] overflow-y-auto px-4 pb-4">{list}</div>
          </SheetContent>
        </Sheet>
        <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('records.help.title')}</DialogTitle>
              <DialogDescription className="sr-only">{t('records.help.intro')}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <HelpPanel
                onPick={
                  configured
                    ? (text) => {
                        chat.setDraft(text);
                        setHelpOpen(false);
                      }
                    : undefined
                }
              />
            </DialogBody>
          </DialogContent>
        </Dialog>

        <ChatView chat={chat} configured={configured} />
      </div>
    </div>
  );
}
