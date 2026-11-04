import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Permission } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, hasPermission, tx } from '../../core/context';

export type Block<T> = { status: 'ok'; data: T } | { status: 'unavailable'; data: null };

/**
 * Aggregates for management readers. An investor holds this and dashboard.view, and no module
 * permission, so this is what lets them see counts and tons. It never unlocks money, which stays
 * behind finance.view (CLAUDE.md rule 7), nor cameras.
 */
export const AGGREGATES: Permission = 'reports.view';

export const holdsAny = (...permissions: Permission[]): boolean => permissions.some(hasPermission);

export async function enabledModules(): Promise<Set<string>> {
  const [row] = await tx()
    .select({ modules: schema.tenants.modules })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, ctx().tenantId));
  return new Set(row?.modules ?? []);
}

/**
 * Run one part of a page so that its failure stays its own. One request is one transaction, and a
 * failed query aborts a transaction, so without this savepoint every later block would fail too.
 */
export async function isolate<T>(name: string, log: FastifyBaseLogger, load: () => Promise<T>): Promise<Block<T>> {
  try {
    return { status: 'ok', data: await tx().transaction(load) };
  } catch (err) {
    log.error({ err, block: name }, 'dashboard block failed');
    return { status: 'unavailable', data: null };
  }
}

export function roundOrNull(value: number | null | undefined, digits: number): number | null {
  if (value === null || value === undefined) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** The feed that runs out first; feeds with no known figure cannot be it. */
export function limitingFeed<T extends { days: number | null }>(items: T[]): (T & { days: number }) | null {
  let lowest: (T & { days: number }) | null = null;
  for (const item of items) {
    if (item.days !== null && (lowest === null || item.days < lowest.days)) lowest = item as T & { days: number };
  }
  return lowest;
}
