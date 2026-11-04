import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'ai', element: page(() => import('./AiPage'), 'ai.view') },
];
