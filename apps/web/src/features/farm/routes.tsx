import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'farm', element: page(() => import('./FarmPassportPage'), 'farm.view') },
  { path: 'farm/map', element: page(() => import('./FarmMapPage'), 'farm.view') },
  { path: 'farm/fields', element: page(() => import('./FieldsPage'), 'farm.view') },
  { path: 'farm/fields/:id', element: page(() => import('./FieldCardPage'), 'farm.view') },
  { path: 'farm/water', element: page(() => import('./water/WaterAdvice'), 'farm.view') },
  { path: 'farm/facilities', element: page(() => import('./FacilitiesPage'), 'farm.view') },
  { path: 'farm/documents', element: page(() => import('./DocumentsPage'), 'farm.view') },
];
