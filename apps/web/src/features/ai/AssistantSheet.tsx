import { Maximize2, MessageSquarePlus, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ErrorCard } from '@/components';
import {
  Alert,
  Badge,
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { useSession } from '@/lib/auth';
import { useDetail } from '@/lib/query';
import type { AssistantRequest } from './assistant-launch';
import { ChatView } from './ChatView';
import { useLastConversation } from './conversation-store';
import { HelpPanel } from './HelpPanel';
import { usePendingProposals } from './pending';
import { PendingPanel } from './PendingPanel';
import type { AiStatus } from './types';
import { useAssistantChat } from './useAssistantChat';
import { useOnline } from './useOnline';

/** Same conversation as the /ai page: a bottom sheet on phones, a side panel on wide screens. */
export default function AssistantSheet({
  open,
  onOpenChange,
  request,
  onRequestDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A question from the assistant bar, asked as soon as the sheet can. */
  request?: AssistantRequest | null;
  onRequestDone?: () => void;
}) {
  const { t } = useTranslation('ai');
  const last = useLastConversation();
  const [conversationId, setConversationId] = useState(last.read);
  const [tab, setTab] = useState('chat');
  const status = useDetail<AiStatus>(open ? '/ai/status' : null);
  const session = useSession();
  const pending = usePendingProposals(open).data?.length ?? 0;
  const configured = status.data?.assistant.configured ?? false;
  const online = useOnline();

  const onConversation = useCallback(
    (id: string) => {
      setConversationId(id);
      last.write(id);
    },
    [last],
  );
  const chat = useAssistantChat({ conversationId, onConversation, enabled: open });

  // Opens ready to talk, on whichever conversation the /ai page last moved on to.
  useEffect(() => {
    if (!open) return;
    setConversationId(last.read());
    setTab('chat');
  }, [open, last]);

  // Waits for the conversation above to settle. Offline or unconfigured, the question stays in the box.
  useEffect(() => {
    if (!open || !request || !status.data || conversationId !== last.read()) return;
    if (configured && online) chat.ask(request.text);
    else chat.setDraft(request.text);
    onRequestDone?.();
    // `chat` is a new object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request, status.data, configured, online, conversationId, last]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-testid="assistant-sheet"
        overlayClassName="bg-black/30 backdrop-blur-sm"
        className="h-[92dvh] bg-popover lg:inset-x-auto lg:top-3 lg:right-3 lg:bottom-3 lg:h-auto lg:max-h-none lg:w-[30rem] lg:overflow-hidden lg:rounded-2xl lg:border"
      >
        <div className="flex min-h-14 items-center gap-1 border-b border-border py-1 pr-14 pl-4">
          <span className="me-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            <Sparkles className="size-4.5" aria-hidden />
          </span>
          <SheetTitle className="min-w-0 flex-1 truncate font-semibold">{t('records.sheet.title')}</SheetTitle>
          <SheetDescription className="sr-only">{t('records.sheet.description')}</SheetDescription>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('chat.newChat')}
            title={t('chat.newChat')}
            onClick={() => {
              chat.startNew();
              setTab('chat');
            }}
          >
            <MessageSquarePlus aria-hidden />
          </Button>
          <Button asChild variant="ghost" size="icon">
            <Link to={conversationId ? `/ai?c=${conversationId}` : '/ai'} aria-label={t('records.sheet.openPage')} title={t('records.sheet.openPage')}>
              <Maximize2 aria-hidden />
            </Link>
          </Button>
        </div>

        {/* The sheet covers the shell's offline bar, so it says so itself, on every tab. */}
        {!online && (
          <div className="border-b border-border p-3">
            <Alert tone="warning">{t('common:status.offline')}</Alert>
          </div>
        )}

        {status.data && !configured && (
          <div className="border-b border-border p-3">
            <Alert tone="info" title={t('page.notConfiguredTitle')}>
              <p>{t('page.notConfiguredBody')}</p>
              <p>{t(session.user.isPlatformAdmin ? 'page.notConfiguredHow' : 'page.notConfiguredAsk')}</p>
            </Alert>
          </div>
        )}

        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="shrink-0 px-2">
            <TabsTrigger value="chat">{t('records.sheet.chat')}</TabsTrigger>
            <TabsTrigger value="pending" data-testid="sheet-pending-tab">
              <span className="flex items-center gap-1.5">
                {t('records.pending.tab')}
                {pending > 0 && <Badge variant="warning">{pending}</Badge>}
              </span>
            </TabsTrigger>
            <TabsTrigger value="help">{t('records.sheet.help')}</TabsTrigger>
          </TabsList>
          <TabsContent value="chat" className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
            {status.error != null ? (
              <div className="p-3">
                <ErrorCard error={status.error} onRetry={() => void status.refetch()} />
              </div>
            ) : status.data ? (
              <ChatView chat={chat} configured={configured} layout="sheet" />
            ) : (
              <Skeleton className="m-3 h-40" />
            )}
          </TabsContent>
          <TabsContent value="pending" className="mt-0 min-h-0 flex-1 overflow-y-auto p-3 data-[state=inactive]:hidden">
            <PendingPanel />
          </TabsContent>
          <TabsContent value="help" className="mt-0 min-h-0 flex-1 overflow-y-auto p-3 data-[state=inactive]:hidden">
            <HelpPanel
              onPick={
                configured
                  ? (text) => {
                      chat.setDraft(text);
                      setTab('chat');
                    }
                  : undefined
              }
            />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
