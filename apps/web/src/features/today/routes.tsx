import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'today', element: page(() => import('./TodayPage')) },
  { path: 'today/sync', element: page(() => import('./SyncPage')) },
  { path: 'today/daily-log/:herdId', element: page(() => import('./DailyLogPage'), 'livestock.create') },
  { path: 'today/report-sick', element: page(() => import('./ReportSickPage'), 'health.create') },
  { path: 'today/death', element: page(() => import('./DeathPage'), 'livestock.create') },
  { path: 'today/weight', element: page(() => import('./WeightPage'), 'livestock.update') },
  { path: 'today/lambing', element: page(() => import('./LambingPage'), 'livestock.create') },
  { path: 'today/night-watch', element: page(() => import('./NightWatchPage'), 'livestock.create') },
];
