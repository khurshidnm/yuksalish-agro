import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ASSET_STATUSES, ASSET_TYPES, CURRENCIES, DEPRECIATION_METHODS, assetBookValue, monthRange, round, toBaseAmount } from '@yap/shared';
import { schema } from '../../db/client';
import { canSeeMoney, ctx, today, tx } from '../../core/context';
import { activateCostCenter, deactivateCostCenter, ensureCostCenter, renameCostCenter } from '../../core/costCenters';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { resolveFxRate } from '../../core/ledger';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy, sumOf } from '../../core/query';

const { assets: t, assetUsageLogs, contracts, counterparties, depreciationEntries, fields, maintenanceRecords } = schema;

export const RENTAL_UNITS = ['ha', 'hour', 'day'] as const;

const MONEY_FIELDS = ['purchasePrice', 'purchaseAmount', 'purchaseCurrency', 'purchaseFxRate', 'salvageValue', 'rentalPrice', 'openingDepreciation', 'openingDepreciationDate'] as const;

type AssetRow = typeof t.$inferSelect;

export const assetInput = z.object({
  id: clientId,
  name: z.string().trim().min(1).max(200),
  type: z.enum(ASSET_TYPES),
  inventoryNo: z.string().trim().min(1).max(60).nullish(),
  purchaseDate: isoDate.nullish(),
  purchasePrice: z.number().min(0).nullish(),
  /** A price paid in another currency. purchasePrice is then worked out here, not taken from the request. */
  purchaseAmount: z.number().positive().nullish(),
  purchaseCurrency: z.enum(CURRENCIES).nullish(),
  /** Empty takes the stored rate for the purchase date. */
  purchaseFxRate: z.number().positive().nullish(),
  status: z.enum(ASSET_STATUSES).optional(),
  usefulLifeMonths: z.number().int().positive().max(1200).nullish(),
  salvageValue: z.number().min(0).optional(),
  depreciationMethod: z.enum(DEPRECIATION_METHODS).optional(),
  totalUnits: z.number().positive().nullish(),
  openingDepreciation: z.number().min(0).optional(),
  openingDepreciationDate: isoDate.nullish(),
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

/** Foreign keys ignore RLS, so an id from a request is confirmed against this farm first. */
export async function assertOnFarm(table: typeof contracts | typeof counterparties | typeof fields, id: string | null | undefined, what: string): Promise<void> {
  if (!id) return;
  const [row] = await tx()
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.farmId, ctx().farmId)));
  if (!row) throw notFound(what);
}

async function assertRentalRefs(input: Partial<AssetInput>): Promise<void> {
  await assertOnFarm(counterparties, input.rentalCounterpartyId, 'Counterparty');
  await assertOnFarm(contracts, input.rentalContractId, 'Contract');
}

/** Who cannot see a figure cannot set it either. The web form leaves these fields out for them. */
function assertMayWriteMoney(input: Partial<AssetInput>): void {
  if (!canSeeMoney() && MONEY_FIELDS.some((field) => input[field] !== undefined)) throw forbidden();
}

type PriceFields = Pick<AssetInput, 'purchasePrice' | 'purchaseAmount' | 'purchaseFxRate'> & { purchaseCurrency?: string | null };

/**
 * What a request does to the price. Paid in another currency, the contract figure and its rate are kept
 * and purchasePrice holds what that came to in the base currency. A bare purchasePrice is a base price.
 */
async function priceFields(input: Partial<AssetInput>, before?: AssetRow): Promise<PriceFields> {
  const { purchaseAmount, purchaseCurrency, purchaseFxRate, purchasePrice } = input;
  const foreignGiven = [purchaseAmount, purchaseCurrency, purchaseFxRate].some((value) => value !== undefined);
  if (!foreignGiven && purchasePrice === undefined) return {};

  const currency = !foreignGiven ? null : purchaseCurrency === undefined ? before?.purchaseCurrency : purchaseCurrency;
  if (!currency || currency === ctx().currency) return { purchaseAmount: null, purchaseCurrency: null, purchaseFxRate: null };

  const amount = purchaseAmount === undefined ? before?.purchaseAmount : purchaseAmount;
  if (!amount) throw badRequest('PURCHASE_AMOUNT_REQUIRED', 'A price in another currency needs its amount');
  const date = input.purchaseDate === undefined ? before?.purchaseDate : input.purchaseDate;
  if (!date) throw badRequest('PURCHASE_DATE_REQUIRED', 'A price in another currency needs the purchase date for its rate');
  // A saved rate belongs to the currency it was saved with.
  const saved = currency === before?.purchaseCurrency ? before.purchaseFxRate : null;
  const fxRate = await resolveFxRate(currency, date, purchaseFxRate === undefined ? saved : purchaseFxRate);
  return { purchaseAmount: amount, purchaseCurrency: currency, purchaseFxRate: fxRate, purchasePrice: toBaseAmount(amount, fxRate) };
}

export function isInOpening(asset: AssetRow, month: string): boolean {
  const date = asset.openingDepreciationDate;
  return asset.openingDepreciation > 0 && date !== null && monthRange(month).to <= date;
}

/**
 * The opening figure holds the months ended by its date, posted entries hold the months after it, so
 * no month is counted twice. Together they never go past what can be depreciated.
 */
async function assertOpening(asset: Partial<AssetRow>): Promise<void> {
  const { id, openingDepreciation: amount = 0, openingDepreciationDate: date, purchaseDate, purchasePrice, salvageValue = 0 } = asset;
  if (amount === 0 || asset.rented) return;
  if (!date) throw badRequest('OPENING_DATE_REQUIRED', 'Opening depreciation needs the date it stands at');
  if (date > today() || (purchaseDate && date < purchaseDate)) {
    throw badRequest('OPENING_DATE_INVALID', 'The opening date must fall between the purchase date and today');
  }
  const entries = id
    ? await tx()
        .select({ month: depreciationEntries.month, amount: depreciationEntries.amount })
        .from(depreciationEntries)
        .where(eq(depreciationEntries.assetId, id))
    : [];
  if (entries.some((entry) => monthRange(entry.month).to <= date)) {
    throw conflict('OPENING_OVERLAPS_POSTED', 'A month up to this date is already posted, so the opening figure would count it twice');
  }
  const accumulated = entries.reduce((sum, entry) => sum + entry.amount, amount);
  if (round(accumulated - ((purchasePrice ?? 0) - salvageValue), 2) > 0) {
    throw badRequest('OPENING_TOO_HIGH', 'Depreciation cannot be more than the purchase price less the salvage value');
  }
}

function ownRow(id: string) {
  return and(eq(t.id, id), eq(t.farmId, ctx().farmId));
}

export async function getAssetRow(id: string): Promise<AssetRow> {
  const [row] = await tx().select().from(t).where(ownRow(id));
  if (!row) throw notFound('Asset');
  return row;
}

/** A depreciation run holds the same lock, so neither acts on what the other is about to change. */
async function lockAssetRow(id: string): Promise<AssetRow> {
  const [row] = await tx().select().from(t).where(ownRow(id)).for('update');
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

  const accumulatedDepreciation: number | null = round(asset.openingDepreciation + depreciation.total, 2);
  const bookValue = asset.rented ? null : assetBookValue(asset.purchasePrice, asset.openingDepreciation, depreciation.total);

  const money = hideMoney(
    [{ ...asset, accumulatedDepreciation, bookValue }],
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
  assertMayWriteMoney(input);
  await assertRentalRefs(input);
  const c = ctx();
  const { id, ...rest } = input;
  const values = { ...rest, ...(await priceFields(rest)) };
  await assertOpening(values);
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  const costCenterId = await ensureCostCenter('asset', row.id, row.name);
  const [saved] = await tx().update(t).set({ costCenterId }).where(eq(t.id, row.id)).returning();
  if (saved.status === 'written_off') await deactivateCostCenter(costCenterId);
  await recordEvent({
    type: 'asset.created',
    entityType: 'asset',
    entityId: row.id,
    data: { name: row.name, type: row.type, inventoryNo: row.inventoryNo },
  });
  return hideMoney([saved], [...MONEY_FIELDS])[0];
}

export async function update(id: string, input: Partial<AssetInput>) {
  assertMayWriteMoney(input);
  const before = await lockAssetRow(id);
  await assertRentalRefs(input);
  const { id: _ignored, ...rest } = input;
  const values = { ...rest, ...(await priceFields(rest, before)) };
  await assertOpening({ ...before, ...values });
  const [row] = await tx().update(t).set(values).where(eq(t.id, id)).returning();
  if (values.name && values.name !== before.name && row.costCenterId) {
    await renameCostCenter(row.costCenterId, values.name);
  }
  if (values.status && values.status !== before.status) {
    const costCenterId = await assetCostCenter(row);
    if (values.status === 'written_off') await deactivateCostCenter(costCenterId);
    // A write-off taken back: the machine carries costs again.
    if (before.status === 'written_off') await activateCostCenter(costCenterId);
    await recordEvent({
      type: 'asset.status_changed',
      entityType: 'asset',
      entityId: id,
      data: { from: before.status, to: values.status },
    });
  }
  if (row.openingDepreciation !== before.openingDepreciation || row.openingDepreciationDate !== before.openingDepreciationDate) {
    await recordEvent({
      type: 'asset.opening_depreciation_changed',
      entityType: 'asset',
      entityId: id,
      data: { name: row.name, date: row.openingDepreciationDate },
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
