import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'feed/rations', element: page(() => import('./RationsPage'), 'feed.view') },
  { path: 'feed/balance', element: page(() => import('./FeedBalancePage'), 'feed.view') },
  { path: 'feed/winter-plan', element: page(() => import('./WinterPlanPage'), 'feed.view') },
];
