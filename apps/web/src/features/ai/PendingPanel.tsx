import { ClipboardCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorCard } from '@/components';
import { Skeleton } from '@/components/ui';
import { usePendingProposals } from './pending';
import { ProposalCard } from './ProposalCard';
import type { ProposalView } from './types';

/**
 * Everything waiting for this person, whichever channel it started in. A card stays after it leaves
 * the pending list, because that is where its outcome and Undo button are.
 */
export function PendingPanel() {
  const { t } = useTranslation('ai');
  const { data, error, isLoading, refetch } = usePendingProposals();
  const [shown, setShown] = useState<ProposalView[]>([]);

  useEffect(() => {
    if (!data) return;
    setShown((current) => {
      const known = new Set(current.map((proposal) => proposal.id));
      return [...current, ...data.filter((proposal) => !known.has(proposal.id))];
    });
  }, [data]);

  // A failed poll keeps what is on screen: replacing it would take an open Undo away.
  if (error != null && !data) return <ErrorCard error={error} onRetry={() => void refetch()} />;
  if (isLoading) return <Skeleton className="h-48" />;
  if (shown.length === 0 && (data?.length ?? 0) === 0) {
    return <EmptyState icon={ClipboardCheck} title={t('records.pending.emptyTitle')} description={t('records.pending.emptyBody')} />;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="pending-panel">
      <p className="text-sm text-muted-foreground">{t('records.pending.intro')}</p>
      {shown.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} />
      ))}
    </div>
  );
}
