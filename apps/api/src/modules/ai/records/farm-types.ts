/**
 * Farm records the assistant prepares: a weight, a death, a treatment, a day's feeding (docs/assistant.md).
 * A shape of its own, because a money card's fields cannot carry a tag or a dose. It holds no money
 * at all, so a card reads the same for a shepherd and for the owner (rule 7).
 */
import type { CareWord } from '@yap/shared/formulas/record-words';
import type { FarmRecordKind } from './routing';
import type { Question, Warning } from './types';

/** The animal as the card names it. The age is counted to the record's day, so it does not drift. */
export interface FarmAnimal {
  id: string;
  tag: string;
  sex: string | null;
  species: string | null;
  category: string | null;
  birthDate: string | null;
  ageMonths: number | null;
  herd: { id: string; name: string } | null;
}

/** What leaves the warehouse when the card is confirmed. Null when the owning service picks the warehouse. */
export interface FarmStockLine {
  itemId: string;
  name: string;
  unit: string;
  qty: number;
  warehouse: { id: string; name: string } | null;
}

export interface FarmFields {
  date: string;
  animal: FarmAnimal | null;
  /** `defaulted` when the farm has one herd and the person named none: the card says so. */
  herd: { id: string; name: string; defaulted: boolean } | null;
  weightKg: number | null;
  /** The person's own words, never the model's summary. */
  cause: string | null;
  healthType: CareWord | null;
  /** A stock item, or a name in the person's words that no stock item answers to. */
  drug: { itemId: string | null; name: string } | null;
  dose: number | null;
  doseUnit: string | null;
  headCount: number | null;
  stockOut: FarmStockLine[];
}

/** A quantity the card rests on and the message it was said in, so that it backs this card only. */
export interface UsedQuantity {
  qty: number;
  unit: string;
  said: string;
  /** Where in that message it stands: "46 kilo" said twice is two quantities. */
  start: number;
}

export interface FarmInput {
  tag?: string;
  herd?: string;
  date?: string;
  weightKg?: number;
  cause?: string;
  drug?: string;
  feed?: string;
  warehouse?: string;
  qty?: number;
  unit?: string;
  headCount?: number;
  /** A herd's day: each feed with its own amount. */
  feeds?: { feed?: string; qty?: number; unit?: string }[];
}

export interface FarmValidated {
  fields: FarmFields;
  questions: Question[];
  warnings: Warning[];
  /** The kind and what it is about: a second draft of the same thing corrects the first card. */
  key: string | null;
  used: UsedQuantity[];
}

export interface FarmProposalView {
  id: string;
  kind: FarmRecordKind;
  status: 'pending' | 'confirmed' | 'rejected' | 'expired' | 'failed' | 'undone';
  channel: string;
  createdAt: string;
  expiresAt: string;
  undoUntil: string | null;
  sourceText: string | null;
  /** What Confirm must send back: the card the person read. */
  stamp: string;
  fields: FarmFields;
  warnings: Warning[];
  /** A correction is waiting for an answer, so this card cannot be confirmed as it stands. */
  needsAnswer: boolean;
  /** Whether this person holds the right the owning module asks for. Confirm checks it again. */
  canConfirm: boolean;
  /** Whether this person may take it back while the window is open. */
  canUndo: boolean;
  result: { type: string; id: string } | null;
}
