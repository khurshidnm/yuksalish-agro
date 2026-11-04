import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './platform.service';

export default async function platformModule(app: FastifyInstance) {
  const r = routes(app, 'platform');

  r.get('/stats', { access: 'platform', handler: () => service.stats() });

  r.get('/tenants', {
    access: 'platform',
    query: service.tenantListQuery,
    handler: (req) => service.listTenants(req.query),
  });
  r.post('/tenants', {
    access: 'platform',
    summary: 'Create a tenant with its first owner. A new owner\'s password is shown once.',
    body: service.tenantInput,
    handler: async (req, reply) => {
      const result = await service.createTenant(req.body);
      req.log.info({ tenantId: result.tenant.id }, 'tenant created');
      reply.code(201);
      return result;
    },
  });
  r.get('/tenants/:id', {
    access: 'platform',
    params: idParam,
    handler: (req) => service.getTenant(req.params.id),
  });
  r.patch('/tenants/:id', {
    access: 'platform',
    summary: 'Rename, change plan, or switch modules on and off',
    params: idParam,
    body: service.tenantUpdate,
    handler: (req) => service.updateTenant(req.params.id, req.body),
  });
  r.post('/tenants/:id/suspend', {
    access: 'platform',
    params: idParam,
    handler: async (req) => {
      req.log.warn({ tenantId: req.params.id }, 'tenant suspended');
      return service.setTenantStatus(req.params.id, 'suspended');
    },
  });
  r.post('/tenants/:id/reactivate', {
    access: 'platform',
    params: idParam,
    handler: (req) => service.setTenantStatus(req.params.id, 'active'),
  });

  r.get('/plans', { access: 'platform', handler: () => service.listPlans() });
  r.post('/plans', {
    access: 'platform',
    body: service.planInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.createPlan(req.body);
    },
  });
  r.patch('/plans/:id', {
    access: 'platform',
    params: idParam,
    body: service.planInput.partial().extend({ active: z.boolean().optional() }),
    handler: (req) => service.updatePlan(req.params.id, req.body),
  });
  r.delete('/plans/:id', {
    access: 'platform',
    summary: 'Retire a plan',
    params: idParam,
    handler: (req) => service.retirePlan(req.params.id),
  });
}
