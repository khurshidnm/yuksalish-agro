/**
 * Route definition helper. Every route goes through here, which gives it, in order:
 * authentication, tenant transaction with RLS, permission check, module check, 2FA policy,
 * idempotent replay, and the { data } response envelope. Types of req.query/body/params come
 * straight from the zod schemas.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { z, type ZodType } from 'zod';
import { ROLES_REQUIRING_2FA, type Permission, type RoleKey } from '@yap/shared';
import { db, schema } from '../db/client';
import { ctx, tx, updateCtx, withPlatform, withTenant, type Identity } from './context';
import { sha256 } from './crypto';
import { AppError, forbidden, unauthorized } from './errors';
import { isPage } from './query';
import { mergeSettings } from './settings';
import { verifyAccessToken } from './tokens';

const { apiKeys, idempotencyKeys, memberships, roles, tenants, users } = schema;

/**
 * - a Permission, or several (any one is enough)
 * - 'authenticated': any signed-in member; skips the 2FA enrolment gate (used by auth itself)
 * - 'public': no authentication and no tenant context
 * - 'platform': platform administrator only. Handler uses withPlatform().
 * - { apiKey: scope }: machine access for devices and integrations
 */
export type Access = Permission | Permission[] | 'authenticated' | 'public' | 'platform' | { apiKey: string };

type Infer<T> = T extends ZodType ? z.output<T> : undefined;

export type Req<Q, B, P> = Omit<FastifyRequest, 'query' | 'body' | 'params'> & {
  query: Infer<Q>;
  body: Infer<B>;
  params: Infer<P>;
  /** Set when the route uses `transaction: false`: pass to withTenant() around each DB step. */
  identity: Identity;
};

export interface RouteDef<Q, B, P> {
  access: Access;
  summary?: string;
  query?: Q;
  body?: B;
  params?: P;
  /**
   * false: authenticate in a short transaction, then run the handler outside one. For handlers
   * that wait on something slow, such as an LLM, so they do not hold a DB connection.
   */
  transaction?: boolean;
  /** Fastify route config, e.g. { rateLimit: { max: 10, timeWindow: '1 minute' } } */
  config?: Record<string, unknown>;
  bodyLimit?: number;
  handler: (req: Req<Q, B, P>, reply: FastifyReply) => unknown | Promise<unknown>;
}

function requestMeta(req: FastifyRequest) {
  return { ip: req.ip, device: (req.headers['user-agent'] ?? '').slice(0, 200) };
}

function bearer(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  return header.slice(7);
}

/** Modules that cannot be switched off, because the app does not work without them. */
const ALWAYS_ON = new Set(['dashboard', 'users', 'settings', 'audit', 'tasks']);

/** Load who is calling. Runs on every request, so blocking someone takes effect immediately. */
async function loadMember(membershipId: string) {
  const [row] = await tx()
    .select({
      status: memberships.status,
      userStatus: users.status,
      totpEnabled: users.totpEnabled,
      tenantStatus: tenants.status,
      tenantModules: tenants.modules,
      tenantSettings: tenants.settings,
      currency: tenants.currency,
      timezone: tenants.timezone,
      roleKey: roles.key,
      permissions: roles.permissions,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.id, membershipId));
  if (!row || row.status !== 'active' || row.userStatus !== 'active') {
    throw unauthorized('ACCOUNT_BLOCKED', 'This account is blocked');
  }
  if (row.tenantStatus !== 'active') throw forbidden('This workspace is suspended', 'TENANT_SUSPENDED');
  return row;
}

function requiredPermissions(access: Access): Permission[] | null {
  if (typeof access === 'object' && !Array.isArray(access)) return null;
  if (access === 'authenticated' || access === 'public' || access === 'platform') return null;
  return Array.isArray(access) ? access : [access];
}

async function authorize(access: Access, member: Awaited<ReturnType<typeof loadMember>>) {
  const settings = mergeSettings(member.tenantSettings);
  updateCtx({
    roleKey: member.roleKey,
    permissions: new Set(member.permissions),
    settings,
    currency: member.currency,
    timezone: member.timezone,
  });

  const required = requiredPermissions(access);
  if (!required) return;

  const mustEnroll =
    settings.security.enforce2fa &&
    !member.totpEnabled &&
    ROLES_REQUIRING_2FA.includes(member.roleKey as RoleKey);
  if (mustEnroll) throw forbidden('Two-factor authentication is required', 'TWO_FACTOR_ENROLLMENT_REQUIRED');

  const granted = required.find((p) => ctx().permissions.has(p));
  if (!granted) throw forbidden(undefined, 'FORBIDDEN', { required });

  const module = granted.split('.')[0];
  if (!ALWAYS_ON.has(module) && !member.tenantModules.includes(module)) {
    throw forbidden('This module is not enabled for your workspace', 'MODULE_DISABLED', { module });
  }
}

async function identityFromKey(req: FastifyRequest, scope: string): Promise<Identity> {
  const raw = req.headers['x-api-key'];
  if (typeof raw !== 'string') throw unauthorized('API_KEY_REQUIRED', 'X-Api-Key header is required');
  const [key] = await withPlatform((trx) =>
    trx.select().from(apiKeys).where(eq(apiKeys.keyHash, sha256(raw))),
  );
  if (!key || key.revokedAt) throw unauthorized('INVALID_API_KEY', 'Invalid API key');
  if (!key.scopes.includes(scope) && !key.scopes.includes('*')) {
    throw forbidden('This key does not allow this action', 'INSUFFICIENT_SCOPE', { scope });
  }
  await withPlatform((trx) =>
    trx.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id)),
  );
  return { userId: null, tenantId: key.tenantId, farmId: key.farmId, source: 'sensor', ...requestMeta(req) };
}

/**
 * zod 4 keeps `.default()` inside `.partial()`, so validation fills in fields a PATCH never sent
 * and the update would silently reset them. Keys are remembered before validation and anything
 * added by it is dropped afterwards, which fixes every PATCH route in one place.
 */
const sentBodyKeys = new WeakMap<FastifyRequest, Set<string>>();

async function rememberSentKeys(req: FastifyRequest) {
  if (req.body && typeof req.body === 'object') sentBodyKeys.set(req, new Set(Object.keys(req.body)));
}

function dropUnsentKeys(req: FastifyRequest) {
  const sent = sentBodyKeys.get(req);
  if (!sent || !req.body || typeof req.body !== 'object') return;
  const body = req.body as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!sent.has(key)) delete body[key];
}

function envelope(result: unknown) {
  return isPage(result) ? result : { data: result ?? null };
}

async function runIdempotent(
  req: FastifyRequest,
  reply: FastifyReply,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const key = req.headers['idempotency-key'];
  if (req.method !== 'POST' || typeof key !== 'string' || !key) return run();

  const c = ctx();
  const [stored] = await tx()
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, c.tenantId), eq(idempotencyKeys.key, key)));
  if (stored) {
    reply.code(stored.statusCode).header('idempotent-replay', 'true');
    return stored.response;
  }
  const result = await run();
  if (result === reply) return result;
  await tx().insert(idempotencyKeys).values({
    tenantId: c.tenantId,
    key,
    path: req.url.split('?')[0],
    statusCode: reply.statusCode,
    response: result,
  });
  return result;
}

function wrap<Q, B, P>(def: RouteDef<Q, B, P>) {
  return async (fastifyReq: FastifyRequest, reply: FastifyReply) => {
    const req = fastifyReq as unknown as Req<Q, B, P>;
    dropUnsentKeys(fastifyReq);

    if (def.access === 'public') {
      const result = await def.handler(req, reply);
      return result === reply || reply.sent ? reply : envelope(result);
    }

    let identity: Identity;
    if (typeof def.access === 'object' && !Array.isArray(def.access)) {
      identity = await identityFromKey(fastifyReq, def.access.apiKey);
    } else {
      const claims = await verifyAccessToken(bearer(fastifyReq));
      if (def.access === 'platform') {
        const [user] = await db.select({ admin: users.isPlatformAdmin, status: users.status }).from(users).where(eq(users.id, claims.userId));
        if (!user?.admin || user.status !== 'active') throw forbidden();
        const result = await def.handler(req, reply);
        return result === reply || reply.sent ? reply : envelope(result);
      }
      if (!claims.membershipId || !claims.tenantId || !claims.farmId) {
        throw forbidden('No active farm', 'NO_ACTIVE_FARM');
      }
      identity = {
        userId: claims.userId,
        tenantId: claims.tenantId,
        farmId: claims.farmId,
        membershipId: claims.membershipId,
        ...requestMeta(fastifyReq),
      };
    }

    const isUser = identity.membershipId != null;

    if (def.transaction === false) {
      req.identity = await withTenant(identity, async () => {
        if (isUser) await authorize(def.access, await loadMember(identity.membershipId!));
        const c = ctx();
        return { ...identity, roleKey: c.roleKey, permissions: c.permissions, settings: c.settings, currency: c.currency, timezone: c.timezone };
      });
      const result = await def.handler(req, reply);
      return result === reply || reply.sent ? reply : envelope(result);
    }

    return withTenant(identity, async () => {
      if (isUser) await authorize(def.access, await loadMember(identity.membershipId!));
      req.identity = identity;
      return runIdempotent(fastifyReq, reply, async () => {
        const result = await def.handler(req, reply);
        return result === reply || reply.sent ? reply : envelope(result);
      });
    });
  };
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Every route defined through routes(), for contract tests. */
export const routeRegistry: { method: Method; url: string; access: Access; body?: ZodType }[] = [];

/** `const r = routes(app, 'finance'); r.get('/counterparties', {...})` */
export function routes(app: FastifyInstance, tag: string) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const add =
    (method: Method) =>
    <Q extends ZodType | undefined = undefined, B extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined>(
      url: string,
      def: RouteDef<Q, B, P>,
    ) => {
      routeRegistry.push({ method, url, access: def.access, body: def.body as ZodType | undefined });
      typed.route({
        method,
        url,
        ...(method === 'PATCH' ? { preValidation: rememberSentKeys } : {}),
        config: def.config,
        bodyLimit: def.bodyLimit,
        schema: {
          tags: [tag],
          // Only defined keys: Fastify warns about a schema key set to undefined.
          ...(def.summary ? { summary: def.summary } : {}),
          ...(def.query ? { querystring: def.query as ZodType } : {}),
          ...(def.body ? { body: def.body as ZodType } : {}),
          ...(def.params ? { params: def.params as ZodType } : {}),
          ...(def.access === 'public' ? { security: [] } : {}),
        },
        handler: wrap(def) as never,
      });
    };
  return { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') };
}

/** Throw when a condition fails with a domain error. */
export function ensure(condition: unknown, error: AppError): asserts condition {
  if (!condition) throw error;
}
