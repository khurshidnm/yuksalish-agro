import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam, isoDate } from '../../core/query';
import * as analysis from './analysis.service';
import * as contracts from './contracts.service';
import * as grants from './grants.service';
import * as prices from './prices.service';
import { settlement } from './settlement.service';
import * as reports from './state-reports.service';

/** Price list, analysis, contracts, grants, state reports and settlement. */
export function registerRegistry(app: FastifyInstance) {
  const r = routes(app, 'sales');

  r.get('/prices', {
    access: 'sales.view',
    summary: 'Price history',
    query: prices.priceListQuery,
    handler: (req) => prices.list(req.query),
  });
  r.get('/prices/current', {
    access: 'sales.view',
    summary: 'Current price of each item, with the previous price and the change',
    handler: () => prices.current(),
  });
  r.post('/prices', {
    access: 'sales.create',
    body: prices.priceInput,
    handler: async (req, reply) => {
      reply.code(201);
      return prices.create(req.body);
    },
  });
  r.patch('/prices/:id', {
    access: 'sales.update',
    params: idParam,
    body: prices.pricePatch,
    handler: (req) => prices.update(req.params.id, req.body),
  });
  r.delete('/prices/:id', {
    access: ['sales.delete', 'sales.update'],
    params: idParam,
    handler: (req) => prices.remove(req.params.id),
  });

  r.get('/analysis', {
    access: 'sales.view',
    summary: 'Sales by product, buyer and month, compared with cost',
    query: analysis.analysisQuery,
    handler: (req) => analysis.salesAnalysis(req.query),
  });

  r.get('/contracts', {
    access: ['sales.view', 'finance.view'],
    summary: 'Contracts. expiringWithin=30 lists those ending soon.',
    query: contracts.contractListQuery,
    handler: (req) => contracts.list(req.query),
  });
  r.get('/contracts/:id', {
    access: ['sales.view', 'finance.view'],
    params: idParam,
    handler: (req) => contracts.get(req.params.id),
  });
  r.post('/contracts', {
    access: ['sales.create', 'finance.create'],
    body: contracts.contractInput,
    handler: async (req, reply) => {
      reply.code(201);
      return contracts.create(req.body);
    },
  });
  r.patch('/contracts/:id', {
    access: ['sales.update', 'finance.update'],
    params: idParam,
    body: contracts.contractPatch,
    handler: (req) => contracts.update(req.params.id, req.body),
  });
  r.delete('/contracts/:id', {
    access: ['sales.delete', 'finance.delete'],
    params: idParam,
    handler: (req) => contracts.remove(req.params.id),
  });

  r.get('/grants', {
    access: ['sales.view', 'finance.view'],
    summary: 'Subsidy, grant and preferential credit applications',
    query: grants.grantListQuery,
    handler: (req) => grants.list(req.query),
  });
  r.get('/grants/:id', {
    access: ['sales.view', 'finance.view'],
    params: idParam,
    handler: (req) => grants.get(req.params.id),
  });
  r.post('/grants', {
    access: ['sales.create', 'finance.create'],
    body: grants.grantInput,
    handler: async (req, reply) => {
      reply.code(201);
      return grants.create(req.body);
    },
  });
  r.patch('/grants/:id', {
    access: ['sales.update', 'finance.update'],
    params: idParam,
    body: grants.grantPatch,
    handler: (req) => grants.update(req.params.id, req.body),
  });
  r.delete('/grants/:id', {
    access: ['sales.delete', 'finance.delete'],
    params: idParam,
    handler: (req) => grants.remove(req.params.id),
  });

  r.get('/state-reports', {
    access: ['sales.view', 'finance.view'],
    summary: 'Calendar of reports due to state bodies',
    query: reports.stateReportListQuery,
    handler: (req) => reports.list(req.query),
  });
  r.post('/state-reports', {
    access: ['sales.create', 'finance.create'],
    body: reports.stateReportInput,
    handler: async (req, reply) => {
      reply.code(201);
      return reports.create(req.body);
    },
  });
  r.patch('/state-reports/:id', {
    access: ['sales.update', 'finance.update'],
    params: idParam,
    body: reports.stateReportPatch,
    handler: (req) => reports.update(req.params.id, req.body),
  });
  r.delete('/state-reports/:id', {
    access: ['sales.delete', 'finance.delete'],
    params: idParam,
    handler: (req) => reports.remove(req.params.id),
  });
  r.post('/state-reports/:id/submit', {
    access: ['sales.update', 'finance.update'],
    summary: 'Mark submitted. A repeating report schedules its next due date.',
    params: idParam,
    body: z.object({ fileId: z.uuid().nullish(), submittedOn: isoDate.nullish() }),
    handler: (req) => reports.submit(req.params.id, req.body),
  });

  r.get('/counterparties/:id/settlement', {
    access: ['sales.view', 'finance.view'],
    summary: 'All documents and payments with a counterparty, and the balance',
    params: idParam,
    handler: (req) => settlement(req.params.id),
  });
}
