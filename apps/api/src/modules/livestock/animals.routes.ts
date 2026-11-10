import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as animals from './animals.service';
import { registerExits } from './exits.routes';
import { animalsUnderWithdrawal } from './health.service';
import * as passport from './passport.service';
import { registerPasture } from './pasture.routes';
import * as saleReadiness from './sale-readiness.service';
import { registerShearing } from './shearing.routes';
import * as summary from './summary';
import { registerWeights } from './weights.routes';

export function registerAnimals(app: FastifyInstance) {
  const r = routes(app, 'livestock');

  r.get('/animals', {
    access: 'livestock.view',
    summary: 'Registry with filters; search matches the tag and every identifier',
    query: animals.animalListQuery,
    handler: (req) => animals.listAnimals(req.query),
  });

  r.get('/sale-readiness', {
    access: 'livestock.view',
    summary: 'Ready-for-sale list: weight, daily gain, the date each animal reaches the target, and what holds it back',
    query: saleReadiness.saleReadinessQuery,
    handler: (req) => saleReadiness.listSaleReadiness(req.query),
  });

  r.get('/animals/lookup', {
    access: 'authenticated',
    summary: 'Id and tag for dropdowns',
    query: animals.lookupQuery,
    handler: (req) => animals.lookupAnimals(req.query),
  });

  r.get('/animals/scan', {
    access: 'livestock.view',
    summary: 'Find one animal by the exact value of a tag, RFID or QR code',
    query: z.object({ code: z.string().trim().min(1).max(60) }),
    handler: (req) => animals.scan(req.query.code),
  });

  r.get('/animals/:id', {
    access: 'livestock.view',
    summary: 'Animal card: identifiers, weights, transfers, parents, exit',
    params: idParam,
    handler: async (req) => {
      const card = await animals.getAnimalCard(req.params.id);
      // Joined here because health.service already imports animals.service.
      const [withdrawal] = await animalsUnderWithdrawal([card.id]);
      return { ...card, withdrawalUntil: withdrawal?.withdrawalUntil ?? null };
    },
  });

  r.get('/animals/:id/breeding', {
    access: 'livestock.view',
    summary: 'Passport: matings with their rams, lambings, and the figures from them',
    params: idParam,
    handler: (req) => passport.animalBreeding(req.params.id),
  });

  r.get('/animals/:id/health', {
    access: 'health.view',
    summary: 'Passport: veterinary history, with the whole-herd records this animal was really there for',
    params: idParam,
    handler: (req) => passport.animalHealth(req.params.id),
  });

  r.post('/animals', {
    access: 'livestock.update',
    summary: 'Register an animal. Registry changes are for the zootechnician, not for shepherds.',
    body: animals.animalInput,
    handler: async (req, reply) => {
      reply.code(201);
      return animals.visible(await animals.createAnimal(req.body));
    },
  });

  r.patch('/animals/:id', {
    access: 'livestock.update',
    params: idParam,
    body: animals.animalUpdate,
    handler: (req) => animals.updateAnimal(req.params.id, req.body),
  });

  r.delete('/animals/:id', {
    access: 'livestock.delete',
    summary: 'Remove an animal registered by mistake. Use exits for animals leaving the farm.',
    params: idParam,
    handler: (req) => animals.removeAnimal(req.params.id),
  });

  r.post('/animals/:id/identifiers', {
    access: 'livestock.update',
    params: idParam,
    body: animals.identifierBody,
    handler: async (req, reply) => {
      reply.code(201);
      return animals.addIdentifier(req.params.id, req.body);
    },
  });

  r.delete('/animals/:id/identifiers/:identifierId', {
    access: 'livestock.update',
    params: z.object({ id: z.uuid(), identifierId: z.uuid() }),
    handler: (req) => animals.removeIdentifier(req.params.id, req.params.identifierId),
  });

  r.get('/species', {
    access: 'authenticated',
    summary: 'Species with their breeds',
    handler: () => animals.listSpecies(),
  });

  r.get('/summary', {
    access: 'livestock.view',
    summary: 'Head counts by category and status',
    handler: () => summary.herdSummary(),
  });

  r.get('/movement', {
    access: 'livestock.view',
    summary: 'Herd movement for a period (spec 8.6)',
    query: z.object({ from: z.iso.date(), to: z.iso.date() }),
    handler: (req) => summary.herdMovement(req.query.from, req.query.to),
  });

  r.get('/kpis', {
    access: 'livestock.view',
    summary: 'Reproduction and growth KPIs',
    query: z.object({ from: z.iso.date(), to: z.iso.date(), herdId: z.uuid().optional() }),
    handler: async (req) => ({
      reproduction: await summary.reproductionKpis(),
      growth: await summary.growthKpis(req.query.from, req.query.to, req.query.herdId),
    }),
  });

  registerWeights(app);
  registerExits(app);
  registerShearing(app);
  registerPasture(app);
}
