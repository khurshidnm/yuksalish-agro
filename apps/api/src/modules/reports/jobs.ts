import type { FarmJob } from '../../jobs/types';
import { deliverDueReports } from './delivery';
import { sendMonthlyInvestorReport } from './investor';

export const jobs: FarmJob[] = [
  {
    name: 'reports.scheduled-delivery',
    // Each morning; weekly and monthly reports decide for themselves whether today is their day.
    cron: '0 8 * * *',
    run: async () => {
      await deliverDueReports();
    },
  },
  {
    name: 'reports.investor-monthly',
    // On the 1st, after the month has closed and depreciation has run.
    cron: '0 9 1 * *',
    run: async () => {
      await sendMonthlyInvestorReport();
    },
  },
];
