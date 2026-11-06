import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { round } from '@yap/shared';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { conflict, notFound } from '../../core/errors';
import { adjustStock, DOCUMENT_REVERSED_EVENT, getItemOrThrow } from '../../core/inventory';
import { recordEvent } from '../../core/journal';
import { hideMoney } from '../../core/privacy';
import { isoDate, listQuery, paged, sortBy, sumOf } from '../../core/query';
import { nextDocNo } from './stock.service';

const { items, stockBatches, stockCountLines: lines, stockCounts: counts, users, warehouses } = schema;

export const countCreateInput = z.object({
  warehouseId: z.uuid(),
  date: isoDate,
  notes: z.string().max(1000).nullish(),
  /** Limit the count to these items. Default: everything in stock in this warehouse. */
  itemIds: z.array(z.uuid()).max(500).optional(),
});

export const countUpdateInput = z.object({
  date: isoDate.optional(),
  notes: z.string().max(1000).nullish(),
  /**
   * Counted quantities. An item not yet on the sheet is added. `systemQty` is the book the person saw
   * beside the number; without it the difference is taken against the book the line already holds.
   */
  lines: z
    .array(z.object({ itemId: z.uuid(), actualQty: z.number().min(0), systemQty: z.number().min(0).optional() }))
    .max(500)
    .optional(),
});

export const countListQuery = listQuery.extend({
  warehouseId: z.uuid().optional(),
  status: z.enum(['draft', 'approved']).optional(),
});

/** What the books say is in this warehouse now, per item. */
async function systemQty(warehouseId: string, itemIds?: string[]) {
  const rows = await tx()
    .select({ itemId: stockBatches.itemId, qty: sumOf(stockBatches.qtyRemaining) })
    .from(stockBatches)
    .where(
      and(
        eq(stockBatches.farmId, ctx().farmId),
        eq(stockBatches.warehouseId, warehouseId),
        itemIds ? inArray(stockBatches.itemId, itemIds) : undefined,
      ),
    )
    .groupBy(stockBatches.itemId);
  return new Map(rows.map((r) => [r.itemId, r.qty]));
}

async function getHeader(id: string, opts: { lock?: boolean } = {}) {
  const query = tx()
    .select()
    .from(counts)
    .where(and(eq(counts.id, id), eq(counts.farmId, ctx().farmId)));
  const [row] = await (opts.lock ? query.for('update') : query);
  if (!row) throw notFound('Stock count');
  return row;
}

function assertDraft(count: { status: string }) {
  if (count.status !== 'draft') throw conflict('COUNT_NOT_DRAFT', 'This count is already approved');
}

/** Take it before putting an item on a sheet: two people can start counting the same shelf at once. */
async function lockOpenSheets(warehouseId: string) {
  await tx().execute(sql`select pg_advisory_xact_lock(hashtext(${`stock_count:${ctx().farmId}:${warehouseId}`}))`);
}

/** Approval applies a difference, so two open sheets on one item would book the same shortage twice. */
async function assertNotOnOpenSheet(warehouseId: string, itemIds: string[], exceptCountId?: string) {
  if (itemIds.length === 0) return;
  const [open] = await tx()
    .select({ docNo: counts.docNo, item: items.name })
    .from(lines)
    .innerJoin(counts, eq(counts.id, lines.countId))
    .innerJoin(items, eq(items.id, lines.itemId))
    .where(
      and(
        eq(counts.farmId, ctx().farmId),
        eq(counts.warehouseId, warehouseId),
        eq(counts.status, 'draft'),
        inArray(lines.itemId, itemIds),
        exceptCountId ? ne(counts.id, exceptCountId) : undefined,
      ),
    )
    .orderBy(asc(counts.docNo), asc(items.name))
    .limit(1);
  if (open) throw conflict('COUNT_ALREADY_OPEN', `${open.item} is already on open count sheet ${open.docNo}`, open);
}

export async function list(q: z.infer<typeof countListQuery>) {
  const where = and(
    eq(counts.farmId, ctx().farmId),
    q.warehouseId ? eq(counts.warehouseId, q.warehouseId) : undefined,
    q.status ? eq(counts.status, q.status) : undefined,
  );
  return paged(q, counts, where, (limit, offset) =>
    tx()
      .select({
        id: counts.id,
        date: counts.date,
        docNo: counts.docNo,
        status: counts.status,
        notes: counts.notes,
        warehouseId: counts.warehouseId,
        warehouseName: warehouses.name,
        approvedAt: counts.approvedAt,
        lines: sql<number>`(select count(*) from stock_count_lines l where l.count_id = ${counts.id})`.mapWith(Number),
      })
      .from(counts)
      .innerJoin(warehouses, eq(warehouses.id, counts.warehouseId))
      .where(where)
      .orderBy(...sortBy(q.sort, { date: counts.date }, [desc(counts.date), desc(counts.createdAt)], counts.id))
      .limit(limit)
      .offset(offset),
  );
}

export async function get(id: string) {
  const count = await getHeader(id);
  const [warehouse] = await tx().select({ name: warehouses.name }).from(warehouses).where(eq(warehouses.id, count.warehouseId));
  const rows = await tx()
    .select({
      id: lines.id,
      itemId: lines.itemId,
      itemName: items.name,
      unit: items.unit,
      systemQty: lines.systemQty,
      actualQty: lines.actualQty,
      diffQty: lines.diffQty,
      diffCost: lines.diffCost,
    })
    .from(lines)
    .innerJoin(items, eq(items.id, lines.itemId))
    .where(eq(lines.countId, id))
    .orderBy(asc(items.name));

  // An approved sheet is the act: what approval applied, as stored. A draft shows today's book, since
  // stock can move while it is open: the difference found stays, and the book follows the moves.
  const live = count.status === 'draft' ? await systemQty(count.warehouseId) : null;
  const data = !live
    ? rows
    : rows.map((row) => {
        const system = live.get(row.itemId) ?? 0;
        return { ...row, systemQty: system, actualQty: Math.max(0, round(system + row.diffQty, 3)) };
      });

  let approvedByName: string | null = null;
  if (count.approvedBy) {
    const [user] = await tx().select({ name: users.fullName }).from(users).where(eq(users.id, count.approvedBy));
    approvedByName = user?.name ?? null;
  }
  return { ...count, warehouseName: warehouse?.name ?? null, approvedByName, lines: hideMoney(data, ['diffCost']) };
}

export async function create(input: z.infer<typeof countCreateInput>) {
  const c = ctx();
  const [warehouse] = await tx()
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.id, input.warehouseId), eq(warehouses.farmId, c.farmId)));
  if (!warehouse) throw notFound('Warehouse');

  if (input.itemIds?.length) {
    const found = await tx()
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.farmId, c.farmId), inArray(items.id, input.itemIds)));
    if (found.length !== new Set(input.itemIds).size) throw notFound('Item');
  }

  await lockOpenSheets(input.warehouseId);
  const stock = await systemQty(input.warehouseId, input.itemIds);
  const itemIds = input.itemIds ? [...new Set(input.itemIds)] : [...stock.entries()].filter(([, qty]) => qty > 0).map(([id]) => id);
  await assertNotOnOpenSheet(input.warehouseId, itemIds);

  const docNo = await nextDocNo('count', input.date);
  const [count] = await tx()
    .insert(counts)
    .values({
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      warehouseId: input.warehouseId,
      date: input.date,
      docNo,
      notes: input.notes,
    })
    .returning();

  if (itemIds.length > 0) {
    await tx()
      .insert(lines)
      .values(
        itemIds.map((itemId) => ({
          tenantId: c.tenantId,
          farmId: c.farmId,
          createdBy: c.userId,
          countId: count.id,
          itemId,
          systemQty: stock.get(itemId) ?? 0,
          // Starts equal to the books, so only real differences need typing in.
          actualQty: stock.get(itemId) ?? 0,
          diffQty: 0,
        })),
      );
  }
  return get(count.id);
}

export async function update(id: string, input: z.infer<typeof countUpdateInput>) {
  const count = await getHeader(id, { lock: true });
  assertDraft(count);
  const c = ctx();

  if (input.date !== undefined || input.notes !== undefined) {
    const { lines: _lines, ...header } = input;
    await tx().update(counts).set(header).where(eq(counts.id, id));
  }
  if (input.lines?.length) {
    const typed = [...new Map(input.lines.map((line) => [line.itemId, line])).values()];
    const existing = await tx().select({ id: lines.id, itemId: lines.itemId, systemQty: lines.systemQty }).from(lines).where(eq(lines.countId, id));
    const byItem = new Map(existing.map((l) => [l.itemId, l]));
    const added = typed.map((line) => line.itemId).filter((itemId) => !byItem.has(itemId));
    if (added.length > 0) {
      await lockOpenSheets(count.warehouseId);
      await assertNotOnOpenSheet(count.warehouseId, added, id);
    }
    const stock = await systemQty(count.warehouseId, added);
    for (const line of typed) {
      const onSheet = byItem.get(line.itemId);
      const system = line.systemQty ?? onSheet?.systemQty ?? stock.get(line.itemId) ?? 0;
      const values = { systemQty: system, actualQty: line.actualQty, diffQty: round(line.actualQty - system, 3) };
      if (onSheet) {
        await tx().update(lines).set(values).where(eq(lines.id, onSheet.id));
      } else {
        await getItemOrThrow(line.itemId);
        await tx()
          .insert(lines)
          .values({ ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId, countId: id, itemId: line.itemId });
      }
    }
  }
  return get(id);
}

/** Apply the counted quantities. The difference goes to the general cost center. */
export async function approve(id: string) {
  const count = await getHeader(id, { lock: true });
  assertDraft(count);

  const rows = await tx().select().from(lines).where(eq(lines.countId, id));
  if (rows.length === 0) throw conflict('COUNT_EMPTY', 'Add at least one item to the count');
  await assertNotOnOpenSheet(count.warehouseId, rows.map((line) => line.itemId), id);

  // What the count found is a difference from the book at that moment. Stock issued since then is
  // already gone, so applying the old total would book it back in as a false surplus.
  const book = await systemQty(count.warehouseId);
  let diffCost = 0;
  for (const line of rows) {
    const before = book.get(line.itemId) ?? 0;
    const result = await adjustStock({
      itemId: line.itemId,
      warehouseId: count.warehouseId,
      actualQty: Math.max(0, round(before + line.diffQty, 3)),
      date: count.date,
      docNo: count.docNo,
      refType: 'stock_count',
      refId: id,
    });
    // adjustStock reads the book under its lock. A different figure means this quantity came from a stale read.
    if (round(result.systemQty - before, 3) !== 0) throw conflict('COUNT_BOOK_MOVED', 'Stock moved during approval. Approve again');
    diffCost += result.diffCost;
    await tx()
      .update(lines)
      .set({
        systemQty: result.systemQty,
        actualQty: round(result.systemQty + result.diffQty, 3),
        diffQty: result.diffQty,
        diffCost: result.diffCost,
      })
      .where(eq(lines.id, line.id));
  }

  await tx().update(counts).set({ status: 'approved', approvedBy: ctx().userId, approvedAt: new Date() }).where(eq(counts.id, id));
  await recordEvent({
    type: 'stock.counted',
    entityType: 'stock_count',
    entityId: id,
    occurredAt: count.date,
    data: { docNo: count.docNo, lines: rows.length, diffCost },
  });
  return get(id);
}

/** The journal keeps the number from coming back: nextDocNo reads this event. */
export async function remove(id: string) {
  const count = await getHeader(id, { lock: true });
  assertDraft(count);
  await tx().delete(counts).where(eq(counts.id, id));
  await recordEvent({ type: DOCUMENT_REVERSED_EVENT, entityType: 'stock_count', entityId: id, data: { docNo: count.docNo } });
  return { id };
}
