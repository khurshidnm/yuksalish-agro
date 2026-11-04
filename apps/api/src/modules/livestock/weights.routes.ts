import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import { findByCode } from './animals.service';
import * as weights from './weights.service';

export function registerWeights(app: FastifyInstance) {
  const r = routes(app, 'livestock');

  r.post('/weights', {
    access: 'livestock.update',
    summary: 'Record a weight',
    body: weights.weightInput,
    handler: async (req, reply) => {
      reply.code(201);
      return weights.createWeight(req.body);
    },
  });

  r.delete('/weights/:id', {
    access: 'livestock.update',
    params: idParam,
    handler: (req) => weights.deleteWeight(req.params.id),
  });

  r.get('/weighing-campaigns', {
    access: 'livestock.view',
    query: weights.campaignListQuery,
    handler: (req) => weights.listCampaigns(req.query),
  });

  r.post('/weighing-campaigns', {
    access: 'livestock.update',
    summary: 'Start weighing a herd',
    body: weights.campaignInput,
    handler: async (req, reply) => {
      reply.code(201);
      return weights.createCampaign(req.body);
    },
  });

  r.get('/weighing-campaigns/:id', {
    access: 'livestock.view',
    params: idParam,
    handler: (req) => weights.getCampaign(req.params.id),
  });

  r.post('/weighing-campaigns/:id/entries', {
    access: 'livestock.update',
    summary: 'One animal: scan or type the code, enter kg. Re-entering corrects the weight.',
    params: idParam,
    body: weights.entryInput,
    handler: (req) => weights.addEntry(req.params.id, req.body, findByCode),
  });

  r.post('/weighing-campaigns/:id/entries/bulk', {
    access: 'livestock.update',
    summary: 'Many entries, e.g. a file from an electronic scale. Bad rows are reported.',
    params: idParam,
    body: weights.bulkEntryInput,
    handler: (req) => weights.addEntries(req.params.id, req.body.entries, findByCode),
  });

  r.post('/weighing-campaigns/:id/close', {
    access: 'livestock.update',
    params: idParam,
    handler: (req) => weights.closeCampaign(req.params.id),
  });
}
