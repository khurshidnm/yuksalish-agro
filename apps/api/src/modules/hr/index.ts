import type { FastifyInstance } from 'fastify';
import { registerEmployees } from './employees.routes';
import { registerPayroll } from './payroll.routes';
import { registerSafety } from './safety.routes';
import { registerTimesheets } from './timesheets.routes';

export default async function hrModule(app: FastifyInstance) {
  registerEmployees(app);
  registerTimesheets(app);
  registerSafety(app);
  registerPayroll(app);
}
