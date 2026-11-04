import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'livestock/animals', element: page(() => import('./AnimalsPage'), 'livestock.view') },
  { path: 'livestock/animals/:id', element: page(() => import('./AnimalCardPage'), 'livestock.view') },
  { path: 'livestock/herds', element: page(() => import('./HerdsPage'), 'livestock.view') },
  { path: 'livestock/herds/:id', element: page(() => import('./HerdCardPage'), 'livestock.view') },
  { path: 'livestock/breeding', element: page(() => import('./BreedingPage'), 'livestock.view') },
  { path: 'livestock/health', element: page(() => import('./HealthPage'), 'health.view') },
  { path: 'livestock/daily-logs', element: page(() => import('./DailyLogsPage'), 'livestock.view') },
  { path: 'livestock/exits', element: page(() => import('./ExitsPage'), 'livestock.view') },
];
