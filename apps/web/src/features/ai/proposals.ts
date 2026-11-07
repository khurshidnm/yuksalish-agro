import type { I18nName } from '@/features/finance/types';
import { ApiError } from '@/lib/api';
import type { Attachment, CategoryRef, ChatMessage, ProposalFields, ProposalResult, ProposalView, ProposalWarning, Question } from './types';

/**
 * Where a written record can be seen. Both result types carry a transaction id, and a stock receipt
 * also shows in the movements, for someone who holds stock rights but not finance. Null when the
 * person may not open either page.
 */
export function recordLink(result: ProposalResult | null, date: string, can: (permission: string) => boolean): string | null {
  if (!result) return null;
  if (can('finance.view')) return `/finance/transactions?${new URLSearchParams({ from: date, to: date })}`;
  if (result.type === 'stock_receipt' && can('inventory.view')) return '/inventory/movements';
  return null;
}

/** Seconds left to undo, or 0 once the window has closed. */
export function undoSecondsLeft(undoUntil: string | null, now: number): number {
  if (!undoUntil) return 0;
  const end = new Date(undoUntil).getTime();
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.ceil((end - now) / 1000));
}

/** 754 → "12:34". */
export function clockText(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The confirmed record is waiting for a second person, so it is not in the books yet. */
export function awaitsApproval(proposal: ProposalView): boolean {
  return proposal.status === 'confirmed' && proposal.result?.status === 'pending';
}

/** The record was written, then a second person refused it or finance voided it: it does not count. */
export function refusedInBooks(proposal: ProposalView): boolean {
  return proposal.status === 'confirmed' && proposal.result?.status === 'rejected';
}

/** The same rule as the server: the rights of manual entry, and seeing the money. It still decides. */
export function canActOn(proposal: ProposalView, can: (permission: string) => boolean): boolean {
  if (proposal.masked || !can('finance.view') || !can('finance.create')) return false;
  return proposal.kind !== 'stock_purchase' || can('inventory.create');
}

/** A category in the reader's language, from `useLocalName`. */
export function categoryLabel(category: CategoryRef, localName: (name: I18nName) => string): string {
  return category.translations ? localName(category.translations) : category.name;
}

/** These have their own place on the card: the target row and the approval note. */
const SHOWN_ELSEWHERE = new Set(['TARGET_DEFAULTED', 'NEEDS_APPROVAL']);

/** Each of these needs an explicit yes. The server says when, through needsAcknowledgement. */
const NEEDS_YES = new Set(['POSSIBLE_DUPLICATE', 'OTHER_AMOUNT', 'AMOUNT_FROM_DOCUMENT', 'CURRENCY_CONVERTED']);

export const needsYes = (warning: ProposalWarning) => NEEDS_YES.has(warning.code);

/** What to show as warnings. Those that need a yes come last, right above the buttons that answer them. */
export function listedWarnings(proposal: ProposalView): ProposalView['warnings'] {
  const listed = proposal.warnings.filter((warning) => !SHOWN_ELSEWHERE.has(warning.code));
  return [...listed.filter((warning) => !needsYes(warning)), ...listed.filter(needsYes)];
}

/** The key of a warning's body. A duplicate reads differently when it is still only an open card. */
export function acknowledgeBodyKey(warning: ProposalWarning): string {
  if (warning.code !== 'POSSIBLE_DUPLICATE') return `records.acknowledge.${warning.code}.body`;
  return `records.acknowledge.POSSIBLE_DUPLICATE.${warning.params.proposalId ? 'open' : 'booked'}`;
}

/** The yes button names what is being agreed to, when that is one thing. */
export function acknowledgeYesKey(proposal: ProposalView): string {
  const codes = new Set(proposal.warnings.filter(needsYes).map((warning) => warning.code));
  return codes.size === 1 ? `records.acknowledge.${[...codes][0]}.yes` : 'records.acknowledge.several';
}

/** Why a confirm was turned down, for the cases where the card itself has to change. */
export type Refusal =
  | { code: 'PROPOSAL_CHANGED'; proposal: ProposalView }
  | { code: 'NOT_ACKNOWLEDGED'; proposal: ProposalView }
  | { code: 'PROPOSAL_NEEDS_ANSWER' }
  | { code: 'PROPOSAL_STALE'; questions: Question[] };

export function readRefusal(error: unknown): Refusal | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const details = (error.details ?? {}) as { proposal?: ProposalView; questions?: Question[] };
  switch (error.code) {
    case 'PROPOSAL_CHANGED':
    case 'NOT_ACKNOWLEDGED':
      return details.proposal ? { code: error.code, proposal: details.proposal } : null;
    case 'PROPOSAL_NEEDS_ANSWER':
      return { code: error.code };
    case 'PROPOSAL_STALE':
      return { code: error.code, questions: details.questions ?? [] };
    default:
      return null;
  }
}

/** What the card says after a refusal. It holds only for the version of the card it was about. */
export type Notice =
  | { code: 'PROPOSAL_CHANGED'; stamp: string; rows: string[] }
  | { code: 'PROPOSAL_NEEDS_ANSWER'; stamp: string }
  | { code: 'PROPOSAL_STALE'; stamp: string; questions: Question[] };

/**
 * `read` is the card the person pressed Confirm on. A missing yes is not a notice: the card goes
 * straight to asking for it, on the fresh card the server sent.
 */
export function afterRefusal(refusal: Refusal, read: ProposalView): { notice: Notice | null; askYesFor: string | null } {
  switch (refusal.code) {
    case 'NOT_ACKNOWLEDGED':
      return { notice: null, askYesFor: refusal.proposal.stamp };
    case 'PROPOSAL_CHANGED':
      return { notice: { code: refusal.code, stamp: refusal.proposal.stamp, rows: changedRows(read.fields, refusal.proposal.fields) }, askYesFor: null };
    case 'PROPOSAL_NEEDS_ANSWER':
      return { notice: { code: refusal.code, stamp: read.stamp }, askYesFor: null };
    case 'PROPOSAL_STALE':
      return { notice: { code: refusal.code, stamp: read.stamp, questions: refusal.questions }, askYesFor: null };
  }
}

const CARD_ROWS: [string, (fields: ProposalFields) => unknown][] = [
  ['amount', (f) => [f.amount, f.currency, f.fxRate]],
  ['date', (f) => f.date],
  ['category', (f) => f.category?.id],
  ['target', (f) => f.target?.costCenterId],
  ['item', (f) => f.item?.id],
  ['qty', (f) => f.qty],
  ['warehouse', (f) => f.warehouse?.id],
  ['account', (f) => [f.account?.id, f.paymentMethod]],
  ['toAccount', (f) => f.toAccount?.id],
  ['direction', (f) => f.direction],
  ['counterparty', (f) => f.counterparty?.id],
  ['description', (f) => f.description],
];

/** The rows that differ between the card a person read and the one that replaced it. */
export function changedRows(before: ProposalFields, after: ProposalFields): string[] {
  return CARD_ROWS.filter(([, read]) => JSON.stringify(read(before)) !== JSON.stringify(read(after))).map(([row]) => row);
}

/** The question a chat answer carries. A reply has at most one. */
export function questionOf(attachments: Attachment[] | undefined): Question | null {
  const found = attachments?.find((attachment) => attachment.type === 'question');
  return found?.type === 'question' ? found.question : null;
}

/** Most specific wording first. `assistant.ask` is the text every channel shares; the card's own comes first. */
export function questionKeys({ code, field }: Question): string[] {
  return [`records.questions.code.${code}`, `assistant.ask.${code}`, `records.questions.field.${field}`, 'records.question.generic'];
}

/** The keys a warning's text is looked up by, most specific first. */
export function warningKeys({ code }: ProposalWarning): string[] {
  return [`records.warnings.${code}`, `recordText.warnings.${code}`, 'records.warnings.generic'];
}

/** This one closes the matter: it says where the record belongs, so nothing is left to answer. */
export const expectsAnswer = (question: Question) => question.code !== 'USE_OTHER_MODULE';

/**
 * Correcting a draft in chat brings the same proposal back in a later message. Two identical cards
 * would look like two records, so each proposal shows once, in the latest message that has it.
 */
export function withoutRepeatedCards(messages: ChatMessage[]): ChatMessage[] {
  const latest = new Map<string, string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type === 'proposal') latest.set(attachment.proposal.id, message.id);
    }
  }
  return messages.map((message) => {
    const attachments = message.attachments?.filter(
      (attachment) => attachment.type !== 'proposal' || latest.get(attachment.proposal.id) === message.id,
    );
    return attachments?.length === message.attachments?.length ? message : { ...message, attachments };
  });
}

/** Fields whose value differs. A form sends only these, so an untouched field is never re-decided. */
export function changedFields<T extends Record<string, unknown>>(before: T, after: T): Partial<T> {
  const entries = Object.entries(after).filter(([key, value]) => (before[key] ?? null) !== (value ?? null));
  return Object.fromEntries(entries) as Partial<T>;
}

/**
 * Nothing typed means nothing to send, because a save re-decides warnings. A stale card is the
 * exception: an empty change is how it asks the server to look again.
 */
export function canSendForm(changes: Record<string, unknown>, recheck: boolean): boolean {
  return recheck || Object.keys(changes).length > 0;
}

/**
 * Changes the server came back with differently from how they were sent. It re-derives a draft from
 * everything said so far, so a value can be overridden; a person must not assume theirs was kept.
 */
export function changesNotApplied(changes: Record<string, unknown>, fields: ProposalFields): ('amount' | 'qty' | 'target')[] {
  const missed: ('amount' | 'qty' | 'target')[] = [];
  if (changes.amount !== undefined && changes.amount !== fields.amount) missed.push('amount');
  if (changes.qty !== undefined && changes.qty !== fields.qty) missed.push('qty');
  if (changes.costCenterId !== undefined && changes.costCenterId !== fields.target?.costCenterId) missed.push('target');
  return missed;
}

const PATCH_REFS: Record<string, string> = {
  category: 'categoryId',
  target: 'costCenterId',
  account: 'accountId',
  toAccount: 'toAccountId',
  counterparty: 'counterpartyId',
  item: 'itemId',
  warehouse: 'warehouseId',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The change that answers a question from the Change form, or null when an answer needs the chat.
 * `amount` options carry the number as their id. A ref field can also offer words, such as "wage"
 * under category, and those are not a record the form can point at.
 */
export function answerAsChange(question: Question, optionId: string): Record<string, unknown> | null {
  if (question.field === 'amount') {
    const amount = Number(optionId);
    return Number.isFinite(amount) && amount > 0 ? { amount } : null;
  }
  if (question.field === 'date') return ISO_DATE.test(optionId) ? { date: optionId } : null;
  if (question.field === 'paymentMethod') return { paymentMethod: optionId };
  const key = PATCH_REFS[question.field];
  return key && UUID.test(optionId) ? { [key]: optionId } : null;
}

/** The card offers its options only when every one of them can be applied from there. */
export function answerableOnCard(question: Question): boolean {
  return question.options.length > 0 && question.options.every((option) => answerAsChange(question, option.id) !== null);
}
