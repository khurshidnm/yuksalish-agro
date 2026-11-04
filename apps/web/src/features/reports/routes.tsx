import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'reports', element: page(() => import('./ReportsPage'), 'reports.view') },
  { path: 'reports/:key', element: page(() => import('./ReportViewPage'), 'reports.view') },
];
