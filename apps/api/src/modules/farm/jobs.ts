import type { ScheduledJob } from '../../jobs/types';
import { refreshSatellite } from './satellite.service';
import { refreshWeather } from './weather.service';

export const jobs: ScheduledJob[] = [
  {
    name: 'farm.weather',
    cron: '15 */6 * * *',
    run: async () => {
      await refreshWeather();
    },
  },
  {
    // Sentinel-2 passes over Uzbekistan before noon and the catalogue has the scene by the evening.
    name: 'farm.satellite',
    cron: '30 21 * * *',
    runDetached: async (farm) => {
      await refreshSatellite(farm);
    },
  },
];
