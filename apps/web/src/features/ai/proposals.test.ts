import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import {
  acknowledgeBodyKey,
  acknowledgeYesKey,
  afterRefusal,
  answerAsChange,
  answerableOnCard,
  awaitsApproval,
  canActOn,
  canSendForm,
  categoryLabel,
  changedFields,
  changedRows,
  changesNotApplied,
  clockText,
  expectsAnswer,
  listedWarnings,
  questionKeys,
  questionOf,
  readRefusal,
  recordLink,
  refusedInBooks,
  undoSecondsLeft,
  withoutRepeatedCards,
} from './proposals';
import type { Attachment, ChatMessage, ProposalFields, ProposalView, Question } from './types';

const fields = (over: Partial<ProposalFields> = {}): ProposalFields => ({
  amount: 3_000_000,
  currency: 'UZS',
  fxRate: 1,
  amountBase: 3_000_000,
  date: '2026-11-04',
  category: { id: 'cat-fuel', name: "Yoqilg'i" },
  target: null,
  account: { id: 'acc-cash', name: 'Kassa' },
  toAccount: null,
  paymentMethod: 'cash',
  counterparty: null,
  item: null,
  warehouse: null,
  qty: null,
  unitPrice: null,
  costTreatment: 'expense',
  direction: null,
  description: null,
  ...over,
});

const proposal = (over: Partial<ProposalView> = {}) =>
  ({
    id: 'p1',
    kind: 'expense',
    status: 'pending',
    stamp: 's1',
    masked: false,
    fields: fields(),
    warnings: [],
    learning: [],
    needsAcknowledgement: false,
    needsAnswer: false,
    willNeedApproval: false,
    result: null,
    ...over,
  }) as ProposalView;

const allow = (...granted: string[]) => (permission: string) => granted.includes(permission);
const MONEY = ['finance.view', 'finance.create'];
const UUID = '0192f6a0-0000-7000-8000-000000000001';

describe('recordLink', () => {
  const tx = { type: 'transaction', id: 't1', status: 'approved' } as const;
  const receipt = { type: 'stock_receipt', id: 't2', status: 'approved' } as const;

  it('opens the journal on the day of the record, for both result types', () => {
    const journal = '/finance/transactions?from=2026-11-04&to=2026-11-04';
    expect(recordLink(tx, '2026-11-04', allow('finance.view'))).toBe(journal);
    expect(recordLink(receipt, '2026-11-04', allow('finance.view'))).toBe(journal);
  });

  it('sends someone without finance to the movements for a stock receipt', () => {
    expect(recordLink(receipt, '2026-11-04', allow('inventory.view'))).toBe('/inventory/movements');
  });

  it('offers no link to a page the person cannot open', () => {
    expect(recordLink(tx, '2026-11-04', allow('inventory.view'))).toBeNull();
    expect(recordLink(receipt, '2026-11-04', allow())).toBeNull();
    expect(recordLink(null, '2026-11-04', allow('finance.view'))).toBeNull();
  });
});

describe('undoSecondsLeft', () => {
  const at = Date.parse('2026-11-04T10:00:00Z');

  it('counts down to the end of the window', () => {
    expect(undoSecondsLeft('2026-11-04T10:15:00Z', at)).toBe(900);
  });

  it('is closed after the end, with no window, or for a bad date', () => {
    expect(undoSecondsLeft('2026-11-04T09:59:59Z', at)).toBe(0);
    expect(undoSecondsLeft(null, at)).toBe(0);
    expect(undoSecondsLeft('not a date', at)).toBe(0);
  });
});

describe('clockText', () => {
  it('pads the seconds', () => {
    expect(clockText(754)).toBe('12:34');
    expect(clockText(65)).toBe('1:05');
    expect(clockText(9)).toBe('0:09');
  });
});

describe('result status follows the books', () => {
  const result = (status: string) => ({ type: 'transaction' as const, id: 't', status });

  it('waits only while the record waits for a second person', () => {
    expect(awaitsApproval(proposal({ status: 'confirmed', result: result('pending') }))).toBe(true);
    expect(awaitsApproval(proposal({ status: 'confirmed', result: result('approved') }))).toBe(false);
    expect(awaitsApproval(proposal({ status: 'pending' }))).toBe(false);
  });

  it('reads a record someone refused or voided as refused, not as recorded', () => {
    expect(refusedInBooks(proposal({ status: 'confirmed', result: result('rejected') }))).toBe(true);
    expect(refusedInBooks(proposal({ status: 'confirmed', result: result('approved') }))).toBe(false);
    expect(refusedInBooks(proposal({ status: 'undone', result: result('rejected') }))).toBe(false);
  });
});

describe('canActOn', () => {
  it('needs the rights of manual entry and seeing the money, as the server does', () => {
    expect(canActOn(proposal(), allow(...MONEY))).toBe(true);
    expect(canActOn(proposal(), allow('finance.create'))).toBe(false);
    expect(canActOn(proposal(), allow('finance.view'))).toBe(false);
    expect(canActOn(proposal(), allow())).toBe(false);
  });

  it('needs inventory.create as well for a stock purchase', () => {
    expect(canActOn(proposal({ kind: 'stock_purchase' }), allow(...MONEY))).toBe(false);
    expect(canActOn(proposal({ kind: 'stock_purchase' }), allow(...MONEY, 'inventory.create'))).toBe(true);
  });

  it('never allows acting on a masked card, whatever the session says', () => {
    expect(canActOn(proposal({ masked: true }), allow(...MONEY, 'inventory.create'))).toBe(false);
  });
});

describe('categoryLabel', () => {
  const localName = (name: { uz: string; ru: string; en: string }) => name.en;

  it('speaks the reader language when the card carries translations', () => {
    expect(categoryLabel({ id: 'c', name: "Yoqilg'i", translations: { uz: "Yoqilg'i", ru: 'Топливо', en: 'Fuel' } }, localName)).toBe('Fuel');
  });

  it('falls back to the stored name on an older card', () => {
    expect(categoryLabel({ id: 'c', name: "Yoqilg'i" }, localName)).toBe("Yoqilg'i");
  });
});

describe('listedWarnings', () => {
  const codes = (...list: string[]) => proposal({ warnings: list.map((code) => ({ code, params: {} })) });

  it('leaves out what the card shows in its own place', () => {
    const shown = listedWarnings(codes('TARGET_DEFAULTED', 'NEEDS_APPROVAL', 'OVER_BALANCE', 'OLD_DATE'));
    expect(shown.map((w) => w.code)).toEqual(['OVER_BALANCE', 'OLD_DATE']);
  });

  it('puts the three that need a yes last, right above the buttons that answer them', () => {
    const shown = listedWarnings(codes('POSSIBLE_DUPLICATE', 'OVER_BALANCE', 'AMOUNT_FROM_DOCUMENT', 'STALE_RATE', 'OTHER_AMOUNT'));
    expect(shown.map((w) => w.code)).toEqual(['OVER_BALANCE', 'STALE_RATE', 'POSSIBLE_DUPLICATE', 'AMOUNT_FROM_DOCUMENT', 'OTHER_AMOUNT']);
  });
});

describe('the explicit yes', () => {
  it('words a duplicate by where the twin is: in the books, or on another open card', () => {
    expect(acknowledgeBodyKey({ code: 'POSSIBLE_DUPLICATE', params: { transactionId: 't' } })).toBe('records.acknowledge.POSSIBLE_DUPLICATE.booked');
    expect(acknowledgeBodyKey({ code: 'POSSIBLE_DUPLICATE', params: { batchId: 'b' } })).toBe('records.acknowledge.POSSIBLE_DUPLICATE.booked');
    expect(acknowledgeBodyKey({ code: 'POSSIBLE_DUPLICATE', params: { proposalId: 'p' } })).toBe('records.acknowledge.POSSIBLE_DUPLICATE.open');
    expect(acknowledgeBodyKey({ code: 'OTHER_AMOUNT', params: {} })).toBe('records.acknowledge.OTHER_AMOUNT.body');
  });

  it('names what is agreed to when it is one thing, and says all of it when it is several', () => {
    const one = proposal({ warnings: [{ code: 'OTHER_AMOUNT', params: {} }, { code: 'OVER_BALANCE', params: {} }] });
    expect(acknowledgeYesKey(one)).toBe('records.acknowledge.OTHER_AMOUNT.yes');
    const two = proposal({ warnings: [{ code: 'OTHER_AMOUNT', params: {} }, { code: 'AMOUNT_FROM_DOCUMENT', params: {} }] });
    expect(acknowledgeYesKey(two)).toBe('records.acknowledge.several');
  });

  it('still has a yes to offer when the server waits on a warning this screen has no words for', () => {
    expect(acknowledgeYesKey(proposal({ warnings: [{ code: 'A_NEW_WARNING', params: {} }], needsAcknowledgement: true }))).toBe('records.acknowledge.several');
  });
});

describe('readRefusal', () => {
  const fresh = proposal({ stamp: 's2' });
  const refused = (code: string, details?: unknown, status = 409) => readRefusal(new ApiError(status, code, 'x', details));

  it('carries the fresh card for a changed card and for a missing yes', () => {
    expect(refused('PROPOSAL_CHANGED', { proposal: fresh })).toEqual({ code: 'PROPOSAL_CHANGED', proposal: fresh });
    expect(refused('NOT_ACKNOWLEDGED', { proposal: fresh })).toEqual({ code: 'NOT_ACKNOWLEDGED', proposal: fresh });
  });

  it('reads a waiting answer and a stale card, with its questions', () => {
    const question: Question = { field: 'account', code: 'ACCOUNT_REQUIRED', options: [] };
    expect(refused('PROPOSAL_NEEDS_ANSWER')).toEqual({ code: 'PROPOSAL_NEEDS_ANSWER' });
    expect(refused('PROPOSAL_STALE', { questions: [question] })).toEqual({ code: 'PROPOSAL_STALE', questions: [question] });
    expect(refused('PROPOSAL_STALE')).toEqual({ code: 'PROPOSAL_STALE', questions: [] });
  });

  it('leaves everything else to the plain error message', () => {
    expect(refused('PROPOSAL_CHANGED')).toBeNull();
    expect(refused('PROPOSAL_EXPIRED')).toBeNull();
    expect(refused('PROPOSAL_CHANGED', { proposal: fresh }, 400)).toBeNull();
    expect(readRefusal(new Error('network'))).toBeNull();
  });
});

describe('afterRefusal', () => {
  const read = proposal({ stamp: 's1' });

  it('turns a missing yes into the yes step on the fresh card, with no notice', () => {
    const fresh = proposal({ stamp: 's1', needsAcknowledgement: true });
    expect(afterRefusal({ code: 'NOT_ACKNOWLEDGED', proposal: fresh }, read)).toEqual({ notice: null, askYesFor: 's1' });
  });

  it('says which rows changed, on the fresh card only', () => {
    const fresh = proposal({ stamp: 's2', fields: fields({ amount: 3_500_000, amountBase: 3_500_000, account: { id: 'acc-bank', name: 'Bank' }, paymentMethod: 'bank' }) });
    expect(afterRefusal({ code: 'PROPOSAL_CHANGED', proposal: fresh }, read)).toEqual({
      notice: { code: 'PROPOSAL_CHANGED', stamp: 's2', rows: ['amount', 'account'] },
      askYesFor: null,
    });
  });

  it('keeps a waiting answer and a stale card on the version that was read', () => {
    expect(afterRefusal({ code: 'PROPOSAL_NEEDS_ANSWER' }, read).notice).toEqual({ code: 'PROPOSAL_NEEDS_ANSWER', stamp: 's1' });
    expect(afterRefusal({ code: 'PROPOSAL_STALE', questions: [] }, read).notice).toEqual({ code: 'PROPOSAL_STALE', stamp: 's1', questions: [] });
  });
});

describe('changedRows', () => {
  it('names each row the person would read differently', () => {
    const before = fields();
    expect(changedRows(before, fields({ fxRate: 12_700, currency: 'USD' }))).toEqual(['amount']);
    expect(changedRows(before, fields({ date: '2026-11-03' }))).toEqual(['date']);
    expect(changedRows(before, fields({ direction: 'payable', counterparty: { id: 'cp', name: 'Akmal' } }))).toEqual(['direction', 'counterparty']);
  });

  it('ignores a renamed reference: the same record is still the same', () => {
    expect(changedRows(fields(), fields({ account: { id: 'acc-cash', name: 'Main cash' } }))).toEqual([]);
  });
});

describe('questions', () => {
  it('finds the question among other attachments', () => {
    const question = { field: 'account', code: 'ACCOUNT_REQUIRED', options: [{ id: 'a', label: 'Kassa' }] };
    const attachments: Attachment[] = [{ type: 'table', title: 'T', columns: [], rows: [], total: 0 }, { type: 'question', question }];
    expect(questionOf(attachments)).toEqual(question);
    expect(questionOf(undefined)).toBeNull();
    expect(questionOf([])).toBeNull();
  });

  it('looks up the card wording first, then the shared one, then the field, then a generic line', () => {
    expect(questionKeys({ field: 'amount', code: 'AMOUNT_CONFLICT', options: [] })).toEqual([
      'records.questions.code.AMOUNT_CONFLICT',
      'assistant.ask.AMOUNT_CONFLICT',
      'records.questions.field.amount',
      'records.question.generic',
    ]);
  });

  it('expects no answer once the matter belongs to another section', () => {
    expect(expectsAnswer({ field: 'category', code: 'USE_OTHER_MODULE', options: [] })).toBe(false);
    expect(expectsAnswer({ field: 'amount', code: 'AMOUNT_REQUIRED', options: [] })).toBe(true);
  });
});

describe('withoutRepeatedCards', () => {
  const card = (id: string): Attachment => ({ type: 'proposal', proposal: { id } as ProposalView });
  const message = (id: string, attachments?: Attachment[]) => ({ id, role: 'assistant', createdAt: '', text: '', attachments }) as ChatMessage;

  it('keeps a proposal only in the latest message that has it', () => {
    const [first, second] = withoutRepeatedCards([message('m1', [card('p1'), card('p2')]), message('m2', [card('p1')])]);
    expect(first.attachments).toEqual([card('p2')]);
    expect(second.attachments).toEqual([card('p1')]);
  });

  it('leaves everything else alone', () => {
    const table: Attachment = { type: 'table', title: 'T', columns: [], rows: [], total: 0 };
    const messages = [message('m1', [table, card('p1')]), message('m2')];
    expect(withoutRepeatedCards(messages)).toEqual(messages);
  });
});

describe('changesNotApplied', () => {
  const kept = fields({ amount: 100, qty: 3_000_000, target: { costCenterId: 'general', type: 'general', name: 'General', defaulted: false } });

  it('names a value the server did not keep', () => {
    expect(changesNotApplied({ qty: 3000 }, kept)).toEqual(['qty']);
    expect(changesNotApplied({ costCenterId: 'field-1' }, kept)).toEqual(['target']);
    expect(changesNotApplied({ amount: 250 }, kept)).toEqual(['amount']);
  });

  it('stays silent when everything was kept or was not changed', () => {
    expect(changesNotApplied({ amount: 100, qty: 3_000_000, costCenterId: 'general' }, kept)).toEqual([]);
    expect(changesNotApplied({ description: 'x' }, kept)).toEqual([]);
  });
});

describe('answerAsChange', () => {
  const question = (field: string, ...ids: string[]): Question => ({ field, code: 'X', options: ids.map((id) => ({ id, label: id })) });

  it('turns an answer into the field the card can change', () => {
    expect(answerAsChange(question('target'), UUID)).toEqual({ costCenterId: UUID });
    expect(answerAsChange(question('toAccount'), UUID)).toEqual({ toAccountId: UUID });
    expect(answerAsChange(question('paymentMethod'), 'bank')).toEqual({ paymentMethod: 'bank' });
    expect(answerAsChange(question('amount'), '500000')).toEqual({ amount: 500000 });
    expect(answerAsChange(question('date'), '2026-11-03')).toEqual({ date: '2026-11-03' });
  });

  it('refuses what the card cannot change, so it goes to the chat', () => {
    expect(answerAsChange(question('direct'), 'stock')).toBeNull();
    expect(answerAsChange(question('direction'), 'payable')).toBeNull();
    expect(answerAsChange(question('amount'), 'lots')).toBeNull();
    expect(answerAsChange(question('amount'), '0')).toBeNull();
    expect(answerAsChange(question('date'), 'kecha')).toBeNull();
    // Words offered under a reference field are not a record the form can point at.
    expect(answerAsChange(question('category'), 'wage')).toBeNull();
  });

  it('offers options on the card only when every one of them can be applied there', () => {
    expect(answerableOnCard(question('account', UUID))).toBe(true);
    expect(answerableOnCard(question('category', UUID, 'wage'))).toBe(false);
    expect(answerableOnCard(question('account'))).toBe(false);
  });
});

describe('canSendForm', () => {
  it('sends nothing for an untouched form, except to ask a stale card to look again', () => {
    expect(canSendForm({}, false)).toBe(false);
    expect(canSendForm({ amount: 5 }, false)).toBe(true);
    expect(canSendForm({}, true)).toBe(true);
  });
});

describe('changedFields', () => {
  it('keeps only what differs, including a cleared value', () => {
    const before: Record<string, unknown> = { amount: 100, accountId: 'a', note: null };
    expect(changedFields(before, { amount: 200, accountId: null, note: null })).toEqual({ amount: 200, accountId: null });
  });

  it('treats a missing value and null as the same', () => {
    expect(changedFields({ note: undefined } as Record<string, unknown>, { note: null })).toEqual({});
  });
});
