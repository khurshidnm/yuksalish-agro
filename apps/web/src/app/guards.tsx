import type { Permission } from '@yap/shared';
import { type ComponentType, type ReactNode, Suspense, isValidElement } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth, useCan, useModuleEnabled, useSession } from '@/lib/auth';
import { lazyPage } from './lazyPage';
import { ForbiddenPage, ModuleOffPage, NoAccessScreen, PageSkeleton, SplashScreen } from './pages';

const LandingRoute = lazyPage(() => import('@/features/landing/LandingRoute'));

/** Lets signed-in users through; everyone else goes to /login and returns here afterwards. */
export function RequireAuth({ children, enrolment, passwordChange }: { children: ReactNode; enrolment?: boolean; passwordChange?: boolean }) {
  const { status, session } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <SplashScreen />;
  if (status === 'anonymous' || !session) {
    // In production nginx answers "/" with the prerendered page, so this is development and sign-out.
    if (location.pathname === '/') {
      return (
        <Suspense fallback={<SplashScreen />}>
          <LandingRoute />
        </Suspense>
      );
    }
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  // In this order: a new owner chooses a password first, then connects an authenticator.
  if (passwordChange) return children;
  if (session.mustChangePassword) return <Navigate to="/password/change" replace />;
  if (session.mustEnroll2fa && !enrolment) return <Navigate to="/2fa/setup" replace />;
  if (!session.tenant && !enrolment) {
    if (!session.user.isPlatformAdmin) return <NoAccessScreen />;
    if (!/^\/platform(\/|$)/.test(location.pathname)) return <Navigate to="/platform" replace />;
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

export interface RouteAccess {
  can: (permission: Permission | string) => boolean;
  moduleEnabled: (module: string) => boolean;
  isPlatformAdmin: boolean;
}

export function useRouteAccess(): RouteAccess {
  const session = useSession();
  return { can: useCan(), moduleEnabled: useModuleEnabled(), isPlatformAdmin: Boolean(session.user.isPlatformAdmin) };
}

function refusal({ permission, platformOnly }: Pick<RouteGuardProps, 'permission' | 'platformOnly'>, access: RouteAccess) {
  if (platformOnly ? !access.isPlatformAdmin : permission && !access.can(permission)) return 'forbidden';
  const module = permission?.split('.')[0];
  return module && !access.moduleEnabled(module) ? 'moduleOff' : null;
}

function RouteGuard({ permission, redirectTo, platformOnly, children }: RouteGuardProps) {
  const refused = refusal({ permission, platformOnly }, useRouteAccess());
  if (refused === 'forbidden') return redirectTo ? <Navigate to={redirectTo} replace /> : <ForbiddenPage />;
  if (refused === 'moduleOff') return <ModuleOffPage />;
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}

/** Asks the route's own guard, so a link and the page it leads to cannot disagree. */
export function routeOpens(element: ReactNode, access: RouteAccess): boolean {
  return !isValidElement<RouteGuardProps>(element) || element.type !== RouteGuard || refusal(element.props, access) === null;
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
  const Page = lazyPage(load);
  return (
    <RouteGuard permission={permission} redirectTo={options.redirectTo} platformOnly={options.platformOnly}>
      <Page />
    </RouteGuard>
  );
}
