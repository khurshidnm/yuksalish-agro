import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { PublicOnly, RequireAuth } from '@/app/guards';
import { lazyPage } from '@/app/lazyPage';
import { RouteErrorPage, SplashScreen } from '@/app/pages';

const LoginPage = lazyPage(() => import('./LoginPage'));
const TwoFactorSetupPage = lazyPage(() => import('./TwoFactorSetupPage'));
const ChangePasswordPage = lazyPage(() => import('./ChangePasswordPage'));

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
    path: 'password/change',
    errorElement: <RouteErrorPage />,
    element: (
      <RequireAuth passwordChange>
        <Suspense fallback={<SplashScreen />}>
          <ChangePasswordPage />
        </Suspense>
      </RequireAuth>
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
