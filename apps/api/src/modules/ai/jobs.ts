import { withTenant, type Identity } from '../../core/context';
import type { ScheduledJob } from '../../jobs/types';
import { runStatistics } from './analysis';
import { sendExecutiveSummary, type SummaryKind } from './executive';
import { sendEveningRecap } from './records/recap';

const summaryFor = (kind: SummaryKind) => async (farm: Identity) => {
  await sendExecutiveSummary(kind, (step) => withTenant(farm, step));
};

export const jobs: ScheduledJob[] = [
  // Before the working day, so the morning alert has last night's logs in it (spec 15.3 scenario 2).
  { name: 'ai-statistics', cron: '15 5 * * *', run: async () => void (await runStatistics()) },
  // End of the working day, while the day's drafts can still be confirmed.
  { name: 'ai-evening-recap', cron: '0 20 * * *', run: async () => void (await sendEveningRecap()) },
  { name: 'ai-summary-weekly', cron: '0 8 * * 1', runDetached: summaryFor('week') },
  { name: 'ai-summary-monthly', cron: '30 8 1 * *', runDetached: summaryFor('month') },
];
