import type { RecordKind } from './routing';

/** Refs carry the name too, so a card can be shown without further lookups. */
export interface Ref {
  id: string;
  name: string;
  /** A category has a name in each language, so a card can speak the reader's. */
  translations?: { uz: string; ru: string; en: string };
}

export interface ProposalFields {
  amount: number | null;
  currency: string;
  fxRate: number | null;
  amountBase: number | null;
  date: string;
  category: Ref | null;
  target: { costCenterId: string; type: string; name: string; defaulted: boolean } | null;
  account: Ref | null;
  /** Where a transfer goes. */
  toAccount: Ref | null;
  paymentMethod: 'cash' | 'bank' | 'card' | 'debt' | null;
  counterparty: Ref | null;
  item: (Ref & { unit: string }) | null;
  warehouse: Ref | null;
  qty: number | null;
  unitPrice: number | null;
  costTreatment: string | null;
  /** A debt payment: payable means we pay them, receivable means they pay us. */
  direction: 'payable' | 'receivable' | null;
  description: string | null;
}

export interface Warning {
  code: string;
  params: Record<string, unknown>;
}

export interface Question {
  field: string;
  code: string;
  options: { id: string; label: string }[];
  /** For the model only: what to ask. It asks in the person's language. */
  hint: string;
}

export interface Learned {
  phrase: string;
  targetType: string;
  targetId: string;
  /** What it will mean, shown on the card before anything is remembered. */
  name: string;
}

/** An amount read from a document in its own step, so the drafting model does not vouch for itself. */
export interface DocumentAmount {
  amount: number;
  currency: string | null;
}

/** What a draft is about, so the next turn can tell an answer from a new record. */
export interface OpenRecord {
  kind: RecordKind;
  /** The category, item or counterparty, once a name has settled it. */
  subject: string | null;
}

export interface DraftRecord extends OpenRecord {
  /** It had nothing to do with what was being asked, so it stood on its own message alone. */
  fresh: boolean;
}

/** The evidence a draft may lean on. */
export interface Evidence {
  /** The person's words, newest last. */
  userTexts: string[];
  /** The day each of those was said, where it is known. */
  saidDays?: (string | undefined)[];
  documentAmounts: DocumentAmount[];
  /** Someone else's words passed on. They back nothing, but they can stop a record. */
  forwarded?: string[];
  /** The amount on each card made from these words: money said once backs one card. */
  onCards?: number[];
}

/** What the words of this exchange allow a draft to claim. */
export interface DraftEnv extends Evidence {
  /** The day they said it, when that is not today: a message held up by an outage. */
  saidOn?: string;
  channel: 'web' | 'telegram';
  conversationId: string | null;
  /** Readiness codes left open by the previous turn, so an answer can be recognised as one. */
  answering?: string[];
  /** What those questions were about. */
  open?: OpenRecord[];
  /** This message alone, for a draft that turns out to be a new record. */
  own?: Evidence;
  /** Typed into the card's form, or being re-checked at confirm: the person's own statement. */
  fromForm?: boolean;
}

export interface Validated {
  fields: ProposalFields | null;
  /** What was decided, in exact form, so a later step starts from this and not from the words. */
  input: Record<string, unknown>;
  questions: Question[];
  warnings: Warning[];
  learn: Learned[];
  record: DraftRecord;
}

export interface ProposalView {
  id: string;
  kind: RecordKind;
  status: 'pending' | 'confirmed' | 'rejected' | 'expired' | 'failed' | 'undone';
  channel: 'web' | 'telegram';
  createdAt: string;
  expiresAt: string;
  undoUntil: string | null;
  sourceText: string;
  /** Identifies what this card shows. A confirm must carry it, so it books what the person read. */
  stamp: string;
  /** Null amounts: this person may no longer see money, and cannot act on it. */
  masked: boolean;
  fields: ProposalFields;
  warnings: Warning[];
  /** Words this will remember if confirmed. */
  learning: { phrase: string; name: string }[];
  /** A warning here needs an explicit yes, not just Confirm. */
  needsAcknowledgement: boolean;
  /** A correction is waiting for an answer, so this card cannot be confirmed as it stands. */
  needsAnswer: boolean;
  willNeedApproval: boolean;
  result: { type: string; id: string; status: string } | null;
}
