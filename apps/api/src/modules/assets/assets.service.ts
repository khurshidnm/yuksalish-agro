import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ASSET_STATUSES, ASSET_TYPES, DEPRECIATION_METHODS } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { deactivateCostCenter, ensureCostCenter, renameCostCenter } from '../../core/costCenters';
import { conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy, sumOf } from '../../core/query';

const { assets: t, assetUsageLogs, costCenters, depreciationEntries, maintenanceRecords } = schema;

export const RENTAL_UNITS = ['ha', 'hour', 'day'] as const;

const MONEY_FIELDS = ['purchasePrice', 'salvageValue', 'rentalPrice'] as const;

type AssetRow = typeof t.$inferSelect;

export const assetInput = z.object({
  id: clientId,
  name: z.string().trim().min(1).max(200),
  type: z.enum(ASSET_TYPES),
  inventoryNo: z.string().trim().min(1).max(60).nullish(),
  purchaseDate: isoDate.nullish(),
  purchasePrice: z.number().min(0).nullish(),
  status: z.enum(ASSET_STATUSES).optional(),
  usefulLifeMonths: z.number().int().positive().max(1200).nullish(),
  salvageValue: z.number().min(0).optional(),
  depreciationMethod: z.enum(DEPRECIATION_METHODS).optional(),
  totalUnits: z.number().positive().nullish(),
  motoHours: z.number().min(0).optional(),
  fuelNormLPerHour: z.number().positive().nullish(),
  fuelNormLPerHa: z.number().positive().nullish(),
  rented: z.boolean().optional(),
  rentalCounterpartyId: z.uuid().nullish(),
  rentalContractId: z.uuid().nullish(),
  rentalPrice: z.number().min(0).nullish(),
  rentalUnit: z.enum(RENTAL_UNITS).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});
export type AssetInput = z.infer<typeof assetInput>;

export const assetListQuery = listQuery.extend({
  type: z.enum(ASSET_TYPES).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
});

export async function getAssetRow(id: string): Promise<AssetRow> {
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Asset');
  return row;
}

/** The asset's cost center; repairs it when an imported asset came without one. */
export async function assetCostCenter(asset: AssetRow): Promise<string> {
  return asset.costCenterId ?? ensureCostCenter('asset', asset.id, asset.name);
}

export async function list(q: z.infer<typeof assetListQuery>) {
  const where = and(
    eq(t.farmId, ctx().farmId),
    q.type ? eq(t.type, q.type) : undefined,
    q.status ? eq(t.status, q.status) : undefined,
    searchAny(q.search, [t.name, t.inventoryNo]),
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select()
      .from(t)
      .where(where)
      .orderBy(
        ...sortBy(
          q.sort,
          { name: t.name, type: t.type, status: t.status, motoHours: t.motoHours, purchaseDate: t.purchaseDate },
          asc(t.name),
          t.id,
        ),
      )
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: hideMoney(page.data, [...MONEY_FIELDS]) };
}

export async function lookup(search: string | undefined, type: string | undefined) {
  return tx()
    .select({ id: t.id, name: t.name, type: t.type, inventoryNo: t.inventoryNo, rented: t.rented })
    .from(t)
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        sql`${t.status} <> 'written_off'`,
        type ? eq(t.type, type) : undefined,
        searchAny(search, [t.name, t.inventoryNo]),
      ),
    )
    .orderBy(asc(t.name))
    .limit(50);
}

/** The registry row plus what the card shows at a glance. */
export async function get(id: string) {
  const asset = await getAssetRow(id);
  const [usage] = await tx()
    .select({
      shifts: sql<number>`count(*)`.mapWith(Number),
      hours: sumOf(assetUsageLogs.motoHours),
      hectares: sumOf(assetUsageLogs.volumeHa),
      fuelL: sumOf(assetUsageLogs.fuelL),
    })
    .from(assetUsageLogs)
    .where(eq(assetUsageLogs.assetId, id));
  const [last] = await tx()
    .select()
    .from(maintenanceRecords)
    .where(eq(maintenanceRecords.assetId, id))
    .orderBy(desc(maintenanceRecords.date), desc(maintenanceRecords.createdAt))
    .limit(1);
  const [depreciation] = await tx()
    .select({ total: sumOf(depreciationEntries.amount) })
    .from(depreciationEntries)
    .where(eq(depreciationEntries.assetId, id));

  const bookValue =
    asset.purchasePrice === null || asset.rented ? null : asset.purchasePrice - depreciation.total;

  const money = hideMoney(
    [{ ...asset, accumulatedDepreciation: depreciation.total as number | null, bookValue }],
    [...MONEY_FIELDS, 'accumulatedDepreciation', 'bookValue'],
  )[0];

  return {
    ...money,
    usage,
    lastMaintenance: last ? hideMoney([last], ['cost'])[0] : null,
    maintenanceDue: last ? dueState(asset, last) : null,
  };
}

/** Service is due by date or by motor-hours, whichever comes first (spec 12.4). */
export function dueState(
  asset: Pick<AssetRow, 'motoHours'>,
  record: Pick<typeof maintenanceRecords.$inferSelect, 'nextDueDate' | 'nextDueMotoHours'>,
) {
  if (!record.nextDueDate && record.nextDueMotoHours === null) return null;
  const byDate = record.nextDueDate !== null && record.nextDueDate < today();
  const byHours = record.nextDueMotoHours !== null && asset.motoHours >= record.nextDueMotoHours;
  return {
    nextDueDate: record.nextDueDate,
    nextDueMotoHours: record.nextDueMotoHours,
    overdue: byDate || byHours,
  };
}

export async function create(input: AssetInput) {
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  const costCenterId = await ensureCostCenter('asset', row.id, row.name);
  const [saved] = await tx().update(t).set({ costCenterId }).where(eq(t.id, row.id)).returning();
  await recordEvent({
    type: 'asset.created',
    entityType: 'asset',
    entityId: row.id,
    data: { name: row.name, type: row.type, inventoryNo: row.inventoryNo },
  });
  return hideMoney([saved], [...MONEY_FIELDS])[0];
}

export async function update(id: string, input: Partial<AssetInput>) {
  const before = await getAssetRow(id);
  const { id: _ignored, ...values } = input;
  const [row] = await tx().update(t).set(values).where(eq(t.id, id)).returning();
  if (values.name && values.name !== before.name && row.costCenterId) {
    await renameCostCenter(row.costCenterId, values.name);
  }
  if (values.status && values.status !== before.status) {
    await recordEvent({
      type: 'asset.status_changed',
      entityType: 'asset',
      entityId: id,
      data: { from: before.status, to: values.status },
    });
  }
  return hideMoney([row], [...MONEY_FIELDS])[0];
}

/** Removes a mistaken entry. An asset with history answers 409 IN_USE: write it off instead. */
export async function remove(id: string) {
  const asset = await getAssetRow(id);
  await tx().delete(t).where(eq(t.id, id));
  if (asset.costCenterId) {
    await deactivateCostCenter(asset.costCenterId);
  }
  await recordEvent({ type: 'asset.deleted', entityType: 'asset', entityId: id, data: { name: asset.name } });
  return { id };
}

export async function assertNotWrittenOff(asset: AssetRow): Promise<void> {
  if (asset.status === 'written_off') {
    throw conflict('ASSET_WRITTEN_OFF', 'This machine has been written off');
  }
}
