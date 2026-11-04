import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './employees.service';
import { reminders } from './safety.service';

export function registerEmployees(app: FastifyInstance) {
  const r = routes(app, 'hr');

  r.get('/employees', {
    access: 'hr.view',
    summary: 'List employees',
    query: service.employeeListQuery,
    handler: (req) => service.list(req.query),
  });

  r.get('/employees/lookup', {
    access: 'authenticated',
    summary: 'Id, name and position, for dropdowns in other modules',
    query: z.object({ search: z.string().trim().optional() }),
    handler: (req) => service.lookup(req.query.search),
  });

  r.get('/divisions', {
    access: 'hr.view',
    summary: 'Farm divisions',
    handler: () => service.listDivisions(),
  });

  r.get('/linkable-users', {
    access: 'hr.update',
    summary: 'Farm logins, for linking an employee to an account',
    handler: () => service.linkableUsers(),
  });

  r.get('/reminders', {
    access: 'hr.view',
    summary: 'Contracts, medical checks, leave and safety briefings coming due',
    query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
    handler: (req) => reminders(req.query.days),
  });

  r.get('/employees/:id', {
    access: 'hr.view',
    params: idParam,
    handler: (req) => service.get(req.params.id),
  });

  r.post('/employees', {
    access: 'hr.create',
    body: service.employeeInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.createEmployee(req.body);
    },
  });

  r.patch('/employees/:id', {
    access: 'hr.update',
    params: idParam,
    body: service.employeePatch,
    handler: (req) => service.updateEmployee(req.params.id, req.body),
  });

  r.delete('/employees/:id', {
    access: 'hr.delete',
    summary: 'Delete an employee with no records. Otherwise terminate them.',
    params: idParam,
    handler: (req) => service.deleteEmployee(req.params.id),
  });

  r.post('/employees/:id/terminate', {
    access: 'hr.update',
    summary: 'Record that a person left: blocks their login, keeps their records',
    params: idParam,
    body: service.terminateInput,
    handler: (req) => service.terminate(req.params.id, req.body),
  });

  r.post('/employees/:id/reinstate', {
    access: 'hr.update',
    params: idParam,
    handler: (req) => service.reinstate(req.params.id),
  });
}
