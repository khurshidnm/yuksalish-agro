import { Navigate, useLocation, type RouteObject } from 'react-router';
import { routes as ai } from '@/features/ai/routes';
import { routes as alerts } from '@/features/alerts/routes';
import { routes as assets } from '@/features/assets/routes';
import { routes as cameras } from '@/features/cameras/routes';
import { routes as crops } from '@/features/crops/routes';
import { routes as dashboard } from '@/features/dashboard/routes';
import { routes as farm } from '@/features/farm/routes';
import { routes as feed } from '@/features/feed/routes';
import { routes as finance } from '@/features/finance/routes';
import { routes as hr } from '@/features/hr/routes';
import { routes as importRoutes } from '@/features/import/routes';
import { routes as inventory } from '@/features/inventory/routes';
import { routes as livestock } from '@/features/livestock/routes';
import { routes as platform } from '@/features/platform/routes';
import { routes as reports } from '@/features/reports/routes';
import { routes as sales } from '@/features/sales/routes';
import { routes as settings } from '@/features/settings/routes';
import { routes as tasks } from '@/features/tasks/routes';
import { routes as today } from '@/features/today/routes';
import { routes as tracking } from '@/features/tracking/routes';
import { NotFoundPage } from './pages';

/** The pages behind sign-in. */
/** A dashboard tab lives in the query, so a reload or a link keeps it. */
function BackToDashboard() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/', search }} replace />;
}

export const appRoutes: RouteObject[] = [
  ...dashboard,
  ...today,
  ...farm,
  ...crops,
  ...livestock,
  ...tracking,
  ...inventory,
  ...feed,
  ...finance,
  ...hr,
  ...assets,
  ...sales,
  ...tasks,
  ...alerts,
  ...reports,
  ...ai,
  ...cameras,
  ...importRoutes,
  ...settings,
  ...platform,
  // Where the public page sends someone who already has a session.
  { path: 'app', element: <BackToDashboard /> },
  { path: '*', element: <NotFoundPage /> },
];
