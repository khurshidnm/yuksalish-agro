import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isTest } from '../../config';
import { ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './alerts.service';
import { sendTestAlert } from './reach';
import { evaluateRules } from './rules';

/** Each test is a message to every member of staff, so a farm has one allowance. Runs in the handler, so a refused call spends none of it. */
function testLimiter(app: FastifyInstance) {
  if (isTest) return async () => {};
  const count = app.createRateLimit({ max: 5, timeWindow: '10 minutes', keyGenerator: () => ctx().farmId });
  return async (req: FastifyRequest) => {
    const tries = await count(req);
    if (!tries.isAllowed && tries.isExceeded) throw new AppError(429, 'RATE_LIMITED', 'Too many attempts, please wait a minute');
  };
}

export default async function alertsModule(app: FastifyInstance) {
  const r = routes(app, 'alerts');
  const limitTest = testLimiter(app);

  r.get('/', {
    access: 'authenticated',
    summary: 'Alerts this user may see, most severe first',
    query: service.alertListQuery,
    handler: (req) => service.list(req.query),
  });

  r.get('/counts', {
    access: 'authenticated',
    summary: 'Unresolved alerts by severity',
    handler: () => service.counts(),
  });

  r.post('/:id/acknowledge', {
    access: service.ACKNOWLEDGE_PERMISSION,
    summary: 'Take responsibility: stops repeat notifications',
    params: idParam,
    handler: (req) => service.acknowledge(req.params.id),
  });

  r.post('/:id/resolve', {
    access: 'tasks.update',
    summary: 'Close an alert. A rule raises it again if the problem still holds.',
    params: idParam,
    handler: (req) => service.resolve(req.params.id),
  });

  r.post('/evaluate', {
    access: 'dashboard.update',
    summary: 'Run the rule engine now',
    handler: () => evaluateRules(),
  });

  r.post('/test', {
    access: 'dashboard.update',
    summary: 'Send one labelled test the way an urgent alert goes, and say who it reached',
    handler: async (req) => {
      await limitTest(req as unknown as FastifyRequest);
      return sendTestAlert();
    },
  });
}
