import { and, asc, eq, gt, gte } from 'drizzle-orm';
import { detectAnomalies } from '@yap/shared/formulas/ai';
import { addDays, round } from '@yap/shared';
import { ctx, today, tx } from '../../../core/context';
import { schema } from '../../../db/client';
import { dayText } from '../render';
import { coverage, type AnalyzerResult, type Finding } from './types';

const { assetUsageLogs, assets } = schema;

const MIN_BASELINE_LOGS = 6;

/** Fuel per motor-hour by machine against its own history (spec 15.1.2). */
export async function fuelSpikes(): Promise<AnalyzerResult> {
  const rows = await tx()
    .select({
      assetId: assetUsageLogs.assetId,
      asset: assets.name,
      date: assetUsageLogs.date,
      fuelL: assetUsageLogs.fuelL,
      motoHours: assetUsageLogs.motoHours,
    })
    .from(assetUsageLogs)
    .innerJoin(assets, eq(assets.id, assetUsageLogs.assetId))
    .where(
      and(
        eq(assetUsageLogs.farmId, ctx().farmId),
        gte(assetUsageLogs.date, addDays(today(), -180)),
        gt(assetUsageLogs.fuelL, 0),
        gt(assetUsageLogs.motoHours, 0),
      ),
    )
    .orderBy(asc(assetUsageLogs.assetId), asc(assetUsageLogs.date), asc(assetUsageLogs.createdAt));

  const byAsset = new Map<string, typeof rows>();
  for (const row of rows) byAsset.set(row.assetId, [...(byAsset.get(row.assetId) ?? []), row]);

  const longest = Math.max(0, ...[...byAsset.values()].map((r) => r.length));
  const cover = coverage('fuel_spike', longest, MIN_BASELINE_LOGS + 1, 'logs');

  const findings: Finding[] = [];
  for (const logs of byAsset.values()) {
    const series = logs.map((l) => l.fuelL! / l.motoHours!);
    for (const a of detectAnomalies(series, {
      window: 10,
      minBaseline: MIN_BASELINE_LOGS,
      lookback: 3,
      direction: 'up',
      minDeviationPercent: 15,
    })) {
      const log = logs[a.index];
      findings.push({
        type: 'fuel_spike',
        dedupKey: `fuel_spike:${log.assetId}:${log.date}`,
        severity: 'attention',
        confidence: a.confidence,
        params: {
          asset: log.asset,
          date: dayText(log.date),
          actual: round(a.value, 1),
          expected: round(a.baselineMean, 1),
          deviation: a.deviationPercent,
        },
        sources: {
          tables: ['asset_usage_logs'],
          logs: logs.length,
          baselineLogs: a.baselineSize,
          z: a.z,
          from: logs[0].date,
          to: logs[logs.length - 1].date,
        },
        data: { litersPerHour: round(a.value, 2), baselineLitersPerHour: round(a.baselineMean, 2) },
        entityType: 'asset',
        entityId: log.assetId,
        periodFrom: log.date,
        periodTo: log.date,
        link: `/assets/${log.assetId}`,
      });
    }
  }
  return { coverage: cover, findings };
}
