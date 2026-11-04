import type { FarmJob } from '../../jobs/types';
import { generateRecurringTasks } from './tasks.service';

export const jobs: FarmJob[] = [
  {
    name: 'tasks.generate-recurring',
    cron: '5 0 * * *',
    run: async () => {
      await generateRecurringTasks();
    },
  },
];
