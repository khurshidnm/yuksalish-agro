import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './counterparties.service';

/** Reference module: copy this shape for every CRUD resource. */
export function registerCounterparties(app: FastifyInstance) {
  const r = routes(app, 'finance');

  r.get('/counterparties', {
    access: 'finance.view',
    summary: 'List counterparties',
    query: service.counterpartyListQuery,
    handler: (req) => service.list(req.query),
  });

  r.get('/counterparties/lookup', {
    access: 'authenticated',
    summary: 'Id and name only, for dropdowns in other modules',
    query: z.object({ search: z.string().trim().optional() }),
    handler: (req) => service.lookup(req.query.search),
  });

  r.get('/counterparties/:id', {
    access: 'finance.view',
    params: idParam,
    handler: (req) => service.get(req.params.id),
  });

  r.post('/counterparties', {
    access: 'finance.create',
    body: service.counterpartyInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.create(req.body);
    },
  });

  r.patch('/counterparties/:id', {
    access: 'finance.update',
    params: idParam,
    body: service.counterpartyInput.partial(),
    handler: (req) => service.update(req.params.id, req.body),
  });

  r.delete('/counterparties/:id', {
    access: 'finance.delete',
    params: idParam,
    handler: (req) => service.remove(req.params.id),
  });
}
