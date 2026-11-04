import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { today } from '../../core/context';
import { routes } from '../../core/http';
import { idParam, isoDate } from '../../core/query';
import * as logs from './daily-logs.service';

export function registerDailyLogs(app: FastifyInstance) {
  const r = routes(app, 'livestock');

  r.get('/daily-logs', {
    access: 'livestock.view',
    query: logs.dailyLogListQuery,
    handler: (req) => logs.listDailyLogs(req.query),
  });

  r.get('/daily-logs/plan', {
    access: 'livestock.view',
    summary: "Ration × head count, stock on hand, and whether the day is logged",
    query: z.object({ herdId: z.uuid(), date: isoDate.optional() }),
    handler: (req) => logs.getPlan(req.query.herdId, req.query.date ?? today()),
  });

  r.get('/daily-logs/day', {
    access: 'livestock.view',
    summary: 'Every herd and whether it is logged for the date',
    query: z.object({ date: isoDate.optional() }),
    handler: (req) => logs.dayOverview(req.query.date ?? today()),
  });

  r.get('/daily-logs/:id', {
    access: 'livestock.view',
    params: idParam,
    handler: (req) => logs.getDailyLog(req.params.id),
  });

  r.post('/daily-logs', {
    access: 'livestock.create',
    summary: 'Record a day for a herd. Safe to retry: send a client id or an Idempotency-Key.',
    body: logs.dailyLogInput,
    handler: async (req, reply) => {
      reply.code(201);
      return logs.createDailyLog(req.body);
    },
  });

  r.patch('/daily-logs/:id', {
    // The service limits livestock.create to the author's own record, on the same day.
    access: ['livestock.update', 'livestock.create'],
    params: idParam,
    body: logs.dailyLogUpdate,
    handler: (req) => logs.updateDailyLog(req.params.id, req.body),
  });

  r.delete('/daily-logs/:id', {
    access: 'livestock.delete',
    summary: 'Delete a record; its feed returns to stock',
    params: idParam,
    handler: (req) => logs.deleteDailyLog(req.params.id),
  });
}
