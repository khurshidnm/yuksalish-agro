import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'sales', element: page(() => import('./SalesPage'), 'sales.view') },
  // The storekeeper and zootechnician raise purchase requests without sales.view (spec 13.3).
  { path: 'sales/purchases', element: page(() => import('./PurchasesPage'), 'inventory.view') },
  { path: 'sales/reservations', element: page(() => import('./ReservationsPage'), 'sales.view') },
];
