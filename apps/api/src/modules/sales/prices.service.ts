/** Price list and history (spec 13.2). Market prices are entered by hand or from an outside source. */
import { and, count, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { deviationPercent, round } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { notFound } from '../../core/errors';
import { getItemOrThrow } from '../../core/inventory';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, searchAny, sortBy } from '../../core/query';
import { MAX_MONEY, PRICE_KINDS } from './constants';

const { items, prices } = schema;

const priceFields = z.object({
  id: clientId,
  itemId: z.uuid(),
  date: isoDate,
  price: z.number().min(0).max(MAX_MONEY),
  kind: z.enum(PRICE_KINDS),
  source: z.string().trim().max(120).nullish(),
});

export const priceInput = priceFields.extend({ kind: priceFields.shape.kind.default('sale') });
export const pricePatch = priceFields.omit({ id: true, itemId: true }).partial();
export type PriceInput = z.infer<typeof priceInput>;

export const priceListQuery = listQuery.extend({
  itemId: z.uuid().optional(),
  kind: z.enum(PRICE_KINDS).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export async function list(q: z.infer<typeof priceListQuery>) {
  const where = and(
    eq(prices.farmId, ctx().farmId),
    q.itemId ? eq(prices.itemId, q.itemId) : undefined,
    q.kind ? eq(prices.kind, q.kind) : undefined,
    q.from ? gte(prices.date, q.from) : undefined,
    q.to ? lte(prices.date, q.to) : undefined,
    searchAny(q.search, [items.name, prices.source]),
  );
  const rows = await tx()
    .select({
      id: prices.id,
      itemId: prices.itemId,
      itemName: items.name,
      unit: items.unit,
      date: prices.date,
      price: prices.price,
      kind: prices.kind,
      source: prices.source,
    })
    .from(prices)
    .innerJoin(items, eq(items.id, prices.itemId))
    .where(where)
    .orderBy(...sortBy(q.sort, { date: prices.date, price: prices.price, itemName: items.name }, desc(prices.date), prices.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [{ total }] = await tx()
    .select({ total: count() })
    .from(prices)
    .innerJoin(items, eq(items.id, prices.itemId))
    .where(where);
  return { data: hideMoney(rows, ['price']), meta: { page: q.page, pageSize: q.pageSize, total } };
}

/** The current price of each item and kind, with the previous one and the change. */
export async function current() {
  const ranked = tx()
    .select({
      itemId: prices.itemId,
      kind: prices.kind,
      date: prices.date,
      price: prices.price,
      source: prices.source,
      rank: sql<number>`row_number() over (partition by ${prices.itemId}, ${prices.kind} order by ${prices.date} desc, ${prices.createdAt} desc)`
        .mapWith(Number)
        .as('rank'),
    })
    .from(prices)
    .where(eq(prices.farmId, ctx().farmId))
    .as('ranked');

  const rows = await tx()
    .select({
      itemId: ranked.itemId,
      itemName: items.name,
      unit: items.unit,
      kind: ranked.kind,
      date: ranked.date,
      price: ranked.price,
      source: ranked.source,
      rank: ranked.rank,
    })
    .from(ranked)
    .innerJoin(items, eq(items.id, ranked.itemId))
    .where(lte(ranked.rank, 2))
    .orderBy(items.name, ranked.kind, ranked.rank);

  const latest = rows
    .filter((r) => r.rank === 1)
    .map(({ rank: _rank, ...row }) => {
      const previous = rows.find((p) => p.rank === 2 && p.itemId === row.itemId && p.kind === row.kind);
      const change = previous ? deviationPercent(row.price, previous.price) : null;
      return {
        ...row,
        previousPrice: previous?.price ?? null,
        changePercent: change === null ? null : round(change, 1),
      };
    });
  return hideMoney(latest, ['price', 'previousPrice', 'changePercent']);
}

export async function create(input: PriceInput) {
  await getItemOrThrow(input.itemId);
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(prices)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  return row;
}

export async function update(id: string, input: z.infer<typeof pricePatch>) {
  const [row] = await tx()
    .update(prices)
    .set(input)
    .where(and(eq(prices.id, id), eq(prices.farmId, ctx().farmId)))
    .returning();
  if (!row) throw notFound('Price');
  return row;
}

export async function remove(id: string) {
  const [row] = await tx()
    .delete(prices)
    .where(and(eq(prices.id, id), eq(prices.farmId, ctx().farmId)))
    .returning({ id: prices.id });
  if (!row) throw notFound('Price');
  return row;
}
