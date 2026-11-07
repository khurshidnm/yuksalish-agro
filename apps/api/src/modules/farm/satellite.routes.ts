import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addDays, type Permission } from '@yap/shared';
import { isTest } from '../../config';
import { today } from '../../core/context';
import { routes } from '../../core/http';
import { idParam, isoDate } from '../../core/query';
import { getField } from './fields.service';
import * as health from './field-health.service';
import * as satellite from './satellite.service';

const readers: Permission[] = ['farm.view', 'crops.view'];
/** Reading images costs the free source's goodwill and a few seconds of the server. */
const refreshLimit = isTest ? {} : { rateLimit: { max: 6, timeWindow: '1 hour' } };
/** A manual refresh reads at most this many scenes, so the wait stays under a minute. */
const MANUAL_SCENES = 2;
/** The farm map shows readings at most this old. */
const MAP_DAYS = 30;

export function registerSatellite(app: FastifyInstance) {
  const r = routes(app, 'farm');

  r.get('/satellite/fields/:id', {
    access: readers,
    summary: 'Crop health of a field from Sentinel-2: latest map, curve, events, checks, pasture',
    params: idParam,
    handler: (req) => health.fieldHealth(req.params.id),
  });

  r.get('/satellite/fields/:id/reading', {
    access: readers,
    summary: 'The field on one date, with its NDVI grid',
    params: idParam,
    query: z.object({ date: isoDate }),
    handler: async (req) => {
      await getField(req.params.id);
      return satellite.vegetationOn(req.params.id, req.query.date);
    },
  });

  r.get('/satellite/latest', {
    access: readers,
    summary: 'Latest clear reading of each field in the last 30 days, for the map',
    handler: () => satellite.latestVegetation(addDays(today(), -MAP_DAYS)),
  });

  r.post('/satellite/refresh', {
    access: 'farm.update',
    summary: 'Look for new images now. Reads at most two scenes; the nightly job reads the rest.',
    transaction: false,
    config: refreshLimit,
    handler: (req) => satellite.refreshSatellite(req.identity, { maxScenes: MANUAL_SCENES }),
  });

  r.post('/satellite/fields/:id/pasture-samples', {
    access: 'farm.update',
    summary: 'Record a cut-and-weigh sample that calibrates the pasture estimate',
    params: idParam,
    body: health.pastureSampleInput,
    handler: async (req, reply) => {
      reply.code(201);
      return health.addPastureSample(req.params.id, req.body);
    },
  });

  r.delete('/satellite/fields/:id/pasture-samples/:sampleId', {
    access: 'farm.update',
    summary: 'Remove a pasture sample',
    params: z.object({ id: z.uuid(), sampleId: z.uuid() }),
    handler: (req) => health.removePastureSample(req.params.id, req.params.sampleId),
  });
}
