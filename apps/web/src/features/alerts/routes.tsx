import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'alerts', element: page(() => import('./AlertsPage'), 'dashboard.view') },
  { path: 'notifications', element: page(() => import('./NotificationsPage')) },
];
