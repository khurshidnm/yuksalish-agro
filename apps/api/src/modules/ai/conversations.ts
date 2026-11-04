import { and, asc, count, desc, eq, gte, sql } from 'drizzle-orm';
import { ctx, tx } from '../../core/context';
import { AppError, notFound } from '../../core/errors';
import { paged, type ListQuery } from '../../core/query';
import { schema } from '../../db/client';
import type { LlmMessage } from './provider';

const { aiConversations: conversations, aiMessages: messages } = schema;

const PER_MINUTE = Number(process.env.AI_CHAT_PER_MINUTE) || 10;
const PER_DAY = Number(process.env.AI_CHAT_PER_DAY) || 200;

/** Earlier turns sent to the model. Older ones stay stored but are not needed for a question. */
const HISTORY_MESSAGES = 20;

async function questionsSince(ms: number): Promise<number> {
  const c = ctx();
  const [row] = await tx()
    .select({ questions: count() })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.userId, c.userId!),
        eq(messages.role, 'user'),
        gte(messages.createdAt, new Date(Date.now() - ms)),
      ),
    );
  return row.questions;
}

/**
 * Per-user limit, counted from stored questions: it needs an authenticated user, holds across API
 * instances, and survives restarts. It caps both abuse and the LLM bill.
 */
export async function assertWithinLimits(): Promise<void> {
  const limited = (retryAfterSeconds: number) =>
    new AppError(429, 'AI_RATE_LIMITED', 'Too many questions, please wait a little', { retryAfterSeconds });
  if ((await questionsSince(60_000)) >= PER_MINUTE) throw limited(60);
  if ((await questionsSince(86_400_000)) >= PER_DAY) throw limited(3600);
}

export async function ensureConversation(id: string | undefined, firstMessage: string): Promise<string> {
  const c = ctx();
  if (id) {
    const [own] = await tx()
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, c.userId!)));
    if (!own) throw notFound('Conversation');
    return own.id;
  }
  const [created] = await tx()
    .insert(conversations)
    .values({
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      userId: c.userId!,
      title: firstMessage.slice(0, 80),
    })
    .returning({ id: conversations.id });
  return created.id;
}

/** Earlier turns as plain text. Tool data is not resent; the answers already state the figures. */
export async function loadHistory(conversationId: string): Promise<LlmMessage[]> {
  const rows = await tx()
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_MESSAGES);
  return rows
    .reverse()
    .map((row): LlmMessage => ({
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: (row.content as { text?: string }).text ?? '' }],
    }))
    .filter((message) => (message.content[0] as { text: string }).text !== '');
}

export async function saveMessage(conversationId: string, role: 'user' | 'assistant', content: unknown) {
  const [row] = await tx()
    .insert(messages)
    .values({ tenantId: ctx().tenantId, conversationId, role, content })
    .returning({ id: messages.id, createdAt: messages.createdAt });
  return row;
}

// ─── Read by the signed-in person, on their own conversations ───────────────

export async function listConversations(q: Pick<ListQuery, 'page' | 'pageSize'>) {
  const where = and(eq(conversations.farmId, ctx().farmId), eq(conversations.userId, ctx().userId!));
  const lastMessage = sql<Date>`(select max(m.created_at) from ${messages} m where m.conversation_id = ${conversations.id})`;
  return paged(q, conversations, where, (limit, offset) =>
    tx()
      .select({ id: conversations.id, title: conversations.title, createdAt: conversations.createdAt, lastMessageAt: lastMessage })
      .from(conversations)
      .where(where)
      .orderBy(desc(lastMessage), desc(conversations.createdAt))
      .limit(limit)
      .offset(offset),
  );
}

export async function getConversation(id: string) {
  const [conversation] = await tx()
    .select({ id: conversations.id, title: conversations.title, createdAt: conversations.createdAt })
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, ctx().userId!)));
  if (!conversation) throw notFound('Conversation');
  const rows = await tx()
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  return {
    ...conversation,
    messages: rows.map((row) => ({
      id: row.id,
      role: row.role,
      createdAt: row.createdAt,
      ...(row.content as Record<string, unknown>),
    })),
  };
}

export async function deleteConversation(id: string) {
  const [deleted] = await tx()
    .delete(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, ctx().userId!)))
    .returning({ id: conversations.id });
  if (!deleted) throw notFound('Conversation');
  return deleted;
}
