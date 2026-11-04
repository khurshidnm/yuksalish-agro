import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import * as service from './timesheets.service';

export function registerTimesheets(app: FastifyInstance) {
  const r = routes(app, 'hr');

  r.get('/timesheets', {
    access: ['hr.view', 'payroll.view'],
    summary: 'Month grid for everyone employed in the month',
    query: service.gridQuery,
    handler: (req) => service.monthGrid(req.query.month, req.query.search),
  });

  r.put('/timesheets/:employeeId/:date', {
    access: ['hr.update', 'payroll.update'],
    summary: 'Set one day',
    params: service.dayParams,
    body: service.dayInput,
    handler: (req) => service.setDay(req.params.employeeId, req.params.date, req.body),
  });

  r.delete('/timesheets/:employeeId/:date', {
    access: ['hr.update', 'payroll.update'],
    params: service.dayParams,
    handler: (req) => service.clearDay(req.params.employeeId, req.params.date),
  });

  r.post('/timesheets/bulk', {
    access: ['hr.update', 'payroll.update'],
    summary: 'Fill a date range for several people',
    body: service.bulkInput,
    handler: (req) => service.bulkFill(req.body),
  });

  // Self-service for field staff: resolved from the signed-in user, so it needs no HR permission.
  r.get('/me/today', {
    access: 'authenticated',
    summary: 'The signed-in employee and their timesheet row for today',
    handler: () => service.myDay(),
  });

  r.post('/me/check-in', {
    access: 'authenticated',
    summary: 'Check in, with browser GPS when available',
    body: service.locationInput,
    handler: (req) => service.checkIn(req.body),
  });

  r.post('/me/check-out', {
    access: 'authenticated',
    body: service.locationInput,
    handler: (req) => service.checkOut(req.body),
  });
}
