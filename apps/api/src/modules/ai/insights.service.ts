import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canSeeMoney, ctx, tx } from '../../core/context';
import { conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { listQuery, paged } from '../../core/query';
import { schema } from '../../db/client';
import { INSIGHT_TYPES, type Finding } from './analyzers/types';
import { aiText } from './render';
import type { LanguageCode } from '@yap/shared/i18n';
import { asAiWriter } from './role';

const { aiInsights: t } = schema;

/** Confidence from which a detection also raises an alert. */
export const ALERT_CONFIDENCE = 0.75;

export interface InsightText {
  title: string;
  body: string;
}

export function findingText(finding: Pick<Finding, 'type' | 'params' | 'textKey'>, language: LanguageCode): InsightText {
  const key = finding.textKey ?? finding.type;
  return {
    title: aiText(language, `insight.${key}.title`, finding.params),
    body: aiText(language, `insight.${key}.body`, finding.params),
  };
}

export interface StoredFinding {
  id: string;
  inserted: boolean;
  finding: Finding;
  text: InsightText;
}

/**
 * Save findings as yap_ai. A finding already stored for the period is refreshed while nobody has
 * decided on it; a decided one stays exactly as the person saw it.
 */
export async function storeFindings(
  findings: Finding[],
  language: LanguageCode,
  options: { model?: string | null; text?: (f: Finding) => InsightText } = {},
): Promise<StoredFinding[]> {
  const c = ctx();
  if (findings.length === 0) return [];
  return asAiWriter(async () => {
    const stored: StoredFinding[] = [];
    for (const finding of findings) {
      const text = options.text?.(finding) ?? findingText(finding, language);
      const data = {
        ...finding.data,
        severity: finding.severity,
        link: finding.link,
        i18n: finding.params,
        textKey: finding.textKey,
      };
      const refreshed = {
        title: text.title,
        body: text.body,
        confidence: finding.confidence,
        sources: finding.sources,
        data,
        // Moves with the text: a refresh may add money figures to a row that had none.
        containsMoney: finding.containsMoney ?? false,
        model: options.model ?? 'statistics',
        updatedAt: new Date(),
      };
      const [row] = await tx()
        .insert(t)
        .values({
          tenantId: c.tenantId,
          farmId: c.farmId,
          type: finding.type,
          dedupKey: finding.dedupKey,
          ...refreshed,
          entityType: finding.entityType,
          entityId: finding.entityId,
          periodFrom: finding.periodFrom,
          periodTo: finding.periodTo,
        })
        .onConflictDoUpdate({
          target: [t.farmId, t.dedupKey],
          set: refreshed,
          where: eq(t.decision, 'pending'),
        })
        .returning({ id: t.id, inserted: sql<boolean>`xmax = 0` });
      if (row) stored.push({ id: row.id, inserted: row.inserted, finding, text });
    }
    return stored;
  });
}

export const insightListQuery = listQuery.extend({
  type: z.enum(INSIGHT_TYPES).optional(),
  decision: z.enum(['pending', 'accepted', 'rejected']).optional(),
});

const visible = () =>
  and(eq(t.farmId, ctx().farmId), canSeeMoney() ? undefined : eq(t.containsMoney, false));

export async function list(q: z.infer<typeof insightListQuery>) {
  const where = and(visible(), q.type ? eq(t.type, q.type) : undefined, q.decision ? eq(t.decision, q.decision) : undefined);
  return paged(q, t, where, (limit, offset) =>
    tx().select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit).offset(offset),
  );
}

async function getVisible(id: string, forUpdate = false) {
  const query = tx().select().from(t).where(and(eq(t.id, id), visible()));
  const [row] = await (forUpdate ? query.for('update') : query);
  if (!row) throw notFound('Insight');
  return row;
}

export const get = (id: string) => getVisible(id);

export const decisionInput = z.object({
  decision: z.enum(['accepted', 'rejected']),
  note: z.string().trim().max(1000).nullish(),
});

/** Spec 15: a recommendation is accepted or rejected by a person, and that decision is kept. */
export async function decide(id: string, input: z.infer<typeof decisionInput>) {
  const row = await getVisible(id, true);
  if (row.decision !== 'pending') throw conflict('ALREADY_DECIDED', 'A decision on this insight is already recorded');
  const [updated] = await tx()
    .update(t)
    .set({ decision: input.decision, decidedBy: ctx().userId, decidedAt: new Date(), decisionNote: input.note })
    .where(eq(t.id, id))
    .returning();
  await recordEvent({
    type: `ai.insight_${input.decision}`,
    entityType: 'ai_insight',
    entityId: id,
    data: { insightType: row.type },
  });
  return updated;
}

export const outcomeInput = z.object({ outcome: z.string().trim().min(1).max(2000) });

/** What actually happened, recorded later, so recommendations can be judged (spec 15.2). */
export async function recordOutcome(id: string, outcome: string) {
  const row = await getVisible(id, true);
  if (row.decision === 'pending') throw conflict('NOT_DECIDED', 'Record a decision before the outcome');
  const [updated] = await tx().update(t).set({ outcome }).where(eq(t.id, id)).returning();
  return updated;
}
