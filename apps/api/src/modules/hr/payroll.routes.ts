import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './payroll.service';
import { workDone, workDoneQuery } from './workdone.service';

export function registerPayroll(app: FastifyInstance) {
  const r = routes(app, 'hr');

  r.get('/work-done', {
    access: ['hr.view', 'payroll.view'],
    summary: 'Hectares, tonnes and head per person, gathered from the field and livestock journals',
    query: workDoneQuery,
    handler: (req) => workDone(req.query.from, req.query.to, req.query.employeeId),
  });

  r.get('/payroll', {
    access: 'payroll.view',
    summary: 'Payroll runs',
    query: service.runListQuery,
    handler: (req) => service.listRuns(req.query),
  });

  r.post('/payroll', {
    access: 'payroll.create',
    summary: 'Calculate the payroll of a month',
    body: service.runInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.createRun(req.body);
    },
  });

  r.get('/payroll/:id', {
    access: 'payroll.view',
    summary: 'A run with its lines and labour cost split',
    params: idParam,
    handler: (req) => service.getRun(req.params.id),
  });

  r.delete('/payroll/:id', {
    access: 'payroll.delete',
    summary: 'Delete a draft run',
    params: idParam,
    handler: (req) => service.deleteRun(req.params.id),
  });

  r.post('/payroll/:id/recalculate', {
    access: 'payroll.update',
    summary: 'Pick up timesheet and work changes. Hand-edited figures stay.',
    params: idParam,
    handler: (req) => service.recalculate(req.params.id),
  });

  r.patch('/payroll/:id/lines/:lineId', {
    access: 'payroll.update',
    summary: 'Edit a line of a draft run',
    params: service.lineParams,
    body: service.lineInput,
    handler: (req) => service.editLine(req.params.id, req.params.lineId, req.body),
  });

  r.post('/payroll/:id/submit', {
    access: 'payroll.update',
    summary: 'Send a draft for approval',
    params: idParam,
    handler: (req) => service.submitRun(req.params.id),
  });

  r.post('/payroll/:id/return', {
    access: 'payroll.approve',
    summary: 'Send a run back to draft with a reason',
    params: idParam,
    body: service.returnInput,
    handler: (req) => service.returnRun(req.params.id, req.body.reason),
  });

  r.post('/payroll/:id/approve', {
    access: 'payroll.approve',
    summary: 'Approve and post labour cost to cost centers. Needs a second person.',
    params: idParam,
    handler: (req) => service.approveRun(req.params.id),
  });

  r.post('/payroll/:id/pay', {
    access: 'payroll.update',
    summary: 'Pay out the net from a cash or bank account',
    params: idParam,
    body: service.payInput,
    handler: (req) => service.payRun(req.params.id, req.body),
  });

  r.get('/advances', {
    access: 'payroll.view',
    query: service.advanceQuery,
    handler: (req) => service.listAdvances(req.query),
  });

  r.post('/advances', {
    access: 'payroll.create',
    summary: 'Record an advance paid during the month',
    body: service.advanceInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.createAdvance(req.body);
    },
  });

  r.get('/kpi-rules', {
    access: 'payroll.view',
    summary: 'Automatic bonus rules',
    handler: () => service.listKpiRules(),
  });

  r.post('/kpi-rules', {
    access: 'payroll.create',
    body: service.kpiRuleInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.createKpiRule(req.body);
    },
  });

  r.patch('/kpi-rules/:id', {
    access: 'payroll.update',
    params: idParam,
    body: service.kpiRuleInput.partial(),
    handler: (req) => service.updateKpiRule(req.params.id, req.body),
  });

  r.delete('/kpi-rules/:id', {
    access: 'payroll.delete',
    params: idParam,
    handler: (req) => service.deleteKpiRule(req.params.id),
  });
}
