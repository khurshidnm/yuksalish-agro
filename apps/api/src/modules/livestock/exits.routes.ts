import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as exits from './exits.service';

export function registerExits(app: FastifyInstance) {
  const r = routes(app, 'livestock');

  r.get('/exits', {
    access: 'livestock.view',
    summary: 'Sales, slaughter, deaths and losses',
    query: exits.exitListQuery,
    handler: (req) => exits.listExits(req.query),
  });

  r.get('/exits/:id', {
    access: 'livestock.view',
    params: idParam,
    handler: (req) => exits.getExit(req.params.id),
  });

  r.post('/exits', {
    // The service narrows this by type: shepherds report deaths, only sales roles record a sale.
    access: ['livestock.create', 'sales.create'],
    summary: 'An animal leaves the farm',
    body: exits.exitInput,
    handler: async (req, reply) => {
      reply.code(201);
      return exits.createExit(req.body);
    },
  });

  r.delete('/exits/:id', {
    access: 'livestock.delete',
    summary: 'Undo an exit recorded by mistake',
    params: idParam,
    handler: (req) => exits.undoExit(req.params.id),
  });
}
