import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button, Card } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan, useSession } from '@/lib/auth';
import { storageGet, storageSet } from '@/lib/utils';
import { SETUP_STEPS, setupProgress, type SetupStep } from './setup';

async function countRows(steps: SetupStep[]): Promise<Record<string, number | null>> {
  const answers = await Promise.allSettled(steps.map((step) => api.list(step.source, { pageSize: 1 })));
  return Object.fromEntries(
    answers.map((answer, index) => {
      if (answer.status === 'rejected') return [steps[index].key, null];
      // Short lists, such as accounts, come whole and carry no total.
      return [steps[index].key, answer.value.meta?.total ?? answer.value.data.length];
    }),
  );
}

/** Shown to whoever sets the farm up, until it is set up. A farm with no use for a step can hide the list. */
export function SetupChecklist() {
  const { t } = useTranslation('dashboard');
  const session = useSession();
  const can = useCan();
  const closedKey = `yap.setupClosed:${session.farm?.id ?? ''}`;
  const [closed, setClosed] = useState(() => storageGet(closedKey) !== null);
  const steps = SETUP_STEPS.filter((step) => can(step.access));
  const enabled = !closed && can('settings.view') && steps.length > 0;

  const query = useQuery({
    queryKey: ['setup-checklist', session.farm?.id, steps.length],
    queryFn: () => countRows(steps),
    enabled,
    // Coming back from a finished step has to show it gone.
    staleTime: 0,
  });

  if (!enabled || !query.data) return null;

  const close = () => {
    storageSet(closedKey, '1');
    setClosed(true);
  };

  const { open, done, total, finished } = setupProgress(steps, query.data);
  if (finished) {
    storageSet(closedKey, '1');
    return null;
  }
  if (open.length === 0) return null;

  return (
    <Card className="mb-4 flex flex-col gap-2 p-4" data-testid="setup-checklist">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 text-base font-bold">{t('setup.title')}</h2>
        <span className="text-sm text-muted-foreground">{t('setup.progress', { done, total })}</span>
      </div>
      <p className="text-sm text-muted-foreground">{t('setup.intro')}</p>
      <ol className="flex flex-col">
        {open.map((step) => (
          <li key={step.key} className="border-t border-border first:border-t-0">
            <Link to={step.link} className="focus-ring flex min-h-14 items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold break-words">{t(`setup.steps.${step.key}.title`)}</span>
                <span className="block text-sm break-words text-muted-foreground">{t(`setup.steps.${step.key}.body`)}</span>
              </span>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ol>
      <Button variant="ghost" className="min-h-11 self-end" onClick={close}>
        {t('setup.hide')}
      </Button>
    </Card>
  );
}
