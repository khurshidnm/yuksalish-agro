import type { FastifyInstance } from 'fastify';
import { registerAnimals } from './animals.routes';
import { registerAppraisal } from './appraisal.routes';
import { registerBreeding } from './breeding.routes';
import { registerCodes } from './codes.routes';
import { registerDailyLogs } from './daily-logs.routes';
import { registerHealth } from './health.routes';
import { registerHerds } from './herds.routes';
import { registerLambingDesk } from './lambing-desk.routes';

export default async function livestockModule(app: FastifyInstance) {
  registerAnimals(app);
  registerCodes(app);
  registerHerds(app);
  registerDailyLogs(app);
  registerBreeding(app);
  registerLambingDesk(app);
  registerAppraisal(app);
  registerHealth(app);
}
