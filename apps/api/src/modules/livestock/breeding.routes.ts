import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { routes } from '../../core/http';
import { idParam, isoDate, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { calendar, ewePerformance, ramRating, reproductionKpis } from './breeding.summary';
import * as service from './breeding.service';

const { animals, lambingRecords } = schema;

const WRITE = ['livestock.create', 'health.update'] as const;
const CHANGE = ['livestock.update', 'health.update'] as const;
const REMOVE = ['livestock.delete', 'health.delete'] as const;

const ewesQuery = listQuery.extend({ herdId: z.uuid().optional() });

async function listEwes(q: z.infer<typeof ewesQuery>) {
  const where = and(
    eq(animals.farmId, ctx().farmId),
    eq(animals.sex, 'female'),
    sql`exists (select 1 from ${lambingRecords} where ${lambingRecords.eweId} = ${animals.id})`,
    q.herdId ? eq(animals.herdId, q.herdId) : undefined,
    searchAny(q.search, [animals.tag]),
  );
  const page = await paged(q, animals, where, async (limit, offset) =>
    tx()
      .select({ id: animals.id, tag: animals.tag, status: animals.status, herdId: animals.herdId })
      .from(animals)
      .where(where)
      .orderBy(...sortBy(q.sort, { tag: animals.tag }, asc(animals.tag), animals.id))
      .limit(limit)
      .offset(offset),
  );
  const stats = await ewePerformance(page.data.map((a) => a.id));
  return { ...page, data: page.data.map((a) => ({ ...a, ...stats.get(a.id)! })) };
}

export function registerBreeding(app: FastifyInstance) {
  const r = routes(app, 'livestock');

  r.get('/breeding', {
    access: 'livestock.view',
    summary: 'Pregnancies',
    query: service.pregnancyListQuery,
    handler: (req) => service.listPregnancies(req.query),
  });

  r.post('/breeding', {
    access: [...WRITE],
    summary: 'Register a pregnancy; expected lambing dates are calculated',
    body: service.pregnancyInput,
    handler: async (req, reply) => {
      reply.code(201);
      const record = await service.createPregnancy(req.body);
      const inbreeding = req.body.ramId ? await service.checkInbreeding(req.body.eweId, req.body.ramId) : null;
      return { ...record, inbreeding };
    },
  });

  r.post('/breeding/bulk', {
    access: [...WRITE],
    summary: 'Register pregnancies for a herd or a list of ewes',
    body: service.bulkPregnancyInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.bulkPregnancy(req.body);
    },
  });

  r.get('/breeding/calendar', {
    access: 'livestock.view',
    summary: 'Expected lambings by day and by week',
    query: z.object({ from: isoDate.optional(), to: isoDate.optional(), herdId: z.uuid().optional() }),
    handler: (req) => calendar(req.query),
  });

  r.get('/breeding/kpis', {
    access: 'livestock.view',
    summary: 'Lambing percent, survival, lambs per ewe, 100-day weight',
    query: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
    handler: (req) => reproductionKpis(req.query.from, req.query.to),
  });

  r.get('/breeding/rams', {
    access: 'livestock.view',
    summary: 'Ram rating by the growth of their lambs',
    handler: () => ramRating(),
  });

  r.get('/breeding/ewes', {
    access: 'livestock.view',
    summary: 'Per-ewe breeding results',
    query: ewesQuery,
    handler: (req) => listEwes(req.query),
  });

  r.get('/breeding/inbreeding-check', {
    access: 'livestock.view',
    summary: 'Do this ewe and ram share an ancestor within three generations?',
    query: z.object({ eweId: z.uuid(), ramId: z.uuid() }),
    handler: (req) => service.checkInbreeding(req.query.eweId, req.query.ramId),
  });

  r.get('/breeding/:id', {
    access: 'livestock.view',
    params: idParam,
    handler: (req) => service.getPregnancy(req.params.id),
  });

  r.patch('/breeding/:id', {
    access: [...CHANGE],
    summary: 'Correct a pregnancy; dates are recalculated',
    params: idParam,
    body: service.pregnancyUpdate,
    handler: (req) => service.updatePregnancy(req.params.id, req.body),
  });

  r.post('/breeding/:id/close', {
    access: [...CHANGE],
    summary: 'End a pregnancy without lambing',
    params: idParam,
    body: service.closePregnancyInput,
    handler: (req) => service.closePregnancy(req.params.id, req.body),
  });

  r.delete('/breeding/:id', {
    access: [...REMOVE],
    params: idParam,
    handler: (req) => service.deletePregnancy(req.params.id),
  });

  r.get('/lambings', {
    access: 'livestock.view',
    query: service.lambingListQuery,
    handler: (req) => service.listLambings(req.query),
  });

  r.post('/lambings', {
    access: [...WRITE],
    summary: 'Record a lambing: creates the lambs and closes the pregnancy',
    body: service.lambingInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.recordLambing(req.body);
    },
  });

  r.patch('/lambings/:id', {
    access: [...CHANGE],
    params: idParam,
    body: service.lambingUpdate,
    handler: (req) => service.updateLambing(req.params.id, req.body),
  });

  r.get('/pedigree/:id', {
    access: 'livestock.view',
    summary: 'Ancestors and descendants of an animal',
    params: idParam,
    query: z.object({ generations: z.coerce.number().int().min(1).max(5).default(3) }),
    handler: (req) => service.pedigree(req.params.id, req.query.generations),
  });
}
