import { asAi } from '../role';
import { cropSuggestion } from './crops';
import { feedAdvice, feedAnomalies, feedSavings } from './feed';
import { expenseSpikes, seasonProfit } from './finance';
import { lambingForecast, mortalitySpike, weightGain } from './livestock';
import { fuelSpikes } from './machinery';
import type { Analyzer, Coverage, Finding } from './types';

const ANALYZERS: [string, Analyzer][] = [
  ['feed_anomaly', feedAnomalies],
  ['mortality_spike', mortalitySpike],
  ['weight_slowdown', weightGain],
  ['fuel_spike', fuelSpikes],
  ['expense_spike', expenseSpikes],
  ['lambing_workload', lambingForecast],
  ['season_profit', seasonProfit],
  ['feed_shortage', feedAdvice],
  ['feed_cost_saving', feedSavings],
  ['crop_suggestion', cropSuggestion],
];

export interface AnalysisRun {
  coverage: Coverage[];
  findings: Finding[];
  /** Analyses that crashed. One failing must not silence the others. */
  failed: { key: string; error: unknown }[];
}

/** Run every analysis read-only as yap_ai. Stores nothing. */
export async function runAnalyzers(): Promise<AnalysisRun> {
  const run: AnalysisRun = { coverage: [], findings: [], failed: [] };
  for (const [key, analyzer] of ANALYZERS) {
    try {
      const result = await asAi(analyzer);
      run.coverage.push(result.coverage);
      run.findings.push(...result.findings);
    } catch (error) {
      run.failed.push({ key, error });
    }
  }
  return run;
}

export * from './types';
