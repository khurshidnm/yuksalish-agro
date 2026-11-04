import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LAND_USES } from '@yap/shared';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import { getFieldCard } from './field-card.service';
import * as fields from './fields.service';
import * as soil from './soil.service';

export function registerFields(app: FastifyInstance) {
  const r = routes(app, 'farm');

  r.get('/fields', {
    access: 'farm.view',
    summary: 'Land contours with their current crop',
    query: fields.fieldListQuery,
    handler: (req) => fields.listFields(req.query),
  });

  r.get('/fields/lookup', {
    access: 'authenticated',
    summary: 'Number, name and area, for dropdowns in other modules',
    query: z.object({ search: z.string().trim().optional(), landUse: z.enum(LAND_USES).optional() }),
    handler: (req) => fields.lookupFields(req.query),
  });

  r.get('/fields/:id', {
    access: 'farm.view',
    summary: 'Field card: current crop, five-year rotation, soil history',
    params: idParam,
    handler: (req) => getFieldCard(req.params.id),
  });

  r.post('/fields', {
    access: 'farm.create',
    summary: 'Create a contour. With a boundary, PostGIS measures the area.',
    body: fields.fieldInput,
    handler: async (req, reply) => {
      reply.code(201);
      const field = await fields.createField(req.body);
      return { ...field, overlaps: await fields.overlappingContours(field.id) };
    },
  });

  r.patch('/fields/:id', {
    access: 'farm.update',
    summary: 'Update a contour. The response lists any contours it now overlaps.',
    params: idParam,
    body: fields.fieldPatch,
    handler: async (req) => {
      const field = await fields.updateField(req.params.id, req.body);
      return { ...field, overlaps: await fields.overlappingContours(field.id) };
    },
  });

  r.delete('/fields/:id', {
    access: 'farm.delete',
    summary: 'Archive a contour',
    params: idParam,
    handler: (req) => fields.archiveField(req.params.id),
  });

  r.get('/fields/:id/soil', {
    access: 'farm.view',
    summary: 'Soil analyses, oldest first',
    params: idParam,
    handler: (req) => soil.listSoil(req.params.id),
  });

  r.post('/fields/:id/soil', {
    access: 'farm.create',
    params: idParam,
    body: soil.soilInput,
    handler: async (req, reply) => {
      reply.code(201);
      return soil.createSoil(req.params.id, req.body);
    },
  });

  r.patch('/soil/:id', {
    access: 'farm.update',
    params: idParam,
    body: soil.soilInput.partial(),
    handler: (req) => soil.updateSoil(req.params.id, req.body),
  });

  r.delete('/soil/:id', {
    access: 'farm.delete',
    params: idParam,
    handler: (req) => soil.removeSoil(req.params.id),
  });
}
