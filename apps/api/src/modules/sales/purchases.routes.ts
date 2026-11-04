import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './purchases.service';

export function registerPurchases(app: FastifyInstance) {
  const r = routes(app, 'sales');

  r.get('/purchases/supplier-prices', {
    access: ['sales.view', 'inventory.view'],
    summary: 'What each supplier charged for one item',
    query: z.object({ itemId: z.uuid() }),
    handler: (req) => service.supplierPrices(req.query.itemId),
  });

  r.get('/purchases', {
    access: ['sales.view', 'inventory.view'],
    summary: 'List purchase requests',
    query: service.purchaseListQuery,
    handler: (req) => service.list(req.query),
  });

  r.get('/purchases/:id', {
    access: ['sales.view', 'inventory.view'],
    params: idParam,
    handler: (req) => service.get(req.params.id),
  });

  r.post('/purchases', {
    access: ['sales.create', 'inventory.create'],
    summary: 'Request a purchase (storekeeper, zootechnician, agronomist)',
    body: service.purchaseInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.create(req.body);
    },
  });

  r.patch('/purchases/:id', {
    access: ['sales.update', 'inventory.update', 'inventory.create'],
    summary: 'Change a request before it is decided',
    params: idParam,
    body: service.purchaseInput.partial(),
    handler: (req) => service.update(req.params.id, req.body),
  });

  r.delete('/purchases/:id', {
    access: ['sales.delete', 'sales.update', 'inventory.update', 'inventory.create'],
    summary: 'Delete a request before it is decided',
    params: idParam,
    handler: (req) => service.remove(req.params.id),
  });

  r.post('/purchases/:id/approve', {
    access: 'sales.approve',
    summary: 'Approve a request. Not by the person who made it.',
    params: idParam,
    handler: (req) => service.approve(req.params.id),
  });

  r.post('/purchases/:id/reject', {
    access: 'sales.approve',
    params: idParam,
    body: z.object({ reason: z.string().trim().min(1).max(500) }),
    handler: (req) => service.reject(req.params.id, req.body.reason),
  });

  r.post('/purchases/:id/pay', {
    access: 'finance.create',
    summary: 'Pay an approved request. The cost goes into stock value.',
    params: idParam,
    body: service.payInput,
    handler: (req) => service.pay(req.params.id, req.body),
  });

  r.post('/purchases/:id/receive', {
    access: 'inventory.create',
    summary: 'Receive paid goods, with a difference act if the quantity differs',
    params: idParam,
    body: service.receiveInput,
    handler: (req) => service.receive(req.params.id, req.body),
  });
}
