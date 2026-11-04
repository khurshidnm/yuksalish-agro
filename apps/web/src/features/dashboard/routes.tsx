import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { index: true, element: page(() => import('./DashboardPage'), 'dashboard.view', { redirectTo: '/today' }) },
];
