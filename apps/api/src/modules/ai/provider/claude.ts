import Anthropic from '@anthropic-ai/sdk';
import { AppError } from '../../../core/errors';
import type { LlmBlock, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmStopReason } from './types';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

const parseEffort = (value: string | undefined): Effort =>
  EFFORTS.find((e) => e === value) ?? 'medium';

/** The part of the SDK this provider uses, so tests can pass a stub instead of the network. */
export interface ClaudeClient {
  beta: { messages: { create(params: never): Promise<unknown> } };
}

type Param = Anthropic.Beta.BetaContentBlockParam;

function toParam(block: LlmBlock): Param {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError ?? false,
      };
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mediaType as 'image/jpeg' | 'image/png' | 'image/webp',
          data: block.dataBase64,
        },
      };
    case 'document':
      return { type: 'document', source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 } };
    case 'audio':
      throw new AppError(501, 'AI_AUDIO_NOT_SUPPORTED', 'This AI provider cannot read audio');
  }
}

function toMessageParam(message: LlmMessage): Anthropic.Beta.BetaMessageParam {
  // Replay the provider's own blocks untouched: thinking blocks must come back unchanged.
  if (message.role === 'assistant' && message.raw) {
    return { role: 'assistant', content: message.raw as Param[] };
  }
  return { role: message.role, content: message.content.map(toParam) };
}

function fromResponse(blocks: Anthropic.Beta.BetaContentBlock[]): LlmBlock[] {
  const out: LlmBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'text') out.push({ type: 'text', text: block.text });
    else if (block.type === 'tool_use') {
      out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
    }
  }
  return out;
}

function stopReason(reason: Anthropic.Beta.BetaMessage['stop_reason']): LlmStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'paused';
    default:
      return 'other';
  }
}

/** Stable codes for the client; the SDK's message and the key never leave the server. */
function mapError(error: unknown): unknown {
  const wrap = (status: number, code: string, message: string) => {
    const mapped = new AppError(status, code, message);
    mapped.cause = error;
    return mapped;
  };
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return wrap(503, 'AI_PROVIDER_AUTH', 'The AI provider rejected our credentials');
  }
  if (error instanceof Anthropic.RateLimitError) {
    return wrap(429, 'AI_PROVIDER_BUSY', 'The AI provider is busy, please try again shortly');
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return wrap(503, 'AI_PROVIDER_UNREACHABLE', 'The AI provider cannot be reached');
  }
  if (error instanceof Anthropic.APIError) {
    return wrap(502, 'AI_PROVIDER_ERROR', 'The AI provider returned an error');
  }
  return error;
}

export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude';
  readonly configured = true;
  readonly model: string;
  private readonly effort: Effort;
  private readonly client: ClaudeClient;

  constructor(options: { apiKey?: string; model?: string; effort?: string; client?: ClaudeClient }) {
    this.model = options.model || DEFAULT_CLAUDE_MODEL;
    this.effort = parseEffort(options.effort);
    this.client =
      options.client ??
      (new Anthropic({ apiKey: options.apiKey, timeout: 120_000, maxRetries: 2 }) as unknown as ClaudeClient);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: request.maxTokens ?? 16_000,
      // Server-side retry on another model when a safety classifier declines the request.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: {
        effort: this.effort,
        ...(request.responseSchema ? { format: { type: 'json_schema', schema: request.responseSchema } } : {}),
      },
      // Tools, then the stable system text, form the cached prefix. The volatile context stays
      // after the breakpoint so a new date does not invalidate it.
      system: [
        { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
        ...(request.context ? [{ type: 'text' as const, text: request.context }] : []),
      ],
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
            })),
          }
        : {}),
      messages: request.messages.map(toMessageParam),
    };

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = (await this.client.beta.messages.create(params as never)) as Anthropic.Beta.BetaMessage;
    } catch (error) {
      throw mapError(error);
    }

    return {
      stopReason: stopReason(response.stop_reason),
      content: fromResponse(response.content),
      raw: response.content,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}
