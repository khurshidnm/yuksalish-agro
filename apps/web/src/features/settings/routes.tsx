import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'settings', element: page(() => import('./SettingsPage'), 'settings.view') },
  { path: 'settings/users', element: page(() => import('./UsersPage'), 'users.view') },
  { path: 'settings/api-keys', element: page(() => import('./ApiKeysPage'), 'settings.update') },
  { path: 'settings/audit', element: page(() => import('./AuditPage'), 'audit.view') },
];
