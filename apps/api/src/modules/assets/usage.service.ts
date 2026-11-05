import { and, desc, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { deviationPercent } from '@yap/shared';
import { fuelNormLiters } from '@yap/shared/formulas/crops';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { issueStock, reverseMovements } from '../../core/inventory';
import { recordEvent } from '../../core/journal';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, paged, sortBy } from '../../core/query';
import { raiseAlert } from '../alerts/alerts.service';
import { assertNotWrittenOff, assertOnFarm, assetCostCenter, getAssetRow } from './assets.service';
import { bestEffort } from './best-effort';

const { assets, assetUsageLogs: t, employees, fields, items, stockBatches } = schema;

/** Fuel this far above the norm raises an alert, percent (spec 12.3). */
export const FUEL_DEVIATION_ALERT_PERCENT = 15;

export const usageInput = z.object({
  id: clientId,
  date: isoDate,
  operatorEmployeeId: z.uuid().nullish(),
  fieldId: z.uuid().nullish(),
  workType: z.string().trim().max(120).nullish(),
  /** Hours in one shift, not the odometer reading. */
  motoHours: z.number().positive().max(24).nullish(),
  volumeHa: z.number().positive().nullish(),
  fuelL: z.number().min(0).nullish(),
  fuelItemId: z.uuid().nullish(),
  fuelWarehouseId: z.uuid().nullish(),
  /** The fuel did not come from our warehouse, e.g. the contractor brought it. */
  skipFuelIssue: z.boolean().optional(),
  notes: z.string().trim().max(1000).nullish(),
});
export type UsageInput = z.infer<typeof usageInput>;

export const usageListQuery = listQuery.extend({ from: isoDate.optional(), to: isoDate.optional() });

type UsageRow = typeof t.$inferSelect;

async function resolveFuelSource(itemId?: string | null, warehouseId?: string | null) {
  if (itemId && warehouseId) return { itemId, warehouseId };
  const [best] = await tx()
    .select({
      itemId: stockBatches.itemId,
      warehouseId: stockBatches.warehouseId,
      qty: sql<number>`sum(${stockBatches.qtyRemaining})`.mapWith(Number),
    })
    .from(stockBatches)
    .innerJoin(items, eq(items.id, stockBatches.itemId))
    .where(
      and(
        eq(stockBatches.farmId, ctx().farmId),
        eq(items.category, 'fuel'),
        eq(items.active, true),
        sql`${stockBatches.qtyRemaining} > 0`,
        itemId ? eq(stockBatches.itemId, itemId) : undefined,
        warehouseId ? eq(stockBatches.warehouseId, warehouseId) : undefined,
      ),
    )
    .groupBy(stockBatches.itemId, stockBatches.warehouseId)
    .orderBy(sql`3 desc`)
    .limit(1);
  if (!best) {
    throw badRequest('FUEL_ITEM_REQUIRED', 'Choose the fuel and warehouse, or mark the fuel as not from stock');
  }
  return { itemId: best.itemId, warehouseId: best.warehouseId };
}

function fuelCheck(asset: typeof assets.$inferSelect, row: Pick<UsageRow, 'motoHours' | 'volumeHa' | 'fuelL'>) {
  const norm = fuelNormLiters({
    motoHours: row.motoHours,
    volumeHa: row.volumeHa,
    normLPerHour: asset.fuelNormLPerHour,
    normLPerHa: asset.fuelNormLPerHa,
  });
  const liters = row.fuelL ?? 0;
  return { fuelNormL: norm, fuelDeviationPercent: norm === null || liters <= 0 ? null : deviationPercent(liters, norm) };
}

/**
 * One shift of a machine (spec 12.2). Adds to the motor-hours and charges fuel from the warehouse
 * to the machine's own cost center, which is what the cost per hour and per hectare is built from.
 */
export async function logUsage(input: UsageInput & { assetId: string; operationId?: string | null }) {
  const asset = await getAssetRow(input.assetId);
  await assertNotWrittenOff(asset);
  await assertOnFarm(fields, input.fieldId, 'Field');
  const c = ctx();
  const id = input.id ?? uuidv7();
  const liters = input.fuelL ?? 0;

  let fuelCost = 0;
  let fuelItemId: string | null = null;
  let fuelWarehouseId: string | null = null;
  if (liters > 0 && !input.skipFuelIssue) {
    const source = await resolveFuelSource(input.fuelItemId, input.fuelWarehouseId);
    fuelItemId = source.itemId;
    fuelWarehouseId = source.warehouseId;
    const issue = await issueStock({
      ...source,
      qty: liters,
      date: input.date,
      costCenterId: await assetCostCenter(asset),
      reason: 'fuel',
      refType: 'asset_usage',
      refId: id,
    });
    fuelCost = issue.totalCost;
  }

  const [row] = await tx()
    .insert(t)
    .values({
      id,
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      assetId: asset.id,
      date: input.date,
      operatorEmployeeId: input.operatorEmployeeId,
      fieldId: input.fieldId,
      operationId: input.operationId,
      workType: input.workType,
      motoHours: input.motoHours,
      volumeHa: input.volumeHa,
      fuelL: input.fuelL,
      fuelItemId,
      fuelWarehouseId,
      fuelCost,
      notes: input.notes,
    })
    .returning();

  if (input.motoHours) {
    await tx()
      .update(assets)
      .set({ motoHours: sql`${assets.motoHours} + ${input.motoHours}` })
      .where(eq(assets.id, asset.id));
  }

  const check = fuelCheck(asset, row);
  await recordEvent({
    type: 'asset.used',
    entityType: 'asset',
    entityId: asset.id,
    occurredAt: input.date,
    data: { motoHours: input.motoHours, volumeHa: input.volumeHa, fuelL: input.fuelL, fieldId: input.fieldId, logId: id },
  });

  if (check.fuelDeviationPercent !== null && check.fuelDeviationPercent > FUEL_DEVIATION_ALERT_PERCENT) {
    const percent = Math.round(check.fuelDeviationPercent);
    await recordEvent({
      type: 'asset.fuel_deviation',
      severity: 'attention',
      entityType: 'asset',
      entityId: asset.id,
      occurredAt: input.date,
      data: { fuelL: liters, normL: check.fuelNormL, percent, logId: id },
    });
    await bestEffort(() =>
      raiseAlert({
        ruleKey: 'asset_fuel_deviation',
        dedupKey: `asset_fuel_deviation:${asset.id}:${input.date}`,
        severity: 'attention',
        title: `Yoqilg'i me'yordan ${percent}% ortiq: ${asset.name}`,
        body: `${input.date}: sarf ${liters} l, me'yor ${check.fuelNormL} l.`,
        link: `/assets/${asset.id}`,
        entityType: 'asset',
        entityId: asset.id,
        source: 'rule',
        notify: ['director', 'agronomist'],
        data: { name: asset.name, date: input.date, fuelL: liters, normL: check.fuelNormL, percent },
      }),
    );
  }

  return { ...hideMoney([row], ['fuelCost'])[0], ...check };
}

/** Locked, so a rental act billing this shift at this moment is seen before it is changed. */
async function getLog(assetId: string, logId: string): Promise<UsageRow> {
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, logId), eq(t.assetId, assetId), eq(t.farmId, ctx().farmId)))
    .for('update');
  if (!row) throw notFound('Usage log');
  return row;
}

async function undoUsage(row: UsageRow): Promise<void> {
  if (row.billedTransactionId) {
    throw conflict('USAGE_ALREADY_BILLED', 'This shift is already on a rental act');
  }
  await reverseMovements('asset_usage', row.id);
  if (row.motoHours) {
    await tx()
      .update(assets)
      .set({ motoHours: sql`greatest(${assets.motoHours} - ${row.motoHours}, 0)` })
      .where(eq(assets.id, row.assetId));
  }
  await tx().delete(t).where(eq(t.id, row.id));
}

function assertStandalone(row: UsageRow): void {
  if (row.operationId) {
    throw conflict('USAGE_LINKED_TO_OPERATION', 'This shift belongs to a field operation: change it there');
  }
}

/** Edit by undoing and re-posting, so stock, cost and motor-hours stay exact. */
export async function updateUsage(assetId: string, logId: string, input: Partial<UsageInput>) {
  const row = await getLog(assetId, logId);
  assertStandalone(row);
  await undoUsage(row);
  const { id: _ignored, ...changes } = input;
  return logUsage({
    id: row.id,
    assetId,
    date: row.date,
    operatorEmployeeId: row.operatorEmployeeId,
    fieldId: row.fieldId,
    workType: row.workType,
    motoHours: row.motoHours,
    volumeHa: row.volumeHa,
    fuelL: row.fuelL,
    fuelItemId: row.fuelItemId,
    fuelWarehouseId: row.fuelWarehouseId,
    skipFuelIssue: !row.fuelItemId,
    notes: row.notes,
    ...changes,
  });
}

export async function removeUsage(assetId: string, logId: string) {
  const row = await getLog(assetId, logId);
  assertStandalone(row);
  await undoUsage(row);
  await recordEvent({ type: 'asset.usage_deleted', entityType: 'asset', entityId: assetId, data: { logId } });
  return { id: logId };
}

/** Called when a field operation is edited or deleted. Returns what it removed, for re-posting. */
export async function removeUsageForOperation(operationId: string): Promise<UsageRow | null> {
  const rows = await tx()
    .select()
    .from(t)
    .where(and(eq(t.operationId, operationId), eq(t.farmId, ctx().farmId)))
    .for('update');
  for (const row of rows) await undoUsage(row);
  return rows[0] ?? null;
}

export async function listUsage(assetId: string, q: z.infer<typeof usageListQuery>) {
  await getAssetRow(assetId);
  const where = and(
    eq(t.assetId, assetId),
    q.from ? sql`${t.date} >= ${q.from}` : undefined,
    q.to ? sql`${t.date} <= ${q.to}` : undefined,
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select({
        id: t.id,
        assetId: t.assetId,
        date: t.date,
        operatorEmployeeId: t.operatorEmployeeId,
        operatorName: employees.fullName,
        fieldId: t.fieldId,
        fieldNumber: fields.number,
        operationId: t.operationId,
        workType: t.workType,
        motoHours: t.motoHours,
        volumeHa: t.volumeHa,
        fuelL: t.fuelL,
        fuelItemId: t.fuelItemId,
        fuelCost: t.fuelCost,
        billedTransactionId: t.billedTransactionId,
        notes: t.notes,
      })
      .from(t)
      .leftJoin(employees, eq(employees.id, t.operatorEmployeeId))
      .leftJoin(fields, eq(fields.id, t.fieldId))
      .where(where)
      .orderBy(...sortBy(q.sort, { date: t.date, motoHours: t.motoHours, fuelL: t.fuelL }, desc(t.date), t.id))
      .limit(limit)
      .offset(offset),
  );
  const asset = await getAssetRow(assetId);
  const data = page.data.map((row) => ({ ...row, ...fuelCheck(asset, row) }));
  return { ...page, data: hideMoney(data, ['fuelCost']) };
}
