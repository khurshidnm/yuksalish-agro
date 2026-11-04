import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'cameras', element: page(() => import('./CamerasPage'), 'cameras.view') },
];
