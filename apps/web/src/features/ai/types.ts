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

export type Attachment =
  | { type: 'table'; title: string; columns: string[]; rows: Record<string, unknown>[]; total: number }
  | { type: 'chart'; chart: 'bar' | 'line'; title: string; xKey: string; yKeys: string[]; rows: Record<string, unknown>[] };

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
