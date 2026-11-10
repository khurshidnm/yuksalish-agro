import { Suspense } from 'react';
import { type RouteObject, createBrowserRouter } from 'react-router';
import { routes as authRoutes } from '@/features/auth/routes';
import { AppShell } from './AppShell';
import { RequireAuth } from './guards';
import { lazyPage } from './lazyPage';
import { PageSkeleton, RouteErrorPage } from './pages';
import { appRoutes } from './routes';

const LandingRoute = lazyPage(() => import('@/features/landing/LandingRoute'));
// A farm's public page of animals for sale: open to anyone, outside the signed-in shell.
const CataloguePage = lazyPage(() => import('@/features/catalogue/CataloguePage'));

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
    path: 'catalogue/:slug',
    errorElement: <RouteErrorPage />,
    element: (
      <Suspense fallback={<PageSkeleton />}>
        <CataloguePage />
      </Suspense>
    ),
  },
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
