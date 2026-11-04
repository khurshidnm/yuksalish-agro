import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as herds from './herds.service';

export function registerHerds(app: FastifyInstance) {
  const r = routes(app, 'livestock');

  r.get('/herds', {
    access: 'livestock.view',
    query: herds.herdListQuery,
    handler: (req) => herds.listHerds(req.query),
  });

  r.get('/herds/lookup', {
    access: 'authenticated',
    summary: 'Id, name and head count for dropdowns',
    query: z.object({ search: z.string().trim().optional() }),
    handler: (req) => herds.lookupHerds(req.query.search),
  });

  r.get('/herds/:id', {
    access: 'livestock.view',
    summary: 'Herd card: composition, ration, occupancy, recent logs',
    params: idParam,
    handler: (req) => herds.getHerdCard(req.params.id),
  });

  r.post('/herds', {
    access: 'livestock.update',
    body: herds.herdInput,
    handler: async (req, reply) => {
      reply.code(201);
      return herds.createHerd(req.body);
    },
  });

  r.patch('/herds/:id', {
    access: 'livestock.update',
    params: idParam,
    body: herds.herdInput.partial(),
    handler: (req) => herds.updateHerd(req.params.id, req.body),
  });

  r.delete('/herds/:id', {
    access: 'livestock.delete',
    summary: 'Archive an empty herd',
    params: idParam,
    handler: (req) => herds.archiveHerd(req.params.id),
  });

  r.post('/transfers', {
    access: 'livestock.update',
    summary: 'Move animals, or a whole herd, to another herd',
    body: herds.transferInput,
    handler: (req) => herds.transfer(req.body),
  });
}
