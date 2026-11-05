import { and, asc, desc, eq, getTableColumns, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { HERD_CONDITIONS, deviationPercent, round } from '@yap/shared';
import { itemUnitToKg, kgToItemUnit } from '@yap/shared/formulas/livestock';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { issueStock, reverseMovements } from '../../core/inventory';
import { recordEvent } from '../../core/journal';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, paged, sortBy, sumOf } from '../../core/query';
import { signedFileUrl } from '../files';
import { raiseAlert } from '../alerts/alerts.service';
import { assertInFarm, assertNotFuture, getHerdOrThrow, herdHeadCount, type Herd } from './refs';

const {
  dailyLogLines: lines,
  dailyLogs: logs,
  herds,
  items,
  rationLines,
  stockBatches,
  warehouses,
} = schema;

const lineInput = z.object({
  itemId: z.uuid(),
  warehouseId: z.uuid().nullish(),
  actualQty: z.number().min(0).max(10_000_000),
});

export const dailyLogInput = z.object({
  /** Generated on the device, so a retry after a lost response cannot create a second log. */
  id: clientId,
  herdId: z.uuid(),
  date: isoDate.optional(),
  headCount: z.number().int().min(0).optional(),
  waterL: z.number().min(0).max(100_000_000).nullish(),
  condition: z.enum(HERD_CONDITIONS).optional(),
  photoFileIds: z.array(z.uuid()).max(10).optional(),
  notes: z.string().max(1000).nullish(),
  lines: z.array(lineInput).max(30).default([]),
});

export const dailyLogUpdate = z.object({
  headCount: z.number().int().min(0).optional(),
  waterL: z.number().min(0).max(100_000_000).nullish(),
  condition: z.enum(HERD_CONDITIONS).optional(),
  photoFileIds: z.array(z.uuid()).max(10).optional(),
  notes: z.string().max(1000).nullish(),
  lines: z.array(lineInput).max(30).optional(),
  /** The version the client edited. A newer one on the server means a conflict to resolve by hand. */
  baseUpdatedAt: z.iso.datetime({ offset: true }).optional(),
});

export const dailyLogListQuery = listQuery.extend({
  herdId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  condition: z.enum(HERD_CONDITIONS).optional(),
});

export interface PlannedLine {
  itemId: string;
  itemName: string;
  unit: string;
  kgPerHeadDay: number;
  plannedQty: number;
}

/** Ration × head count, in each item's own stock unit (spec 9.3). */
async function plannedLines(herd: Herd, head: number): Promise<PlannedLine[]> {
  if (!herd.rationId) return [];
  const rows = await tx()
    .select({
      itemId: rationLines.itemId,
      itemName: items.name,
      unit: items.unit,
      kgPerHeadDay: rationLines.kgPerHeadDay,
    })
    .from(rationLines)
    .innerJoin(items, eq(items.id, rationLines.itemId))
    .where(eq(rationLines.rationId, herd.rationId))
    .orderBy(asc(items.name));
  return rows.map((row) => ({
    ...row,
    plannedQty: round(kgToItemUnit(row.kgPerHeadDay * head, row.unit), 3),
  }));
}

async function stockByWarehouse(itemId: string) {
  return tx()
    .select({ warehouseId: stockBatches.warehouseId, qty: sumOf(stockBatches.qtyRemaining) })
    .from(stockBatches)
    .where(and(eq(stockBatches.farmId, ctx().farmId), eq(stockBatches.itemId, itemId)))
    .groupBy(stockBatches.warehouseId);
}

/**
 * A shepherd does not know which store a feed came from. Use the item's usual warehouse if it can
 * cover the quantity, otherwise the one holding the most. Only a true shortage stops the entry.
 */
async function chooseWarehouse(itemId: string, qty: number, given?: string | null): Promise<string | null> {
  if (given) {
    await assertInFarm(warehouses, given, 'Warehouse');
    return given;
  }
  const [item] = await tx()
    .select({ defaultWarehouseId: items.defaultWarehouseId })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.farmId, ctx().farmId)));
  if (!item) throw badRequest('INVALID_REFERENCE', 'Item was not found on this farm', { field: 'Item' });

  const stock = await stockByWarehouse(itemId);
  const usual = stock.find((s) => s.warehouseId === item.defaultWarehouseId);
  if (usual && usual.qty >= qty) return usual.warehouseId;
  const largest = [...stock].sort((a, b) => b.qty - a.qty)[0];
  if (largest) return largest.warehouseId;
  if (item.defaultWarehouseId) return item.defaultWarehouseId;
  // "None given" is a fact worth keeping, even for a feed no warehouse has ever held.
  if (qty === 0) return null;
  throw badRequest('WAREHOUSE_REQUIRED', 'No warehouse holds this feed', { itemId });
}

interface Deviation {
  itemId: string;
  itemName: string;
  plannedQty: number;
  actualQty: number;
  percent: number;
}

/** Items outside the allowed band, in either direction (spec 15.3 scenario 2). */
function findDeviations(planned: PlannedLine[], actual: Map<string, number>, threshold: number): Deviation[] {
  const found: Deviation[] = [];
  for (const line of planned) {
    const actualQty = actual.get(line.itemId) ?? 0;
    const raw = deviationPercent(actualQty, line.plannedQty);
    if (raw === null) continue;
    // Rounded before comparing: in binary floats exactly 15 % comes out as 15.000000000000004.
    const percent = round(raw, 1);
    if (Math.abs(percent) > threshold) {
      found.push({ itemId: line.itemId, itemName: line.itemName, plannedQty: line.plannedQty, actualQty, percent });
    }
  }
  return found;
}

/** Insert the lines and charge the feed to the herd. Called on create and after a reversal. */
async function postLines(
  logId: string,
  herd: Herd,
  date: string,
  planned: PlannedLine[],
  input: z.infer<typeof lineInput>[],
): Promise<void> {
  const c = ctx();
  const seen = new Set<string>();
  for (const line of input) {
    if (seen.has(line.itemId)) throw badRequest('DUPLICATE_LINE', 'The same feed is listed twice', { itemId: line.itemId });
    seen.add(line.itemId);
  }

  // A ration item left out of a feeding record was not given, so it is stored as zero.
  const omitted = input.length
    ? planned.filter((p) => !seen.has(p.itemId)).map((p) => ({ itemId: p.itemId, warehouseId: null, actualQty: 0 }))
    : [];

  for (const line of [...input, ...omitted]) {
    const plan = planned.find((p) => p.itemId === line.itemId);
    const warehouseId = await chooseWarehouse(line.itemId, line.actualQty, line.warehouseId);
    if (!warehouseId) continue;
    let totalCost = 0;
    if (line.actualQty > 0) {
      const issue = await issueStock({
        itemId: line.itemId,
        warehouseId,
        qty: line.actualQty,
        date,
        costCenterId: herd.costCenterId,
        reason: 'ration',
        refType: 'daily_log',
        refId: logId,
      });
      totalCost = issue.totalCost;
    }
    await tx()
      .insert(lines)
      .values({
        tenantId: c.tenantId,
        farmId: c.farmId,
        createdBy: c.userId,
        logId,
        itemId: line.itemId,
        warehouseId,
        plannedQty: plan?.plannedQty ?? 0,
        actualQty: line.actualQty,
        totalCost,
      });
  }
}

async function totalsInKg(logId: string): Promise<{ plannedKg: number; actualKg: number }> {
  const rows = await tx()
    .select({ planned: lines.plannedQty, actual: lines.actualQty, unit: items.unit })
    .from(lines)
    .innerJoin(items, eq(items.id, lines.itemId))
    .where(eq(lines.logId, logId));
  return {
    plannedKg: round(rows.reduce((sum, r) => sum + itemUnitToKg(r.planned, r.unit), 0), 3),
    actualKg: round(rows.reduce((sum, r) => sum + itemUnitToKg(r.actual, r.unit), 0), 3),
  };
}

/**
 * Journal the feeds that strayed, and raise the alert at once when the herd's total did.
 * The alert uses the rule engine's own key and level: it re-checks this rule every hour and
 * resolves anything it does not find itself, so a second definition here would flicker.
 */
async function reportDeviations(herd: Herd, date: string, logId: string, deviations: Deviation[]): Promise<void> {
  if (deviations.length > 0) {
    await recordEvent({
      type: 'herd.feed_deviation',
      entityType: 'herd',
      entityId: herd.id,
      severity: 'attention',
      occurredAt: date,
      data: { logId, deviations },
    });
  }

  const { plannedKg, actualKg } = await totalsInKg(logId);
  const raw = deviationPercent(actualKg, plannedKg);
  if (raw === null) return;
  const percent = round(raw, 1);
  const threshold = ctx().settings.feed.deviationPercent;
  if (Math.abs(percent) <= threshold) return;

  await raiseAlert({
    ruleKey: 'ration_deviation',
    dedupKey: `ration_deviation:${herd.id}:${date}`,
    severity: 'attention',
    title: `${herd.name}: ozuqa sarfi me'yordan chetlandi`,
    body: `${date} kuni farq ${percent}%: berilgan ${actualKg}, me'yor ${plannedKg}.`,
    link: '/livestock/daily-logs',
    entityType: 'herd',
    entityId: herd.id,
    data: { herd: herd.name, date, percent, actual: actualKg, planned: plannedKg },
  });
}

async function reportCondition(herd: Herd, date: string, notes: string | null | undefined): Promise<void> {
  await raiseAlert({
    ruleKey: 'herd_condition',
    dedupKey: `herd_condition:${herd.id}:${date}`,
    severity: 'attention',
    title: `Podada og'ish qayd etildi: ${herd.name}`,
    body: notes ?? undefined,
    link: `/livestock/herds/${herd.id}`,
    entityType: 'herd',
    entityId: herd.id,
    notify: ['zootechnician', 'veterinarian', 'director'],
    data: { date, herd: herd.name },
  });
}

/** Everything the form needs: the plan, stock on hand, and whether this day is already logged. */
export async function getPlan(herdId: string, date: string) {
  const herd = await getHerdOrThrow(herdId);
  const head = await herdHeadCount(herdId);
  const planned = await plannedLines(herd, head);
  const stock = planned.length
    ? await tx()
        .select({ itemId: stockBatches.itemId, qty: sumOf(stockBatches.qtyRemaining) })
        .from(stockBatches)
        .where(and(eq(stockBatches.farmId, ctx().farmId), inArray(stockBatches.itemId, planned.map((p) => p.itemId))))
        .groupBy(stockBatches.itemId)
    : [];
  const [existing] = await tx()
    .select({ id: logs.id })
    .from(logs)
    .where(and(eq(logs.herdId, herdId), eq(logs.date, date)));
  return {
    herd: { id: herd.id, name: herd.name, rationId: herd.rationId, headCount: head },
    date,
    logId: existing?.id ?? null,
    lines: planned.map((p) => ({
      ...p,
      qtyOnHand: stock.find((s) => s.itemId === p.itemId)?.qty ?? 0,
    })),
  };
}

/** Herds and whether each is logged for the date: the shepherd's starting screen. */
export async function dayOverview(date: string) {
  const rows = await tx()
    .select({ id: herds.id, name: herds.name, state: herds.state, logId: logs.id, condition: logs.condition })
    .from(herds)
    .leftJoin(logs, and(eq(logs.herdId, herds.id), eq(logs.date, date)))
    .where(and(eq(herds.farmId, ctx().farmId), eq(herds.status, 'active')))
    .orderBy(asc(herds.name));
  const result = [];
  for (const row of rows) {
    result.push({ ...row, headCount: await herdHeadCount(row.id), logged: row.logId !== null });
  }
  return { date, herds: result };
}

export async function createDailyLog(input: z.infer<typeof dailyLogInput>) {
  const c = ctx();
  const date = input.date ?? today();
  assertNotFuture(date);

  // The lock serialises two people logging the same herd, so both see the same stock and plan.
  const herd = await getHerdOrThrow(input.herdId, { lock: true });
  if (herd.status !== 'active') throw badRequest('HERD_ARCHIVED', 'This herd is archived');

  const [existing] = await tx()
    .select()
    .from(logs)
    .where(and(eq(logs.herdId, input.herdId), eq(logs.date, date)));
  if (existing) {
    // The same device retrying after a lost response is a success, not a clash.
    if (input.id && existing.id === input.id) return getDailyLog(existing.id);
    throw conflict('DAILY_LOG_EXISTS', 'This herd already has a record for this day', { id: existing.id, date });
  }

  const registered = await herdHeadCount(herd.id);
  const planned = await plannedLines(herd, registered);
  const condition = input.condition ?? 'normal';

  const [log] = await tx()
    .insert(logs)
    .values({
      ...(input.id ? { id: input.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      herdId: herd.id,
      date,
      headCount: input.headCount ?? registered,
      waterL: input.waterL,
      condition,
      photoFileIds: input.photoFileIds ?? [],
      notes: input.notes,
    })
    .returning();

  await postLines(log.id, herd, date, planned, input.lines);

  // A log with no feed lines is an observation, e.g. a herd out on pasture: there is nothing to compare.
  const deviations =
    input.lines.length > 0
      ? findDeviations(planned, new Map(input.lines.map((l) => [l.itemId, l.actualQty])), c.settings.feed.deviationPercent)
      : [];

  await recordEvent({
    type: 'herd.daily_log',
    entityType: 'herd',
    entityId: herd.id,
    occurredAt: date,
    photoFileId: log.photoFileIds[0] ?? null,
    data: {
      logId: log.id,
      headCount: log.headCount,
      registeredHead: registered,
      waterL: log.waterL,
      condition,
    },
  });
  await reportDeviations(herd, date, log.id, deviations);
  if (condition === 'deviation') await reportCondition(herd, date, input.notes);

  return { ...(await getDailyLog(log.id)), deviations };
}

async function getLogRow(id: string, opts: { lock?: boolean } = {}) {
  const query = tx()
    .select()
    .from(logs)
    .where(and(eq(logs.id, id), eq(logs.farmId, ctx().farmId)));
  const [row] = await (opts.lock ? query.for('update') : query);
  if (!row) throw notFound('Daily log');
  return row;
}

/** A shepherd may fix their own entry on the same day. Older records need livestock.update. */
function assertCanEdit(log: typeof logs.$inferSelect): void {
  if (hasPermission('livestock.update')) return;
  if (log.createdBy !== ctx().userId || log.date !== today()) {
    throw forbidden('Only your own record for today can be corrected', 'EDIT_WINDOW_CLOSED', { id: log.id });
  }
}

export async function updateDailyLog(id: string, input: z.infer<typeof dailyLogUpdate>) {
  const log = await getLogRow(id, { lock: true });
  assertCanEdit(log);
  if (input.baseUpdatedAt && new Date(input.baseUpdatedAt).getTime() !== log.updatedAt.getTime()) {
    throw conflict('STALE_UPDATE', 'Someone changed this record while you were editing', {
      updatedAt: log.updatedAt,
    });
  }

  const herd = await getHerdOrThrow(log.herdId);
  const { lines: newLines, baseUpdatedAt: _base, ...values } = input;
  // Checked here because updatedAt is always set below, so the kernel would never see an empty update.
  if (!newLines && Object.keys(values).length === 0) throw badRequest('NOTHING_TO_UPDATE', 'No changes were sent');

  if (newLines) {
    // Stock goes back first, so a corrected quantity can use what the old one had taken.
    await reverseMovements('daily_log', id);
    await tx().delete(lines).where(eq(lines.logId, id));
    const registered = await herdHeadCount(herd.id);
    const planned = await plannedLines(herd, registered);
    await postLines(id, herd, log.date, planned, newLines);
    const deviations = newLines.length
      ? findDeviations(planned, new Map(newLines.map((l) => [l.itemId, l.actualQty])), ctx().settings.feed.deviationPercent)
      : [];
    await reportDeviations(herd, log.date, id, deviations);
  }
  if (input.condition === 'deviation' && log.condition !== 'deviation') {
    await reportCondition(herd, log.date, input.notes ?? log.notes);
  }

  // Always bump updatedAt: a change to the lines alone is still a new version of the record.
  await tx()
    .update(logs)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(logs.id, id));
  await recordEvent({ type: 'herd.daily_log_corrected', entityType: 'herd', entityId: herd.id, occurredAt: log.date, data: { logId: id } });
  return getDailyLog(id);
}

export async function deleteDailyLog(id: string) {
  const log = await getLogRow(id, { lock: true });
  await reverseMovements('daily_log', id);
  await tx().delete(logs).where(eq(logs.id, id));
  await recordEvent({ type: 'herd.daily_log_deleted', entityType: 'herd', entityId: log.herdId, occurredAt: log.date, data: { logId: id } });
  return { id };
}

export async function getDailyLog(id: string) {
  const log = await getLogRow(id);
  const [herd] = await tx().select({ name: herds.name }).from(herds).where(eq(herds.id, log.herdId));
  const rows = await tx()
    .select({ ...getTableColumns(lines), itemName: items.name, unit: items.unit, warehouseName: warehouses.name })
    .from(lines)
    .innerJoin(items, eq(items.id, lines.itemId))
    .leftJoin(warehouses, eq(warehouses.id, lines.warehouseId))
    .where(eq(lines.logId, id))
    .orderBy(asc(items.name));
  const photos = [];
  for (const fileId of log.photoFileIds) photos.push({ id: fileId, url: await signedFileUrl(fileId) });
  return {
    ...log,
    herdName: herd?.name ?? null,
    lines: hideMoney(rows, ['totalCost']),
    photos,
  };
}

const kgExpr = (column: typeof lines.plannedQty | typeof lines.actualQty) =>
  sql`case when ${items.unit} = 't' then ${column} * 1000 else ${column} end`;

export async function listDailyLogs(q: z.infer<typeof dailyLogListQuery>) {
  const where = and(
    eq(logs.farmId, ctx().farmId),
    q.herdId ? eq(logs.herdId, q.herdId) : undefined,
    q.from ? gte(logs.date, q.from) : undefined,
    q.to ? lte(logs.date, q.to) : undefined,
    q.condition ? eq(logs.condition, q.condition) : undefined,
  );
  const page = await paged(q, logs, where, (limit, offset) =>
    tx()
      .select({ ...getTableColumns(logs), herdName: herds.name })
      .from(logs)
      .innerJoin(herds, eq(herds.id, logs.herdId))
      .where(where)
      .orderBy(...sortBy(q.sort, { date: logs.date, herdName: herds.name }, desc(logs.date), logs.id))
      .limit(limit)
      .offset(offset),
  );

  const ids = page.data.map((row) => row.id);
  const totals = ids.length
    ? await tx()
        .select({
          logId: lines.logId,
          plannedKg: sumOf(kgExpr(lines.plannedQty)),
          actualKg: sumOf(kgExpr(lines.actualQty)),
          totalCost: sumOf(lines.totalCost),
        })
        .from(lines)
        .innerJoin(items, eq(items.id, lines.itemId))
        .where(inArray(lines.logId, ids))
        .groupBy(lines.logId)
    : [];
  const byLog = new Map(totals.map((row) => [row.logId, row]));

  const data = page.data.map((row) => {
    const total = byLog.get(row.id);
    const percent = total ? deviationPercent(total.actualKg, total.plannedKg) : null;
    return {
      ...row,
      plannedKg: total?.plannedKg ?? null,
      actualKg: total?.actualKg ?? null,
      deviationPercent: percent === null ? null : round(percent, 1),
      totalCost: total?.totalCost ?? null,
    };
  });
  return { ...page, data: hideMoney(data, ['totalCost']) };
}
