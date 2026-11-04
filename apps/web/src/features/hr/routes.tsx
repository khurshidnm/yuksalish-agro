import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'hr/employees', element: page(() => import('./EmployeesPage'), 'hr.view') },
  { path: 'hr/timesheet', element: page(() => import('./TimesheetPage'), 'hr.view') },
  { path: 'hr/payroll', element: page(() => import('./PayrollPage'), 'payroll.view') },
];
