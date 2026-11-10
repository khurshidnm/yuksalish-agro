import { and, desc, eq, getTableColumns, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ANIMAL_EXIT_TYPES, round, type Permission } from '@yap/shared';
import { animalBookValue, kgToItemUnit, meatYieldPercent } from '@yap/shared/formulas/livestock';
import { schema } from '../../db/client';
import { assertPermission, ctx, today, tx } from '../../core/context';
import { generalCostCenterId } from '../../core/costCenters';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getItemOrThrow, receiveStock, reverseMovements } from '../../core/inventory';
import { recordEvent } from '../../core/journal';
import { postTransaction } from '../../core/ledger';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { signedFileUrl } from '../files';
import { assertNotReservedForOthers, settleReservations } from '../sales/reserved.service';
import { markExited } from './animals.service';
import { restingStatus } from './breeding.shared';
import { animalsUnderWithdrawal } from './health.service';
import {
  accumulatedCostPerHead,
  assertInFarm,
  assertNotFuture,
  assertOnFarm,
  getAnimalOrThrow,
  type Animal,
} from './refs';

const { animalExits: t, animals, breedingRecords, counterparties, financeCategories, healthRecords, herds, transactions, warehouses } = schema;

export const exitInput = z.object({
  id: clientId,
  animalId: z.uuid(),
  type: z.enum(ANIMAL_EXIT_TYPES),
  date: isoDate.optional(),
  liveWeightKg: z.number().positive().max(2000).nullish(),
  carcassWeightKg: z.number().positive().max(2000).nullish(),
  reason: z.string().trim().max(500).nullish(),
  vetConclusion: z.string().trim().max(1000).nullish(),
  photoFileIds: z.array(z.uuid()).max(10).optional(),
  notes: z.string().max(1000).nullish(),
  // Sale
  pricePerKg: z.number().positive().nullish(),
  /** Price for the whole animal, when sold per head rather than by weight. */
  amount: z.number().positive().nullish(),
  counterpartyId: z.uuid().nullish(),
  paymentMethod: z.enum(['cash', 'bank', 'card', 'debt']).optional(),
  accountId: z.uuid().nullish(),
  categoryId: z.uuid().nullish(),
  dueDate: isoDate.nullish(),
  // Slaughter
  meatItemId: z.uuid().nullish(),
  warehouseId: z.uuid().nullish(),
});
export type ExitInput = z.infer<typeof exitInput>;

export const exitListQuery = listQuery.extend({
  type: z.enum(ANIMAL_EXIT_TYPES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

type ExitType = (typeof ANIMAL_EXIT_TYPES)[number];

const STATUS_BY_TYPE = { sale: 'sold', slaughter: 'slaughtered', death: 'dead', loss: 'lost' } as const;

/** Shepherds report deaths and losses; a sale moves money; slaughter is a zootechnician's decision. */
const PERMISSION_BY_TYPE: Record<ExitType, Permission> = {
  sale: 'sales.create',
  slaughter: 'livestock.update',
  death: 'livestock.create',
  loss: 'livestock.create',
};

/** Meat from an animal under treatment must not reach anyone (spec 8.3). The rule lives in health.service. */
async function assertNoWithdrawal(animal: Animal, date: string): Promise<void> {
  const [blocked] = await animalsUnderWithdrawal([animal.id], date);
  if (blocked) {
    throw conflict('WITHDRAWAL_PERIOD_ACTIVE', `Withdrawal period lasts until ${blocked.withdrawalUntil}`, {
      until: blocked.withdrawalUntil,
    });
  }
}

async function herdCostCenter(animal: Animal): Promise<string> {
  if (animal.herdId) {
    const [herd] = await tx().select({ costCenterId: herds.costCenterId }).from(herds).where(eq(herds.id, animal.herdId));
    if (herd?.costCenterId) return herd.costCenterId;
  }
  return generalCostCenterId();
}

async function saleCategory(animal: Animal, given?: string | null): Promise<string> {
  if (given) return given;
  const key = animal.category === 'lamb_male' || animal.category === 'lamb_female' ? 'lamb_sales' : 'sheep_sales';
  const [row] = await tx()
    .select({ id: financeCategories.id })
    .from(financeCategories)
    .where(and(eq(financeCategories.tenantId, ctx().tenantId), eq(financeCategories.key, key)));
  if (!row) throw badRequest('CATEGORY_REQUIRED', 'Choose a category');
  return row.id;
}

async function postSale(exitId: string, animal: Animal, i: ExitInput, date: string, liveWeightKg: number | null) {
  if (animal.status === 'quarantine') throw conflict('ANIMAL_IN_QUARANTINE', 'An animal in quarantine cannot be sold');
  await assertNoWithdrawal(animal, date);
  if (!i.counterpartyId) throw badRequest('COUNTERPARTY_REQUIRED', 'Choose the buyer');
  await assertInFarm(counterparties, i.counterpartyId, 'Buyer');
  // An animal held for one buyer is not sold to another, whichever screen the sale is entered on.
  await assertNotReservedForOthers([animal.id], i.counterpartyId);
  await settleReservations([animal.id], i.counterpartyId, null);

  const amount = i.amount ?? (i.pricePerKg && liveWeightKg ? round(i.pricePerKg * liveWeightKg, 2) : null);
  if (!amount) throw badRequest('AMOUNT_REQUIRED', 'Enter the price and the weight, or the total amount');

  const transaction = await postTransaction({
    date,
    type: 'income',
    amount,
    categoryId: await saleCategory(animal, i.categoryId),
    paymentMethod: i.paymentMethod ?? 'debt',
    accountId: i.accountId,
    counterpartyId: i.counterpartyId,
    costCenterId: await herdCostCenter(animal),
    dueDate: i.dueDate,
    description: `Sotuv: ${animal.tag}`,
    sourceType: 'animal_exit',
    sourceId: exitId,
  });
  return { amount, transactionId: transaction.id };
}

async function postSlaughter(exitId: string, animal: Animal, i: ExitInput, date: string, liveWeightKg: number | null) {
  if (animal.status === 'quarantine') throw conflict('ANIMAL_IN_QUARANTINE', 'An animal in quarantine cannot be slaughtered');
  await assertNoWithdrawal(animal, date);
  if (!liveWeightKg || !i.carcassWeightKg) {
    throw badRequest('WEIGHTS_REQUIRED', 'Enter the live weight and the carcass weight');
  }
  if (i.carcassWeightKg > liveWeightKg) {
    throw badRequest('INVALID_WEIGHTS', 'Carcass weight cannot exceed live weight');
  }
  if (!i.meatItemId || !i.warehouseId) {
    throw badRequest('MEAT_ITEM_REQUIRED', 'Choose the meat item and the warehouse');
  }
  const item = await getItemOrThrow(i.meatItemId);
  await assertInFarm(warehouses, i.warehouseId, 'Warehouse');

  // The animal's book value moves into the meat, so its cost stays traceable through to sale.
  const book = animalBookValue(animal.purchasePrice, await accumulatedCostPerHead(animal.herdId));
  const qty = round(kgToItemUnit(i.carcassWeightKg, item.unit), 3);
  const unitCost = book === null ? (item.transferPrice ?? 0) : round(book / qty, 4);

  const { batch } = await receiveStock({
    itemId: i.meatItemId,
    warehouseId: i.warehouseId,
    qty,
    unitCost,
    date,
    source: 'own_harvest',
    refType: 'animal_exit',
    refId: exitId,
    notes: animal.tag,
  });
  return { batchId: batch.id };
}

export async function createExit(i: ExitInput) {
  const c = ctx();
  const date = i.date ?? today();
  assertNotFuture(date);
  assertPermission(PERMISSION_BY_TYPE[i.type]);

  const animal = await getAnimalOrThrow(i.animalId, { lock: true });
  if (i.id) {
    // A retry from a device that lost the response.
    const [same] = await tx().select({ id: t.id }).from(t).where(eq(t.id, i.id));
    if (same) return getExit(same.id);
  }
  assertOnFarm(animal);

  const liveWeightKg = i.liveWeightKg ?? animal.currentWeightKg ?? null;
  const [exit] = await tx()
    .insert(t)
    .values({
      ...(i.id ? { id: i.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      animalId: animal.id,
      type: i.type,
      date,
      liveWeightKg,
      carcassWeightKg: i.carcassWeightKg,
      pricePerKg: i.pricePerKg,
      counterpartyId: i.type === 'sale' ? i.counterpartyId : null,
      reason: i.reason,
      vetConclusion: i.vetConclusion,
      photoFileIds: i.photoFileIds ?? [],
      notes: i.notes,
    })
    .returning();

  if (i.type === 'sale') {
    const { amount, transactionId } = await postSale(exit.id, animal, i, date, liveWeightKg);
    await tx().update(t).set({ amount, transactionId }).where(eq(t.id, exit.id));
  } else if (i.type === 'slaughter') {
    const { batchId } = await postSlaughter(exit.id, animal, i, date, liveWeightKg);
    await tx().update(t).set({ batchId }).where(eq(t.id, exit.id));
  } else {
    const lossAmount = animalBookValue(animal.purchasePrice, await accumulatedCostPerHead(animal.herdId));
    await tx().update(t).set({ lossAmount }).where(eq(t.id, exit.id));
  }

  await markExited(animal.id, STATUS_BY_TYPE[i.type], date);

  const eventType = { sale: 'animal.sold', slaughter: 'animal.slaughtered', death: 'animal.died', loss: 'animal.lost' }[i.type];
  await recordEvent({
    type: eventType,
    entityType: 'animal',
    entityId: animal.id,
    severity: i.type === 'death' || i.type === 'loss' ? 'attention' : 'info',
    occurredAt: date,
    photoFileId: exit.photoFileIds[0] ?? null,
    data: { tag: animal.tag, exitId: exit.id, reason: i.reason, liveWeightKg },
  });
  return getExit(exit.id);
}

export async function getExit(id: string) {
  const [row] = await tx()
    .select({
      ...getTableColumns(t),
      tag: animals.tag,
      category: animals.category,
      herdId: animals.herdId,
      herdName: herds.name,
      counterpartyName: counterparties.name,
      transactionStatus: transactions.status,
    })
    .from(t)
    .innerJoin(animals, eq(animals.id, t.animalId))
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .leftJoin(counterparties, eq(counterparties.id, t.counterpartyId))
    .leftJoin(transactions, eq(transactions.id, t.transactionId))
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Exit');
  const photos = [];
  for (const fileId of row.photoFileIds) photos.push({ id: fileId, url: await signedFileUrl(fileId) });
  const yieldPercent =
    row.carcassWeightKg && row.liveWeightKg ? meatYieldPercent(row.carcassWeightKg, row.liveWeightKg) : null;
  return { ...withoutMoney(row), meatYieldPercent: yieldPercent === null ? null : round(yieldPercent, 1), photos };
}

type ExitMoneyRow = {
  pricePerKg: number | null;
  amount: number | null;
  lossAmount: number | null;
  transactionId: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  transactionStatus: string | null;
};

const withoutMoney = <T extends ExitMoneyRow>(row: T): T =>
  hideMoney([row], ['pricePerKg', 'amount', 'lossAmount', 'transactionId', 'counterpartyId', 'counterpartyName', 'transactionStatus'])[0];

export async function listExits(q: z.infer<typeof exitListQuery>) {
  const where = and(
    eq(t.farmId, ctx().farmId),
    q.type ? eq(t.type, q.type) : undefined,
    q.from ? gte(t.date, q.from) : undefined,
    q.to ? lte(t.date, q.to) : undefined,
    searchAny(q.search, [sql`(select a.tag from animals a where a.id = ${t.animalId})`]),
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select({
        ...getTableColumns(t),
        tag: animals.tag,
        category: animals.category,
        herdName: herds.name,
        counterpartyName: counterparties.name,
        transactionStatus: transactions.status,
      })
      .from(t)
      .innerJoin(animals, eq(animals.id, t.animalId))
      .leftJoin(herds, eq(herds.id, animals.herdId))
      .leftJoin(counterparties, eq(counterparties.id, t.counterpartyId))
      .leftJoin(transactions, eq(transactions.id, t.transactionId))
      .where(where)
      .orderBy(...sortBy(q.sort, { date: t.date, type: t.type, tag: animals.tag }, desc(t.date), t.id))
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: page.data.map(withoutMoney) };
}

/** Correct a mistaken record. A sale has money attached, so it is reversed through finance. */
export async function undoExit(id: string) {
  const [exit] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)))
    .for('update');
  if (!exit) throw notFound('Exit');
  if (exit.transactionId) {
    throw conflict('EXIT_HAS_TRANSACTION', 'This sale has a transaction. Reverse it in finance first.');
  }

  await reverseMovements('animal_exit', id);
  await tx().delete(t).where(eq(t.id, id));

  const [animal] = await tx()
    .update(animals)
    .set({ status: 'active', exitDate: null })
    .where(eq(animals.id, exit.animalId))
    .returning({ tag: animals.tag });
  // markExited closed any open pregnancy and left this marker, so only that pregnancy reopens.
  const marker = `(${STATUS_BY_TYPE[exit.type as ExitType]} ${exit.date})`;
  const reopened = await tx()
    .update(breedingRecords)
    .set({ status: 'pregnant', notes: sql`nullif(trim(replace(${breedingRecords.notes}, ${marker}, '')), '')` })
    .where(
      and(
        eq(breedingRecords.eweId, exit.animalId),
        eq(breedingRecords.status, 'failed'),
        sql`position(${marker} in ${breedingRecords.notes}) > 0`,
      ),
    )
    .returning({ id: breedingRecords.id });
  // markExited closed these on the exit date and gave no result, unlike a recovery.
  const health = await tx()
    .update(healthRecords)
    .set({ reportStatus: sql`case when ${healthRecords.reportStatus} = 'resolved' then 'open' else ${healthRecords.reportStatus} end`, endedOn: null })
    .where(
      and(
        eq(healthRecords.animalId, exit.animalId),
        eq(healthRecords.endedOn, exit.date),
        isNull(healthRecords.result),
        or(eq(healthRecords.reportStatus, 'resolved'), eq(healthRecords.type, 'quarantine')),
      ),
    )
    .returning({ type: healthRecords.type, until: healthRecords.nextDueDate });
  const quarantine = health.find((row) => row.type === 'quarantine');
  if (reopened.length || health.length) {
    await tx()
      .update(animals)
      .set({ status: await restingStatus(exit.animalId), ...(quarantine ? { quarantineUntil: quarantine.until } : {}) })
      .where(eq(animals.id, exit.animalId));
  }

  await recordEvent({ type: 'animal.exit_undone', entityType: 'animal', entityId: exit.animalId, data: { tag: animal.tag, type: exit.type } });
  return { id };
}
