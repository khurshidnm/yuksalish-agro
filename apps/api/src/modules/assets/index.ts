import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam, isoDate, isoMonth, listQuery } from '../../core/query';
import * as service from './assets.service';
import * as costs from './costs.service';
import * as depreciation from './depreciation.service';
import * as maintenance from './maintenance.service';
import * as rental from './rental.service';
import * as usage from './usage.service';

const logParam = z.object({ id: z.uuid(), logId: z.uuid() });
const recordParam = z.object({ id: z.uuid(), recordId: z.uuid() });
const period = z.object({ from: isoDate.optional(), to: isoDate.optional() });

export default async function assetsModule(app: FastifyInstance) {
  const r = routes(app, 'assets');

  r.get('/', {
    access: 'assets.view',
    summary: 'Machinery and equipment registry',
    query: service.assetListQuery,
    handler: (req) => service.list(req.query),
  });

  r.get('/lookup', {
    access: 'authenticated',
    summary: 'Id and name only, for dropdowns in other modules',
    query: z.object({ search: z.string().trim().optional(), type: z.string().optional() }),
    handler: (req) => service.lookup(req.query.search, req.query.type),
  });

  r.get('/maintenance/due', {
    access: 'assets.view',
    summary: 'Machines that need service now or soon',
    query: z.object({ withinDays: z.coerce.number().int().min(0).max(365).default(14) }),
    handler: (req) => maintenance.dueMaintenance(req.query.withinDays),
  });

  r.post('/depreciation/run', {
    access: 'finance.approve',
    summary: 'Post every ended month not posted yet, or one named month. Safe to repeat.',
    body: z.object({ month: isoMonth.optional() }),
    handler: async (req) => depreciation.postMonths(req.body.month ? [req.body.month] : await depreciation.monthsToRun()),
  });

  r.get('/:id', {
    access: 'assets.view',
    params: idParam,
    handler: (req) => service.get(req.params.id),
  });

  r.post('/', {
    access: 'assets.create',
    body: service.assetInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.create(req.body);
    },
  });

  r.patch('/:id', {
    access: 'assets.update',
    params: idParam,
    body: service.assetInput.partial(),
    handler: (req) => service.update(req.params.id, req.body),
  });

  r.delete('/:id', {
    access: 'assets.delete',
    params: idParam,
    handler: (req) => service.remove(req.params.id),
  });

  r.get('/:id/usage', {
    access: 'assets.view',
    summary: 'Shift journal of one machine',
    params: idParam,
    query: usage.usageListQuery,
    handler: (req) => usage.listUsage(req.params.id, req.query),
  });

  // Mechanics report their own shifts (spec section 5) and hold crops.create, not assets.create.
  r.post('/:id/usage', {
    access: ['assets.create', 'crops.create'],
    summary: 'Log a shift. Fuel leaves the warehouse and is charged to the machine.',
    params: idParam,
    body: usage.usageInput,
    handler: async (req, reply) => {
      reply.code(201);
      return usage.logUsage({ ...req.body, assetId: req.params.id });
    },
  });

  r.patch('/:id/usage/:logId', {
    access: ['assets.update', 'crops.update'],
    params: logParam,
    body: usage.usageInput.partial(),
    handler: (req) => usage.updateUsage(req.params.id, req.params.logId, req.body),
  });

  r.delete('/:id/usage/:logId', {
    access: ['assets.delete', 'crops.delete'],
    params: logParam,
    handler: (req) => usage.removeUsage(req.params.id, req.params.logId),
  });

  r.get('/:id/maintenance', {
    access: 'assets.view',
    params: idParam,
    query: listQuery,
    handler: (req) => maintenance.listMaintenance(req.params.id, req.query),
  });

  r.post('/:id/maintenance', {
    access: 'assets.create',
    params: idParam,
    body: maintenance.maintenanceInput,
    handler: async (req, reply) => {
      reply.code(201);
      return maintenance.createMaintenance(req.params.id, req.body);
    },
  });

  r.patch('/:id/maintenance/:recordId', {
    access: 'assets.update',
    params: recordParam,
    body: maintenance.maintenanceInput.partial(),
    handler: (req) => maintenance.updateMaintenance(req.params.id, req.params.recordId, req.body),
  });

  r.delete('/:id/maintenance/:recordId', {
    access: 'assets.delete',
    params: recordParam,
    handler: (req) => maintenance.removeMaintenance(req.params.id, req.params.recordId),
  });

  r.get('/:id/costs', {
    access: 'finance.view',
    summary: 'Cost per motor-hour and per hectare',
    params: idParam,
    query: period,
    handler: (req) => costs.assetCosts(req.params.id, req.query.from, req.query.to),
  });

  r.get('/:id/depreciation', {
    access: 'finance.view',
    params: idParam,
    handler: (req) => depreciation.listDepreciation(req.params.id),
  });

  r.post('/:id/rental-act', {
    access: 'finance.create',
    summary: 'Bill the unbilled shifts of a rented machine as a debt to the contractor',
    params: idParam,
    body: rental.rentalActInput,
    handler: async (req, reply) => {
      reply.code(201);
      return rental.createRentalAct(req.params.id, req.body);
    },
  });
}
