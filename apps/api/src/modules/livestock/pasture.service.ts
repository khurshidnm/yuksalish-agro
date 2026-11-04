import { and, desc, eq, getTableColumns, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { round } from '@yap/shared';
import { stockingRate } from '@yap/shared/formulas/livestock';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate, listQuery, paged, sortBy } from '../../core/query';
import { assertInFarm, assertNotFuture, getHerdOrThrow, herdHeadCount } from './refs';

const { fields, herds, pastureMoves: t } = schema;

export const pastureOutInput = z.object({
  id: clientId,
  herdId: z.uuid(),
  fieldId: z.uuid(),
  outDate: isoDate.optional(),
  notes: z.string().max(500).nullish(),
});

export const pastureReturnInput = z.object({ returnDate: isoDate.optional() });

export const pastureListQuery = listQuery.extend({
  herdId: z.uuid().optional(),
  open: z.enum(['true', 'false']).optional(),
});

/** Stocking rate for a move in progress, using the herd as it stands today. */
async function withStockingRate<T extends { herdId: string; areaHa: number; returnDate: string | null }>(row: T) {
  const head = await herdHeadCount(row.herdId);
  const rate = row.returnDate ? null : stockingRate(head, row.areaHa);
  return { ...row, headCount: head, stockingRate: rate === null ? null : round(rate, 2) };
}

export async function sendToPasture(input: z.infer<typeof pastureOutInput>) {
  const c = ctx();
  const outDate = input.outDate ?? today();
  assertNotFuture(outDate);
  await getHerdOrThrow(input.herdId, { lock: true });
  await assertInFarm(fields, input.fieldId, 'Field');

  const [open] = await tx()
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.herdId, input.herdId), isNull(t.returnDate)));
  if (open) throw conflict('PASTURE_MOVE_OPEN', 'This herd is already out on pasture', { id: open.id });

  const [row] = await tx()
    .insert(t)
    .values({
      ...(input.id ? { id: input.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      herdId: input.herdId,
      fieldId: input.fieldId,
      outDate,
      notes: input.notes,
    })
    .returning();
  await recordEvent({
    type: 'herd.pasture_out',
    entityType: 'herd',
    entityId: input.herdId,
    occurredAt: outDate,
    data: { fieldId: input.fieldId },
  });
  return row;
}

export async function returnFromPasture(id: string, input: z.infer<typeof pastureReturnInput>) {
  const [move] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)))
    .for('update');
  if (!move) throw notFound('Pasture move');
  if (move.returnDate) throw conflict('PASTURE_MOVE_CLOSED', 'This herd has already returned');
  const returnDate = input.returnDate ?? today();
  assertNotFuture(returnDate);
  if (returnDate < move.outDate) throw badRequest('INVALID_DATES', 'The return date is before the departure');
  const [row] = await tx().update(t).set({ returnDate }).where(eq(t.id, id)).returning();
  await recordEvent({ type: 'herd.pasture_return', entityType: 'herd', entityId: move.herdId, occurredAt: returnDate, data: { fieldId: move.fieldId } });
  return row;
}

export async function listPastureMoves(q: z.infer<typeof pastureListQuery>) {
  const where = and(
    eq(t.farmId, ctx().farmId),
    q.herdId ? eq(t.herdId, q.herdId) : undefined,
    q.open === 'true' ? isNull(t.returnDate) : undefined,
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select({
        ...getTableColumns(t),
        herdName: herds.name,
        fieldNumber: fields.number,
        fieldName: fields.name,
        areaHa: fields.areaHa,
      })
      .from(t)
      .innerJoin(herds, eq(herds.id, t.herdId))
      .innerJoin(fields, eq(fields.id, t.fieldId))
      .where(where)
      .orderBy(...sortBy(q.sort, { outDate: t.outDate }, desc(t.outDate), t.id))
      .limit(limit)
      .offset(offset),
  );
  const data = [];
  for (const row of page.data) data.push(await withStockingRate(row));
  return { ...page, data };
}
