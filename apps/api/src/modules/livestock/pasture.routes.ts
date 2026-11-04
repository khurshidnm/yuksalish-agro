import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as pasture from './pasture.service';

export function registerPasture(app: FastifyInstance) {
  const r = routes(app, 'livestock');

  r.get('/pasture-moves', {
    access: 'livestock.view',
    summary: 'Pasture journal with stocking rate (head/ha)',
    query: pasture.pastureListQuery,
    handler: (req) => pasture.listPastureMoves(req.query),
  });

  r.post('/pasture-moves', {
    access: 'livestock.update',
    body: pasture.pastureOutInput,
    handler: async (req, reply) => {
      reply.code(201);
      return pasture.sendToPasture(req.body);
    },
  });

  r.post('/pasture-moves/:id/return', {
    access: 'livestock.update',
    params: idParam,
    body: pasture.pastureReturnInput,
    handler: (req) => pasture.returnFromPasture(req.params.id, req.body),
  });
}
