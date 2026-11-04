import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './orders.service';

const reason = z.object({ reason: z.string().trim().min(1).max(500) });

export function registerOrders(app: FastifyInstance) {
  const r = routes(app, 'sales');

  r.get('/orders', {
    access: 'sales.view',
    summary: 'List sale documents',
    query: service.saleListQuery,
    handler: (req) => service.list(req.query),
  });

  r.get('/orders/:id', {
    access: 'sales.view',
    summary: 'Sale document with lines, postings and attachments',
    params: idParam,
    handler: (req) => service.get(req.params.id),
  });

  r.post('/orders', {
    access: 'sales.create',
    summary: 'Create a draft sale. Moves no stock and no money.',
    body: service.saleInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.create(req.body);
    },
  });

  r.patch('/orders/:id', {
    access: 'sales.update',
    summary: 'Change a draft sale. Sending lines replaces all of them.',
    params: idParam,
    body: service.salePatch,
    handler: (req) => service.update(req.params.id, req.body),
  });

  r.delete('/orders/:id', {
    access: ['sales.delete', 'sales.update'],
    summary: 'Delete a draft sale',
    params: idParam,
    handler: (req) => service.remove(req.params.id),
  });

  r.post('/orders/:id/confirm', {
    access: ['sales.approve', 'sales.update'],
    summary: 'Confirm: issue stock, move animals, post income. Large sales need a second person.',
    params: idParam,
    handler: (req) => service.confirm(req.params.id),
  });

  r.post('/orders/:id/reject', {
    access: 'sales.approve',
    summary: 'Return a pending sale to draft',
    params: idParam,
    body: reason,
    handler: (req) => service.reject(req.params.id, req.body.reason),
  });

  r.post('/orders/:id/cancel', {
    access: ['sales.approve', 'sales.update'],
    summary: 'Cancel a sale. A confirmed sale needs sales.approve and is reversed.',
    params: idParam,
    body: reason,
    handler: (req) => service.cancel(req.params.id, req.body.reason),
  });

  r.post('/orders/:id/documents', {
    access: 'sales.update',
    summary: 'Attach a document to a sale',
    params: idParam,
    body: service.saleDocumentInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.addDocument(req.params.id, req.body);
    },
  });
}
