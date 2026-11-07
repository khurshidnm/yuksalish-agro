import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@yap/shared';
import { routes } from '../../core/http';
import * as water from './water.service';

const readers: Permission[] = ['farm.view', 'crops.view'];

export function registerWater(app: FastifyInstance) {
  const r = routes(app, 'farm');

  r.get('/water/advice', {
    access: readers,
    summary: 'Irrigation advice per growing crop from the FAO-56 soil water balance',
    query: z.object({ fieldId: z.uuid().optional() }),
    handler: (req) => water.waterAdvice(req.query.fieldId ? [req.query.fieldId] : undefined),
  });
}
