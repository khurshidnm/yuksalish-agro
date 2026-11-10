import { describe, expect, it } from 'vitest';
import { resources } from '@yap/shared/i18n';
import { ApiError } from '@/lib/api';
import { afterFarmRefusal, farmRecordLink, herdOnCard, onlyCancelLeft, readFarmRefusal } from './farm-proposals';
import { withoutRepeatedCards } from './proposals';
import type { ChatMessage, FarmFields, FarmProposalView } from './types';

const fields = (over: Partial<FarmFields> = {}): FarmFields => ({
  date: '2026-11-10',
  animal: { id: 'a-1', tag: '1234', sex: 'female', species: 'sheep', category: 'ewe', birthDate: '2025-09-01', ageMonths: 14, herd: { id: 'h-1', name: '1-otar' } },
  herd: null,
  weightKg: 46,
  cause: null,
  healthType: null,
  drug: null,
  dose: null,
  doseUnit: null,
  headCount: null,
  stockOut: [],
  ...over,
});

const card = (over: Partial<FarmProposalView> = {}): FarmProposalView => ({
  id: 'p-1',
  kind: 'weight',
  status: 'pending',
  channel: 'web',
  createdAt: '2026-11-10T05:00:00.000Z',
  expiresAt: '2026-11-11T05:00:00.000Z',
  undoUntil: null,
  sourceText: '1234-qo\'y 46 kilo chiqdi',
  stamp: 'aaaaaaaaaaaa',
  fields: fields(),
  warnings: [],
  needsAnswer: false,
  canConfirm: true,
  canUndo: false,
  result: null,
  ...over,
});

const everything = () => true;
const nothing = () => false;

describe('where a confirmed farm record can be read', () => {
  it('opens the animal for a weight, and nothing before it is in the books', () => {
    expect(farmRecordLink(card(), everything)).toBeNull();
    const confirmed = card({ status: 'confirmed', result: { type: 'weight_record', id: 'w-1' } });
    expect(farmRecordLink(confirmed, everything)).toBe('/livestock/animals/a-1');
    expect(farmRecordLink(confirmed, nothing)).toBeNull();
  });

  it('asks for the right of the page it points to', () => {
    const treated = card({ kind: 'treatment', status: 'confirmed', result: { type: 'health_record', id: 'r-1' } });
    expect(farmRecordLink(treated, (permission) => permission === 'health.view')).toBe('/livestock/health');
    expect(farmRecordLink(treated, (permission) => permission === 'livestock.view')).toBeNull();
    const fed = card({ kind: 'herd_log', status: 'confirmed', result: { type: 'daily_log', id: 'd-1' } });
    expect(farmRecordLink(fed, (permission) => permission === 'livestock.view')).toBe('/livestock/daily-logs');
    const died = card({ kind: 'death', status: 'confirmed', result: { type: 'animal_exit', id: 'e-1' } });
    expect(farmRecordLink(died, everything)).toBe('/livestock/exits');
  });
});

describe('the herd row', () => {
  it('is the card\'s own herd, and says when it was not named', () => {
    expect(herdOnCard(fields({ animal: null, herd: { id: 'h-1', name: '1-otar', defaulted: true } }))).toEqual({ name: '1-otar', defaulted: true });
  });

  it('is otherwise the herd the animal stands in, or none', () => {
    expect(herdOnCard(fields())).toEqual({ name: '1-otar', defaulted: false });
    expect(herdOnCard(fields({ animal: { ...fields().animal!, herd: null } }))).toEqual({ name: null, defaulted: false });
    expect(herdOnCard(fields({ animal: null }))).toBeNull();
  });
});

describe('a refused confirm', () => {
  const refusal = (code: string, details?: unknown, status = 409) => readFarmRefusal(new ApiError(status, code, code, details));

  it('takes the fresh card from a change, and holds the notice for that card only', () => {
    const fresh = card({ stamp: 'bbbbbbbbbbbb', fields: fields({ weightKg: 48 }) });
    const changed = refusal('PROPOSAL_CHANGED', { proposal: fresh });
    expect(changed).toEqual({ code: 'PROPOSAL_CHANGED', proposal: fresh });
    expect(afterFarmRefusal(changed!, card())).toEqual({ code: 'PROPOSAL_CHANGED', stamp: 'bbbbbbbbbbbb' });
    expect(refusal('PROPOSAL_CHANGED')).toBeNull();
  });

  it('leaves only Cancel on a card that is stale or already in the books', () => {
    for (const code of ['PROPOSAL_STALE', 'FARM_RECORD_EXISTS'] as const) {
      const notice = afterFarmRefusal(refusal(code)!, card());
      expect(notice).toEqual({ code, stamp: 'aaaaaaaaaaaa' });
      expect(onlyCancelLeft(notice)).toBe(true);
    }
    expect(onlyCancelLeft(afterFarmRefusal(refusal('PROPOSAL_NEEDS_ANSWER')!, card()))).toBe(false);
    expect(onlyCancelLeft(null)).toBe(false);
  });

  it('leaves a permission refusal and every other error to the server\'s own words', () => {
    expect(refusal('FORBIDDEN', undefined, 403)).toBeNull();
    expect(refusal('PROPOSAL_NOT_PENDING')).toBeNull();
    expect(readFarmRefusal(new Error('x'))).toBeNull();
  });
});

describe('a corrected farm card in the chat', () => {
  it('shows once, in the latest message that has it', () => {
    const message = (id: string, proposal: FarmProposalView): ChatMessage => ({
      id,
      role: 'assistant',
      createdAt: '2026-11-10T05:00:00.000Z',
      text: '',
      attachments: [{ type: 'farm_proposal', proposal }],
    });
    const shown = withoutRepeatedCards([message('m-1', card()), message('m-2', card({ fields: fields({ weightKg: 48 }) }))]);
    expect(shown[0].attachments).toEqual([]);
    expect(shown[1].attachments).toHaveLength(1);
  });
});

describe('the words of a farm card', () => {
  const KEYS = [
    'kind.weight', 'kind.death', 'kind.treatment', 'kind.herd_log',
    'fields.animal', 'fields.herd', 'fields.weight', 'fields.date', 'fields.cause', 'fields.care', 'fields.drug', 'fields.dose',
    'fields.stockOut', 'fields.headCount', 'fields.said',
    'ageMonths', 'ageUnknown', 'noHerd', 'herdDefaulted', 'warehouseByRule', 'noPermission', 'deathNote', 'expires',
    'confirmedBody', 'undoneBody', 'noUndo', 'staleBody', 'existsTitle', 'existsBody', 'needsAnswer', 'pendingTitle',
  ];

  it.each(['uz', 'ru', 'en'] as const)('%s: every label the card uses is there', (language) => {
    const block = (resources[language].ai as unknown as { farmRecords: Record<string, unknown> }).farmRecords;
    for (const key of KEYS) {
      const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], block);
      expect(typeof value, key).toBe('string');
    }
  });
});
