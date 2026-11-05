import { Suspense, lazy } from 'react';
import { Navigate, type RouteObject, createBrowserRouter } from 'react-router';
import { routes as ai } from '@/features/ai/routes';
import { routes as alerts } from '@/features/alerts/routes';
import { routes as assets } from '@/features/assets/routes';
import { routes as authRoutes } from '@/features/auth/routes';
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
import { AppShell } from './AppShell';
import { RequireAuth } from './guards';
import { NotFoundPage, PageSkeleton, RouteErrorPage } from './pages';

const LandingRoute = lazy(() => import('@/features/landing/LandingRoute'));

const appRoutes: RouteObject[] = [
  ...dashboard,
  ...today,
  ...farm,
  ...crops,
  ...livestock,
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
  { path: 'app', element: <Navigate to="/" replace /> },
  { path: '*', element: <NotFoundPage /> },
];

const landingRoutes: RouteObject[] = (
  [
    ['ru', 'ru'],
    ['en', 'en'],
    ['uz-cyrl', 'uz-Cyrl'],
  ] as const
).map(([path, language]) => ({
  path,
  element: (
    <Suspense fallback={<PageSkeleton />}>
      <LandingRoute language={language} />
    </Suspense>
  ),
}));

export const router = createBrowserRouter([
  ...landingRoutes,
  ...authRoutes,
  {
    errorElement: <RouteErrorPage />,
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: appRoutes,
  },
]);
