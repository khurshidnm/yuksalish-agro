import { useQueries } from '@tanstack/react-query';
import { BookA, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorCard, useConfirm } from '@/components';
import { Button, Skeleton } from '@/components/ui';
import { useCenterName, useLocalName } from '@/features/finance/lib';
import type { CategoryOption, CostCenterOption } from '@/features/finance/types';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { pathKey, useApiMutation, useDetail } from '@/lib/query';
import type { LearnedPhrase } from './types';

const PATH = '/ai/aliases';

/** Where each kind of target can be named. An alias stores only the id. */
const LOOKUPS: Record<string, string> = {
  category: '/finance/categories',
  account: '/finance/accounts/lookup',
  counterparty: '/finance/counterparties/lookup',
  item: '/inventory/items/lookup',
  warehouse: '/inventory/warehouses/lookup',
  cost_center: '/finance/cost-centers/lookup',
};

type Named = { id: string; name: unknown; type?: string };

/** The record each phrase points to: that is what a person needs to judge whether it is right. */
function useTargetNames(phrases: LearnedPhrase[]): (phrase: LearnedPhrase) => string | null {
  const localName = useLocalName();
  const centerName = useCenterName();
  const types = useMemo(() => [...new Set(phrases.map((p) => p.targetType))].filter((type) => LOOKUPS[type]), [phrases]);
  const results = useQueries({
    queries: types.map((type) => ({ queryKey: pathKey(LOOKUPS[type]), queryFn: () => api.get<Named[]>(LOOKUPS[type]) })),
  });

  return ({ targetId, targetType }) => {
    const rows = results[types.indexOf(targetType)]?.data;
    const row = rows?.find((r) => r.id === targetId);
    if (!row) return null;
    if (targetType === 'category') return localName((row as unknown as CategoryOption).name);
    if (targetType === 'cost_center') return centerName(row.name as string, (row as unknown as CostCenterOption).type);
    return row.name as string;
  };
}

/** What the assistant has learned on this farm. Removing one makes it ask again next time. */
export function PhrasesPanel() {
  const { t } = useTranslation('ai');
  const canDelete = usePermission('ai.create');
  const confirm = useConfirm();
  const { data, error, isLoading, refetch } = useDetail<LearnedPhrase[]>(PATH);
  const phrases = data ?? [];
  const targetName = useTargetNames(phrases);
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [PATH],
    successMessage: 'ai:records.phrases.deleted',
  });

  if (error != null) return <ErrorCard error={error} onRetry={() => void refetch()} />;
  if (isLoading) return <Skeleton className="h-40" />;
  if (phrases.length === 0) {
    return <EmptyState icon={BookA} title={t('records.phrases.emptyTitle')} description={t('records.phrases.emptyBody')} />;
  }

  return (
    <div className="flex max-w-2xl flex-col gap-3" data-testid="phrases-panel">
      <p className="text-sm text-muted-foreground">{t('records.phrases.intro')}</p>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
        {phrases.map((phrase) => {
          const type = t(`records.phrases.types.${phrase.targetType}`, { defaultValue: phrase.targetType });
          const name = targetName(phrase);
          return (
            <li key={phrase.id} className="flex min-h-14 items-center gap-2 px-3 py-2" data-testid="phrase-row">
              <div className="min-w-0 flex-1">
                <p className="font-medium break-words">{phrase.phrase}</p>
                <p className="text-sm break-words text-muted-foreground">{name ? `${type}: ${name}` : type}</p>
              </div>
              {canDelete && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('records.phrases.delete', { phrase: phrase.phrase })}
                  loading={remove.isPending && remove.variables === phrase.id}
                  onClick={async () => {
                    const yes = await confirm({
                      title: t('records.phrases.deleteTitle', { phrase: phrase.phrase }),
                      description: t('records.phrases.deleteBody'),
                      destructive: true,
                      confirmLabel: t('common:actions.delete'),
                    });
                    if (yes) remove.mutate(phrase.id);
                  }}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
