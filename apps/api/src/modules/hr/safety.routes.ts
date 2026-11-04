import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './safety.service';

export function registerSafety(app: FastifyInstance) {
  const r = routes(app, 'hr');

  r.get('/safety', {
    access: 'hr.view',
    summary: 'Signed safety instructions',
    query: service.safetyQuery,
    handler: (req) => service.listSafety(req.query.employeeId),
  });

  r.post('/safety', {
    access: 'hr.create',
    body: service.safetyInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.createSafety(req.body);
    },
  });

  r.patch('/safety/:id', {
    access: 'hr.update',
    params: idParam,
    body: service.safetyPatch,
    handler: (req) => service.updateSafety(req.params.id, req.body),
  });

  r.delete('/safety/:id', {
    access: 'hr.delete',
    params: idParam,
    handler: (req) => service.deleteSafety(req.params.id),
  });
}
