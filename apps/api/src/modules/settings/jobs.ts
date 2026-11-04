import type { FarmJob } from '../../jobs/types';
import { collectEvents, deliverDue } from './webhooks.service';

/** Wired in jobs/index.ts next to the other modules' jobs. */
export const jobs: FarmJob[] = [
  {
    name: 'webhooks.dispatch',
    cron: '* * * * *',
    run: async () => {
      await collectEvents();
      await deliverDue();
    },
  },
];
