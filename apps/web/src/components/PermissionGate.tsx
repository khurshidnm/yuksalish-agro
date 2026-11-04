import type { Permission } from '@yap/shared';
import type { ReactNode } from 'react';
import { useCan } from '@/lib/auth';

export interface PermissionGateProps {
  /** All of these are required. */
  permission?: Permission | Permission[];
  /** At least one of these is required. */
  anyOf?: Permission[];
  fallback?: ReactNode;
  children: ReactNode;
}

/** Hides UI the user may not use. The server still enforces every permission. */
export function PermissionGate({ permission, anyOf, fallback = null, children }: PermissionGateProps) {
  const can = useCan();
  const all = permission === undefined ? [] : Array.isArray(permission) ? permission : [permission];
  const allowed = all.every(can) && (!anyOf || anyOf.some(can));
  return <>{allowed ? children : fallback}</>;
}
