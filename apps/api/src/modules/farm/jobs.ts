import type { FarmJob } from '../../jobs/types';
import { refreshWeather } from './weather.service';

export const jobs: FarmJob[] = [
  {
    name: 'farm.weather',
    cron: '15 */6 * * *',
    run: async () => {
      await refreshWeather();
    },
  },
];
