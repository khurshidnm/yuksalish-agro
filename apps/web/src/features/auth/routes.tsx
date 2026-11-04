import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { PublicOnly, RequireAuth } from '@/app/guards';
import { RouteErrorPage, SplashScreen } from '@/app/pages';

const LoginPage = lazy(() => import('./LoginPage'));
const TwoFactorSetupPage = lazy(() => import('./TwoFactorSetupPage'));

export const routes: RouteObject[] = [
  {
    path: 'login',
    errorElement: <RouteErrorPage />,
    element: (
      <PublicOnly>
        <Suspense fallback={<SplashScreen />}>
          <LoginPage />
        </Suspense>
      </PublicOnly>
    ),
  },
  {
    path: '2fa/setup',
    errorElement: <RouteErrorPage />,
    element: (
      <RequireAuth enrolment>
        <Suspense fallback={<SplashScreen />}>
          <TwoFactorSetupPage />
        </Suspense>
      </RequireAuth>
    ),
  },
];
