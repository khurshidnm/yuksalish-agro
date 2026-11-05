import type { FarmJob } from '../../jobs/types';
import { runStatistics } from './analysis';
import { sendExecutiveSummary } from './executive';
import { sendEveningRecap } from './records/recap';

export const jobs: FarmJob[] = [
  // Before the working day, so the morning alert has last night's logs in it (spec 15.3 scenario 2).
  { name: 'ai-statistics', cron: '15 5 * * *', run: async () => void (await runStatistics()) },
  // End of the working day, while the day's drafts can still be confirmed.
  { name: 'ai-evening-recap', cron: '0 20 * * *', run: async () => void (await sendEveningRecap()) },
  { name: 'ai-summary-weekly', cron: '0 8 * * 1', run: async () => void (await sendExecutiveSummary('week')) },
  { name: 'ai-summary-monthly', cron: '30 8 1 * *', run: async () => void (await sendExecutiveSummary('month')) },
];
