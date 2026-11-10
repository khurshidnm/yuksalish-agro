import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { PHYSIOLOGICAL_STATES, rationCostPerHeadDay, round } from '@yap/shared';
import { dryMatterKg, kgPerUnit, rationDryMatterKg } from '@yap/shared/formulas/feed';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { hideMoney } from '../../core/privacy';
import { clientId, listQuery, paged, searchAny, sortBy } from '../../core/query';

const { herds, items, rationLines: lines, rations: t, stockBatches } = schema;

export const rationInput = z.object({
  id: clientId,
  name: z.string().trim().min(1).max(120),
  state: z.enum(PHYSIOLOGICAL_STATES),
  notes: z.string().max(1000).nullish(),
  lines: z
    .array(z.object({ itemId: z.uuid(), kgPerHeadDay: z.number().positive().max(100) }))
    .min(1)
    .max(30),
});
export type RationInput = z.infer<typeof rationInput>;

export const rationListQuery = listQuery.extend({ state: z.enum(PHYSIOLOGICAL_STATES).optional() });

/**
 * Value of one kg of each item: average cost of what is in stock, or the latest batch's cost
 * when the stock has run out. Absent when the item was never received, or its weight is unknown.
 *
 * With `ownProduce: 'left_out'` the farm's own harvest counts at no cost, as farm-level operating
 * expense counts it (rule 3: its cost was counted as it grew). A feed half bought and half grown
 * then costs half its bought price per kg. For a farm-level cost that sits beside crop spending.
 */
export async function unitCostsPerKg(itemIds: string[], opts: { ownProduce?: 'left_out' } = {}): Promise<Map<string, number>> {
  const bought = opts.ownProduce === 'left_out' ? sql`case when ${stockBatches.source} = 'own_harvest' then 0 else ${stockBatches.unitCost} end` : sql`${stockBatches.unitCost}`;
  const result = new Map<string, number>();
  if (itemIds.length === 0) return result;
  const farmId = ctx().farmId;

  const rows = await tx()
    .select({ id: items.id, unit: items.unit, kgPerUnit: items.kgPerUnit })
    .from(items)
    .where(and(eq(items.farmId, farmId), inArray(items.id, itemIds)));
  const weight = new Map(rows.map((r) => [r.id, kgPerUnit(r.unit, r.kgPerUnit)]));

  const onHand = await tx()
    .select({
      itemId: stockBatches.itemId,
      cost: sql<number>`sum(${stockBatches.qtyRemaining} * ${bought}) / sum(${stockBatches.qtyRemaining})`.mapWith(Number),
    })
    .from(stockBatches)
    .where(and(eq(stockBatches.farmId, farmId), inArray(stockBatches.itemId, itemIds), gt(stockBatches.qtyRemaining, 0)))
    .groupBy(stockBatches.itemId);
  const costs = new Map(onHand.map((r) => [r.itemId, r.cost]));

  const missing = itemIds.filter((id) => !costs.has(id));
  if (missing.length > 0) {
    const last = await tx()
      .selectDistinctOn([stockBatches.itemId], { itemId: stockBatches.itemId, cost: sql<number>`${bought}`.mapWith(Number) })
      .from(stockBatches)
      .where(and(eq(stockBatches.farmId, farmId), inArray(stockBatches.itemId, missing)))
      .orderBy(stockBatches.itemId, desc(stockBatches.receivedDate), desc(stockBatches.createdAt));
    for (const row of last) costs.set(row.itemId, row.cost);
  }

  for (const [itemId, cost] of costs) {
    const kg = weight.get(itemId);
    if (kg) result.set(itemId, cost / kg);
  }
  return result;
}

async function withLines(rows: (typeof t.$inferSelect)[]) {
  if (rows.length === 0) return [];
  const lineRows = await tx()
    .select({
      id: lines.id,
      rationId: lines.rationId,
      itemId: lines.itemId,
      itemName: items.name,
      unit: items.unit,
      kgPerHeadDay: lines.kgPerHeadDay,
      dryMatterPct: items.dryMatterPct,
    })
    .from(lines)
    .innerJoin(items, eq(items.id, lines.itemId))
    .where(inArray(lines.rationId, rows.map((r) => r.id)))
    .orderBy(desc(lines.kgPerHeadDay));

  const costs = await unitCostsPerKg([...new Set(lineRows.map((l) => l.itemId))]);
  const winterDays = ctx().settings.feed.winterDays;

  const data = rows.map((ration) => {
    const own = lineRows
      .filter((l) => l.rationId === ration.id)
      .map(({ rationId: _rationId, ...line }) => ({
        ...line,
        dryMatterKg: (() => {
          const dm = dryMatterKg(line.kgPerHeadDay, line.dryMatterPct);
          return dm === null ? null : round(dm, 4);
        })(),
        unitCostPerKg: costs.get(line.itemId) ?? null,
        costPerHeadDay: costs.has(line.itemId) ? line.kgPerHeadDay * costs.get(line.itemId)! : null,
      }));
    // A cost built from partial prices would look real and be wrong (CLAUDE.md rule 5).
    const priced = own.length > 0 && own.every((l) => l.unitCostPerKg !== null);
    const costPerHeadDay = priced
      ? round(
          rationCostPerHeadDay(own.map((l) => ({ kgPerHeadPerDay: l.kgPerHeadDay, unitCostPerKg: l.unitCostPerKg! }))),
          2,
        )
      : null;
    return {
      ...ration,
      lines: hideMoney(own, ['unitCostPerKg', 'costPerHeadDay'], 'feed.approve'),
      totalKgPerHeadDay: round(own.reduce((sum, l) => sum + l.kgPerHeadDay, 0), 4),
      // As-fed kilos of silage and hay do not add up; an expert checks a ration on dry matter.
      totalDryMatterKg: (() => {
        const dm = rationDryMatterKg(own);
        return dm === null ? null : round(dm, 4);
      })(),
      costPerHeadDay,
      costPerSeason: costPerHeadDay === null ? null : round(costPerHeadDay * winterDays, 2),
      seasonDays: winterDays,
    };
  });
  return hideMoney(data, ['costPerHeadDay', 'costPerSeason'], 'feed.approve');
}

export async function list(q: z.infer<typeof rationListQuery>) {
  const where: SQL | undefined = and(
    eq(t.farmId, ctx().farmId),
    eq(t.active, true),
    q.state ? eq(t.state, q.state) : undefined,
    searchAny(q.search, [t.name]),
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select()
      .from(t)
      .where(where)
      .orderBy(...sortBy(q.sort, { name: t.name, state: t.state }, asc(t.name), t.id))
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: await withLines(page.data) };
}

export async function get(id: string) {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Ration');
  const [ration] = await withLines([row]);
  return ration;
}

async function assertLines(rationLines: RationInput['lines']) {
  const ids = rationLines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) {
    throw badRequest('DUPLICATE_RATION_ITEM', 'Each feed can appear only once in a ration');
  }
  const found = await tx()
    .select({ id: items.id, category: items.category })
    .from(items)
    .where(and(eq(items.farmId, ctx().farmId), inArray(items.id, ids)));
  if (found.length !== ids.length) throw notFound('Item');
  if (found.some((i) => i.category !== 'feed')) {
    throw badRequest('NOT_A_FEED_ITEM', 'A ration can only contain feed items');
  }
}

async function writeLines(rationId: string, rationLines: RationInput['lines']) {
  const c = ctx();
  await tx().delete(lines).where(eq(lines.rationId, rationId));
  await tx()
    .insert(lines)
    .values(
      rationLines.map((l) => ({
        tenantId: c.tenantId,
        farmId: c.farmId,
        createdBy: c.userId,
        rationId,
        itemId: l.itemId,
        kgPerHeadDay: l.kgPerHeadDay,
      })),
    );
}

export async function create(input: RationInput) {
  await assertLines(input.lines);
  const c = ctx();
  const { id, lines: rationLines, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await writeLines(row.id, rationLines);
  await recordEvent({ type: 'ration.created', entityType: 'ration', entityId: row.id, data: { name: row.name } });
  return get(row.id);
}

export async function update(id: string, input: Partial<RationInput>) {
  const { id: _ignored, lines: rationLines, ...values } = input;
  if (rationLines) await assertLines(rationLines);
  const [row] = await tx()
    .update(t)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)))
    .returning();
  if (!row) throw notFound('Ration');
  if (rationLines) await writeLines(id, rationLines);
  return get(id);
}

/** Soft delete. A ration still assigned to a herd stays, or feeding plans would silently empty. */
export async function remove(id: string) {
  await get(id);
  const [inUse] = await tx()
    .select({ id: herds.id, name: herds.name })
    .from(herds)
    .where(and(eq(herds.farmId, ctx().farmId), eq(herds.rationId, id), eq(herds.status, 'active')))
    .limit(1);
  if (inUse) throw conflict('RATION_IN_USE', `This ration is assigned to ${inUse.name}`, { herd: inUse.name });
  await tx()
    .update(t)
    .set({ active: false })
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  await recordEvent({ type: 'ration.archived', entityType: 'ration', entityId: id });
  return { id };
}
