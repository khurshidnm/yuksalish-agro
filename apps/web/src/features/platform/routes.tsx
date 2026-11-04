import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'platform', element: page(() => import('./PlatformPage'), undefined, { platformOnly: true }) },
];
