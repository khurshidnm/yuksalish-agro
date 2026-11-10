import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'inventory/stock', element: page(() => import('./StockPage'), 'inventory.view') },
  { path: 'inventory/items', element: page(() => import('./ItemsPage'), 'inventory.view') },
  { path: 'inventory/items/labels', element: page(() => import('./ItemLabelsPage'), 'inventory.view') },
  { path: 'inventory/warehouses', element: page(() => import('./WarehousesPage'), 'inventory.view') },
  { path: 'inventory/movements', element: page(() => import('./MovementsPage'), 'inventory.view') },
  { path: 'inventory/counts', element: page(() => import('./CountsPage'), 'inventory.view') },
];
