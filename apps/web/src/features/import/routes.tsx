import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

// No single permission fits: each template follows its own module's create permission, and an
// accountant holds finance.create but not settings.view. The page shows what the API allows.
export const routes: RouteObject[] = [{ path: 'import', element: page(() => import('./ImportPage')) }];
