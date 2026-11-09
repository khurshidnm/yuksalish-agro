import { and, eq, inArray, sql } from 'drizzle-orm';
import { detectAnomalies, hasEnoughBaseline, rationSavingOption, type RationCostLine } from '@yap/shared/formulas/ai';
import { ANIMAL_ON_FARM_STATUSES, addDays, monthOf, round } from '@yap/shared';
import { ctx, today, tx } from '../../../core/context';
import { schema } from '../../../db/client';
import { winterPlan } from '../../feed/balance.service';
import { feedBalance } from '../../inventory/summary';
import { dayText, groupDigits } from '../render';
import { coverage, type AnalyzerResult, type Finding } from './types';

const { animals, dailyLogLines, dailyLogs, herds, items, rationLines, rations } = schema;

const WINDOW_DAYS = 14;
const MIN_BASELINE_DAYS = 7;
const LOOKBACK_DAYS = 7;
const HISTORY_DAYS = 60;
/** Days needed to order and receive feed. An assumption, shown with the finding. */
const PURCHASE_LEAD_DAYS = 14;

/** Daily feed per head against its moving average (spec 15.1.2, 15.3 scenario 2). */
export async function feedAnomalies(): Promise<AnalyzerResult> {
  const from = addDays(today(), -HISTORY_DAYS);
  const result = await tx().execute(sql`
    select date::text as date, sum(qty)::float8 as qty, sum(head_count)::float8 as head
    from (
      select log.id, log.date, log.head_count, sum(line.actual_qty) as qty
      from ${dailyLogs} log
      join ${dailyLogLines} line on line.log_id = log.id
      join ${items} item on item.id = line.item_id and item.unit = 'kg'
      where log.farm_id = ${ctx().farmId} and log.date >= ${from}
      group by log.id
    ) logs
    where head_count > 0
    group by date
    order by date`);
  const rows = result.rows as { date: string; qty: number; head: number }[];

  const cover = coverage('feed_anomaly', rows.length, MIN_BASELINE_DAYS + 1, 'days');
  if (!hasEnoughBaseline(rows.length, MIN_BASELINE_DAYS)) return { coverage: cover, findings: [] };

  const series = rows.map((r) => r.qty / r.head);
  const findings = detectAnomalies(series, {
    window: WINDOW_DAYS,
    minBaseline: MIN_BASELINE_DAYS,
    lookback: LOOKBACK_DAYS,
  }).map((a): Finding => {
    const { date } = rows[a.index];
    return {
      type: 'feed_anomaly',
      dedupKey: `feed_anomaly:${date}`,
      severity: Math.abs(a.deviationPercent) >= 30 ? 'urgent' : 'attention',
      confidence: a.confidence,
      params: {
        date: dayText(date),
        actual: round(a.value, 2),
        expected: round(a.baselineMean, 2),
        deviation: Math.abs(a.deviationPercent),
        direction: a.deviationPercent > 0 ? '+' : '−',
      },
      sources: {
        tables: ['daily_logs', 'daily_log_lines'],
        from: rows[0].date,
        to: rows[rows.length - 1].date,
        days: rows.length,
        baselineDays: a.baselineSize,
        baselineMeanKgPerHead: round(a.baselineMean, 3),
        baselineStd: round(a.baselineStd, 3),
        z: a.z,
      },
      data: { actualKgPerHead: round(a.value, 3), deviationPercent: a.deviationPercent },
      periodFrom: date,
      periodTo: date,
      link: '/livestock/daily-logs',
    };
  });
  return { coverage: cover, findings };
}

/** Which feeds run out before winter ends, when to buy and how much (spec 15.1.5). */
export async function feedAdvice(): Promise<AnalyzerResult> {
  const { minStockDays } = ctx().settings.feed;
  const plan = await winterPlan({});
  const balance = await feedBalance();
  const cover = coverage('feed_shortage', plan.rows.length, 1, 'feeds');
  const month = monthOf(today());

  const findings: Finding[] = [];
  for (const row of plan.rows) {
    if (!row.shortageKg || row.shortageKg <= 0) continue;
    const position = balance.find((b) => b.itemId === row.itemId);
    const days = position?.days ?? row.coverageDays;
    if (days === null) continue;
    const runOut = addDays(today(), Math.floor(days));
    const purchaseBy = addDays(runOut, -PURCHASE_LEAD_DAYS);
    const fromActualUse = position?.basis === 'actual' && (position.actualDaysCovered ?? 0) >= 5;
    findings.push({
      type: 'feed_shortage',
      dedupKey: `feed_shortage:${row.itemId}:${month}`,
      severity: days < minStockDays ? 'urgent' : 'attention',
      confidence: fromActualUse ? 0.85 : 0.7,
      params: {
        item: row.name,
        days: Math.floor(days),
        runOut: dayText(runOut),
        shortageT: round(row.shortageKg / 1000, 1),
        winterDays: plan.days,
        purchaseBy: dayText(purchaseBy < today() ? today() : purchaseBy),
      },
      sources: {
        tables: ['stock_batches', 'stock_movements', 'ration_lines'],
        basis: position?.basis ?? 'plan',
        stockKg: row.stockKg,
        dailyKg: row.dailyKg,
        requiredKg: row.requiredKg,
        assumptions: { purchaseLeadDays: PURCHASE_LEAD_DAYS, winterDays: plan.days },
      },
      data: { stockKg: row.stockKg, shortageKg: row.shortageKg, hectares: row.hectares },
      entityType: 'item',
      entityId: row.itemId,
      periodFrom: today(),
      periodTo: addDays(today(), plan.days),
      link: '/feed/winter-plan',
      alertable: false, // The alert engine already watches feed days.
    });
  }
  return { coverage: cover, findings };
}

/**
 * A cheaper mix for each ration in use (spec 15.1.5): roughage for roughage, grain for grain, never the salt
 * or premix, and only when it saves at least 1% of what the ration costs. Money, and for the zootechnician
 * to judge.
 */
export async function feedSavings(): Promise<AnalyzerResult> {
  const farmId = ctx().farmId;
  const inUse = await tx()
    .select({
      rationId: herds.rationId,
      name: rations.name,
      head: sql<number>`count(${animals.id})`.mapWith(Number),
    })
    .from(herds)
    .innerJoin(rations, eq(rations.id, herds.rationId))
    .leftJoin(animals, and(eq(animals.herdId, herds.id), inArray(animals.status, [...ANIMAL_ON_FARM_STATUSES])))
    .where(eq(herds.farmId, farmId))
    .groupBy(herds.rationId, rations.name);

  const costPerKg = new Map((await winterPlan({})).rows.map((row) => [row.itemId, row.unitCostPerKg]));
  const month = monthOf(today());
  const findings: Finding[] = [];
  let priced = 0;

  for (const ration of inUse) {
    if (!ration.rationId) continue;
    const rows = await tx()
      .select({
        itemId: items.id,
        name: items.name,
        kgPerHeadDay: rationLines.kgPerHeadDay,
        dryMatterPct: items.dryMatterPct,
      })
      .from(rationLines)
      .innerJoin(items, eq(items.id, rationLines.itemId))
      .where(eq(rationLines.rationId, ration.rationId));
    const lines: RationCostLine[] = rows.map((row) => ({ ...row, unitCostPerKg: costPerKg.get(row.itemId) ?? null }));
    // Readiness counts rations that can be judged. Finding no swap worth making is an answer, not missing data.
    const fed = lines.filter((line) => line.kgPerHeadDay > 0);
    if (fed.length >= 2 && fed.every((line) => line.unitCostPerKg !== null && line.dryMatterPct !== null)) priced += 1;

    const saving = rationSavingOption(lines, ration.head);
    if (!saving) continue;
    findings.push({
      type: 'feed_cost_saving',
      dedupKey: `feed_cost_saving:${ration.rationId}:${month}`,
      severity: 'info',
      confidence: 0.55,
      containsMoney: true,
      params: {
        ration: ration.name,
        from: saving.fromName,
        to: saving.toName,
        savingPerDay: groupDigits(saving.savingPerDay),
        savingPerHead: groupDigits(saving.savingPerHeadDay),
        head: ration.head,
        currency: ctx().currency,
      },
      sources: {
        tables: ['ration_lines', 'items', 'stock_batches', 'animals'],
        head: ration.head,
        lines: lines.length,
        feedClass: saving.feedClass,
        savingPercent: saving.savingPercent,
        method: 'dry_matter_swap',
      },
      data: { ...saving },
      entityType: 'ration',
      entityId: ration.rationId,
      periodFrom: today(),
      link: '/feed/rations',
      alertable: false,
    });
  }
  return { coverage: coverage('feed_cost_saving', priced, 1, 'feeds'), findings };
}
