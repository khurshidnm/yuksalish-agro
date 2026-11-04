import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { CURRENCIES } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { notFound } from '../../core/errors';
import { isoDate } from '../../core/query';

const { fxRates: r } = schema;

const foreignCurrency = z.enum(CURRENCIES).exclude(['UZS']);

export const fxQuery = z.object({
  currency: foreignCurrency.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const fxInput = z.object({
  date: isoDate,
  currency: foreignCurrency,
  rate: z.number().positive().max(1e9),
});

export const fxKey = z.object({ date: isoDate, currency: foreignCurrency });

export async function list(q: z.infer<typeof fxQuery>) {
  return tx()
    .select({ date: r.date, currency: r.currency, rate: r.rate })
    .from(r)
    .where(
      and(
        eq(r.tenantId, ctx().tenantId),
        q.currency ? eq(r.currency, q.currency) : undefined,
        q.from ? gte(r.date, q.from) : undefined,
        q.to ? lte(r.date, q.to) : undefined,
      ),
    )
    .orderBy(desc(r.date), r.currency)
    .limit(500);
}

/** One rate per currency per day: saving a day again corrects it. */
export async function upsert(input: z.infer<typeof fxInput>) {
  const [row] = await tx()
    .insert(r)
    .values({ tenantId: ctx().tenantId, ...input })
    .onConflictDoUpdate({ target: [r.tenantId, r.date, r.currency], set: { rate: input.rate } })
    .returning({ date: r.date, currency: r.currency, rate: r.rate });
  return row;
}

export async function remove(key: z.infer<typeof fxKey>) {
  const deleted = await tx()
    .delete(r)
    .where(and(eq(r.tenantId, ctx().tenantId), eq(r.date, key.date), eq(r.currency, key.currency)))
    .returning({ date: r.date });
  if (deleted.length === 0) throw notFound('Exchange rate');
  return key;
}
