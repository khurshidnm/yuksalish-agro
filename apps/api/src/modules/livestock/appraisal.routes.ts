import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as appraisal from './appraisal.service';
import * as marks from './cull-marks.service';
import * as culling from './culling.service';
import * as scores from './ewe-score.service';

// The same lists as the lambing desk: whoever may record a lambing may record what a hand finds on
// the animal; grading and the decision to cull are for those who may change an animal's record.
const WRITE = ['livestock.create', 'health.update'] as const;
const CHANGE = ['livestock.update', 'health.update'] as const;
const REMOVE = ['livestock.delete', 'health.delete'] as const;

export function registerAppraisal(app: FastifyInstance) {
  const r = routes(app, 'livestock');

  r.get('/animals/:id/appraisal', {
    access: 'livestock.view',
    summary: 'Body condition, fat-tail measurements, gradings and an open cull mark of one animal',
    params: idParam,
    handler: (req) => appraisal.animalAppraisal(req.params.id),
  });

  // ─── Body condition score ─────────────────────────────────────────────────

  r.get('/condition-scores/herd', {
    access: 'livestock.view',
    summary: 'Animals of a herd with their latest body condition score, and the herd average',
    query: appraisal.herdConditionQuery,
    handler: (req) => appraisal.herdConditionList(req.query),
  });

  r.post('/condition-scores', {
    access: [...WRITE],
    summary: 'Record a body condition score, 1 to 5 in half steps; the same day again corrects it',
    body: appraisal.conditionInput,
    handler: async (req, reply) => {
      reply.code(201);
      return appraisal.recordCondition(req.body);
    },
  });

  r.post('/condition-scores/bulk', {
    access: [...WRITE],
    summary: 'A scoring day: one body condition score per animal, by tag or id',
    body: appraisal.bulkConditionInput,
    handler: async (req, reply) => {
      reply.code(201);
      return appraisal.bulkCondition(req.body);
    },
  });

  r.delete('/condition-scores/:id', {
    access: [...REMOVE],
    params: idParam,
    handler: (req) => appraisal.deleteCondition(req.params.id),
  });

  // ─── Fat tail ─────────────────────────────────────────────────────────────

  r.post('/fat-tail', {
    access: [...WRITE],
    summary: 'Record fat-tail measurements: width, length, circumference, at least one',
    body: appraisal.fatTailInput,
    handler: async (req, reply) => {
      reply.code(201);
      return appraisal.recordFatTail(req.body);
    },
  });

  r.delete('/fat-tail/:id', {
    access: [...REMOVE],
    params: idParam,
    handler: (req) => appraisal.deleteFatTail(req.params.id),
  });

  // ─── Grading ──────────────────────────────────────────────────────────────

  r.get('/gradings/classes', {
    access: 'livestock.view',
    summary: 'The grading classes this farm uses, best first',
    handler: () => ({ classes: appraisal.gradingClasses() }),
  });

  r.post('/gradings', {
    access: [...CHANGE],
    summary: 'Record a grading: the class given to an animal on inspection',
    body: appraisal.gradingInput,
    handler: async (req, reply) => {
      reply.code(201);
      return appraisal.recordGrading(req.body);
    },
  });

  r.delete('/gradings/:id', {
    access: [...REMOVE],
    params: idParam,
    handler: (req) => appraisal.deleteGrading(req.params.id),
  });

  // ─── Ewe score ────────────────────────────────────────────────────────────

  r.get('/ewes/scores', {
    access: 'livestock.view',
    summary: 'Ewes with their score and its breakdown; sort by score, tag, condition, age or lambings',
    query: scores.eweScoreQuery,
    handler: (req) => scores.listEweScores(req.query),
  });

  r.get('/ewes/:id/score', {
    access: 'livestock.view',
    summary: 'One ewe\'s score with its breakdown; null for an animal that is not a ewe of the flock',
    params: idParam,
    handler: (req) => scores.eweScoreOf(req.params.id),
  });

  // ─── Culling ──────────────────────────────────────────────────────────────

  r.get('/culling', {
    access: 'livestock.view',
    summary: 'Culling list: ewes the records speak against, with reasons, and animals marked by a person',
    query: culling.cullingQuery,
    handler: (req) => culling.cullingList(req.query),
  });

  r.post('/culling/marks', {
    access: [...CHANGE],
    summary: 'Mark an animal for culling; one open mark per animal',
    body: marks.cullMarkInput,
    handler: async (req, reply) => {
      reply.code(201);
      return marks.markForCulling(req.body);
    },
  });

  r.post('/culling/marks/:id/clear', {
    access: [...CHANGE],
    summary: 'Take a cull mark off; it stays as history',
    params: idParam,
    body: marks.cullClearInput,
    handler: (req) => marks.clearCullMark(req.params.id, req.body),
  });
}
