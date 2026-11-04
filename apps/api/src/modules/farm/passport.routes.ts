import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { farmMap } from './map.service';
import * as service from './passport.service';

export function registerPassport(app: FastifyInstance) {
  const r = routes(app, 'farm');

  r.get('/passport', {
    access: 'farm.view',
    summary: 'Farm passport with the land balance',
    handler: () => service.getPassport(),
  });

  r.patch('/passport', {
    access: 'farm.update',
    body: service.passportPatch,
    handler: (req) => service.updatePassport(req.body),
  });

  r.get('/map', {
    access: 'farm.view',
    summary: 'All contours and facilities as GeoJSON',
    handler: () => farmMap(),
  });
}
