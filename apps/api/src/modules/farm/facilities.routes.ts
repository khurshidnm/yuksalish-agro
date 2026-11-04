import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FACILITY_TYPES } from '@yap/shared';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './facilities.service';
import * as irrigation from './irrigation.service';

export function registerFacilities(app: FastifyInstance) {
  const r = routes(app, 'farm');

  r.get('/facilities', {
    access: 'farm.view',
    summary: 'Barns, stores, water, power, roads, with capacity in use',
    query: service.facilityListQuery,
    handler: (req) => service.listFacilities(req.query),
  });

  r.get('/facilities/lookup', {
    access: 'authenticated',
    summary: 'Id, name and type, for dropdowns in other modules',
    query: z.object({ search: z.string().trim().optional(), type: z.enum(FACILITY_TYPES).optional() }),
    handler: (req) => service.lookupFacilities(req.query),
  });

  r.get('/facilities/:id', {
    access: 'farm.view',
    params: idParam,
    handler: (req) => service.getFacilityCard(req.params.id),
  });

  r.post('/facilities', {
    access: 'farm.create',
    body: service.facilityInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.createFacility(req.body);
    },
  });

  r.patch('/facilities/:id', {
    access: 'farm.update',
    params: idParam,
    body: service.facilityInput.partial(),
    handler: (req) => service.updateFacility(req.params.id, req.body),
  });

  r.delete('/facilities/:id', {
    access: 'farm.delete',
    summary: 'Archive a facility',
    params: idParam,
    handler: (req) => service.archiveFacility(req.params.id),
  });

  r.get('/irrigation', {
    access: 'farm.view',
    summary: 'Irrigation network with water limit against actual use',
    query: irrigation.irrigationListQuery,
    handler: (req) => irrigation.listIrrigation(req.query),
  });

  r.post('/irrigation', {
    access: 'farm.create',
    body: irrigation.irrigationInput,
    handler: async (req, reply) => {
      reply.code(201);
      return irrigation.createIrrigation(req.body);
    },
  });

  r.patch('/irrigation/:id', {
    access: 'farm.update',
    params: idParam,
    body: irrigation.irrigationPatch,
    handler: (req) => irrigation.updateIrrigation(req.params.id, req.body),
  });

  r.delete('/irrigation/:id', {
    access: 'farm.delete',
    params: idParam,
    handler: (req) => irrigation.removeIrrigation(req.params.id),
  });
}
