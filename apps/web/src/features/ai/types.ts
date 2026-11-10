import type { I18nName } from '@/features/finance/types';

export interface AiStatus {
  assistant: { configured: boolean; provider: string; model: string | null };
  statistics: { enabled: boolean };
}

export type ToolStatus = 'ok' | 'no_data' | 'denied' | 'invalid' | 'error';

export interface ToolCall {
  name: string;
  input: unknown;
  status: ToolStatus;
  rows: number | null;
  durationMs: number;
}

export interface AnswerSource {
  tool: string;
  tables: string[];
  from?: string;
  to?: string;
  rows?: number;
}

export type ProposalKind = 'expense' | 'stock_purchase' | 'income' | 'debt_payment' | 'transfer';
export type ProposalStatus = 'pending' | 'confirmed' | 'rejected' | 'expired' | 'failed' | 'undone';
export type PaymentMethod = 'cash' | 'bank' | 'card' | 'debt';

export interface Ref {
  id: string;
  name: string;
}

/** Stored proposals older than the translations carry only `name`. */
export interface CategoryRef extends Ref {
  translations?: I18nName;
}

/** Money and who it moved between are null when the card is masked. */
export interface ProposalFields {
  amount: number | null;
  currency: string;
  fxRate: number | null;
  amountBase: number | null;
  date: string;
  category: CategoryRef | null;
  target: { costCenterId: string; type: string; name: string; defaulted: boolean } | null;
  account: Ref | null;
  /** Where a transfer goes. */
  toAccount: Ref | null;
  paymentMethod: PaymentMethod | null;
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

export interface ProposalWarning {
  code: string;
  params: Record<string, unknown>;
}

export interface ProposalResult {
  type: 'transaction' | 'stock_receipt';
  /** A transaction id for both types. */
  id: string;
  status: string;
}

/** A record the assistant prepared. Nothing reaches the books until its owner confirms it. */
export interface ProposalView {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  channel: 'web' | 'telegram';
  createdAt: string;
  expiresAt: string;
  undoUntil: string | null;
  sourceText: string;
  /** Names what this card shows. Confirm sends it back, so it books the card the person read. */
  stamp: string;
  /** This person may no longer see the money, so the card shows none and cannot be acted on. */
  masked: boolean;
  fields: ProposalFields;
  warnings: ProposalWarning[];
  /** Words confirming this will teach the assistant. */
  learning: { phrase: string; name: string }[];
  /** A warning needs an explicit yes, not just Confirm. */
  needsAcknowledgement: boolean;
  /** A correction waits for an answer, so the card cannot be confirmed as it stands. */
  needsAnswer: boolean;
  willNeedApproval: boolean;
  result: ProposalResult | null;
}

export type FarmRecordKind = 'weight' | 'death' | 'treatment' | 'herd_log';

/** The animal as the card names it. The age is counted to the record's day. */
export interface FarmAnimal {
  id: string;
  tag: string;
  sex: string | null;
  species: string | null;
  category: string | null;
  birthDate: string | null;
  ageMonths: number | null;
  herd: Ref | null;
}

/** What leaves the warehouse on confirm. The warehouse is null when the owning service picks it. */
export interface FarmStockLine {
  itemId: string;
  name: string;
  unit: string;
  qty: number;
  warehouse: Ref | null;
}

/** A farm card holds no money, so it reads the same for everyone. */
export interface FarmFields {
  date: string;
  animal: FarmAnimal | null;
  herd: (Ref & { defaulted: boolean }) | null;
  weightKg: number | null;
  /** The person's own words. */
  cause: string | null;
  healthType: string | null;
  drug: { itemId: string | null; name: string } | null;
  dose: number | null;
  doseUnit: string | null;
  headCount: number | null;
  stockOut: FarmStockLine[];
}

/** A farm record the assistant prepared: a weight, a death, a treatment, a day's feeding. */
export interface FarmProposalView {
  id: string;
  kind: FarmRecordKind;
  status: ProposalStatus;
  channel: string;
  createdAt: string;
  expiresAt: string;
  undoUntil: string | null;
  sourceText: string | null;
  stamp: string;
  fields: FarmFields;
  warnings: ProposalWarning[];
  needsAnswer: boolean;
  /** Cards stored before this was sent lack it; the live card always has it. */
  canConfirm?: boolean;
  canUndo: boolean;
  result: { type: string; id: string } | null;
}

export interface QuestionOption {
  id: string;
  label: string;
}

/** The API also sends `hint`, written for the model. It is left out here so it cannot be shown. */
export interface Question {
  field: string;
  /** Stable, so the wording lives in the dictionary. */
  code: string;
  options: QuestionOption[];
}

/** A phrase the assistant learned for this farm: "solyarka" is a certain item. */
export interface LearnedPhrase {
  id: string;
  phrase: string;
  targetType: string;
  targetId: string;
}

export type Attachment =
  | { type: 'table'; title: string; columns: string[]; rows: Record<string, unknown>[]; total: number }
  | { type: 'chart'; chart: 'bar' | 'line'; title: string; xKey: string; yKeys: string[]; rows: Record<string, unknown>[] }
  | { type: 'proposal'; proposal: ProposalView }
  | { type: 'farm_proposal'; proposal: FarmProposalView }
  | { type: 'question'; question: Question };

export interface AnswerConfidence {
  value: number;
  level: 'high' | 'medium' | 'low';
  basis: 'farm_data' | 'partial' | 'general';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  createdAt: string;
  text: string;
  outcome?: 'answered' | 'refused' | 'truncated' | 'gave_up';
  toolCalls?: ToolCall[];
  attachments?: Attachment[];
  sources?: AnswerSource[];
  confidence?: AnswerConfidence;
  model?: string | null;
}

export interface ChatReply {
  conversationId: string;
  message: ChatMessage;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  createdAt: string;
  lastMessageAt: string | null;
}

export interface Conversation extends ConversationSummary {
  messages: ChatMessage[];
}

export type ChatEvent =
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string; status: ToolStatus; rows: number | null };

export const INSIGHT_TYPES = [
  'feed_anomaly',
  'mortality_spike',
  'weight_slowdown',
  'weight_loss',
  'fuel_spike',
  'expense_spike',
  'lambing_workload',
  'season_profit',
  'feed_shortage',
  'feed_cost_saving',
  'crop_suggestion',
  'executive_summary',
] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];

export interface Insight {
  id: string;
  type: InsightType;
  title: string;
  body: string;
  confidence: number;
  sources: Record<string, unknown>;
  data: {
    severity?: 'info' | 'attention' | 'urgent';
    link?: string;
    /** Values for the dictionary text, so an insight reads in the viewer's language. */
    i18n?: Record<string, string | number>;
    /** Values that differ by language, such as crop names, given in each. They replace the same key in `i18n`. */
    localized?: Record<string, I18nName>;
    /** Dictionary entry when it differs from the type. */
    textKey?: string;
  } & Record<string, unknown>;
  containsMoney: boolean;
  periodFrom: string | null;
  periodTo: string | null;
  model: string | null;
  decision: 'pending' | 'accepted' | 'rejected';
  decidedAt: string | null;
  decisionNote: string | null;
  outcome: string | null;
  createdAt: string;
}

export interface Coverage {
  key: string;
  have: number;
  need: number;
  unit: string;
  enough: boolean;
}

export interface AnalysisReport {
  created: number;
  refreshed: number;
  /** Pending advice the run no longer gave, taken off the list. */
  retired: number;
  alertsRaised: number;
  coverage: Coverage[];
  failed: string[];
}

export interface DocumentProposal {
  documentType: string;
  number: string | null;
  date: string | null;
  counterpartyName: string | null;
  counterpartyTin: string | null;
  currency: string | null;
  total: number | null;
  lines: { name: string; qty: number | null; unit: string | null; unitPrice: number | null; amount: number | null }[];
  animals: number | null;
  validUntil: string | null;
  issuer: string | null;
}

export interface DocumentReading {
  status: 'proposal';
  requiresConfirmation: true;
  proposal: DocumentProposal;
  confidence: number;
  sources: { file: { id: string; name: string }; model: string };
}
