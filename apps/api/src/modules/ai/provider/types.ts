/**
 * The swappable LLM boundary (spec 15.2: Claude, OpenAI or a local model). Nothing outside
 * provider/ knows which vendor runs. A new provider implements LlmProvider and is chosen in
 * provider/index.ts.
 *
 * Data policy: requests carry only what one question needs, and tenant data is never sent for
 * model training. A provider must be configured on terms that guarantee this.
 */
export type LlmBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'image'; mediaType: string; dataBase64: string }
  | { type: 'document'; mediaType: 'application/pdf'; dataBase64: string };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: LlmBlock[];
  /**
   * The provider's own form of an assistant turn. Sent back verbatim during a tool loop, because
   * a provider may need blocks the neutral form does not model, such as thinking.
   */
  raw?: unknown;
}

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  /** Stable instructions. Keep free of dates and ids, so a provider can cache them. */
  system: string;
  /** Per-request facts: today's date, farm, language. */
  context?: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens?: number;
  /** Ask for JSON that matches this schema instead of prose. */
  responseSchema?: Record<string, unknown>;
}

export type LlmStopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'paused' | 'other';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface LlmResponse {
  stopReason: LlmStopReason;
  content: LlmBlock[];
  /** Pass back as LlmMessage.raw when continuing this turn. */
  raw: unknown;
  /** The model that actually answered, which can differ after a server-side fallback. */
  model: string;
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string | null;
  readonly configured: boolean;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
