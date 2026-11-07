import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './trackers.service';

export function registerTrackers(app: FastifyInstance) {
  const r = routes(app, 'tracking');

  r.get('/trackers', {
    access: 'livestock.view',
    summary: 'Collars, boluses and ear sensors, with the animal each is on and its battery',
    query: service.trackerListQuery,
    handler: (req) => service.list(req.query),
  });

  r.post('/trackers/import', {
    access: 'livestock.update',
    summary: 'Register trackers and fit them to animals from a list. All or nothing; dryRun only checks.',
    body: service.importInput,
    bodyLimit: 512 * 1024,
    handler: (req) => service.importTrackers(req.body),
  });

  r.post('/assignments', {
    access: 'livestock.update',
    summary: 'Fit a tracker to an animal, taking it off any other',
    body: service.fitInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.fit(req.body);
    },
  });

  r.post('/assignments/:id/remove', {
    access: 'livestock.update',
    summary: 'Take a tracker off an animal',
    params: idParam,
    body: service.removeInput,
    handler: (req) => service.remove(req.params.id, req.body),
  });
}
