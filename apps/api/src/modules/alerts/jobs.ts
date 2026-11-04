import type { FarmJob } from '../../jobs/types';
import { repeatUrgentAlerts } from './alerts.service';
import { evaluateRules } from './rules';

export const jobs: FarmJob[] = [
  {
    name: 'alerts.evaluate',
    cron: '0 * * * *',
    run: async () => {
      await evaluateRules();
    },
  },
  {
    name: 'alerts.repeat-urgent',
    cron: '*/5 * * * *',
    run: async () => {
      await repeatUrgentAlerts();
    },
  },
];
