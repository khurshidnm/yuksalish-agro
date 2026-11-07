import { matchRoutes } from 'react-router';
import { type RouteAccess, routeOpens, useRouteAccess } from './guards';
import { appRoutes } from './routes';

/** False for a link that would end on a no-access, switched-off or not-found page. */
export function linkOpens(link: string, access: RouteAccess): boolean {
  const route = matchRoutes(appRoutes, link)?.at(-1)?.route;
  return route !== undefined && route.path !== '*' && routeOpens(route.element, access);
}

/** The link for those who can follow it, null for those who cannot. */
export function useOpenableLink(): (link: string | null | undefined) => string | null {
  const access = useRouteAccess();
  return (link) => (link && linkOpens(link, access) ? link : null);
}
