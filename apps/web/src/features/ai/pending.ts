import { useDetail } from '@/lib/query';
import type { ProposalView } from './types';

export const PROPOSALS_PATH = '/ai/proposals';

/** Open proposals from every channel. Polling must never disturb a page, so failures stay quiet. */
export function usePendingProposals(enabled = true) {
  return useDetail<ProposalView[]>(PROPOSALS_PATH, undefined, { enabled, refetchInterval: 60_000, retry: false });
}
