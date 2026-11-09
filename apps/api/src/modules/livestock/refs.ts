/** Helpers shared by the livestock services. No imports from sibling services, to avoid cycles. */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { ANIMAL_ON_FARM_STATUSES } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { herdCost } from '../finance/summary';

const { animals, breedingRecords, herds } = schema;

export type Animal = typeof animals.$inferSelect;
export type Herd = typeof herds.$inferSelect;

export const onFarm = () => inArray(animals.status, [...ANIMAL_ON_FARM_STATUSES]);

/** Has an open pregnancy, whatever the animal's one status says: a pregnant ewe can also be sick. */
export const carryingPregnancy = sql`exists (select 1 from ${breedingRecords} br where br.ewe_id = ${animals.id} and br.status = 'pregnant')`;

export function isOnFarm(status: string): boolean {
  return (ANIMAL_ON_FARM_STATUSES as readonly string[]).includes(status);
}

type FarmTable = PgTable & { id: AnyPgColumn; farmId: AnyPgColumn };
type TenantTable = PgTable & { id: AnyPgColumn; tenantId: AnyPgColumn };

/**
 * A foreign key alone is not enough: Postgres runs FK checks outside RLS, so a client could point
 * at another tenant's row. Every incoming reference is checked against the current farm first.
 */
export async function assertInFarm(table: FarmTable, id: string | null | undefined, what: string): Promise<void> {
  if (!id) return;
  const [row] = await tx()
    .select({ id: table.id })
    .from(table as PgTable)
    .where(and(eq(table.id, id), eq(table.farmId, ctx().farmId)));
  if (!row) throw badRequest('INVALID_REFERENCE', `${what} was not found on this farm`, { field: what });
}

export async function assertInTenant(table: TenantTable, id: string | null | undefined, what: string): Promise<void> {
  if (!id) return;
  const [row] = await tx()
    .select({ id: table.id })
    .from(table as PgTable)
    .where(and(eq(table.id, id), eq(table.tenantId, ctx().tenantId)));
  if (!row) throw badRequest('INVALID_REFERENCE', `${what} was not found`, { field: what });
}

export async function getAnimalOrThrow(id: string, opts: { lock?: boolean } = {}): Promise<Animal> {
  const query = tx()
    .select()
    .from(animals)
    .where(and(eq(animals.id, id), eq(animals.farmId, ctx().farmId)));
  const [row] = await (opts.lock ? query.for('update') : query);
  if (!row) throw notFound('Animal');
  return row;
}

export async function getHerdOrThrow(id: string, opts: { lock?: boolean } = {}): Promise<Herd> {
  const query = tx()
    .select()
    .from(herds)
    .where(and(eq(herds.id, id), eq(herds.farmId, ctx().farmId)));
  const [row] = await (opts.lock ? query.for('update') : query);
  if (!row) throw notFound('Herd');
  return row;
}

export function assertOnFarm(animal: Pick<Animal, 'id' | 'tag' | 'status'>): void {
  if (!isOnFarm(animal.status)) {
    throw conflict('ANIMAL_NOT_ON_FARM', `Animal ${animal.tag} is no longer on the farm`, {
      animalId: animal.id,
      tag: animal.tag,
      status: animal.status,
    });
  }
}

/** Field staff type dates by hand. Records for a day that has not happened are always a mistake. */
export function assertNotFuture(date: string): void {
  if (date > today()) throw badRequest('FUTURE_DATE', 'The date cannot be in the future', { date });
}

/** Animals of a herd that are on the farm today. */
export async function herdHeadCount(herdId: string): Promise<number> {
  const [row] = await tx()
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(animals)
    .where(and(eq(animals.farmId, ctx().farmId), eq(animals.herdId, herdId), onFarm()));
  return row.n;
}

/** Herd cost from the finance engine, which is the only place that computes cost. */
export async function accumulatedCostPerHead(herdId: string | null): Promise<number | null> {
  if (!herdId) return null;
  const cost = await herdCost(herdId);
  // What the herd carries beyond each animal's own price: running costs, plus the transport and import
  // vet work capitalised on arrival, so an animal's book value agrees with the herd's cost per head.
  const carried = cost.accumulated + cost.landedExtra;
  // No cost charged yet means the value is unknown, which is not the same as worth nothing.
  return cost.head > 0 && carried > 0 ? carried / cost.head : null;
}
