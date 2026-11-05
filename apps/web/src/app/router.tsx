import { Suspense } from 'react';
import { type RouteObject, createBrowserRouter } from 'react-router';
import { routes as authRoutes } from '@/features/auth/routes';
import { AppShell } from './AppShell';
import { RequireAuth } from './guards';
import { lazyPage } from './lazyPage';
import { PageSkeleton, RouteErrorPage } from './pages';
import { appRoutes } from './routes';

const LandingRoute = lazyPage(() => import('@/features/landing/LandingRoute'));

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
