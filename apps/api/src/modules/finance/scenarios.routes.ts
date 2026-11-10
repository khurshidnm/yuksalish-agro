import type { FastifyInstance } from 'fastify';
import type { Permission } from '@yap/shared';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './scenarios.service';

/**
 * Reading a plan shows only totals and averages, so an investor's finance.summary is enough.
 * Keeping a plan under a name is a finance record like any other.
 */
const READ: Permission[] = ['finance.view', 'finance.summary'];

export function registerScenarios(app: FastifyInstance) {
  const r = routes(app, 'finance');

  r.get('/scenarios/baseline', {
    access: READ,
    summary: "A three-year plan's assumptions, prefilled from the farm's own records",
    handler: () => service.baseline(),
  });

  r.post('/scenarios/compute', {
    access: READ,
    summary: 'Run the three-year model for a set of assumptions. Nothing is stored',
    body: service.assumptionsInput,
    handler: (req) => service.compute(req.body),
  });

  r.get('/scenarios', {
    access: READ,
    summary: 'List saved plans',
    query: service.scenarioListQuery,
    handler: (req) => service.list(req.query),
  });

  r.get('/scenarios/:id', {
    access: READ,
    params: idParam,
    handler: (req) => service.get(req.params.id),
  });

  r.post('/scenarios', {
    access: 'finance.create',
    body: service.scenarioInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.create(req.body);
    },
  });

  r.patch('/scenarios/:id', {
    access: 'finance.update',
    params: idParam,
    body: service.scenarioInput.partial(),
    handler: (req) => service.update(req.params.id, req.body),
  });

  r.delete('/scenarios/:id', {
    access: 'finance.delete',
    params: idParam,
    handler: (req) => service.remove(req.params.id),
  });
}
