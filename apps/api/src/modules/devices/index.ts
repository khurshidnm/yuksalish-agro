import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './devices.service';

const WRITE_SCOPE = { apiKey: 'events:write' };

/** The guard has already verified this header. */
const apiKeyOf = (req: { headers: FastifyRequest['headers'] }) => req.headers['x-api-key'] as string;

export default async function devicesModule(app: FastifyInstance) {
  const r = routes(app, 'devices');

  // Machine ingest. Static paths win over /:id in the router.
  r.post('/events', {
    access: WRITE_SCOPE,
    summary: 'Ingest one event from a camera or sensor (see docs/device-events.md)',
    bodyLimit: 64 * 1024,
    body: service.deviceEvent,
    handler: (req) => service.ingest(req.body, apiKeyOf(req)),
  });
  r.post('/events/batch', {
    access: WRITE_SCOPE,
    summary: 'Ingest up to 100 buffered events; failures are reported per event',
    bodyLimit: 1024 * 1024,
    body: z.object({ events: z.array(service.deviceEvent).min(1).max(100) }),
    handler: (req) => service.ingestBatch(req.body.events, apiKeyOf(req)),
  });
  r.post('/heartbeat', {
    access: WRITE_SCOPE,
    summary: 'Tell the platform a device is alive',
    body: service.heartbeatInput,
    handler: (req) => service.heartbeat(req.body.deviceId, apiKeyOf(req)),
  });

  r.get('/events', {
    access: 'cameras.view',
    summary: 'Camera and sensor event feed',
    query: service.eventFeedQuery,
    handler: (req) => service.eventFeed(req.query),
  });
  r.get('/plan', {
    access: 'cameras.view',
    summary: 'Planned camera layout against what is registered',
    handler: () => service.plan(),
  });

  r.get('/', {
    access: 'cameras.view',
    query: service.deviceListQuery,
    handler: (req) => service.list(req.query),
  });
  r.get('/:id', {
    access: 'cameras.view',
    params: idParam,
    handler: (req) => service.get(req.params.id),
  });
  r.post('/', {
    access: 'cameras.create',
    body: service.deviceInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.create(req.body);
    },
  });
  r.patch('/:id', {
    access: 'cameras.update',
    params: idParam,
    body: service.deviceInput.partial(),
    handler: (req) => service.update(req.params.id, req.body),
  });
  r.delete('/:id', {
    access: 'cameras.delete',
    params: idParam,
    handler: (req) => service.remove(req.params.id),
  });
}
