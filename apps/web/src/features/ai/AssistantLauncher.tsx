import { Bot } from 'lucide-react';
import { Suspense, lazy, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { useAuth, useModuleEnabled, usePermission } from '@/lib/auth';
import { type AssistantRequest, onAssistantRequest } from './assistant-launch';
import { usePendingProposals } from './pending';

// Loaded on first use: the chat brings charts along, which the shell must not pay for.
const AssistantSheet = lazy(() => import('./AssistantSheet'));

/**
 * Single-task entry forms for gloved hands. Their full-width controls and sticky save button leave
 * no free corner, so a floating button would always sit on top of one of them.
 */
const FIELD_ENTRY_PAGES = /^\/today\/(daily-log|report-sick|death|weight|lambing)(\/|$)/;

function LauncherButton({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation('ai');
  const count = usePendingProposals().data?.length ?? 0;
  const label = count > 0 ? t('records.launcher.pending', { count }) : t('records.launcher.open');

  return (
    <button
      type="button"
      data-app-chrome
      data-testid="assistant-launcher"
      aria-label={label}
      title={label}
      onClick={onOpen}
      className="focus-ring fixed right-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-pop hover:bg-primary-hover lg:right-6 lg:bottom-6"
    >
      <Bot className="size-6" aria-hidden />
      {count > 0 && (
        <span
          data-testid="assistant-badge"
          className="absolute -top-1 -right-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-destructive px-1 text-xs font-semibold text-destructive-foreground tabular-nums"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

/**
 * The assistant from anywhere, for people with AI access. Not shown on /ai, which is the same
 * conversation, or on field entry forms. The spacer lets the end of a page scroll clear of the button.
 */
export function AssistantLauncher() {
  const { session } = useAuth();
  const allowed = usePermission('ai.view');
  const moduleEnabled = useModuleEnabled();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const [request, setRequest] = useState<AssistantRequest | null>(null);

  useEffect(
    () =>
      onAssistantRequest((next) => {
        setUsed(true);
        setRequest(next);
        setOpen(true);
      }),
    [],
  );

  // Links inside the sheet lead to other pages, and the sheet would otherwise cover them.
  useEffect(() => setOpen(false), [pathname]);

  if (!allowed || !session?.tenant || !moduleEnabled('ai')) return null;
  const hidden = pathname === '/ai' || pathname.startsWith('/ai/') || FIELD_ENTRY_PAGES.test(pathname);

  return (
    <>
      {!hidden && (
        <>
          <div aria-hidden data-app-chrome className="h-14 shrink-0" />
          <LauncherButton
            onOpen={() => {
              setUsed(true);
              setOpen(true);
            }}
          />
        </>
      )}
      {used && (
        <Suspense fallback={null}>
          <AssistantSheet open={open && !hidden} onOpenChange={setOpen} request={request} onRequestDone={() => setRequest(null)} />
        </Suspense>
      )}
    </>
  );
}
