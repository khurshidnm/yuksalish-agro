import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_ROLE_PERMISSIONS, ROLE_KEYS, type Permission, type RoleKey } from '@yap/shared';
import { buildApp } from '../src/app';
import { withTenant } from '../src/core/context';
import { DEFAULT_SETTINGS, mergeSettings, type TenantSettings } from '../src/core/settings';
import { addMember, provisionTenant } from '../src/core/tenancy';
import { signAccessToken } from '../src/core/tokens';

let appPromise: Promise<FastifyInstance> | undefined;

/** One Fastify instance per test file. */
export function getApp(): Promise<FastifyInstance> {
  appPromise ??= buildApp();
  return appPromise;
}

export interface TestResponse<T = any> {
  status: number;
  body: any;
  /** body.data */
  data: T;
  headers: Record<string, unknown>;
}

export interface Client {
  userId: string;
  membershipId: string;
  get<T = any>(url: string, query?: Record<string, unknown>): Promise<TestResponse<T>>;
  post<T = any>(url: string, body?: unknown, headers?: Record<string, string>): Promise<TestResponse<T>>;
  patch<T = any>(url: string, body?: unknown): Promise<TestResponse<T>>;
  put<T = any>(url: string, body?: unknown): Promise<TestResponse<T>>;
  delete<T = any>(url: string): Promise<TestResponse<T>>;
}

function makeClient(app: FastifyInstance, token: string, userId: string, membershipId: string): Client {
  const send = async (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    query?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<TestResponse> => {
    const path = url.startsWith('/api') ? url : `/api/v1${url}`;
    const response = await app.inject({
      method,
      url: path,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      query: query ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])) : undefined,
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
    let body: any = null;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body, data: body?.data, headers: response.headers };
  };
  return {
    userId,
    membershipId,
    get: (url, query) => send('GET', url, undefined, query),
    post: (url, body, headers) => send('POST', url, body ?? {}, undefined, headers),
    patch: (url, body) => send('PATCH', url, body ?? {}),
    put: (url, body) => send('PUT', url, body ?? {}),
    delete: (url) => send('DELETE', url),
  };
}

export interface Fixture {
  app: FastifyInstance;
  tenantId: string;
  farmId: string;
  roleIds: Record<RoleKey, string>;
  /** API client signed in with the given role. Creates the user on first use. */
  as(role: RoleKey): Promise<Client>;
  /** Run code inside the tenant as the system, with every permission: arrange test data. */
  run<T>(fn: () => Promise<T>, opts?: { settings?: TenantSettings; userId?: string; permissions?: string[] }): Promise<T>;
}

export interface FixtureOptions {
  /** Merged over defaults. 2FA enforcement is off in fixtures unless a test turns it on. */
  settings?: Record<string, unknown>;
  modules?: string[];
}

export async function createFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  const app = await getApp();
  const suffix = randomBytes(4).toString('hex');
  const storedSettings = { security: { enforce2fa: false }, ...opts.settings };
  const { tenantId, farmId, roleIds } = await provisionTenant({
    tenant: { name: `Test ${suffix}`, settings: storedSettings, modules: opts.modules },
    farm: { name: `Farm ${suffix}`, lat: 39.5, lng: 64.8 },
  });
  const settings = mergeSettings(storedSettings);
  const clients = new Map<RoleKey, Client>();

  return {
    app,
    tenantId,
    farmId,
    roleIds,
    async as(role) {
      const existing = clients.get(role);
      if (existing) return existing;
      const phone = `+998${Math.floor(100_000_000 + Math.random() * 899_999_999)}`;
      const { userId, membershipId } = await addMember({
        tenantId,
        farmId,
        roleId: roleIds[role],
        phone,
        fullName: `${role} ${suffix}`,
        password: 'Password123!',
      });
      const token = await signAccessToken({ userId, membershipId, tenantId, farmId });
      const client = makeClient(app, token, userId, membershipId);
      clients.set(role, client);
      return client;
    },
    run(fn, o = {}) {
      return withTenant(
        {
          userId: o.userId ?? null,
          tenantId,
          farmId,
          source: 'system',
          permissions: o.permissions ?? allPermissions(),
          settings: o.settings ?? settings,
        },
        fn,
      );
    },
  };
}

function allPermissions(): Permission[] {
  return ROLE_KEYS.flatMap((r) => DEFAULT_ROLE_PERMISSIONS[r]);
}

export { DEFAULT_SETTINGS };
