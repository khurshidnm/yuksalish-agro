import { eq } from 'drizzle-orm';
import type { RoleKey } from '@yap/shared';
import { ctx, tx } from '../../core/context';
import { recordEvent } from '../../core/journal';
import { schema } from '../../db/client';
import { raiseAlert } from '../alerts/alerts.service';
import { runAnalyzers, type Coverage, type InsightType } from './analyzers';
import { ALERT_CONFIDENCE, storeFindings } from './insights.service';
import { asLanguage } from './render';
import { asAi } from './role';

/** Who acts on each detection. */
const ALERT_ROLES: Partial<Record<InsightType, RoleKey[]>> = {
  feed_anomaly: ['zootechnician', 'director'],
  mortality_spike: ['veterinarian', 'zootechnician', 'director', 'owner'],
  weight_slowdown: ['zootechnician', 'veterinarian'],
  fuel_spike: ['director'],
  expense_spike: ['accountant', 'director', 'owner'],
};

/** The language insights are stored in. The web app re-renders them in each viewer's language. */
export async function tenantLanguage() {
  const [tenant] = await tx()
    .select({ locale: schema.tenants.locale })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, ctx().tenantId));
  return asLanguage(tenant?.locale);
}

export interface AnalysisReport {
  created: number;
  refreshed: number;
  alertsRaised: number;
  coverage: Coverage[];
  failed: string[];
}

/** Run every analysis, store what it found, and raise alerts for confident new detections. */
export async function runStatistics(): Promise<AnalysisReport> {
  const language = await asAi(tenantLanguage);
  const run = await runAnalyzers();
  const stored = await storeFindings(run.findings, language);

  let alertsRaised = 0;
  for (const { id, inserted, finding, text } of stored) {
    const alertable =
      inserted &&
      finding.alertable !== false &&
      finding.severity !== 'info' &&
      finding.confidence >= ALERT_CONFIDENCE;
    if (!alertable) continue;
    await raiseAlert({
      ruleKey: `ai.${finding.type}`,
      dedupKey: `ai:${finding.dedupKey}`,
      severity: finding.severity,
      title: text.title,
      body: text.body,
      link: finding.link,
      entityType: finding.entityType,
      entityId: finding.entityId,
      source: 'ai',
      // Same wording as the insight, so each reader gets it in their own language.
      data: { insightId: id, confidence: finding.confidence, insightKey: finding.textKey ?? finding.type, i18n: finding.params },
      notify: ALERT_ROLES[finding.type],
      permission: finding.containsMoney ? 'finance.view' : undefined,
    });
    alertsRaised += 1;
  }

  for (const { key, error } of run.failed) {
    console.error(`[ai] analysis ${key} failed`, error);
    await recordEvent({ type: 'ai.analysis_failed', severity: 'attention', source: 'ai', data: { analysis: key } });
  }

  return {
    created: stored.filter((s) => s.inserted).length,
    refreshed: stored.filter((s) => !s.inserted).length,
    alertsRaised,
    coverage: run.coverage,
    failed: run.failed.map((f) => f.key),
  };
}

/** How much data each analysis has. Stores nothing. */
export async function dataCoverage() {
  const run = await runAnalyzers();
  return { coverage: run.coverage, failed: run.failed.map((f) => f.key) };
}
