import type { Severity } from '@yap/shared';
import type { TextParams } from '../render';

export const INSIGHT_TYPES = [
  'feed_anomaly',
  'mortality_spike',
  'weight_slowdown',
  'weight_loss',
  'fuel_spike',
  'expense_spike',
  'lambing_workload',
  'season_profit',
  'feed_shortage',
  'feed_cost_saving',
  'crop_suggestion',
  'executive_summary',
] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];

/** How much data one analysis has, against the least it needs before it may claim anything. */
export interface Coverage {
  key: string;
  have: number;
  need: number;
  unit: 'days' | 'weeks' | 'intervals' | 'logs' | 'months' | 'ewes' | 'lines' | 'feeds' | 'crops';
  enough: boolean;
}

export interface Finding {
  type: InsightType;
  /** Same key in a later run refreshes the finding rather than repeating it. */
  dedupKey: string;
  severity: Severity;
  /** 0..1 */
  confidence: number;
  /** Numbers for the title and body text in the `ai` dictionary. */
  params: TextParams;
  /** Dictionary entry when it is not named after the type: a variant that fits the facts. */
  textKey?: string;
  /** What the conclusion rests on: tables, date range, sample size, figures. */
  sources: Record<string, unknown>;
  data?: Record<string, unknown>;
  containsMoney?: boolean;
  entityType?: string;
  entityId?: string;
  periodFrom?: string;
  periodTo?: string;
  link?: string;
  /** Forecasts and advice inform; only detections raise alerts. */
  alertable?: boolean;
}

export interface AnalyzerResult {
  coverage: Coverage;
  findings: Finding[];
}

export type Analyzer = () => Promise<AnalyzerResult>;

export function coverage(key: string, have: number, need: number, unit: Coverage['unit']): Coverage {
  return { key, have, need, unit, enough: have >= need };
}
