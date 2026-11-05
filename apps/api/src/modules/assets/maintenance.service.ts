import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { MAINTENANCE_TYPES, addDays } from '@yap/shared';
import { schema } from '../../db/client';
import { assertPermission, ctx, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { issueStock, reverseMovements } from '../../core/inventory';
import { recordEvent } from '../../core/journal';
import { postTransaction } from '../../core/ledger';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, paged, sortBy } from '../../core/query';
import { assertOnFarm, assetCostCenter, dueState, getAssetRow } from './assets.service';

const { assets, counterparties, financeCategories, maintenanceRecords: t } = schema;

export const maintenanceInput = z.object({
  id: clientId,
  date: isoDate,
  type: z.enum(MAINTENANCE_TYPES),
  description: z.string().trim().max(1000).nullish(),
  cost: z.number().min(0).optional(),
  nextDueDate: isoDate.nullish(),
  nextDueMotoHours: z.number().min(0).nullish(),
  downtimeHours: z.number().min(0).nullish(),
  /** Spare parts taken from a warehouse (spec 12.4). */
  parts: z
    .array(z.object({ itemId: z.uuid(), warehouseId: z.uuid(), qty: z.number().positive() }))
    .max(30)
    .optional(),
  /** Records the payment in finance. Without it the cost is only history on the card. */
  payment: z
    .object({
      paymentMethod: z.enum(['cash', 'bank', 'card', 'debt']),
      accountId: z.uuid().nullish(),
      counterpartyId: z.uuid().nullish(),
      dueDate: isoDate.nullish(),
    })
    .optional(),
});
export type MaintenanceInput = z.infer<typeof maintenanceInput>;

type Row = typeof t.$inferSelect;

async function categoryId(key: string): Promise<string> {
  const [row] = await tx()
    .select({ id: financeCategories.id })
    .from(financeCategories)
    .where(and(eq(financeCategories.tenantId, ctx().tenantId), eq(financeCategories.key, key)));
  if (!row) throw badRequest('CATEGORY_NOT_FOUND', `Finance category ${key} does not exist`);
  return row.id;
}

export async function listMaintenance(assetId: string, q: z.infer<typeof listQuery>) {
  await getAssetRow(assetId);
  const where = eq(t.assetId, assetId);
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select()
      .from(t)
      .where(where)
      .orderBy(...sortBy(q.sort, { date: t.date, cost: t.cost }, desc(t.date), t.id))
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: hideMoney(page.data, ['cost']) };
}

export async function createMaintenance(assetId: string, input: MaintenanceInput) {
  const asset = await getAssetRow(assetId);
  const c = ctx();
  const id = input.id ?? uuidv7();
  const cost = input.cost ?? 0;
  const costCenterId = await assetCostCenter(asset);

  if (input.payment && cost <= 0) throw badRequest('INVALID_AMOUNT', 'Enter the amount to record a payment');

  // Money first: a rejected payment must not leave a half-recorded repair behind.
  let transactionId: string | null = null;
  if (input.payment) {
    assertPermission('finance.create');
    await assertOnFarm(counterparties, input.payment.counterpartyId, 'Counterparty');
    const transaction = await postTransaction({
      date: input.date,
      type: 'expense',
      categoryId: await categoryId('repair'),
      amount: cost,
      paymentMethod: input.payment.paymentMethod,
      accountId: input.payment.accountId,
      counterpartyId: input.payment.counterpartyId,
      dueDate: input.payment.dueDate,
      costCenterId,
      description: input.description ?? asset.name,
      sourceType: 'maintenance',
      sourceId: id,
    });
    transactionId = transaction.id;
  }

  for (const part of input.parts ?? []) {
    await issueStock({
      ...part,
      date: input.date,
      costCenterId,
      reason: 'maintenance',
      refType: 'maintenance',
      refId: id,
    });
  }

  const [row] = await tx()
    .insert(t)
    .values({
      id,
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      assetId,
      date: input.date,
      type: input.type,
      description: input.description,
      cost,
      nextDueDate: input.nextDueDate,
      nextDueMotoHours: input.nextDueMotoHours,
      downtimeHours: input.downtimeHours,
      transactionId,
    })
    .returning();

  await recordEvent({
    type: 'asset.maintained',
    entityType: 'asset',
    entityId: assetId,
    occurredAt: input.date,
    data: { type: input.type, recordId: id, downtimeHours: input.downtimeHours },
  });
  return hideMoney([row], ['cost'])[0];
}

async function getRecord(assetId: string, id: string): Promise<Row> {
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.assetId, assetId), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Maintenance record');
  return row;
}

export async function updateMaintenance(assetId: string, id: string, input: Partial<MaintenanceInput>) {
  const row = await getRecord(assetId, id);
  if (input.parts || input.payment) {
    throw conflict('MAINTENANCE_LOCKED_FIELDS', 'Parts and payments cannot be changed: delete and enter again');
  }
  if (row.transactionId && input.cost !== undefined && input.cost !== row.cost) {
    throw conflict('MAINTENANCE_HAS_PAYMENT', 'This repair has a payment in finance, so its amount cannot change');
  }
  const { id: _i, parts: _p, payment: _m, ...values } = input;
  const [saved] = await tx().update(t).set(values).where(eq(t.id, id)).returning();
  return hideMoney([saved], ['cost'])[0];
}

export async function removeMaintenance(assetId: string, id: string) {
  const row = await getRecord(assetId, id);
  if (row.transactionId) {
    throw conflict('MAINTENANCE_HAS_PAYMENT', 'This repair has a payment in finance, so it cannot be deleted');
  }
  await reverseMovements('maintenance', id);
  await tx().delete(t).where(eq(t.id, id));
  return { id };
}

/**
 * Machines that need service now or soon, read by the calendar and alerts. Only the latest
 * record of each machine counts: an older "next due" has been superseded by later service.
 */
export async function dueMaintenance(withinDays = 14) {
  const c = ctx();
  const latest = await tx()
    .selectDistinctOn([t.assetId])
    .from(t)
    .where(eq(t.farmId, c.farmId))
    .orderBy(t.assetId, desc(t.date), desc(t.createdAt));
  if (latest.length === 0) return [];

  const rows = await tx()
    .select()
    .from(assets)
    .where(and(inArray(assets.id, latest.map((l) => l.assetId)), sql`${assets.status} <> 'written_off'`));
  const byId = new Map(rows.map((a) => [a.id, a]));
  const until = addDays(today(), withinDays);

  const result = [];
  for (const record of latest) {
    const asset = byId.get(record.assetId);
    if (!asset) continue;
    const state = dueState(asset, record);
    if (!state) continue;
    const dateSoon = record.nextDueDate !== null && record.nextDueDate <= until;
    const hoursSoon = record.nextDueMotoHours !== null && asset.motoHours >= record.nextDueMotoHours - 25;
    if (state.overdue || dateSoon || hoursSoon) {
      result.push({ assetId: asset.id, name: asset.name, motoHours: asset.motoHours, ...state });
    }
  }
  return result;
}
