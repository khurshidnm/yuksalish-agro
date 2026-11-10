import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as harvests from './harvests.service';
import * as operations from './operations.service';
import * as planFact from './plan-fact.service';
import * as plans from './plans.service';
import * as seasons from './seasons.service';
import { cropFigures, fieldStatus, harvestPlanFact, overdueOperations } from './summary';
import * as techCards from './tech-cards.service';

const seasonFilter = z.object({ seasonId: z.uuid().optional() });

export default async function cropsModule(app: FastifyInstance) {
  const r = routes(app, 'crops');

  // ─── Reference data ──────────────────────────────────────────────────────
  r.get('/seasons', {
    access: 'authenticated',
    summary: 'Seasons, newest first. Also used by dropdowns in other modules.',
    handler: () => seasons.list(),
  });
  r.post('/seasons', {
    access: 'crops.create',
    body: seasons.seasonInput,
    handler: async (req, reply) => {
      reply.code(201);
      return seasons.create(req.body);
    },
  });
  r.patch('/seasons/:id', {
    access: 'crops.update',
    params: idParam,
    body: seasons.seasonInput.partial(),
    handler: (req) => seasons.update(req.params.id, req.body),
  });
  r.delete('/seasons/:id', {
    access: 'crops.delete',
    params: idParam,
    handler: (req) => seasons.remove(req.params.id),
  });

  r.get('/crops', {
    access: 'authenticated',
    summary: 'Crop reference list',
    handler: () => seasons.listCrops(),
  });
  r.post('/crops', {
    access: 'crops.create',
    body: seasons.cropInput,
    handler: async (req, reply) => {
      reply.code(201);
      return seasons.createCrop(req.body);
    },
  });
  r.patch('/crops/:id', {
    access: 'crops.update',
    summary: "A crop's rotation family and nutrient removal",
    params: idParam,
    body: seasons.cropPatch,
    handler: (req) => seasons.updateCrop(req.params.id, req.body),
  });

  // ─── Tech cards ──────────────────────────────────────────────────────────
  r.get('/tech-cards', {
    access: 'crops.view',
    query: z.object({ cropId: z.uuid().optional() }),
    handler: (req) => techCards.list(req.query.cropId),
  });
  r.get('/tech-cards/:id', {
    access: 'crops.view',
    params: idParam,
    handler: (req) => techCards.get(req.params.id),
  });
  r.post('/tech-cards', {
    access: 'crops.create',
    body: techCards.techCardInput,
    handler: async (req, reply) => {
      reply.code(201);
      return techCards.create(req.body);
    },
  });
  r.patch('/tech-cards/:id', {
    access: 'crops.update',
    params: idParam,
    body: techCards.techCardInput.partial(),
    handler: (req) => techCards.update(req.params.id, req.body),
  });
  r.delete('/tech-cards/:id', {
    access: 'crops.delete',
    params: idParam,
    handler: (req) => techCards.remove(req.params.id),
  });

  // ─── Crop plans ──────────────────────────────────────────────────────────
  r.get('/plans', {
    access: 'crops.view',
    summary: 'Crop plans with field status and progress',
    query: plans.planListQuery,
    handler: (req) => plans.list(req.query),
  });
  r.get('/plans/estimate', {
    access: 'crops.view',
    summary: 'Cost estimate and expected yield from the tech card',
    query: z.object({
      cropId: z.uuid(),
      areaHa: z.coerce.number().positive(),
      techCardId: z.uuid().optional(),
    }),
    handler: (req) => plans.estimate(req.query),
  });
  r.get('/plans/rotation-check', {
    access: 'crops.view',
    summary: 'Rotation notes for a crop on a field in a season. They warn and never block.',
    query: plans.rotationQuery,
    handler: (req) => plans.rotationCheck(req.query),
  });
  r.get('/plans/:id', {
    access: 'crops.view',
    params: idParam,
    handler: (req) => plans.get(req.params.id),
  });
  r.post('/plans', {
    access: 'crops.create',
    body: plans.planInput,
    handler: async (req, reply) => {
      reply.code(201);
      return plans.create(req.body);
    },
  });
  r.patch('/plans/:id', {
    access: 'crops.update',
    params: idParam,
    body: plans.planInput.partial(),
    handler: (req) => plans.update(req.params.id, req.body),
  });
  r.delete('/plans/:id', {
    access: 'crops.delete',
    params: idParam,
    handler: (req) => plans.remove(req.params.id),
  });
  r.post('/plans/:id/generate-operations', {
    access: 'crops.create',
    summary: 'Create planned operations from the tech card',
    params: idParam,
    handler: (req) => plans.generateOperations(req.params.id),
  });

  r.get('/plan-fact', {
    access: 'crops.view',
    summary: 'Plan against fact per field for a season',
    query: seasonFilter,
    handler: (req) => planFact.planFact(req.query.seasonId),
  });

  r.get('/summary', {
    access: 'crops.view',
    summary: 'Field status, overdue work, harvest plan and KPIs',
    query: seasonFilter,
    handler: async (req) => {
      const { kpis, yields } = await cropFigures(req.query.seasonId);
      return {
        fields: await fieldStatus(req.query.seasonId),
        overdue: await overdueOperations(),
        harvest: await harvestPlanFact(req.query.seasonId),
        kpis,
        // Each crop's yield on its own: hay, silage and grain do not average into one t/ha.
        yields,
      };
    },
  });

  // ─── Field operations ────────────────────────────────────────────────────
  r.get('/operations', {
    access: 'crops.view',
    summary: 'Agrotechnical journal',
    query: operations.operationListQuery,
    handler: (req) => operations.listOperations(req.query),
  });
  r.get('/operations/:id', {
    access: 'crops.view',
    params: idParam,
    handler: (req) => operations.getOperation(req.params.id),
  });
  r.post('/operations', {
    access: 'crops.create',
    summary: 'Record field work. Materials leave the warehouse and are charged to the field.',
    body: operations.operationInput,
    handler: async (req, reply) => {
      reply.code(201);
      return operations.createOperation(req.body);
    },
  });
  r.patch('/operations/:id', {
    access: 'crops.update',
    params: idParam,
    body: operations.operationPatch,
    handler: (req) => operations.updateOperation(req.params.id, req.body),
  });
  r.delete('/operations/:id', {
    access: 'crops.delete',
    params: idParam,
    handler: (req) => operations.removeOperation(req.params.id),
  });
  // Mechanics hold crops.create and close their own planned work (spec section 5).
  r.post('/operations/:id/complete', {
    access: ['crops.update', 'crops.create'],
    summary: 'Mark planned work as done',
    params: idParam,
    body: operations.completeInput,
    handler: (req) => operations.completeOperation(req.params.id, req.body),
  });

  // ─── Harvests ────────────────────────────────────────────────────────────
  r.get('/harvests', {
    access: 'crops.view',
    query: harvests.harvestListQuery,
    handler: (req) => harvests.listHarvests(req.query),
  });
  r.get('/harvests/:id', {
    access: 'crops.view',
    params: idParam,
    handler: (req) => harvests.getHarvest(req.params.id),
  });
  r.post('/harvests', {
    access: 'crops.create',
    summary: 'Record a harvest, optionally receiving it into a warehouse',
    body: harvests.harvestInput,
    handler: async (req, reply) => {
      reply.code(201);
      return harvests.createHarvest(req.body);
    },
  });
  r.patch('/harvests/:id', {
    access: 'crops.update',
    params: idParam,
    body: harvests.harvestPatch,
    handler: (req) => harvests.updateHarvest(req.params.id, req.body),
  });
  r.delete('/harvests/:id', {
    access: 'crops.delete',
    params: idParam,
    handler: (req) => harvests.removeHarvest(req.params.id),
  });
  r.post('/harvests/:id/receive', {
    access: ['crops.update', 'inventory.create'],
    summary: 'Receive a recorded harvest into a warehouse',
    params: idParam,
    body: harvests.receiveInput,
    handler: (req) => harvests.receiveHarvest(req.params.id, req.body),
  });
}
