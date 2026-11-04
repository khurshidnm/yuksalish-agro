import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import { feedBalance, feedConsumption, feedingPlan, winterPlan, winterPlanQuery } from './balance.service';
import * as rations from './rations.service';

export default async function feedModule(app: FastifyInstance) {
  const r = routes(app, 'feed');

  r.get('/rations', {
    access: 'feed.view',
    query: rations.rationListQuery,
    handler: (req) => rations.list(req.query),
  });
  r.get('/rations/:id', {
    access: 'feed.view',
    params: idParam,
    handler: (req) => rations.get(req.params.id),
  });
  r.post('/rations', {
    access: 'feed.create',
    body: rations.rationInput,
    handler: async (req, reply) => {
      reply.code(201);
      return rations.create(req.body);
    },
  });
  r.patch('/rations/:id', {
    access: 'feed.update',
    params: idParam,
    body: rations.rationInput.partial(),
    handler: (req) => rations.update(req.params.id, req.body),
  });
  r.delete('/rations/:id', {
    access: 'feed.delete',
    params: idParam,
    handler: (req) => rations.remove(req.params.id),
  });

  r.get('/plan', {
    access: 'feed.view',
    summary: 'Planned daily feeding per herd: ration × head count',
    handler: () => feedingPlan(),
  });
  r.get('/balance', {
    access: 'feed.view',
    summary: 'Stock and days left per feed, by plan and by actual consumption',
    handler: () => feedBalance(),
  });
  r.get('/consumption', {
    access: 'feed.view',
    summary: 'Feed issued per day in kg',
    query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
    handler: (req) => feedConsumption(req.query.days),
  });
  r.get('/winter-plan', {
    access: 'feed.view',
    summary: 'Winter requirement, shortage, purchase cost and hectares to sow',
    query: winterPlanQuery,
    handler: (req) => winterPlan(req.query),
  });
}
