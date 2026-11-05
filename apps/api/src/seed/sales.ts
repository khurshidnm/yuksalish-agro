import { and, eq, gt } from 'drizzle-orm';
import { addDays } from '@yap/shared';
import { schema } from '../db/client';
import { ctx, today, tx } from '../core/context';
import * as contracts from '../modules/sales/contracts.service';
import * as grants from '../modules/sales/grants.service';
import * as orders from '../modules/sales/orders.service';
import * as prices from '../modules/sales/prices.service';
import * as purchases from '../modules/sales/purchases.service';
import * as reports from '../modules/sales/state-reports.service';
import { findAccount, findCounterparty, findItem, findWarehouse } from './lookup';
import { SEED } from './names';
import type { SeedContext } from './types';

const { items, stockBatches } = schema;

const LAMB_ITEM = "Qo'zi (tirik vazn)";

/** Item with the given price per kg, converted when the item is kept in tonnes. */
const perUnit = (unit: string, pricePerKg: number) => (unit === 't' ? pricePerKg * 1000 : pricePerKg);

/** Monthly prices ending today, oldest first: [own sale price, market price] per kg. */
const PRICE_HISTORY_PER_KG: Record<string, [number, number][]> = {
  [LAMB_ITEM]: [[62_000, 63_000], [63_000, 64_000], [64_000, 65_500], [65_000, 66_000], [66_000, 67_000], [68_000, 69_000]],
  [SEED.item.wool]: [[9_000, 9_500], [9_000, 9_500], [9_500, 10_000], [10_000, 10_500], [10_500, 11_000], [11_000, 11_500]],
  [SEED.item.wheatGrain]: [[4_200, 4_300], [4_300, 4_400], [4_400, 4_500], [4_300, 4_450], [4_500, 4_600], [4_600, 4_700]],
  [SEED.item.alfalfa]: [[1_700, 1_750], [1_750, 1_800], [1_800, 1_900], [1_900, 2_000], [2_000, 2_100], [2_100, 2_200]],
};

async function seedPrices() {
  const c = ctx();
  const productWarehouse = await findWarehouse(SEED.warehouse.products);
  await tx().insert(items).values({
    tenantId: c.tenantId,
    farmId: c.farmId,
    createdBy: c.userId,
    name: LAMB_ITEM,
    category: 'product',
    unit: 'kg',
    defaultWarehouseId: productWarehouse.id,
  });

  for (const [name, history] of Object.entries(PRICE_HISTORY_PER_KG)) {
    const item = await findItem(name);
    for (const [index, [sale, market]] of history.entries()) {
      const date = addDays(today(), (index - history.length + 1) * 30);
      await prices.create({ itemId: item.id, date, kind: 'sale', price: perUnit(item.unit, sale), source: 'Narxlar ro\'yxati' });
      await prices.create({ itemId: item.id, date, kind: 'market', price: perUnit(item.unit, market), source: 'Qorovulbozor bozori' });
    }
  }
}

async function warehouseHolding(itemId: string, qty: number): Promise<string | null> {
  const [batch] = await tx()
    .select({ warehouseId: stockBatches.warehouseId })
    .from(stockBatches)
    .where(and(eq(stockBatches.farmId, ctx().farmId), eq(stockBatches.itemId, itemId), gt(stockBatches.qtyRemaining, qty)))
    .limit(1);
  return batch?.warehouseId ?? null;
}

/** A small confirmed sale when grain is in stock, and a large one waiting for the director. */
async function seedSaleDocuments() {
  const grain = await findItem(SEED.item.wheatGrain);
  const buyer = await findCounterparty(SEED.counterparty.grainBuyer);
  const account = await findAccount(SEED.account.bank);
  const qtyOf = (kg: number) => (grain.unit === 't' ? kg / 1000 : kg);
  // Stays above what the grain cost in the inventory seed, so the demo margin is a real one.
  const price = perUnit(grain.unit, 4_600);

  const small = qtyOf(800);
  const holding = await warehouseHolding(grain.id, small);
  const warehouseId = holding ?? (await findWarehouse(SEED.warehouse.feed)).id;
  const draft = await orders.create({
    date: addDays(today(), -3),
    counterpartyId: buyer.id,
    paymentMethod: 'bank',
    accountId: account.id,
    notes: "Bug'doy savdosi",
    lines: [{ itemId: grain.id, warehouseId, qty: small, price }],
  });
  if (holding) await orders.confirm(draft.id);

  const large = await orders.create({
    date: today(),
    counterpartyId: buyer.id,
    paymentMethod: 'debt',
    dueDate: addDays(today(), 30),
    deliveryDate: addDays(today(), 5),
    notes: 'Direktor tasdig\'ini kutmoqda',
    lines: [{ itemId: grain.id, warehouseId, qty: qtyOf(12_000), price }],
  });
  return large.id;
}

async function requestPurchase(itemName: string, kg: number, pricePerKg: number, supplierName: string, notes: string) {
  const item = await findItem(itemName);
  const supplier = await findCounterparty(supplierName);
  return purchases.create({
    itemId: item.id,
    qty: item.unit === 't' ? kg / 1000 : kg,
    expectedPrice: perUnit(item.unit, pricePerKg),
    counterpartyId: supplier.id,
    neededBy: addDays(today(), 10),
    notes,
  });
}

async function seedContracts() {
  const feedSupplier = await findCounterparty(SEED.counterparty.feedSupplier);
  const seller = await findCounterparty(SEED.counterparty.sheepSeller);
  const meatBuyer = await findCounterparty(SEED.counterparty.buyer);

  await contracts.create({
    counterpartyId: feedSupplier.id,
    number: 'YS-2026/14',
    title: 'Ozuqa yetkazib berish shartnomasi',
    startDate: addDays(today(), -345),
    endDate: addDays(today(), 18),
    amount: 180_000_000,
    currency: 'UZS',
    terms: "To'lov yetkazib berilgandan keyin 15 kun ichida.",
    status: 'active',
  });
  await contracts.create({
    counterpartyId: seller.id,
    number: 'SCH-2026/03',
    title: "700 bosh Hisori naslli sovliq xaridi",
    startDate: addDays(today(), -30),
    endDate: addDays(today(), -5),
    currency: 'UZS',
    status: 'closed',
  });
  await contracts.create({
    counterpartyId: meatBuyer.id,
    number: 'BGK-2027/01',
    title: "Qo'zilarni yetkazib berish shartnomasi",
    startDate: today(),
    endDate: addDays(today(), 300),
    amount: 1_200_000_000,
    currency: 'UZS',
    terms: 'Tirik vazn bo\'yicha, avgust-oktyabr 2027.',
    status: 'active',
  });
}

async function seedGrantsAndReports() {
  await grants.create({
    title: "Chorvachilikni rivojlantirish subsidiyasi",
    program: "Qishloq xo'jaligini qo'llab-quvvatlash jamg'armasi",
    kind: 'subsidy',
    amount: 180_000_000,
    status: 'in_review',
    submittedOn: addDays(today(), -14),
    notes: "700 bosh naslli sovliq xaridi bo'yicha.",
  });
  await grants.create({
    title: 'Imtiyozli kredit arizasi',
    program: 'Agrobank',
    kind: 'preferential_loan',
    amount: 800_000_000,
    status: 'draft',
  });

  await reports.create({
    title: 'Veterinariya oylik hisoboti',
    authority: 'veterinary',
    period: 'monthly',
    dueDate: addDays(today(), 6),
    notes: 'Tuman veterinariya bo\'limiga.',
  });
  await reports.create({
    title: 'Chorvachilik statistikasi (24-sh)',
    authority: 'statistics',
    period: 'quarterly',
    dueDate: addDays(today(), 22),
  });
  await reports.create({
    title: 'Yagona soliq hisoboti',
    authority: 'tax',
    period: 'quarterly',
    dueDate: addDays(today(), 12),
  });
}

export async function seedSales(s: SeedContext): Promise<void> {
  const largeSaleId = await s.run(async () => {
    await seedPrices();
    await seedContracts();
    await seedGrantsAndReports();
    return seedSaleDocuments();
  }, 'accountant');
  // At or above the threshold, so this waits as `pending` for a second person.
  await s.run(() => orders.confirm(largeSaleId), 'accountant');

  // Waiting for the director.
  await s.run(
    () => requestPurchase(SEED.item.bran, 5_000, 2_400, SEED.counterparty.feedSupplier, "Qo'zilash davri uchun qo'shimcha kepak"),
    'storekeeper',
  );

  // Approved, waiting for finance.
  const approved = await s.run(
    () => requestPurchase(SEED.item.premix, 300, 18_000, SEED.counterparty.feedSupplier, "Bo'g'oz sovliqlar uchun"),
    'storekeeper',
  );
  await s.run(() => purchases.approve(approved.id), 'director');

  // The full flow, with 20 kg short on arrival.
  const finished = await s.run(
    () => requestPurchase(SEED.item.salt, 1_000, 1_500, SEED.counterparty.feedSupplier, 'Yalama tuz'),
    'storekeeper',
  );
  await s.run(() => purchases.approve(finished.id), 'director');
  await s.run(async () => {
    const account = await findAccount(SEED.account.bank);
    await purchases.pay(finished.id, {
      date: addDays(today(), -6),
      amount: finished.qty * finished.expectedPrice!,
      paymentMethod: 'bank',
      accountId: account.id,
    });
  }, 'accountant');
  await s.run(async () => {
    const warehouse = await findWarehouse(SEED.warehouse.feed);
    await purchases.receive(finished.id, {
      date: addDays(today(), -4),
      qty: finished.qty * 0.98,
      warehouseId: warehouse.id,
      quality: 'Yaxshi',
      notes: "20 kg kam keldi, yetkazib beruvchiga akt yuborildi.",
    });
  }, 'storekeeper');
}
