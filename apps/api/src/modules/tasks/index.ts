import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as calendar from './calendar.service';
import * as service from './tasks.service';

export default async function tasksModule(app: FastifyInstance) {
  const r = routes(app, 'tasks');

  // Static paths first, so that "calendar" is not read as a task id.
  r.get('/calendar', {
    access: 'tasks.view',
    summary: 'Everything scheduled on the farm in a date range',
    query: calendar.calendarQuery,
    handler: (req) => calendar.calendar(req.query),
  });

  r.post('/calendar/events', {
    access: 'tasks.create',
    summary: 'Add a meeting, inspection or delivery',
    body: calendar.eventInput,
    handler: async (req, reply) => {
      reply.code(201);
      return calendar.createEvent(req.body);
    },
  });

  r.patch('/calendar/events/:id', {
    access: 'tasks.update',
    params: idParam,
    body: calendar.eventPatch,
    handler: (req) => calendar.updateEvent(req.params.id, req.body),
  });

  r.delete('/calendar/events/:id', {
    access: 'tasks.delete',
    params: idParam,
    handler: (req) => calendar.removeEvent(req.params.id),
  });

  r.get('/', {
    access: 'tasks.view',
    summary: 'Tasks. People who cannot create tasks see only their own.',
    query: service.taskListQuery,
    handler: (req) => service.list(req.query),
  });

  r.post('/', {
    access: 'tasks.create',
    body: service.taskInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.create(req.body);
    },
  });

  r.get('/on-time', {
    access: 'tasks.view',
    summary: 'How many of my tasks due this month I closed on time',
    handler: () => service.myOnTime(),
  });

  r.get('/:id', {
    access: 'tasks.view',
    params: idParam,
    handler: (req) => service.get(req.params.id),
  });

  r.get('/:id/record-candidates', {
    access: 'tasks.view',
    summary: 'Records that could close this task',
    params: idParam,
    handler: (req) => service.recordCandidates(req.params.id),
  });

  r.patch('/:id', {
    access: 'tasks.update',
    params: idParam,
    body: service.taskPatch,
    handler: (req) => service.update(req.params.id, req.body),
  });

  r.post('/:id/start', {
    access: 'tasks.update',
    params: idParam,
    handler: (req) => service.start(req.params.id),
  });

  r.post('/:id/complete', {
    access: 'tasks.update',
    summary: 'Close a task. It may demand a photo or a linked record (spec 17.2).',
    params: idParam,
    body: service.completeInput,
    handler: (req) => service.complete(req.params.id, req.body),
  });

  r.post('/:id/cancel', {
    access: 'tasks.update',
    params: idParam,
    handler: (req) => service.cancel(req.params.id),
  });

  r.post('/:id/reopen', {
    access: 'tasks.update',
    params: idParam,
    handler: (req) => service.reopen(req.params.id),
  });

  r.delete('/:id', {
    access: 'tasks.delete',
    params: idParam,
    handler: (req) => service.remove(req.params.id),
  });
}
