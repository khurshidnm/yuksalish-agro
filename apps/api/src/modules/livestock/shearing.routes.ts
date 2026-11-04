import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as shearing from './shearing.service';

export function registerShearing(app: FastifyInstance) {
  const r = routes(app, 'livestock');

  r.get('/shearing', {
    access: 'livestock.view',
    query: shearing.shearingListQuery,
    handler: (req) => shearing.listShearing(req.query),
  });

  r.post('/shearing', {
    access: 'livestock.update',
    summary: 'Record wool; it enters the products warehouse',
    body: shearing.shearingInput,
    handler: async (req, reply) => {
      reply.code(201);
      return shearing.createShearing(req.body);
    },
  });

  r.delete('/shearing/:id', {
    access: 'livestock.update',
    params: idParam,
    handler: (req) => shearing.deleteShearing(req.params.id),
  });
}
