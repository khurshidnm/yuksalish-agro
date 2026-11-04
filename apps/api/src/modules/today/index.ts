import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import * as service from './today.service';

export default async function todayModule(app: FastifyInstance) {
  const r = routes(app, 'today');

  r.get('/', {
    access: 'authenticated',
    summary: "The signed-in user's day: tasks, attendance, quick actions, and data for offline forms",
    handler: () => service.overview(),
  });

  r.get('/animals', {
    access: 'livestock.view',
    summary: 'Every animal on the farm, for finding one by tag with no connection',
    handler: () => service.animalDirectory(),
  });

  r.post('/conflicts', {
    access: 'livestock.create',
    summary: 'Hand an offline record that clashes with a saved one to someone who can decide',
    body: service.conflictReportInput,
    handler: (req) => service.reportConflict(req.body),
  });
}
