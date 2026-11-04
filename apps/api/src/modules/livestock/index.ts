import type { FastifyInstance } from 'fastify';
import { registerAnimals } from './animals.routes';
import { registerBreeding } from './breeding.routes';
import { registerDailyLogs } from './daily-logs.routes';
import { registerHealth } from './health.routes';
import { registerHerds } from './herds.routes';

export default async function livestockModule(app: FastifyInstance) {
  registerAnimals(app);
  registerHerds(app);
  registerDailyLogs(app);
  registerBreeding(app);
  registerHealth(app);
}
