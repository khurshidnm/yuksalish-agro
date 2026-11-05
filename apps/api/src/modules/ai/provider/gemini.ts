import { randomUUID } from 'node:crypto';
import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  type Candidate,
  type Content,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';
import { AppError } from '../../../core/errors';
import type { LlmBlock, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmStopReason } from './types';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

const DEFAULT_THINKING_BUDGET = 1024;
const DEFAULT_MAX_TOKENS = 8000;

/**
 * Gemini 3.x treats the thinking budget as a target rather than a cap, and thinking counts against
 * maxOutputTokens, so an over-thinking request would lose the end of its answer or its JSON.
 * This multiple of the budget is reserved on top of the answer. It only raises the ceiling.
 */
const THINKING_HEADROOM = 3;

/** Gemini may omit a call id. These mark ours, which must not be sent back as if Gemini made them. */
const LOCAL_ID_PREFIX = 'local-';

/** The part of the SDK this provider uses, so tests can pass a stub instead of the network. */
export interface GeminiClient {
  models: { generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse> };
}

function toPart(block: LlmBlock, callNames: Map<string, string>): Part {
  switch (block.type) {
    case 'text':
      return { text: block.text };
    case 'tool_use':
      return { functionCall: { name: block.name, args: block.input as Record<string, unknown> } };
    case 'tool_result':
      return {
        functionResponse: {
          ...(block.toolUseId.startsWith(LOCAL_ID_PREFIX) ? {} : { id: block.toolUseId }),
          name: callNames.get(block.toolUseId) ?? 'unknown',
          response: block.isError ? { error: block.content } : { output: block.content },
        },
      };
    case 'image':
    case 'document':
    case 'audio':
      return { inlineData: { mimeType: block.mediaType, data: block.dataBase64 } };
  }
}

function toContents(messages: LlmMessage[]): Content[] {
  // A function response must name its function, which only the earlier call records.
  const callNames = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'tool_use') callNames.set(block.id, block.name);
  }
  return messages.map((message) => {
    // Replay the model's own turn untouched: its thought signatures must come back exactly as sent.
    if (message.role === 'assistant' && message.raw) return message.raw as Content;
    return {
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: message.content.map((block) => toPart(block, callNames)),
    };
  });
}

function fromParts(parts: Part[]): LlmBlock[] {
  const out: LlmBlock[] = [];
  for (const part of parts) {
    if (part.thought) continue;
    if (part.text) out.push({ type: 'text', text: part.text });
    else if (part.functionCall) {
      out.push({
        type: 'tool_use',
        id: part.functionCall.id ?? `${LOCAL_ID_PREFIX}${randomUUID()}`,
        name: part.functionCall.name ?? '',
        input: part.functionCall.args ?? {},
      });
    }
  }
  return out;
}

const REFUSALS = new Set<string>([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
  FinishReason.IMAGE_PROHIBITED_CONTENT,
  FinishReason.IMAGE_RECITATION,
]);

function stopReason(candidate: Candidate | undefined, content: LlmBlock[], blocked: boolean): LlmStopReason {
  if (blocked) return 'refusal';
  const reason = candidate?.finishReason;
  if (reason === FinishReason.MAX_TOKENS) return 'max_tokens';
  if (reason && REFUSALS.has(reason)) return 'refusal';
  if (content.some((block) => block.type === 'tool_use')) return 'tool_use';
  return reason === FinishReason.STOP ? 'end' : 'other';
}

/** Stable codes for the client; the SDK's message and the key never leave the server. */
function mapError(error: unknown): unknown {
  const wrap = (status: number, code: string, message: string) => {
    const mapped = new AppError(status, code, message);
    mapped.cause = error;
    return mapped;
  };
  if (error instanceof ApiError) {
    // An invalid key comes back as 400 from this API, not 401.
    if (error.status === 401 || error.status === 403 || /api[_ ]key/i.test(error.message)) {
      return wrap(503, 'AI_PROVIDER_AUTH', 'The AI provider rejected our credentials');
    }
    if (error.status === 429) return wrap(429, 'AI_PROVIDER_BUSY', 'The AI provider is busy, please try again shortly');
    return wrap(502, 'AI_PROVIDER_ERROR', 'The AI provider returned an error');
  }
  // fetch reports network trouble as a TypeError, but so does a bug here: only match the former.
  if (error instanceof TypeError && /fetch failed|network|terminated/i.test(error.message)) {
    return wrap(503, 'AI_PROVIDER_UNREACHABLE', 'The AI provider cannot be reached');
  }
  return error;
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  readonly configured = true;
  readonly model: string;
  private readonly thinkingBudget: number;
  private readonly client: GeminiClient;

  constructor(options: { apiKey?: string; model?: string; thinkingBudget?: number; client?: GeminiClient }) {
    this.model = options.model || DEFAULT_GEMINI_MODEL;
    this.thinkingBudget = options.thinkingBudget || DEFAULT_THINKING_BUDGET;
    this.client =
      options.client ??
      new GoogleGenAI({
        apiKey: options.apiKey,
        httpOptions: { timeout: 120_000, retryOptions: { attempts: 3 } },
      });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const config: GenerateContentConfig = {
      systemInstruction: [request.system, request.context].filter(Boolean).join('\n\n'),
      maxOutputTokens: (request.maxTokens ?? DEFAULT_MAX_TOKENS) + this.thinkingBudget * THINKING_HEADROOM,
      thinkingConfig: { thinkingBudget: this.thinkingBudget },
      ...(request.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parametersJsonSchema: tool.inputSchema,
                })),
              },
            ],
          }
        : {}),
      ...(request.responseSchema
        ? { responseMimeType: 'application/json', responseJsonSchema: request.responseSchema }
        : {}),
    };

    let response: GenerateContentResponse;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: toContents(request.messages),
        config,
      });
    } catch (error) {
      throw mapError(error);
    }

    const candidate = response.candidates?.[0];
    const content = fromParts(candidate?.content?.parts ?? []);
    const usage = response.usageMetadata;
    const cached = usage?.cachedContentTokenCount ?? 0;
    return {
      stopReason: stopReason(candidate, content, !candidate && Boolean(response.promptFeedback?.blockReason)),
      content,
      raw: candidate?.content,
      model: response.modelVersion ?? this.model,
      usage: {
        inputTokens: (usage?.promptTokenCount ?? 0) - cached,
        // Thinking is billed as output, so it belongs in the count.
        outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
        cacheReadTokens: cached,
      },
    };
  }
}
