import type { FarmJob } from '../../jobs/types';
import { expireReservations } from './reservations.service';

export const jobs: FarmJob[] = [
  {
    // Just after midnight at the farm, so a reservation that ended yesterday frees its animal for the morning.
    name: 'sales.expire-reservations',
    cron: '10 0 * * *',
    run: async () => {
      await expireReservations();
    },
  },
];
