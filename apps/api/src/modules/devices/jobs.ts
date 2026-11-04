import type { FarmJob } from '../../jobs/types';
import { detectOffline } from './devices.service';

/** Wired in jobs/index.ts next to the other modules' jobs. */
export const jobs: FarmJob[] = [
  {
    name: 'devices.offline-check',
    cron: '*/5 * * * *',
    run: async () => {
      await detectOffline();
    },
  },
];
