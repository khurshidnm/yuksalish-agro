import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [{ path: 'livestock/tracking', element: page(() => import('./TrackingPage'), 'livestock.view') }];
