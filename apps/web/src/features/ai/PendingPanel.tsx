import { ClipboardCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorCard } from '@/components';
import { Skeleton } from '@/components/ui';
import { FarmProposalCard } from './FarmProposalCard';
import { usePendingFarmProposals, usePendingProposals } from './pending';
import { ProposalCard } from './ProposalCard';
import type { FarmProposalView, ProposalView } from './types';

/** Cards seen so far. One stays after it leaves the pending list: its outcome and Undo are on it. */
function useShown<T extends { id: string }>(data: T[] | undefined): T[] {
  const [shown, setShown] = useState<T[]>([]);
  useEffect(() => {
    if (!data) return;
    setShown((current) => {
      const known = new Set(current.map((proposal) => proposal.id));
      return [...current, ...data.filter((proposal) => !known.has(proposal.id))];
    });
  }, [data]);
  return shown;
}

/**
 * Everything waiting for this person, whichever channel it started in. A card stays after it leaves
 * the pending list, because that is where its outcome and Undo button are.
 */
export function PendingPanel() {
  const { t } = useTranslation('ai');
  const money = usePendingProposals();
  const farm = usePendingFarmProposals();
  const shownMoney = useShown<ProposalView>(money.data);
  const shownFarm = useShown<FarmProposalView>(farm.data);

  // A failed poll keeps what is on screen: replacing it would take an open Undo away.
  const failed = money.error != null && !money.data ? money : farm.error != null && !farm.data ? farm : null;
  if (failed) return <ErrorCard error={failed.error} onRetry={() => void failed.refetch()} />;
  if (money.isLoading || farm.isLoading) return <Skeleton className="h-48" />;
  if (shownMoney.length + shownFarm.length === 0 && (money.data?.length ?? 0) + (farm.data?.length ?? 0) === 0) {
    return <EmptyState icon={ClipboardCheck} title={t('records.pending.emptyTitle')} description={t('records.pending.emptyBody')} />;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="pending-panel">
      <p className="text-sm text-muted-foreground">{t('records.pending.intro')}</p>
      {shownMoney.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} />
      ))}
      {shownFarm.length > 0 && shownMoney.length > 0 && <h3 className="mt-1 font-semibold">{t('farmRecords.pendingTitle')}</h3>}
      {shownFarm.map((proposal) => (
        <FarmProposalCard key={proposal.id} proposal={proposal} />
      ))}
    </div>
  );
}
