import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MONEY_QUERIES } from '@/features/finance/lib';
import { STOCK_PATHS } from '@/features/inventory/shared';
import { api } from '@/lib/api';
import { pathKey, useApiMutation } from '@/lib/query';
import { PROPOSALS_PATH } from './pending';
import { readRefusal } from './proposals';
import type { ProposalView, Question } from './types';

const AFTER_WRITE = [PROPOSALS_PATH, ...MONEY_QUERIES, ...STOCK_PATHS];

export type ProposalChanges = Record<string, unknown>;
export type UpdateResult = ProposalView | { questions: Question[] };

/** `stamp` is from the card on screen, so the server books what the person actually read. */
export interface ConfirmInput {
  stamp: string;
  acknowledged?: true;
}

export function asksQuestions(result: UpdateResult): result is { questions: Question[] } {
  return 'questions' in result;
}

/**
 * One proposal, kept live. A chat message stores a copy from when it was written, so the card reads
 * the current state: a proposal confirmed in Telegram must not offer Confirm again here.
 */
export function useProposal(snapshot: ProposalView) {
  const client = useQueryClient();
  const path = `${PROPOSALS_PATH}/${snapshot.id}`;
  const key = pathKey(path);

  const query = useQuery<ProposalView>({
    queryKey: key,
    queryFn: () => api.get<ProposalView>(path),
    initialData: snapshot,
    initialDataUpdatedAt: 0,
    retry: false,
  });

  const store = (view: ProposalView) => client.setQueryData(key, view);
  // After a failure the server may have moved on, for example when the window closed.
  const recheck = () => void client.invalidateQueries({ queryKey: key });

  const confirm = useApiMutation<ConfirmInput, ProposalView>({
    mutationFn: (input) => api.post<ProposalView>(`${path}/confirm`, input),
    invalidate: AFTER_WRITE,
    silentError: true,
    onSuccess: store,
    onError: (error) => {
      const refusal = readRefusal(error);
      if (refusal && 'proposal' in refusal) store(refusal.proposal);
      else recheck();
    },
  });
  const reject = useApiMutation<void, ProposalView>({
    mutationFn: () => api.post<ProposalView>(`${path}/reject`),
    invalidate: [PROPOSALS_PATH],
    silentError: true,
    onSuccess: store,
    onError: recheck,
  });
  const undo = useApiMutation<void, ProposalView>({
    mutationFn: () => api.post<ProposalView>(`${path}/undo`),
    invalidate: AFTER_WRITE,
    silentError: true,
    onSuccess: store,
    onError: recheck,
  });
  const update = useApiMutation<ProposalChanges, UpdateResult>({
    mutationFn: (changes) => api.patch<UpdateResult>(path, changes),
    invalidate: [PROPOSALS_PATH],
    silentError: true,
    onSuccess: (result) => {
      if (!asksQuestions(result)) store(result);
    },
    onError: recheck,
  });

  return { proposal: query.data ?? snapshot, confirm, reject, undo, update };
}
