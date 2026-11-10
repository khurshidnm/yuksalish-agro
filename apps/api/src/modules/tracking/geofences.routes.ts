import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import { ctx } from '../../core/context';
import * as service from './geofences.service';

/** Read with the flock map's permission; changed with the permission that changes herds. */
export function registerGeofences(app: FastifyInstance) {
  const r = routes(app, 'tracking');

  r.get('/zones', {
    access: 'livestock.view',
    summary: 'Zones herds must stay in or keep out of, each with the outline the rule reads',
    handler: () => service.list(),
  });

  r.get('/night-watch', {
    access: 'livestock.view',
    summary: 'Whether a herd on the move at night raises an alert on this farm. Changed in the workspace policy',
    handler: () => ({ enabled: ctx().settings.tracking.nightWatch }),
  });

  r.post('/zones', {
    access: 'livestock.update',
    summary: "Add a zone from a field's boundary or a drawn polygon, for one herd or for all",
    body: service.zoneInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.create(req.body);
    },
  });

  r.patch('/zones/:id', {
    access: 'livestock.update',
    summary: 'Rename a zone, switch it on or off, or change its kind, herd or outline',
    params: idParam,
    body: service.zonePatch,
    handler: (req) => service.update(req.params.id, req.body),
  });

  r.delete('/zones/:id', {
    access: 'livestock.delete',
    summary: 'Remove a zone',
    params: idParam,
    handler: (req) => service.remove(req.params.id),
  });
}
