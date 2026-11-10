import { useDetail } from '@/lib/query';
import type { FarmProposalView, ProposalView } from './types';

export const PROPOSALS_PATH = '/ai/proposals';

/** Open proposals from every channel. Polling must never disturb a page, so failures stay quiet. */
export function usePendingProposals(enabled = true) {
  return useDetail<ProposalView[]>(PROPOSALS_PATH, undefined, { enabled, refetchInterval: 60_000, retry: false });
}

export const FARM_PROPOSALS_PATH = '/ai/farm-proposals';

/** Farm records waiting for this person: weights, deaths, treatments, feedings. */
export function usePendingFarmProposals(enabled = true) {
  return useDetail<FarmProposalView[]>(FARM_PROPOSALS_PATH, undefined, { enabled, refetchInterval: 60_000, retry: false });
}

/** How many cards wait, money and farm records together. */
export function usePendingCount(enabled = true): number {
  return (usePendingProposals(enabled).data?.length ?? 0) + (usePendingFarmProposals(enabled).data?.length ?? 0);
}
