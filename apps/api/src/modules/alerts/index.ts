import type { FastifyInstance } from 'fastify';
import { isTest } from '../../config';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './alerts.service';
import { sendTestAlert } from './reach';
import { evaluateRules } from './rules';

// Each one is a message to every member of staff.
const testLimit = isTest ? {} : { rateLimit: { max: 5, timeWindow: '10 minutes' } };

export default async function alertsModule(app: FastifyInstance) {
  const r = routes(app, 'alerts');

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
    config: testLimit,
    handler: () => sendTestAlert(),
  });
}
