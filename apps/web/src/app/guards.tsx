import type { Permission } from '@yap/shared';
import { type ComponentType, type ReactNode, Suspense, lazy } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth, useCan, useModuleEnabled, useSession } from '@/lib/auth';
import { ForbiddenPage, ModuleOffPage, NoAccessScreen, PageSkeleton, SplashScreen } from './pages';

/** Lets signed-in users through; everyone else goes to /login and returns here afterwards. */
export function RequireAuth({ children, enrolment }: { children: ReactNode; enrolment?: boolean }) {
  const { status, session } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <SplashScreen />;
  if (status === 'anonymous' || !session) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (session.mustEnroll2fa && !enrolment) return <Navigate to="/2fa/setup" replace />;
  if (!session.tenant && !enrolment) {
    if (!session.user.isPlatformAdmin) return <NoAccessScreen />;
    if (location.pathname !== '/platform') return <Navigate to="/platform" replace />;
  }
  return children;
}

/** Keeps signed-in users away from the login screen. */
export function PublicOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <SplashScreen />;
  if (status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }
  return children;
}

interface RouteGuardProps {
  permission?: Permission;
  redirectTo?: string;
  platformOnly?: boolean;
  children: ReactNode;
}

function RouteGuard({ permission, redirectTo, platformOnly, children }: RouteGuardProps) {
  const session = useSession();
  const can = useCan();
  const moduleEnabled = useModuleEnabled();

  if (platformOnly ? !session.user.isPlatformAdmin : permission && !can(permission)) {
    return redirectTo ? <Navigate to={redirectTo} replace /> : <ForbiddenPage />;
  }
  const module = permission?.split('.')[0];
  if (module && !moduleEnabled(module)) return <ModuleOffPage />;
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}

export interface PageOptions {
  /** Go here instead of showing the 403 page when the permission is missing. */
  redirectTo?: string;
  platformOnly?: boolean;
}

/**
 * Route element for a lazily loaded page, behind a permission:
 * `{ path: 'finance/costs', element: page(() => import('./CostsPage'), 'finance.view') }`
 * The permission here only decides what the UI shows. The API enforces it for real.
 */
export function page(load: () => Promise<{ default: ComponentType }>, permission?: Permission, options: PageOptions = {}) {
  const Page = lazy(load);
  return (
    <RouteGuard permission={permission} redirectTo={options.redirectTo} platformOnly={options.platformOnly}>
      <Page />
    </RouteGuard>
  );
}
