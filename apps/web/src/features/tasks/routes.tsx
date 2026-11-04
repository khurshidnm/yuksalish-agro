import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'tasks', element: page(() => import('./TasksPage'), 'tasks.view') },
  { path: 'calendar', element: page(() => import('./CalendarPage'), 'tasks.view') },
];
