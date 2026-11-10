import { ApiError } from '@/lib/api';
import type { FarmFields, FarmProposalView, FarmRecordKind } from './types';

/** Where the confirmed record can be read, for someone who may open that page. */
export function farmRecordLink(proposal: FarmProposalView, can: (permission: string) => boolean): string | null {
  if (proposal.status !== 'confirmed' || !proposal.result) return null;
  const { animal } = proposal.fields;
  const pages: Record<FarmRecordKind, [string, string | null]> = {
    weight: ['livestock.view', animal ? `/livestock/animals/${animal.id}` : null],
    death: ['livestock.view', '/livestock/exits'],
    treatment: ['health.view', '/livestock/health'],
    herd_log: ['livestock.view', '/livestock/daily-logs'],
  };
  const [permission, path] = pages[proposal.kind] ?? [null, null];
  return permission && path && can(permission) ? path : null;
}

/** The herd row: the card's own herd, or the herd the animal stands in. Null means the row is left out. */
export function herdOnCard(fields: FarmFields): { name: string | null; defaulted: boolean } | null {
  if (fields.herd) return { name: fields.herd.name, defaulted: fields.herd.defaulted };
  if (fields.animal) return { name: fields.animal.herd?.name ?? null, defaulted: false };
  return null;
}

export type FarmRefusal =
  | { code: 'PROPOSAL_CHANGED'; proposal: FarmProposalView }
  | { code: 'PROPOSAL_STALE' | 'FARM_RECORD_EXISTS' | 'PROPOSAL_NEEDS_ANSWER' };

/** A refusal the card explains itself. Anything else is shown as the server worded it. */
export function readFarmRefusal(error: unknown): FarmRefusal | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const details = (error.details ?? {}) as { proposal?: FarmProposalView };
  switch (error.code) {
    case 'PROPOSAL_CHANGED':
      return details.proposal ? { code: error.code, proposal: details.proposal } : null;
    case 'PROPOSAL_STALE':
    case 'FARM_RECORD_EXISTS':
    case 'PROPOSAL_NEEDS_ANSWER':
      return { code: error.code };
    default:
      return null;
  }
}

/** What the card says after a refusal. It holds only for the version of the card it was about. */
export interface FarmNotice {
  code: FarmRefusal['code'];
  stamp: string;
}

export function afterFarmRefusal(refusal: FarmRefusal, read: FarmProposalView): FarmNotice {
  return { code: refusal.code, stamp: refusal.code === 'PROPOSAL_CHANGED' ? refusal.proposal.stamp : read.stamp };
}

/** Stale and already-recorded cards can only be cancelled: saying it again makes a fresh card. */
export const onlyCancelLeft = (notice: FarmNotice | null) => notice?.code === 'PROPOSAL_STALE' || notice?.code === 'FARM_RECORD_EXISTS';
