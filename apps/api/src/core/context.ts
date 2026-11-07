import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { todayIso, type EventSource, type Permission } from '@yap/shared';
import { db, type Tx } from '../db/client';
import { forbidden } from './errors';
import { DEFAULT_SETTINGS, type TenantSettings } from './settings';

export interface Identity {
  userId: string | null;
  tenantId: string;
  farmId: string;
  membershipId?: string | null;
  roleKey?: string | null;
  permissions?: Iterable<string>;
  ip?: string | null;
  device?: string | null;
  source?: EventSource;
  settings?: TenantSettings;
  currency?: string;
  timezone?: string;
}

export interface Ctx {
  userId: string | null;
  tenantId: string;
  farmId: string;
  membershipId: string | null;
  roleKey: string | null;
  permissions: Set<string>;
  /** Held by the role, but its module is switched off for this workspace. */
  withheld: Set<string>;
  ip: string | null;
  device: string | null;
  source: EventSource;
  settings: TenantSettings;
  currency: string;
  timezone: string;
  tx: Tx;
}

const storage = new AsyncLocalStorage<Ctx>();

export function ctx(): Ctx {
  const current = storage.getStore();
  if (!current) throw new Error('No tenant context: this code must run inside guard() or withTenant()');
  return current;
}

/** The current request's transaction. All business queries go through this, so RLS applies. */
export const tx = (): Tx => ctx().tx;

/** Today at the farm. */
export const today = (): string => todayIso(ctx().timezone);

export const hasPermission = (permission: Permission): boolean => ctx().permissions.has(permission);

/**
 * Money visibility (CLAUDE.md rule 7): strip these fields when this is false. `domain` lets the
 * manager of a module see that module's costs without opening the rest of finance.
 */
export const canSeeMoney = (domain?: Permission): boolean =>
  hasPermission('finance.view') || (domain !== undefined && hasPermission(domain));

export function assertPermission(permission: Permission): void {
  if (hasPermission(permission)) return;
  if (ctx().withheld.has(permission)) {
    throw forbidden('This module is not enabled for your workspace', 'MODULE_DISABLED', { module: permission.split('.')[0] });
  }
  throw forbidden(undefined, 'FORBIDDEN', { required: permission });
}

async function setSession(trx: Tx, identity: Identity): Promise<void> {
  await trx.execute(sql`select
    set_config('app.tenant_id', ${identity.tenantId}, true),
    set_config('app.user_id', ${identity.userId ?? ''}, true),
    set_config('app.ip', ${identity.ip ?? ''}, true),
    set_config('app.device', ${identity.device ?? ''}, true)`);
}

/** Run `fn` in one transaction with row-level security bound to this tenant. */
export async function withTenant<T>(identity: Identity, fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (trx) => {
    await setSession(trx, identity);
    const context: Ctx = {
      userId: identity.userId,
      tenantId: identity.tenantId,
      farmId: identity.farmId,
      membershipId: identity.membershipId ?? null,
      roleKey: identity.roleKey ?? null,
      permissions: new Set(identity.permissions ?? []),
      withheld: new Set(),
      ip: identity.ip ?? null,
      device: identity.device ?? null,
      source: identity.source ?? 'user',
      settings: identity.settings ?? DEFAULT_SETTINGS,
      currency: identity.currency ?? 'UZS',
      timezone: identity.timezone ?? 'Asia/Tashkent',
      tx: trx,
    };
    return storage.run(context, fn);
  });
}

/** Replace parts of the context for the rest of the current request, e.g. after loading identity. */
export function updateCtx(patch: Partial<Omit<Ctx, 'tx'>>): void {
  Object.assign(ctx(), patch);
}

/**
 * Identity tables across tenants: login, API key lookup, platform admin, tenant enumeration in jobs.
 * Reaches tenants, farms, roles, memberships and api_keys only. Business tables stay invisible,
 * which is how "platform admin does not see tenant data" (spec 5) is enforced at the database.
 */
export async function withPlatform<T>(fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (trx) => {
    await trx.execute(sql`select set_config('app.platform', 'on', true)`);
    return fn(trx);
  });
}
