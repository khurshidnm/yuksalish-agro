import type { FarmJob } from '../../jobs/types';
import { monthsToRun, runDepreciation } from './depreciation.service';

export const jobs: FarmJob[] = [
  {
    name: 'assets.monthly-depreciation',
    // After the month has closed in Tashkent.
    cron: '30 2 1 * *',
    run: async () => {
      for (const month of await monthsToRun()) await runDepreciation(month);
    },
  },
];
