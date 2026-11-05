import type { FastifyInstance } from 'fastify';
import { isTest } from '../../config';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './leads.service';

// Enough for a person correcting a typo, too few to fill the table from one address.
const submitLimit = isTest ? {} : { rateLimit: { max: 5, timeWindow: '10 minutes' } };

export default async function leadsModule(app: FastifyInstance) {
  const r = routes(app, 'leads');

  r.post('/', {
    access: 'public',
    summary: 'Contact form on the public website',
    body: service.leadInput,
    config: submitLimit,
    handler: async (req, reply) => {
      const result = await service.submitLead(req.body, req.log);
      reply.code(201);
      return result;
    },
  });

  r.get('/', { access: 'platform', query: service.leadListQuery, handler: (req) => service.listLeads(req.query) });
  r.get('/stats', { access: 'platform', handler: () => service.leadStats() });
  r.patch('/:id', {
    access: 'platform',
    params: idParam,
    body: service.leadUpdate,
    handler: (req) => service.updateLead(req.params.id, req.body),
  });
  r.delete('/:id', {
    access: 'platform',
    params: idParam,
    handler: async (req) => {
      req.log.warn({ leadId: req.params.id, adminId: req.adminId }, 'lead deleted');
      return service.deleteLead(req.params.id);
    },
  });
}
