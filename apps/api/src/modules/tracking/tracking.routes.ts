import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './tracking.service';

export function registerTracking(app: FastifyInstance) {
  const r = routes(app, 'tracking');

  r.get('/live', {
    access: 'livestock.view',
    summary: 'Every animal wearing a tracker: position, temperature, activity, battery and health flags',
    query: service.liveQuery,
    handler: (req) => service.live(req.query),
  });

  r.get('/animals/:id', {
    access: 'livestock.view',
    summary: "An animal's tracking state now and the trackers it has worn",
    params: idParam,
    handler: (req) => service.animalSummary(req.params.id),
  });

  r.get('/animals/:id/track', {
    access: 'livestock.view',
    summary: 'Positions in a window (last 24 hours by default), at most 2000 points',
    params: idParam,
    query: service.trackQuery,
    handler: (req) => service.track(req.params.id, req.query),
  });

  r.get('/animals/:id/series', {
    access: 'livestock.view',
    summary: 'Hourly temperature and activity, and 90 days of daily summaries',
    params: idParam,
    query: service.seriesQuery,
    handler: (req) => service.series(req.params.id, req.query),
  });
}
