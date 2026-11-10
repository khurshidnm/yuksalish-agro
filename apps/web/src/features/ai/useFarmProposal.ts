import { useQuery, useQueryClient } from '@tanstack/react-query';
import { STOCK_PATHS } from '@/features/inventory/shared';
import { api } from '@/lib/api';
import { pathKey, useApiMutation } from '@/lib/query';
import { readFarmRefusal } from './farm-proposals';
import { FARM_PROPOSALS_PATH } from './pending';
import type { FarmProposalView } from './types';

/** A weight, a death, a treatment or a feeding shows on these pages, and the last two move stock. */
const AFTER_WRITE = [FARM_PROPOSALS_PATH, '/livestock', '/today', '/dashboard', ...STOCK_PATHS];

/** One farm card, kept live: a card confirmed in Telegram must not offer Confirm again here. */
export function useFarmProposal(snapshot: FarmProposalView) {
  const client = useQueryClient();
  const path = `${FARM_PROPOSALS_PATH}/${snapshot.id}`;
  const key = pathKey(path);

  const query = useQuery<FarmProposalView>({
    queryKey: key,
    queryFn: () => api.get<FarmProposalView>(path),
    initialData: snapshot,
    initialDataUpdatedAt: 0,
    retry: false,
  });

  const store = (view: FarmProposalView) => client.setQueryData(key, view);
  const recheck = () => void client.invalidateQueries({ queryKey: key });

  const confirm = useApiMutation<{ stamp: string }, FarmProposalView>({
    mutationFn: (input) => api.post<FarmProposalView>(`${path}/confirm`, input),
    invalidate: AFTER_WRITE,
    silentError: true,
    onSuccess: store,
    onError: (error) => {
      const refusal = readFarmRefusal(error);
      if (refusal?.code === 'PROPOSAL_CHANGED') store(refusal.proposal);
      else recheck();
    },
  });
  const reject = useApiMutation<void, FarmProposalView>({
    mutationFn: () => api.post<FarmProposalView>(`${path}/reject`),
    invalidate: [FARM_PROPOSALS_PATH],
    silentError: true,
    onSuccess: store,
    onError: recheck,
  });
  const undo = useApiMutation<void, FarmProposalView>({
    mutationFn: () => api.post<FarmProposalView>(`${path}/undo`),
    invalidate: AFTER_WRITE,
    silentError: true,
    onSuccess: store,
    onError: recheck,
  });

  return { proposal: query.data ?? snapshot, confirm, reject, undo };
}
