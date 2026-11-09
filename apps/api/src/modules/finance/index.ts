import type { FastifyInstance } from 'fastify';
import { registerAdvances } from './advances.routes';
import { registerCounterparties } from './counterparties.routes';
import { registerFinance } from './finance.routes';

export default async function financeModule(app: FastifyInstance) {
  registerCounterparties(app);
  registerFinance(app);
  registerAdvances(app);
}
