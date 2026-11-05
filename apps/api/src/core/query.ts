import { asc, count, desc, ilike, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { tx } from './context';

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().optional(),
  sort: z.string().optional(),
});
export type ListQuery = z.infer<typeof listQuery>;

export const idParam = z.object({ id: z.uuid() });
/** Business date in a request. */
export const isoDate = z.iso.date();
/** "YYYY-MM" */
export const isoMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
/** Optional client-generated id, used by the offline outbox. */
export const clientId = z.uuid().optional();

export interface Page<T> {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    /** The count stopped at `total`: there are more rows than that. */
    totalCapped?: true;
  };
}

export function isPage(value: unknown): value is Page<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Page<unknown>).data) &&
    typeof (value as Page<unknown>).meta === 'object'
  );
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Case-insensitive "contains" across columns; undefined when there is no search term. */
export function searchAny(term: string | undefined, columns: (AnyColumn | SQL)[]): SQL | undefined {
  if (!term) return undefined;
  const pattern = `%${escapeLike(term)}%`;
  return or(...columns.map((column) => ilike(column as AnyColumn, pattern)));
}

/**
 * ORDER BY from "field" or "-field", limited to the allowed columns, so a client cannot
 * sort on arbitrary expressions. A stable tie-breaker keeps pages from overlapping.
 */
export function sortBy(
  sort: string | undefined,
  allowed: Record<string, AnyColumn | SQL>,
  fallback: SQL | SQL[],
  tieBreaker?: AnyColumn,
): SQL[] {
  const fallbackList = Array.isArray(fallback) ? fallback : [fallback];
  let order = fallbackList;
  if (sort) {
    const descending = sort.startsWith('-');
    const column = allowed[descending ? sort.slice(1) : sort];
    if (column) order = [descending ? desc(column) : asc(column)];
  }
  return tieBreaker ? [...order, asc(tieBreaker)] : order;
}

/**
 * How far a count reads past the page in view. Row-level security makes a count visit every row, so
 * an exact total costs more the longer a farm runs, and nobody pages through 400 screens by hand.
 */
const COUNT_AHEAD = 10_000;

/**
 * Run the page query plus a count over the same filter. Past COUNT_AHEAD the total is a floor that
 * moves with the page, so a caller reading until it has `total` rows still reaches the end.
 */
export async function paged<T>(
  q: Pick<ListQuery, 'page' | 'pageSize'>,
  table: PgTable,
  where: SQL | undefined,
  rows: (limit: number, offset: number) => Promise<T[]>,
): Promise<Page<T>> {
  const offset = (q.page - 1) * q.pageSize;
  const meta = { page: q.page, pageSize: q.pageSize };
  // Sequential on purpose: one transaction is one connection, so Promise.all gains nothing.
  const data = await rows(q.pageSize, offset);
  // A page that is not full is the last one, so it already knows the total.
  const isLast = data.length < q.pageSize && (data.length > 0 || offset === 0);
  if (isLast) return { data, meta: { ...meta, total: offset + data.length } };

  const limit = offset + q.pageSize + COUNT_AHEAD;
  const counted = tx().select({ one: sql`1`.as('one') }).from(table).where(where).limit(limit + 1).as('counted');
  const [{ total }] = await tx().select({ total: count() }).from(counted);
  return total > limit ? { data, meta: { ...meta, total: limit, totalCapped: true } } : { data, meta: { ...meta, total } };
}

/** Sum as a number; empty set is 0. */
export const sumOf = (column: AnyColumn | SQL) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
