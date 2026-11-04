import { ApiError, refreshSession } from '@/lib/api';
import type { ChatEvent, ChatReply } from './types';

export interface SseMessage {
  event: string;
  data: unknown;
}

/** Split a server-sent event buffer into complete messages and the unfinished remainder. */
export function parseSse(buffer: string): { messages: SseMessage[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const messages = parts.flatMap((part) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    return data.length > 0 ? [{ event, data: JSON.parse(data.join('\n')) as unknown }] : [];
  });
  return { messages, rest };
}

async function failure(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: unknown } } | null;
  return new ApiError(res.status, body?.error?.code ?? 'HTTP_ERROR', body?.error?.message ?? res.statusText, body?.error?.details);
}

interface ChatRequest {
  conversationId?: string;
  message: string;
  language?: string;
}

/**
 * Ask the assistant and report tool activity while it works. The answer takes seconds, so a
 * fresh token is fetched first: `api` has no streaming call to attach one for us.
 */
export async function streamChat(body: ChatRequest, onEvent: (event: ChatEvent) => void, signal?: AbortSignal): Promise<ChatReply> {
  const session = await refreshSession();
  if (!session) throw new ApiError(401, 'NO_SESSION', 'Please sign in');

  const res = await fetch('/api/v1/ai/chat/stream', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw await failure(res);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const { messages, rest } = parseSse(buffer + value);
    buffer = rest;
    for (const { data, event } of messages) {
      if (event === 'done') return data as ChatReply;
      if (event === 'failure') {
        const error = data as { code: string; message: string; details?: unknown };
        throw new ApiError(500, error.code, error.message, error.details);
      }
      onEvent(data as ChatEvent);
    }
  }
  throw new ApiError(0, 'NETWORK_ERROR', 'The connection closed before the answer arrived');
}
