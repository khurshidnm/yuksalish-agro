import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../../core/errors';
import { routes } from '../../core/http';
import { fromChirpstack, fromTheThingsStack, type Adapted } from './decode';
import * as service from './ingest.service';

/** The same scope as camera and sensor events: a key that may write what devices report. */
const WRITE_SCOPE = { apiKey: 'events:write' };

/** The guard has already verified this header. */
const apiKeyOf = (req: { headers: FastifyRequest['headers'] }) => req.headers['x-api-key'] as string;

const anyObject = z.record(z.string(), z.unknown());

function uplinkOf(adapted: Adapted) {
  if ('invalid' in adapted) throw badRequest('INVALID_UPLINK', `The message has no usable ${adapted.invalid}`);
  return 'ignored' in adapted ? null : adapted.uplink;
}

export function registerIngest(app: FastifyInstance) {
  const r = routes(app, 'tracking');

  r.post('/ingest/chirpstack', {
    access: WRITE_SCOPE,
    summary: 'ChirpStack v4 HTTP integration, JSON encoding (docs/tracking.md). Events other than up, status and location get 204.',
    query: z.object({ event: z.string().max(32).optional() }),
    body: anyObject,
    bodyLimit: 64 * 1024,
    handler: async (req, reply) => {
      const uplink = uplinkOf(fromChirpstack(req.query.event, req.body));
      if (!uplink) return reply.code(204).send();
      return service.ingest([uplink], apiKeyOf(req));
    },
  });

  r.post('/ingest/tts', {
    access: WRITE_SCOPE,
    summary: 'The Things Stack webhook: uplink messages and solved locations (docs/tracking.md)',
    body: anyObject,
    bodyLimit: 64 * 1024,
    handler: async (req, reply) => {
      const uplink = uplinkOf(fromTheThingsStack(req.body));
      if (!uplink) return reply.code(204).send();
      return service.ingest([uplink], apiKeyOf(req));
    },
  });

  r.post('/readings', {
    access: WRITE_SCOPE,
    summary: 'Up to 500 readings in AgroPanel format, for vendor-cloud bridges (docs/tracking.md)',
    body: service.readingsInput,
    bodyLimit: 512 * 1024,
    handler: (req) => service.ingest(service.uplinksFromReadings(req.body), apiKeyOf(req)),
  });
}
