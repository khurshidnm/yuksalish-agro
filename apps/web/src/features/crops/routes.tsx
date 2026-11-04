import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'crops/plans', element: page(() => import('./CropPlansPage'), 'crops.view') },
  { path: 'crops/operations', element: page(() => import('./OperationsPage'), 'crops.view') },
  { path: 'crops/harvests', element: page(() => import('./HarvestsPage'), 'crops.view') },
];
