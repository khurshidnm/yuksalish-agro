import type { RoleKey } from '@yap/shared';

export interface SeedContext {
  tenantId: string;
  farmId: string;
  /** Login user id per role. */
  users: Record<RoleKey, string>;
  /** Run inside the tenant transaction as the given role's user (default: owner). */
  run<T>(fn: () => Promise<T>, as?: RoleKey): Promise<T>;
}
