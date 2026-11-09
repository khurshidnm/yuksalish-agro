import type { FastifyInstance } from 'fastify';
import { FINANCE_CAPITAL } from '@yap/shared';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './advances.service';

/** Cash held by people for the farm, and cash handed to them (docs/cash-holders.md). */
export function registerAdvances(app: FastifyInstance) {
  const r = routes(app, 'finance');

  r.get('/cash-holders', {
    access: 'finance.view',
    summary: 'People holding farm cash, with their cash and this week',
    handler: () => service.listHolders(),
  });

  r.post('/cash-holders', {
    access: 'finance.create',
    summary: "Open a person's cash account",
    body: service.openHolderInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.openHolderAccount(req.body.employeeId, req.body.currency);
    },
  });

  r.get('/cash-holders/:id', {
    access: 'finance.view',
    summary: 'What one person received and spent over a period, this week unless named',
    params: idParam,
    query: service.periodQuery,
    handler: (req) => service.holderSummary(req.params.id, req.query),
  });

  r.post('/cash-holders/:id/close', {
    access: 'finance.update',
    summary: "Close a person's cash account once it is empty",
    params: idParam,
    handler: (req) => service.closeHolderAccount(req.params.id),
  });

  r.post('/cash-holders/:id/return', {
    access: 'finance.create',
    summary: 'Cash given back: to the owner, or into a farm account',
    params: idParam,
    body: service.returnInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.returnCash(req.params.id, req.body);
    },
  });

  r.get('/cash-handovers', {
    access: 'finance.view',
    summary: 'Cash handed over, newest first',
    query: service.handoverListQuery,
    handler: (req) => service.listHandovers(req.query),
  });

  r.post('/cash-handovers', {
    access: ['finance.create', FINANCE_CAPITAL],
    summary: 'Hand cash to a person. Nothing moves until they say it arrived',
    body: service.handoverInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.sendHandover(req.body);
    },
  });

  r.post('/cash-handovers/:id/accept', {
    access: 'finance.create',
    summary: 'The person who received the cash says it arrived',
    params: idParam,
    handler: (req) => service.acceptHandover(req.params.id),
  });

  r.post('/cash-handovers/:id/dispute', {
    access: 'finance.view',
    summary: 'The person says it did not arrive, or not all of it',
    params: idParam,
    body: service.reasonInput,
    handler: (req) => service.disputeHandover(req.params.id, req.body.reason),
  });

  r.post('/cash-handovers/:id/cancel', {
    access: ['finance.create', FINANCE_CAPITAL],
    summary: 'The sender takes it back while it waits',
    params: idParam,
    handler: (req) => service.cancelHandover(req.params.id),
  });

  r.post('/cash-handovers/:id/reverse', {
    access: 'finance.approve',
    summary: 'Take accepted cash off the books, while none of it is spent',
    params: idParam,
    body: service.reasonInput,
    handler: (req) => service.reverseHandover(req.params.id, req.body.reason),
  });

  r.get('/capital', {
    access: 'finance.view',
    summary: "The owner's own money put in so far, and the cash in people's hands",
    handler: () => service.capitalTiles(),
  });
}
