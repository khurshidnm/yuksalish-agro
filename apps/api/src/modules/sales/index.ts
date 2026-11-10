import type { FastifyInstance } from 'fastify';
import { registerCatalogue } from './catalogue.routes';
import { registerOrders } from './orders.routes';
import { registerPurchases } from './purchases.routes';
import { registerRegistry } from './registry.routes';
import { registerReservations } from './reservations.routes';

export default async function salesModule(app: FastifyInstance) {
  registerOrders(app);
  registerPurchases(app);
  registerRegistry(app);
  registerReservations(app);
  registerCatalogue(app);
}
