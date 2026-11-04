import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './health.service';

/**
 * `health.create` is the shepherd's permission, and it stops at reporting a sick animal.
 * Clinical records take `health.update`, which vets and zootechnicians hold, because they
 * consume drugs and set withdrawal dates.
 */
const CLINICAL = 'health.update' as const;

export function registerHealth(app: FastifyInstance) {
  const r = routes(app, 'livestock');

  r.get('/health/today', {
    access: 'health.view',
    summary: "What needs the vet's attention today",
    handler: () => service.vetToday(),
  });

  r.get('/health/records', {
    access: 'health.view',
    summary: 'Veterinary journal',
    query: service.healthListQuery,
    handler: (req) => service.listRecords(req.query),
  });

  r.post('/health/records', {
    access: CLINICAL,
    summary: 'Add a record for one animal or a whole herd; the drug leaves stock',
    body: service.healthRecordInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.createRecord(req.body);
    },
  });

  r.get('/health/records/:id', {
    access: 'health.view',
    params: idParam,
    handler: (req) => service.getRecord(req.params.id),
  });

  r.patch('/health/records/:id', {
    access: CLINICAL,
    summary: 'Correct a record; stock is reversed and issued again',
    params: idParam,
    body: service.healthRecordUpdate,
    handler: (req) => service.updateRecord(req.params.id, req.body),
  });

  r.delete('/health/records/:id', {
    access: 'health.delete',
    summary: 'Delete a record and return its drug to stock',
    params: idParam,
    handler: (req) => service.deleteRecord(req.params.id),
  });

  r.post('/health/report-sick', {
    access: 'health.create',
    summary: 'Report a sick animal: urgent alert to the vet',
    body: service.reportSickInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.reportSick(req.body);
    },
  });

  r.get('/health/sick-reports', {
    access: 'health.view',
    query: service.sickReportQuery,
    handler: (req) => service.listSickReports(req.query),
  });

  r.post('/health/sick-reports/:id/resolve', {
    access: CLINICAL,
    summary: 'The animal has recovered',
    params: idParam,
    body: service.resolveSickInput,
    handler: (req) => service.resolveSickReport(req.params.id, req.body),
  });

  r.post('/health/animals/:id/recover', {
    access: CLINICAL,
    summary: 'Mark an animal as recovered and close its open reports',
    params: idParam,
    body: service.resolveSickInput,
    handler: (req) => service.recoverAnimal(req.params.id, req.body),
  });

  r.get('/health/quarantine', {
    access: 'health.view',
    query: service.quarantineQuery,
    handler: (req) => service.listQuarantine(req.query),
  });

  r.post('/health/quarantine', {
    access: CLINICAL,
    summary: 'Put animals into quarantine',
    body: service.quarantineInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.startQuarantine(req.body);
    },
  });

  r.post('/health/quarantine/:id/end', {
    access: CLINICAL,
    params: idParam,
    body: service.quarantineEndInput,
    handler: (req) => service.endQuarantine(req.params.id, req.body),
  });

  r.get('/health/withdrawal', {
    access: 'health.view',
    summary: 'Animals still under a withdrawal period',
    query: service.withdrawalQuery,
    handler: (req) => service.listWithdrawal(req.query),
  });

  r.get('/health/withdrawal/check', {
    access: ['health.view', 'livestock.view', 'sales.view'],
    summary: 'Which of these animals may not be sold yet',
    query: z.object({ animalIds: z.string().transform((v) => v.split(',')).pipe(z.array(z.uuid()).max(500)) }),
    handler: (req) => service.animalsUnderWithdrawal(req.query.animalIds),
  });

  r.get('/health/vaccination-plans', {
    access: 'health.view',
    handler: () => service.listPlans(),
  });

  r.post('/health/vaccination-plans', {
    access: CLINICAL,
    body: service.vaccinationPlanInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.createPlan(req.body);
    },
  });

  r.patch('/health/vaccination-plans/:id', {
    access: CLINICAL,
    params: idParam,
    body: service.vaccinationPlanInput.partial(),
    handler: (req) => service.updatePlan(req.params.id, req.body),
  });

  r.delete('/health/vaccination-plans/:id', {
    access: 'health.delete',
    params: idParam,
    handler: (req) => service.removePlan(req.params.id),
  });

  r.get('/health/vaccinations/due', {
    access: 'health.view',
    summary: 'Vaccination calendar, grouped by plan, herd and date',
    query: service.vaccinationDueQuery,
    handler: (req) => service.vaccinationDue(req.query),
  });

  r.get('/health/vaccinations/due/:id/animals', {
    access: 'health.view',
    summary: 'The animals due for one plan',
    params: idParam,
    query: service.vaccinationDueQuery,
    handler: (req) => service.vaccinationDueAnimals(req.params.id, req.query),
  });

  r.post('/health/vaccinations/herd', {
    access: CLINICAL,
    summary: 'Vaccinate a whole herd',
    body: service.herdVaccinationInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.vaccinateHerd(req.body);
    },
  });

  r.get('/health/documents', {
    access: 'health.view',
    summary: 'Veterinary certificates',
    query: service.vetDocumentQuery,
    handler: (req) => service.listDocuments(req.query),
  });

  r.post('/health/documents', {
    access: CLINICAL,
    body: service.vetDocumentInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.createDocument(req.body);
    },
  });

  r.delete('/health/documents/:id', {
    access: 'health.delete',
    params: idParam,
    handler: (req) => service.removeDocument(req.params.id),
  });
}
