import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, real, text, unique, uuid } from 'drizzle-orm/pg-core';
import { day, pk, ts } from './_helpers';
import { tenantColumns } from './_tenant';
import { tenants, users } from './platform';

/** AI findings (spec 4.1 p.8, 15.2). */
export const aiInsights = pgTable(
  'ai_insights',
  {
    id: pk(),
    ...tenantColumns(),
    type: text().notNull(),
    /** One finding per period: re-running an analysis refreshes it instead of repeating it. */
    dedupKey: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    /** Must be 0..1. Required: a conclusion without a confidence is not stored (spec 15.2). */
    confidence: real().notNull(),
    /** What the conclusion rests on: tables, ranges, figures. Required and never empty. */
    sources: jsonb().$type<Record<string, unknown>>().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Shows money figures, so only finance.view holders may read it (CLAUDE.md rule 7). */
    containsMoney: boolean().notNull().default(false),
    entityType: text(),
    entityId: uuid(),
    periodFrom: day(),
    periodTo: day(),
    model: text(),
    decision: text().notNull().default('pending'),
    decidedBy: uuid().references(() => users.id),
    decidedAt: ts(),
    decisionNote: text(),
    outcome: text(),
    /** When it went out to people, so a summary is sent once however often it is generated. */
    notifiedAt: ts(),
  },
  (t) => [
    unique().on(t.farmId, t.dedupKey),
    index().on(t.farmId, t.createdAt),
    index().on(t.farmId, t.decision),
    check('ai_insights_confidence_range', sql`${t.confidence} between 0 and 1`),
    check('ai_insights_has_sources', sql`${t.sources} <> '{}'::jsonb`),
  ],
);

export const aiConversations = pgTable('ai_conversations', {
  id: pk(),
  ...tenantColumns(),
  userId: uuid().notNull().references(() => users.id),
  title: text(),
  /** Where it happens: 'web' or 'telegram'. */
  channel: text().notNull().default('web'),
});

export const aiMessages = pgTable(
  'ai_messages',
  {
    id: pk(),
    tenantId: uuid().notNull().references(() => tenants.id),
    conversationId: uuid().notNull().references(() => aiConversations.id, { onDelete: 'cascade' }),
    role: text().notNull(),
    content: jsonb().notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.conversationId, t.createdAt)],
);

/**
 * A record the assistant prepared, waiting for a person (docs/assistant.md). This table is as far
 * as AI can reach: only a person's Confirm moves it into the books, through the owning service.
 */
export const aiProposals = pgTable(
  'ai_proposals',
  {
    id: pk(),
    ...tenantColumns(),
    userId: uuid().notNull().references(() => users.id),
    conversationId: uuid().references(() => aiConversations.id),
    kind: text().notNull(),
    status: text().notNull().default('pending'),
    channel: text().notNull().default('web'),
    /** What the person actually said. */
    sourceText: text().notNull(),
    /** Resolved ids with their names, so a card can be shown without further lookups. */
    fields: jsonb().$type<Record<string, unknown>>().notNull(),
    warnings: jsonb().$type<{ code: string; params: Record<string, unknown> }[]>().notNull().default([]),
    /** Phrases to remember once confirmed: { phrase, targetType, targetId }. */
    learn: jsonb().$type<{ phrase: string; targetType: string; targetId: string }[]>().notNull().default([]),
    expiresAt: ts().notNull(),
    confirmedAt: ts(),
    undoUntil: ts(),
    resultType: text(),
    resultId: uuid(),
    resultStatus: text(),
  },
  (t) => [index().on(t.userId, t.status), index().on(t.conversationId)],
);

/** What this farm's people call things: "solyarka" is Dizel (docs/assistant.md, Learning). */
export const aiAliases = pgTable(
  'ai_aliases',
  {
    id: pk(),
    ...tenantColumns(),
    phrase: text().notNull(),
    targetType: text().notNull(),
    targetId: uuid().notNull(),
  },
  (t) => [unique().on(t.farmId, t.targetType, t.phrase)],
);
