import type { FastifyInstance } from 'fastify';
import { registerCounterparties } from './counterparties.routes';
import { registerFinance } from './finance.routes';

export default async function financeModule(app: FastifyInstance) {
  registerCounterparties(app);
  registerFinance(app);
}
