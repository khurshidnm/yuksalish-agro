import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { ctx, hasPermission, tx } from '../../core/context';
import { AppError, notFound } from '../../core/errors';
import { paged, type ListQuery } from '../../core/query';
import { schema } from '../../db/client';
import type { LlmMessage } from './provider';
import { toView } from './records/service';
import type { DocumentAmount, OpenRecord } from './records/types';
import { aiText, asLanguage } from './render';
import { isMoneyTool } from './tools';

const { aiConversations: conversations, aiMessages: messages, aiProposals: proposals } = schema;

const PER_MINUTE = Number(process.env.AI_CHAT_PER_MINUTE) || 10;
const PER_DAY = Number(process.env.AI_CHAT_PER_DAY) || 200;

/** Earlier turns sent to the model. Older ones stay stored but are not needed for a question. */
const HISTORY_MESSAGES = 20;
/** Past this much silence an open question has lapsed, on either channel, so old money funds nothing. */
const EXCHANGE_IDLE_MS = 12 * 3_600_000;
const HIDDEN_FROM_MODEL = 'An earlier answer about money, which this person may no longer see.';

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

export async function ensureConversation(
  id: string | undefined,
  firstMessage: string,
  channel: 'web' | 'telegram' = 'web',
): Promise<string> {
  const c = ctx();
  if (id) {
    const [own] = await tx()
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, c.userId!), eq(conversations.farmId, c.farmId)));
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
      title: [...firstMessage].slice(0, 80).join(''),
      channel,
    })
    .returning({ id: conversations.id });
  return created.id;
}

interface StoredTurn {
  text?: string;
  forwarded?: boolean;
  /** The day the person said it, so "kecha" keeps its meaning when the answer comes after midnight. */
  saidOn?: string;
  /** What the assistant was still waiting to hear at the end of a turn. Empty means the exchange closed. */
  asked?: string[];
  /** What those questions are about. */
  open?: OpenRecord[];
  /** Every draft of this turn was about something new, so nothing before its message counts any more. */
  fresh?: boolean;
  documentAmounts?: DocumentAmount[];
  toolCalls?: { name: string; money?: boolean }[];
  attachments?: { type: string; proposal?: { id: string; fields: { amount: number | null } } }[];
}

const cardsOf = (turn: StoredTurn) => (turn.attachments ?? []).flatMap((a) => (a.type === 'proposal' && a.proposal ? [a.proposal] : []));
/** An answer holding money must not outlive the right to see it. */
const heldMoney = (turn: StoredTurn) => cardsOf(turn).length > 0 || (turn.toolCalls ?? []).some((call) => call.money || isMoneyTool(call.name));

/** Earlier turns as plain text. Tool data is not resent; the answers already state the figures. */
export async function loadHistory(conversationId: string): Promise<LlmMessage[]> {
  const rows = await tx()
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_MESSAGES);
  const seesMoney = hasPermission('finance.view');
  const textOf = (role: string, turn: StoredTurn) => (role === 'assistant' && !seesMoney && heldMoney(turn) ? HIDDEN_FROM_MODEL : (turn.text ?? ''));
  return rows
    .reverse()
    .map((row): LlmMessage => ({
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: textOf(row.role, row.content as StoredTurn) }],
    }))
    .filter((message) => (message.content[0] as { text: string }).text !== '');
}

export interface Exchange {
  /** The person's messages this one continues, oldest first. */
  texts: string[];
  /** The day each of them was said, where that was stored. */
  saidDays: (string | undefined)[];
  /** Someone else's words passed on in this exchange. */
  forwarded: string[];
  documentAmounts: DocumentAmount[];
  /** Readiness codes left open by the last turn. */
  asked: string[];
  /** What those questions are about. */
  open: OpenRecord[];
  /** The amount on each card shown in this exchange, which is money already spoken for. */
  cardAmounts: number[];
}

/**
 * The words a new message may lean on. An amount said earlier counts only while the assistant is still
 * asking about it: once a turn ends with no open question, that money is spoken for, and so it is once a
 * question has gone unanswered for half a day.
 */
export async function openExchange(conversationId: string, limit: number): Promise<Exchange> {
  const rows = await tx()
    .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit * 2);
  const exchange: Exchange = { texts: [], saidDays: [], forwarded: [], documentAmounts: [], asked: [], open: [], cardAmounts: [] };
  const [last] = rows;
  const lastTurn = last?.role === 'assistant' ? (last.content as StoredTurn) : undefined;
  if (!lastTurn?.asked?.length || Date.now() - last.createdAt.getTime() > EXCHANGE_IDLE_MS) return exchange;
  exchange.asked = lastTurn.asked;
  exchange.open = lastTurn.open ?? [];
  let newer = last.createdAt.getTime();
  let startsHere = false;
  for (const row of rows) {
    if (newer - row.createdAt.getTime() > EXCHANGE_IDLE_MS) break;
    newer = row.createdAt.getTime();
    const turn = row.content as StoredTurn;
    if (row.role === 'assistant') {
      if (!turn.asked?.length) break;
      exchange.documentAmounts.unshift(...(turn.documentAmounts ?? []));
      exchange.cardAmounts.push(...cardsOf(turn).flatMap((card) => card.fields.amount ?? []));
      startsHere = turn.fresh ?? false;
      continue;
    }
    if (turn.forwarded) {
      exchange.forwarded.unshift(turn.text ?? '');
    } else {
      exchange.texts.unshift(turn.text ?? '');
      exchange.saidDays.unshift(turn.saidOn);
    }
    if (startsHere || exchange.texts.length >= limit) break;
  }
  return exchange;
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

/**
 * What is left of an answer for someone who has lost finance.view. A sentence cannot be stripped figure by
 * figure, so it goes whole, and a card comes back masked as it stands now. Their own messages stay: those
 * are words they typed themselves.
 */
async function withoutMoney(turn: StoredTurn, hidden: string) {
  const ids = cardsOf(turn).map((card) => card.id);
  const rows = ids.length === 0 ? [] : await tx().select().from(proposals).where(and(inArray(proposals.id, ids), eq(proposals.userId, ctx().userId!)));
  const attachments: unknown[] = [];
  for (const row of rows) attachments.push({ type: 'proposal', proposal: await toView(row) });
  return { text: hidden, attachments, toolCalls: [], sources: [], asked: [] };
}

async function hiddenAnswerText(): Promise<string> {
  const [user] = await tx().select({ locale: schema.users.locale }).from(schema.users).where(eq(schema.users.id, ctx().userId!));
  return aiText(asLanguage(user?.locale), 'assistant.hiddenAnswer');
}

export async function getConversation(id: string) {
  const [conversation] = await tx()
    .select({ id: conversations.id, title: conversations.title, createdAt: conversations.createdAt })
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, ctx().userId!), eq(conversations.farmId, ctx().farmId)));
  if (!conversation) throw notFound('Conversation');
  const rows = await tx()
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const hidden = hasPermission('finance.view') ? null : await hiddenAnswerText();
  const shown = [];
  for (const row of rows) {
    const turn = row.content as StoredTurn;
    const content = hidden !== null && row.role === 'assistant' && heldMoney(turn) ? await withoutMoney(turn, hidden) : turn;
    shown.push({ id: row.id, role: row.role, createdAt: row.createdAt, ...content });
  }
  return { ...conversation, messages: shown };
}

export async function deleteConversation(id: string) {
  // A card outlives its chat: the record it made still points back to the proposal.
  await tx()
    .update(schema.aiProposals)
    .set({ conversationId: null })
    .where(and(eq(schema.aiProposals.conversationId, id), eq(schema.aiProposals.userId, ctx().userId!), eq(schema.aiProposals.farmId, ctx().farmId)));
  const [deleted] = await tx()
    .delete(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, ctx().userId!), eq(conversations.farmId, ctx().farmId)))
    .returning({ id: conversations.id });
  if (!deleted) throw notFound('Conversation');
  return deleted;
}
