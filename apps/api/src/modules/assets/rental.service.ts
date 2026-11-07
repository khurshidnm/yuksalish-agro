import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { round } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { ensureCostCenter, generalCostCenterId } from '../../core/costCenters';
import { badRequest, conflict } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { postTransaction } from '../../core/ledger';
import { isoDate } from '../../core/query';
import { getAssetRow } from './assets.service';

const { assetUsageLogs: logs, fields, financeCategories } = schema;

export const rentalActInput = z.object({ from: isoDate, to: isoDate });

/**
 * Acceptance act for hired machinery (spec 12.6): bills the unbilled shifts of a period at the
 * contract price, as a debt to the contractor, charged to the fields that were worked. A shift
 * can only be billed once.
 */
export async function createRentalAct(assetId: string, input: z.infer<typeof rentalActInput>) {
  if (input.to < input.from) throw badRequest('INVALID_PERIOD', 'The end date is before the start date');
  const asset = await getAssetRow(assetId);
  if (!asset.rented) throw conflict('ASSET_NOT_RENTED', 'This machine is not rented');
  if (!asset.rentalCounterpartyId || !asset.rentalPrice || !asset.rentalUnit) {
    throw badRequest('RENTAL_TERMS_REQUIRED', 'Set the contractor, price and unit on the machine first');
  }

  const shifts = await tx()
    .select({
      id: logs.id,
      date: logs.date,
      fieldId: logs.fieldId,
      fieldName: fields.number,
      hours: logs.motoHours,
      hectares: logs.volumeHa,
    })
    .from(logs)
    .leftJoin(fields, eq(fields.id, logs.fieldId))
    .where(
      and(
        eq(logs.assetId, assetId),
        isNull(logs.billedTransactionId),
        sql`${logs.date} between ${input.from} and ${input.to}`,
      ),
    )
    .orderBy(logs.id)
    .for('update', { of: logs });
  if (shifts.length === 0) throw conflict('NOTHING_TO_BILL', 'There are no unbilled shifts in this period');

  const quantityOf = (shift: (typeof shifts)[number]): number => {
    if (asset.rentalUnit === 'ha') return shift.hectares ?? 0;
    if (asset.rentalUnit === 'hour') return shift.hours ?? 0;
    return 1;
  };

  const groups = new Map<string, { fieldId: string | null; fieldName: string | null; quantity: number; ids: string[] }>();
  for (const shift of shifts) {
    const key = shift.fieldId ?? 'none';
    const group = groups.get(key) ?? { fieldId: shift.fieldId, fieldName: shift.fieldName, quantity: 0, ids: [] };
    group.quantity += quantityOf(shift);
    group.ids.push(shift.id);
    groups.set(key, group);
  }

  const c = ctx();
  const [category] = await tx()
    .select({ id: financeCategories.id })
    .from(financeCategories)
    .where(and(eq(financeCategories.tenantId, c.tenantId), eq(financeCategories.key, 'equipment_rent')));
  if (!category) throw badRequest('CATEGORY_NOT_FOUND', 'Finance category equipment_rent does not exist');

  const price = asset.rentalPrice;
  const bills = [...groups.values()].map((group) => ({ ...group, amount: round(group.quantity * price, 2) }));
  if (bills.some((bill) => bill.amount <= 0)) {
    throw badRequest('RENTAL_QUANTITY_MISSING', 'Some shifts have no hectares or hours to bill');
  }
  const documentBase = round(bills.reduce((sum, bill) => sum + bill.amount, 0), 2);

  const lines = [];
  for (const { amount, ...group } of bills) {
    const costCenterId = group.fieldId
      ? await ensureCostCenter('field', group.fieldId, group.fieldName ?? group.fieldId)
      : await generalCostCenterId();
    const transaction = await postTransaction({
      date: input.to,
      type: 'expense',
      categoryId: category.id,
      amount,
      documentBase,
      paymentMethod: 'debt',
      counterpartyId: asset.rentalCounterpartyId,
      costCenterId,
      description: `Ijara: ${asset.name}, ${input.from} — ${input.to}`,
      sourceType: 'rental_act',
      sourceId: asset.id,
    });
    await tx()
      .update(logs)
      .set({ billedTransactionId: transaction.id })
      .where(inArray(logs.id, group.ids));
    lines.push({
      fieldId: group.fieldId,
      fieldNumber: group.fieldName,
      quantity: group.quantity,
      amount,
      transactionId: transaction.id,
      status: transaction.status,
    });
  }

  await recordEvent({
    type: 'asset.rental_act',
    entityType: 'asset',
    entityId: asset.id,
    occurredAt: input.to,
    data: { from: input.from, to: input.to, total: documentBase, shifts: shifts.length },
  });
  return { assetId, from: input.from, to: input.to, unit: asset.rentalUnit, price, lines, total: documentBase };
}
