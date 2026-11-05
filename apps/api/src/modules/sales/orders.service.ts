/**
 * Sale documents (spec 13.2). A draft moves no goods and no money. Confirming is the one step
 * that does both, in a single transaction: stock leaves, animals leave the herd, income is posted.
 * At or above the approval threshold a second person must confirm (spec 5.1).
 */
import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ANIMAL_ON_FARM_STATUSES, CURRENCIES, SALE_STATUSES, UNITS, round, toBaseAmount } from '@yap/shared';
import { animalBookValue } from '@yap/shared/formulas/livestock';
import { newId } from '../../db/schema';
import { schema } from '../../db/client';
import { assertPermission, ctx, hasPermission, today, tx } from '../../core/context';
import { ensureCostCenter, generalCostCenterId } from '../../core/costCenters';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { getItemOrThrow, issueStock, reverseMovements } from '../../core/inventory';
import { recordEvent } from '../../core/journal';
import { assertCostCenterOpen, postTransaction, voidTransactions } from '../../core/ledger';
import { hideMoney } from '../../core/privacy';
import { clientId, isoDate, listQuery, searchAny, sortBy } from '../../core/query';
import { MAX_MONEY, MAX_QTY, SALE_PAYMENT_METHODS } from './constants';
import { herdCost } from '../finance/summary';
import { markExited } from '../livestock/animals.service';
import { undoExit } from '../livestock/exits.service';
import { animalsUnderWithdrawal } from '../livestock/health.service';
import { notifySaleSubmitted } from './notify';
import { assertAccount, assertCategories, assertCounterparty, assertFile, assertWarehouses } from './refs';

const {
  animalExits,
  animals,
  costCenters,
  counterparties,
  documents,
  financeCategories,
  fxRates,
  herds,
  items,
  saleLines,
  sales,
  stockBatches,
  fields,
  transactions,
  warehouses,
} = schema;

type Sale = typeof sales.$inferSelect;
type SaleLine = typeof saleLines.$inferSelect;
type Animal = typeof animals.$inferSelect;
type Item = typeof items.$inferSelect;

const lineInput = z
  .object({
    itemId: z.uuid().nullish(),
    warehouseId: z.uuid().nullish(),
    animalId: z.uuid().nullish(),
    description: z.string().trim().max(200).nullish(),
    qty: z.number().positive().max(MAX_QTY),
    unit: z.enum(UNITS).optional(),
    price: z.number().min(0).max(MAX_MONEY),
    categoryId: z.uuid().nullish(),
    costCenterId: z.uuid().nullish(),
  })
  .refine((l) => Boolean(l.itemId) !== Boolean(l.animalId), {
    message: 'A line sells either an item or an animal',
    path: ['itemId'],
  })
  .refine((l) => !l.itemId || Boolean(l.warehouseId), {
    message: 'Choose the warehouse the item leaves from',
    path: ['warehouseId'],
  });

const saleFields = z.object({
  id: clientId,
  date: isoDate,
  counterpartyId: z.uuid(),
  currency: z.enum(CURRENCIES).optional(),
  fxRate: z.number().positive().nullish(),
  deliveryDate: isoDate.nullish(),
  dueDate: isoDate.nullish(),
  paymentMethod: z.enum(SALE_PAYMENT_METHODS),
  accountId: z.uuid().nullish(),
  notes: z.string().max(1000).nullish(),
  lines: z.array(lineInput).min(1).max(1000),
});

export const saleInput = saleFields.extend({ paymentMethod: saleFields.shape.paymentMethod.default('debt') });
/** Built from the fields without defaults: zod keeps a default inside partial(), which would reset them. */
export const salePatch = saleFields.partial();
export type SaleInput = z.infer<typeof saleInput>;
type SalePatch = z.infer<typeof salePatch>;
type LineInput = SaleInput['lines'][number];

export const saleListQuery = listQuery.extend({
  status: z.enum(SALE_STATUSES).optional(),
  counterpartyId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const saleDocumentInput = z.object({
  type: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  number: z.string().trim().max(60).nullish(),
  fileId: z.uuid().nullish(),
  issueDate: isoDate.nullish(),
});

const MONEY_FIELDS = ['totalAmount', 'fxRate'] as const;
const LINE_MONEY_FIELDS = ['price', 'amount', 'costAmount'] as const;

/** Its `number` outlives the draft, so a deleted number is never issued again. */
const SALE_DELETED_EVENT = 'sale.deleted';

/**
 * Year-based document number. The lock serialises numbering per farm and year. One statement,
 * because a deletion committing between two reads could hide its number from both.
 */
async function nextNumber(date: string): Promise<string> {
  const farmId = ctx().farmId;
  const year = date.slice(0, 4);
  const prefix = `S-${year}-`;
  await tx().execute(sql`select pg_advisory_xact_lock(hashtext(${`sale-number:${farmId}:${year}`}))`);
  const { rows } = await tx().execute(sql`
    select coalesce(max(substring(number from '[0-9]+$')::bigint), 0) as last
    from (
      select number from sales where farm_id = ${farmId}
      union all
      select data->>'number' from events where farm_id = ${farmId} and type = ${SALE_DELETED_EVENT}
    ) numbers
    where number ~ ${`^${prefix}[0-9]+$`}`);
  return `${prefix}${String(Number(rows[0].last) + 1).padStart(4, '0')}`;
}

async function loadLineTargets(lines: LineInput[]) {
  const farmId = ctx().farmId;
  const itemIds = [...new Set(lines.flatMap((l) => (l.itemId ? [l.itemId] : [])))];
  const animalIds = lines.flatMap((l) => (l.animalId ? [l.animalId] : []));
  if (new Set(animalIds).size !== animalIds.length) {
    throw badRequest('DUPLICATE_ANIMAL', 'The same animal appears twice in this sale');
  }
  const itemRows = itemIds.length
    ? await tx().select().from(items).where(and(eq(items.farmId, farmId), inArray(items.id, itemIds)))
    : [];
  const animalRows = animalIds.length
    ? await tx().select().from(animals).where(and(eq(animals.farmId, farmId), inArray(animals.id, animalIds)))
    : [];
  if (itemRows.length !== itemIds.length) throw notFound('Item');
  if (animalRows.length !== animalIds.length) throw notFound('Animal');
  return { itemById: new Map(itemRows.map((i) => [i.id, i])), animalById: new Map(animalRows.map((a) => [a.id, a])) };
}

function assertOnFarm(animal: Animal): void {
  if (!(ANIMAL_ON_FARM_STATUSES as readonly string[]).includes(animal.status)) {
    throw conflict('ANIMAL_NOT_ON_FARM', `Animal ${animal.tag} is no longer on the farm`, {
      animalId: animal.id,
      tag: animal.tag,
      status: animal.status,
    });
  }
}

/** Build line rows, resolving unit and amount. Stored in the sale's own currency. */
async function buildLines(saleId: string, input: LineInput[]) {
  const c = ctx();
  const { itemById, animalById } = await loadLineTargets(input);
  return input.map((l) => {
    const animal = l.animalId ? animalById.get(l.animalId)! : null;
    const item = l.itemId ? itemById.get(l.itemId)! : null;
    if (animal) assertOnFarm(animal);
    return {
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      saleId,
      itemId: l.itemId ?? null,
      warehouseId: l.warehouseId ?? null,
      animalId: l.animalId ?? null,
      description: l.description ?? null,
      qty: l.qty,
      // An item has one unit, so a line cannot disagree with it. An animal sells by head or by live weight.
      unit: item ? item.unit : (l.unit ?? 'kg'),
      price: l.price,
      amount: round(l.qty * l.price, 2),
      categoryId: l.categoryId ?? null,
      costCenterId: l.costCenterId ?? null,
    };
  });
}

const sumAmounts = (rows: { amount: number }[]) => round(rows.reduce((sum, l) => sum + l.amount, 0), 2);

/** A line names a cost center only when a person chose one, so a blank line works it out and skips this. */
async function assertLineCostCenters(lines: { costCenterId?: string | null }[]): Promise<void> {
  for (const id of new Set(lines.flatMap((l) => (l.costCenterId ? [l.costCenterId] : [])))) await assertCostCenterOpen(id);
}

async function assertSaleRefs(input: SalePatch): Promise<void> {
  await assertCounterparty(input.counterpartyId);
  await assertAccount(input.accountId);
  await assertWarehouses((input.lines ?? []).map((l) => l.warehouseId));
  await assertLineCostCenters(input.lines ?? []);
  await assertCategories((input.lines ?? []).map((l) => l.categoryId));
}

export async function list(q: z.infer<typeof saleListQuery>) {
  const where = and(
    eq(sales.farmId, ctx().farmId),
    q.status ? eq(sales.status, q.status) : undefined,
    q.counterpartyId ? eq(sales.counterpartyId, q.counterpartyId) : undefined,
    q.from ? gte(sales.date, q.from) : undefined,
    q.to ? lte(sales.date, q.to) : undefined,
    searchAny(q.search, [sales.number, counterparties.name]),
  );
  const lineCount = tx()
    .select({ saleId: saleLines.saleId, lines: count().as('lines') })
    .from(saleLines)
    .groupBy(saleLines.saleId)
    .as('line_count');

  const rows = await tx()
    .select({
      id: sales.id,
      number: sales.number,
      date: sales.date,
      status: sales.status,
      counterpartyId: sales.counterpartyId,
      counterpartyName: counterparties.name,
      totalAmount: sales.totalAmount,
      currency: sales.currency,
      fxRate: sales.fxRate,
      deliveryDate: sales.deliveryDate,
      paymentMethod: sales.paymentMethod,
      lineCount: sql<number>`coalesce(${lineCount.lines}, 0)`.mapWith(Number),
      createdBy: sales.createdBy,
    })
    .from(sales)
    .innerJoin(counterparties, eq(counterparties.id, sales.counterpartyId))
    .leftJoin(lineCount, eq(lineCount.saleId, sales.id))
    .where(where)
    .orderBy(
      ...sortBy(
        q.sort,
        { date: sales.date, number: sales.number, totalAmount: sales.totalAmount, status: sales.status },
        desc(sales.date),
        sales.id,
      ),
    )
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  const [{ total }] = await tx()
    .select({ total: count() })
    .from(sales)
    .innerJoin(counterparties, eq(counterparties.id, sales.counterpartyId))
    .where(where);

  return { data: hideMoney(rows, [...MONEY_FIELDS]), meta: { page: q.page, pageSize: q.pageSize, total } };
}

async function lineRows(saleId: string) {
  return tx()
    .select({
      id: saleLines.id,
      itemId: saleLines.itemId,
      itemName: items.name,
      warehouseId: saleLines.warehouseId,
      warehouseName: warehouses.name,
      animalId: saleLines.animalId,
      animalTag: animals.tag,
      animalCategory: animals.category,
      description: saleLines.description,
      qty: saleLines.qty,
      unit: saleLines.unit,
      price: saleLines.price,
      amount: saleLines.amount,
      costAmount: saleLines.costAmount,
      categoryId: saleLines.categoryId,
      categoryName: financeCategories.name,
      costCenterId: saleLines.costCenterId,
      costCenterName: costCenters.name,
    })
    .from(saleLines)
    .leftJoin(items, eq(items.id, saleLines.itemId))
    .leftJoin(warehouses, eq(warehouses.id, saleLines.warehouseId))
    .leftJoin(animals, eq(animals.id, saleLines.animalId))
    .leftJoin(financeCategories, eq(financeCategories.id, saleLines.categoryId))
    .leftJoin(costCenters, eq(costCenters.id, saleLines.costCenterId))
    .where(eq(saleLines.saleId, saleId))
    .orderBy(asc(saleLines.createdAt), asc(saleLines.id));
}

export async function get(id: string) {
  const [row] = await tx()
    .select({
      sale: sales,
      counterpartyName: counterparties.name,
      counterpartyTin: counterparties.tin,
    })
    .from(sales)
    .innerJoin(counterparties, eq(counterparties.id, sales.counterpartyId))
    .where(and(eq(sales.id, id), eq(sales.farmId, ctx().farmId)));
  if (!row) throw notFound('Sale');

  const lines = await lineRows(id);
  // Same check and same date as confirming, so the warning on a line predicts the refusal.
  const underWithdrawal = await animalsUnderWithdrawal(lines.flatMap((l) => (l.animalId ? [l.animalId] : [])), row.sale.date);
  const withdrawal = new Map(underWithdrawal.map((r) => [r.animalId, r.withdrawalUntil]));
  const attachments = await tx()
    .select()
    .from(documents)
    .where(and(eq(documents.entityType, 'sale'), eq(documents.entityId, id)))
    .orderBy(asc(documents.createdAt));
  const postings = await tx()
    .select({
      id: transactions.id,
      type: transactions.type,
      amountBase: transactions.amountBase,
      status: transactions.status,
      date: transactions.date,
    })
    .from(transactions)
    .where(and(eq(transactions.sourceId, id), eq(transactions.sourceType, 'sale')))
    .orderBy(asc(transactions.createdAt));

  const [sale] = hideMoney([row.sale], [...MONEY_FIELDS]);
  return {
    ...sale,
    counterpartyName: row.counterpartyName,
    counterpartyTin: row.counterpartyTin,
    lines: hideMoney(
      lines.map((l) => ({ ...l, withdrawalUntil: l.animalId ? (withdrawal.get(l.animalId) ?? null) : null })),
      [...LINE_MONEY_FIELDS],
    ),
    documents: attachments,
    postings: hideMoney(postings, ['amountBase']),
  };
}

async function lockSale(id: string): Promise<Sale> {
  const [row] = await tx()
    .select()
    .from(sales)
    .where(and(eq(sales.id, id), eq(sales.farmId, ctx().farmId)))
    .for('update');
  if (!row) throw notFound('Sale');
  return row;
}

export async function create(input: SaleInput) {
  await assertSaleRefs(input);
  const c = ctx();
  const { id: givenId, lines: lineValues, ...header } = input;
  const id = givenId ?? newId();
  const rows = await buildLines(id, lineValues);
  const number = await nextNumber(input.date);
  await tx()
    .insert(sales)
    .values({
      ...header,
      id,
      number,
      currency: input.currency ?? c.currency,
      totalAmount: sumAmounts(rows),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
    });
  await tx().insert(saleLines).values(rows);
  await recordEvent({
    type: 'sale.created',
    entityType: 'sale',
    entityId: id,
    occurredAt: input.date,
    data: { number, total: sumAmounts(rows), lines: rows.length },
  });
  return get(id);
}

/** Only an unconfirmed sale can be edited. Editing a pending sale sends it back to draft. */
export async function update(id: string, input: SalePatch) {
  const sale = await lockSale(id);
  if (sale.status !== 'draft' && sale.status !== 'pending') {
    throw conflict('SALE_NOT_EDITABLE', 'Only a draft sale can be changed');
  }
  const { id: _ignored, lines: lineValues, ...header } = input;
  // This write always sets status, so the kernel's empty-update check would never see it, and an
  // empty PATCH would pull a pending sale out of its approval.
  if (!lineValues && Object.values(header).every((v) => v === undefined)) {
    throw badRequest('NOTHING_TO_UPDATE', 'No changes were sent');
  }
  await assertSaleRefs(input);
  let totalAmount = sale.totalAmount;
  if (lineValues) {
    const rows = await buildLines(id, lineValues);
    await tx().delete(saleLines).where(eq(saleLines.saleId, id));
    await tx().insert(saleLines).values(rows);
    totalAmount = sumAmounts(rows);
  }
  await tx()
    .update(sales)
    .set({ ...header, totalAmount, status: 'draft', rejectedReason: null })
    .where(eq(sales.id, id));
  return get(id);
}

export async function remove(id: string) {
  const sale = await lockSale(id);
  if (sale.status !== 'draft') throw conflict('SALE_NOT_EDITABLE', 'Only a draft sale can be deleted');
  await tx().delete(sales).where(eq(sales.id, id));
  await recordEvent({ type: SALE_DELETED_EVENT, entityType: 'sale', entityId: id, data: { number: sale.number } });
  return { id };
}

async function resolveRate(sale: Sale): Promise<number> {
  const c = ctx();
  if (sale.currency === c.currency) return 1;
  if (sale.fxRate) return sale.fxRate;
  const [row] = await tx()
    .select({ rate: fxRates.rate })
    .from(fxRates)
    .where(and(eq(fxRates.tenantId, c.tenantId), eq(fxRates.currency, sale.currency), lte(fxRates.date, sale.date)))
    .orderBy(desc(fxRates.date))
    .limit(1);
  if (!row) throw badRequest('FX_RATE_REQUIRED', `No exchange rate for ${sale.currency} on ${sale.date}`);
  return row.rate;
}

/** Income category key for a product, when the line does not name one (spec 10.2). */
export function incomeCategoryKey(line: { animalCategory?: string | null; itemName?: string | null }): string {
  if (line.animalCategory) return line.animalCategory.startsWith('lamb') ? 'lamb_sales' : 'sheep_sales';
  const name = (line.itemName ?? '').toLowerCase().replaceAll(/[ʻʼ‘’`]/g, "'");
  if (/\bjun\b|wool|шерст/.test(name)) return 'wool_sales';
  if (/go'sht|gosht|meat|мяс/.test(name)) return 'meat_sales';
  if (/beda|alfalfa|люцерн/.test(name)) return 'alfalfa_sales';
  if (/qo'zi|lamb|ягн/.test(name)) return 'lamb_sales';
  if (/qo'y|sheep|овц/.test(name)) return 'sheep_sales';
  if (/bug'doy|arpa|sholi|don\b|wheat|barley|rice|grain|пшениц|ячмен|рис|зерн/.test(name)) return 'grain_sales';
  return 'other';
}

async function categoryIdByKey(key: string): Promise<string> {
  const [row] = await tx()
    .select({ id: financeCategories.id })
    .from(financeCategories)
    .where(and(eq(financeCategories.tenantId, ctx().tenantId), eq(financeCategories.key, key)));
  if (!row) throw badRequest('CATEGORY_REQUIRED', `Income category "${key}" is missing`);
  return row.id;
}

async function assertNoWithdrawal(saleAnimals: Animal[], saleDate: string): Promise<void> {
  const blocked = await animalsUnderWithdrawal(saleAnimals.map((a) => a.id), saleDate);
  if (blocked.length === 0) return;
  throw conflict(
    'ANIMAL_UNDER_WITHDRAWAL',
    `${blocked.length} animal(s) are still under a withdrawal period and cannot be sold`,
    { animals: blocked.map((r) => ({ animalId: r.animalId, tag: r.tag, until: r.withdrawalUntil })) },
  );
}

/** Field cost center of the batch that supplied most of an issue, for own produce. */
async function costCenterFromBatches(batchQty: Map<string, number>): Promise<string | null> {
  const rows = await tx()
    .select({ batchId: stockBatches.id, costCenterId: fields.costCenterId })
    .from(stockBatches)
    .innerJoin(fields, eq(fields.id, stockBatches.fieldId))
    .where(inArray(stockBatches.id, [...batchQty.keys()]));
  const best = rows
    .filter((r) => r.costCenterId)
    .sort((a, b) => (batchQty.get(b.batchId) ?? 0) - (batchQty.get(a.batchId) ?? 0))[0];
  return best?.costCenterId ?? null;
}

async function herdCostCenter(herdId: string): Promise<string> {
  const [herd] = await tx().select().from(herds).where(eq(herds.id, herdId));
  return herd.costCenterId ?? ensureCostCenter('herd', herdId, herd.name);
}

interface Posting {
  line: SaleLine;
  categoryId: string;
  costCenterId: string;
  costAmount: number;
  animal: Animal | null;
}

async function prepareItemLine(sale: Sale, line: SaleLine, item: Item): Promise<Posting> {
  const issue = await issueStock({
    itemId: line.itemId!,
    warehouseId: line.warehouseId!,
    qty: line.qty,
    date: sale.date,
    reason: 'sale',
    docNo: sale.number,
    refType: 'sale',
    refId: sale.id,
  });
  const batchQty = new Map<string, number>();
  for (const m of issue.movements) batchQty.set(m.batchId, (batchQty.get(m.batchId) ?? 0) + m.qty);
  return {
    line,
    animal: null,
    costAmount: issue.totalCost,
    categoryId: line.categoryId ?? (await categoryIdByKey(incomeCategoryKey({ itemName: item.name }))),
    costCenterId: line.costCenterId ?? (await costCenterFromBatches(batchQty)) ?? (await generalCostCenterId()),
  };
}

/** What the herd has cost per animal so far, on top of purchase prices. */
async function accumulatedCostPerHead(herdId: string): Promise<number | null> {
  const cost = await herdCost(herdId);
  return cost.head > 0 ? cost.accumulated / cost.head : null;
}

async function prepareAnimalLine(line: SaleLine, animal: Animal, perHead: Map<string, number | null>): Promise<Posting> {
  let accumulated: number | null = null;
  if (animal.herdId) {
    if (!perHead.has(animal.herdId)) perHead.set(animal.herdId, await accumulatedCostPerHead(animal.herdId));
    accumulated = perHead.get(animal.herdId)!;
  }
  return {
    line,
    animal,
    // Spec 8.1: purchase price plus attached costs. A lamb born here has no purchase price.
    costAmount: animalBookValue(animal.purchasePrice, accumulated) ?? 0,
    categoryId: line.categoryId ?? (await categoryIdByKey(incomeCategoryKey({ animalCategory: animal.category }))),
    costCenterId: line.costCenterId ?? (animal.herdId ? await herdCostCenter(animal.herdId) : await generalCostCenterId()),
  };
}

async function postIncome(sale: Sale, postings: Posting[], fxRate: number) {
  const groups = new Map<string, { categoryId: string; costCenterId: string; amount: number; items: Posting[] }>();
  for (const p of postings) {
    const key = `${p.categoryId}:${p.costCenterId}`;
    const group = groups.get(key) ?? { categoryId: p.categoryId, costCenterId: p.costCenterId, amount: 0, items: [] };
    group.amount = round(group.amount + p.line.amount, 2);
    group.items.push(p);
    groups.set(key, group);
  }

  const transactionByLine = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.amount <= 0) continue; // A free line (price 0) moves goods but no money.
    const transaction = await postTransaction({
      date: sale.date,
      type: 'income',
      amount: group.amount,
      currency: sale.currency,
      fxRate,
      categoryId: group.categoryId,
      costCenterId: group.costCenterId,
      paymentMethod: sale.paymentMethod as (typeof SALE_PAYMENT_METHODS)[number],
      accountId: sale.accountId,
      counterpartyId: sale.counterpartyId,
      dueDate: sale.dueDate,
      description: sale.number,
      sourceType: 'sale',
      sourceId: sale.id,
      // Confirmation is the approval: spec 5.1 is enforced on the sale itself.
      autoApprove: true,
    });
    for (const p of group.items) transactionByLine.set(p.line.id, transaction.id);
  }
  return transactionByLine;
}

/** Everything a confirmed sale does, in one transaction: any failure undoes all of it. */
async function postSale(sale: Sale, lines: SaleLine[], fxRate: number) {
  const c = ctx();
  const animalIds = lines.flatMap((l) => (l.animalId ? [l.animalId] : []));
  const animalRows = animalIds.length
    ? await tx().select().from(animals).where(and(eq(animals.farmId, c.farmId), inArray(animals.id, animalIds))).for('update')
    : [];
  const animalById = new Map(animalRows.map((a) => [a.id, a]));
  animalRows.forEach(assertOnFarm);
  await assertNoWithdrawal(animalRows, sale.date);

  const perHead = new Map<string, number | null>();
  const postings: Posting[] = [];
  for (const line of lines) {
    postings.push(
      line.animalId
        ? await prepareAnimalLine(line, animalById.get(line.animalId)!, perHead)
        : await prepareItemLine(sale, line, await getItemOrThrow(line.itemId!)),
    );
  }

  const transactionByLine = await postIncome(sale, postings, fxRate);

  for (const p of postings) {
    await tx()
      .update(saleLines)
      .set({
        costAmount: p.costAmount,
        categoryId: p.categoryId,
        costCenterId: p.costCenterId,
        previousStatus: p.animal?.status ?? null,
        previousHerdId: p.animal?.herdId ?? null,
      })
      .where(eq(saleLines.id, p.line.id));

    if (!p.animal) continue;
    const byWeight = p.line.unit === 'kg';
    await tx().insert(animalExits).values({
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      animalId: p.animal.id,
      type: 'sale',
      date: sale.date,
      liveWeightKg: byWeight ? p.line.qty : p.animal.currentWeightKg,
      pricePerKg: byWeight ? p.line.price : null,
      amount: p.line.amount,
      counterpartyId: sale.counterpartyId,
      transactionId: transactionByLine.get(p.line.id) ?? null,
      notes: sale.number,
    });
    await markExited(p.animal.id, 'sold', sale.date);
  }

  const [first] = transactionByLine.values();
  await tx()
    .update(sales)
    .set({
      status: 'confirmed',
      fxRate,
      transactionId: first ?? null,
      confirmedBy: c.userId,
      confirmedAt: new Date(),
      rejectedReason: null,
    })
    .where(eq(sales.id, sale.id));
  await recordEvent({
    type: 'sale.confirmed',
    entityType: 'sale',
    entityId: sale.id,
    occurredAt: sale.date,
    data: { number: sale.number, total: sale.totalAmount, animals: animalRows.length },
  });
}

/**
 * Confirm a sale. Below the threshold anyone who may edit sales can do it. At or above it, a
 * person holding sales.approve who did not create the sale must confirm; anyone else only
 * submits it, and nothing moves until then.
 */
export async function confirm(id: string) {
  const sale = await lockSale(id);
  if (sale.status !== 'draft' && sale.status !== 'pending') {
    throw conflict('SALE_NOT_CONFIRMABLE', 'This sale cannot be confirmed');
  }
  // Confirming moves stock and money now. A future delivery belongs in deliveryDate.
  if (sale.date > today()) throw badRequest('SALE_DATE_IN_FUTURE', 'A sale dated in the future cannot be confirmed yet');
  const lines = await tx().select().from(saleLines).where(eq(saleLines.saleId, id));
  if (lines.length === 0) throw badRequest('SALE_EMPTY', 'A sale needs at least one line');
  // It may have closed while the draft waited.
  await assertLineCostCenters(lines);

  const c = ctx();
  const fxRate = await resolveRate(sale);
  const { approvalThreshold, makerChecker } = c.settings.finance;
  const needsSecondPerson = makerChecker && toBaseAmount(sale.totalAmount, fxRate) >= approvalThreshold;

  if (needsSecondPerson) {
    const isChecker = hasPermission('sales.approve') && sale.createdBy !== c.userId;
    if (!isChecker) {
      if (sale.status === 'pending') {
        throw forbidden('The person who entered a sale cannot confirm it', 'SAME_MAKER_CHECKER');
      }
      await tx().update(sales).set({ status: 'pending', rejectedReason: null }).where(eq(sales.id, id));
      await recordEvent({
        type: 'sale.submitted',
        entityType: 'sale',
        entityId: id,
        occurredAt: sale.date,
        data: { number: sale.number, total: sale.totalAmount },
      });
      await notifySaleSubmitted(sale.number!);
      return get(id);
    }
  }

  await postSale(sale, lines, fxRate);
  return get(id);
}

/** Send a pending sale back to draft, with the reason. */
export async function reject(id: string, reason: string) {
  const sale = await lockSale(id);
  if (sale.status !== 'pending') throw conflict('SALE_NOT_PENDING', 'This sale is not waiting for confirmation');
  if (ctx().settings.finance.makerChecker && sale.createdBy === ctx().userId) {
    throw forbidden('The person who entered a sale cannot decide on it', 'SAME_MAKER_CHECKER');
  }
  await tx().update(sales).set({ status: 'draft', rejectedReason: reason }).where(eq(sales.id, id));
  await recordEvent({ type: 'sale.rejected', entityType: 'sale', entityId: id, data: { reason } });
  return get(id);
}

/** Bring sold animals back. undoExit also reopens a pregnancy that the sale closed. */
async function restoreAnimals(saleId: string): Promise<void> {
  const rows = await tx()
    .select({ exitId: animalExits.id, animalId: animalExits.animalId, previousStatus: saleLines.previousStatus })
    .from(saleLines)
    .innerJoin(animalExits, eq(animalExits.animalId, saleLines.animalId))
    .where(eq(saleLines.saleId, saleId));
  for (const row of rows) {
    // The income is voided by now, so the exit no longer has money attached.
    await tx().update(animalExits).set({ transactionId: null }).where(eq(animalExits.id, row.exitId));
    await undoExit(row.exitId);
    // undoExit knows active and pregnant. A sick or quarantined animal goes back to that.
    if (row.previousStatus && row.previousStatus !== 'active' && row.previousStatus !== 'pregnant') {
      await tx().update(animals).set({ status: row.previousStatus }).where(eq(animals.id, row.animalId));
    }
  }
}

/** Void the sale's income, so the buyer no longer owes for a sale that never happened. */
async function voidIncome(sale: Sale, reason: string): Promise<number> {
  const voided = await voidTransactions({ sourceType: 'sale', sourceId: sale.id }, reason, { saleId: sale.id });
  return voided.length;
}

/** Same two-person rule as confirming: whoever confirmed a large sale cannot also undo it. */
function assertCanReverse(sale: Sale): void {
  assertPermission('sales.approve');
  const c = ctx();
  const { approvalThreshold, makerChecker } = c.settings.finance;
  const large = toBaseAmount(sale.totalAmount, sale.fxRate ?? 1) >= approvalThreshold;
  if (makerChecker && large && sale.confirmedBy === c.userId) {
    throw forbidden('The person who confirmed a sale cannot reverse it', 'SAME_CONFIRMER');
  }
}

/**
 * Cancel a sale. A draft or pending sale has moved nothing. A confirmed sale needs sales.approve:
 * stock returns to its batches, animals return to their herds, and the income is voided.
 */
export async function cancel(id: string, reason: string) {
  const sale = await lockSale(id);
  if (sale.status === 'cancelled') throw conflict('SALE_ALREADY_CANCELLED', 'This sale is already cancelled');

  const wasConfirmed = sale.status === 'confirmed';
  let voided = 0;
  if (wasConfirmed) {
    assertCanReverse(sale);
    await reverseMovements('sale', id);
    voided = await voidIncome(sale, reason);
    await restoreAnimals(id);
  }
  await tx()
    .update(sales)
    .set({ status: 'cancelled', cancelReason: reason, cancelledBy: ctx().userId, cancelledAt: new Date() })
    .where(eq(sales.id, id));
  await recordEvent({
    type: 'sale.cancelled',
    entityType: 'sale',
    entityId: id,
    data: { reason, wasConfirmed, voided },
  });
  return get(id);
}

/** Attach a contract, invoice, waybill or veterinary certificate (spec 13.2). */
export async function addDocument(id: string, input: z.infer<typeof saleDocumentInput>) {
  await lockSale(id);
  await assertFile(input.fileId);
  const c = ctx();
  const [row] = await tx()
    .insert(documents)
    .values({ ...input, entityType: 'sale', entityId: id, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  return row;
}
