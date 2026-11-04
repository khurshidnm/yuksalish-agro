import { and, eq, inArray, isNull, notInArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { allocateOverhead, machineryUnitCost, monthOf, round } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { COST_MOVEMENT_TYPES } from '../../core/inventory';
import { sumOf } from '../../core/query';
import { getAssetRow } from './assets.service';

const { assetUsageLogs, depreciationEntries, financeCategories, maintenanceRecords, stockMovements, transactions } = schema;

const REPAIR_CATEGORIES = ['repair', 'spare_parts'];

function dateRange(column: AnyColumn, from?: string, to?: string) {
  return [from ? sql`${column} >= ${from}` : undefined, to ? sql`${column} <= ${to}` : undefined];
}

/**
 * Cost of one machine: fuel + labour + repairs + depreciation (spec 12.7), per motor-hour and per
 * hectare. Each repair is counted once: from the ledger when it was paid there, otherwise from
 * the card, so entering the same repair in both places needs a linked payment.
 */
export async function assetCosts(assetId: string, from?: string, to?: string) {
  const asset = await getAssetRow(assetId);
  const costCenterId = asset.costCenterId;

  const [usage] = await tx()
    .select({
      hours: sumOf(assetUsageLogs.motoHours),
      hectares: sumOf(assetUsageLogs.volumeHa),
      fuelL: sumOf(assetUsageLogs.fuelL),
      fuel: sumOf(assetUsageLogs.fuelCost),
    })
    .from(assetUsageLogs)
    .where(and(eq(assetUsageLogs.assetId, assetId), ...dateRange(assetUsageLogs.date, from, to)));

  const [cardRepairs] = await tx()
    .select({ amount: sumOf(maintenanceRecords.cost) })
    .from(maintenanceRecords)
    .where(
      and(
        eq(maintenanceRecords.assetId, assetId),
        isNull(maintenanceRecords.transactionId),
        ...dateRange(maintenanceRecords.date, from, to),
      ),
    );

  const [depreciation] = await tx()
    .select({ amount: sumOf(depreciationEntries.amount) })
    .from(depreciationEntries)
    .where(
      and(
        eq(depreciationEntries.assetId, assetId),
        from ? sql`${depreciationEntries.month} >= ${monthOf(from)}` : undefined,
        to ? sql`${depreciationEntries.month} <= ${monthOf(to)}` : undefined,
      ),
    );

  let labor = 0;
  let ledgerRepairs = 0;
  let parts = 0;
  if (costCenterId) {
    const inLedger = async (where: SQL | undefined) => {
      const [row] = await tx()
        .select({ amount: sumOf(transactions.amountBase) })
        .from(transactions)
        .innerJoin(financeCategories, eq(financeCategories.id, transactions.categoryId))
        .where(
          and(
            eq(transactions.costCenterId, costCenterId),
            eq(transactions.type, 'expense'),
            eq(transactions.status, 'approved'),
            eq(transactions.costTreatment, 'expense'),
            where,
            ...dateRange(transactions.date, from, to),
          ),
        );
      return row.amount;
    };
    labor = await inLedger(eq(financeCategories.group, 'labor'));
    ledgerRepairs = await inLedger(inArray(financeCategories.key, REPAIR_CATEGORIES));

    const [issued] = await tx()
      .select({ amount: sumOf(stockMovements.totalCost) })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.costCenterId, costCenterId),
          inArray(stockMovements.type, [...COST_MOVEMENT_TYPES]),
          // Fuel is already counted above, from the shift log.
          notInArray(stockMovements.reason, ['fuel']),
          ...dateRange(stockMovements.date, from, to),
        ),
      );
    parts = issued.amount;
  }

  const costs = {
    fuel: usage.fuel,
    labor,
    repairs: round(cardRepairs.amount + ledgerRepairs + parts, 2),
    depreciation: depreciation.amount,
  };
  const total = round(costs.fuel + costs.labor + costs.repairs + costs.depreciation, 2);
  return {
    assetId,
    from: from ?? null,
    to: to ?? null,
    ...costs,
    total,
    hours: usage.hours,
    hectares: usage.hectares,
    fuelL: usage.fuelL,
    costPerHour: machineryUnitCost(costs, usage.hours),
    costPerHectare: machineryUnitCost(costs, usage.hectares),
    fuelPerHectare: usage.hectares > 0 ? usage.fuelL / usage.hectares : null,
  };
}

/**
 * What each field owes the machines that worked it, shared by shift hours (or hectares when a
 * machine logs no hours). Field cost needs this because fuel and depreciation sit on the
 * machine's cost center. Work with no field stays on the machine, so the shares never
 * exceed the machine's real cost.
 */
export async function machineryCostByField(from?: string, to?: string): Promise<{ fieldId: string; amount: number }[]> {
  const rows = await tx()
    .select({
      assetId: assetUsageLogs.assetId,
      fieldId: assetUsageLogs.fieldId,
      hours: sumOf(assetUsageLogs.motoHours),
      hectares: sumOf(assetUsageLogs.volumeHa),
    })
    .from(assetUsageLogs)
    .where(and(eq(assetUsageLogs.farmId, ctx().farmId), ...dateRange(assetUsageLogs.date, from, to)))
    .groupBy(assetUsageLogs.assetId, assetUsageLogs.fieldId);

  const byField = new Map<string, number>();
  for (const assetId of new Set(rows.map((r) => r.assetId))) {
    const parts = rows.filter((r) => r.assetId === assetId);
    const useHours = parts.some((p) => p.hours > 0);
    const { total } = await assetCosts(assetId, from, to);
    const shares = allocateOverhead(
      total,
      parts.map((p) => ({ id: p.fieldId ?? 'none', weight: useHours ? p.hours : p.hectares })),
    );
    for (const [fieldId, amount] of Object.entries(shares)) {
      if (fieldId !== 'none') byField.set(fieldId, round((byField.get(fieldId) ?? 0) + amount, 2));
    }
  }
  return [...byField].map(([fieldId, amount]) => ({ fieldId, amount }));
}
