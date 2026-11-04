import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'assets', element: page(() => import('./AssetsPage'), 'assets.view') },
  { path: 'assets/:id', element: page(() => import('./AssetCardPage'), 'assets.view') },
];
