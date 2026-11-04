import type { FastifyInstance } from 'fastify';
import { registerOrders } from './orders.routes';
import { registerPurchases } from './purchases.routes';
import { registerRegistry } from './registry.routes';

export default async function salesModule(app: FastifyInstance) {
  registerOrders(app);
  registerPurchases(app);
  registerRegistry(app);
}
