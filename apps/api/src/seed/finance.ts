import { and, eq, inArray, sql } from 'drizzle-orm';
import { addDays, round, todayIso } from '@yap/shared';
import { schema } from '../db/client';
import { ctx, tx } from '../core/context';
import { ensureCostCenter, generalCostCenterId } from '../core/costCenters';
import { approveTransaction, postTransaction, type PostTransactionInput } from '../core/ledger';
import { listWithBalances } from '../modules/finance/accounts.service';
import { saveEntries } from '../modules/finance/budget.service';
import { settle } from '../modules/finance/debts.service';
import { upsert as saveRate } from '../modules/finance/fx.service';
import { create as createLoan, payInstalment } from '../modules/finance/loans.service';
import {
  findAccount,
  findAsset,
  findCategory,
  findCounterparty,
  findField,
  findHerd,
} from './lookup';
import { SEED } from './names';
import type { SeedContext } from './types';

const { accounts, animals, financeCategories, items, stockBatches, transactions } = schema;

const P = SEED.counterparty;

/** Item category → how its purchase is recorded. */
const STOCK_PURCHASE: Record<string, { category: string; supplier: string }> = {
  feed: { category: 'feed', supplier: P.feedSupplier },
  seed: { category: 'seed', supplier: P.seedSupplier },
  fertilizer: { category: 'fertilizer', supplier: P.seedSupplier },
  chemical: { category: 'crop_protection', supplier: P.seedSupplier },
  vet_drug: { category: 'veterinary', supplier: P.vetSupplier },
  vaccine: { category: 'veterinary', supplier: P.vetSupplier },
  fuel: { category: 'fuel', supplier: P.fuelSupplier },
  lubricant: { category: 'fuel', supplier: P.fuelSupplier },
  spare_part: { category: 'spare_parts', supplier: P.fuelSupplier },
};

/** Feed bought on credit, part of it paid, the rest due later this month. */
const CREDIT_FEED = 24_000_000;
const CREDIT_FEED_PAID = 10_000_000;

/** The ewes are capitalised with what it took to get them here: road and border veterinary work. */
const TATARSTAN_TRANSPORT = 268_000_000;
const IMPORT_VETERINARY = 18_500_000;

const CLOSING_BANK = 1_860_000_000;
const CLOSING_CASH = 62_000_000;

const BUDGET_MONTHS = [
  '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04',
  '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10',
];

/**
 * Budget 2026/27 in million so'm, one value per month in BUDGET_MONTHS. Winter runs on the money set
 * aside for it. From summer come the 2027 harvest and then the first lambs: 770 born at 110 % and
 * 8 % losses, a fifth kept for the flock and about 566 sold at 45 kg and 68 000 so'm a kilogram.
 */
const BUDGET: Record<string, number[]> = {
  animal_purchase: [3510, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  feed: [120, 8, 8, 8, 14, 14, 10, 6, 4, 4, 20, 40, 60],
  veterinary: [34, 6, 6, 6, 12, 12, 8, 6, 6, 6, 6, 6, 8],
  tags_devices: [6, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0],
  shearing: [0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0],
  seed: [115, 0, 0, 0, 0, 12, 10, 0, 0, 0, 0, 0, 110],
  fertilizer: [210, 0, 0, 0, 0, 30, 20, 0, 0, 0, 0, 0, 130],
  crop_protection: [15, 0, 0, 0, 0, 5, 6, 4, 0, 0, 0, 0, 0],
  water: [3, 1, 0, 0, 0, 3, 6, 8, 8, 8, 6, 3, 3],
  mechanization_service: [10, 0, 0, 0, 0, 5, 0, 0, 30, 18, 0, 0, 10],
  salary: [34, 34, 34, 34, 38, 38, 38, 36, 36, 36, 36, 36, 36],
  fuel: [175, 6, 4, 4, 5, 16, 14, 10, 20, 16, 10, 8, 85],
  repair: [8, 4, 3, 3, 3, 6, 5, 4, 5, 4, 3, 3, 6],
  electricity: [5, 5, 6, 6, 6, 5, 5, 5, 5, 5, 5, 5, 5],
  communication: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  transport: [6, 2, 2, 2, 2, 3, 3, 2, 3, 3, 3, 3, 3],
  bank_fees: [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4],
  insurance: [12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12],
  loan_interest: [29, 28, 28, 27, 26, 26, 25, 24, 24, 23, 22, 22, 21],
  subsidies: [65, 0, 0, 0, 0, 90, 0, 0, 0, 0, 0, 0, 0],
  wool_sales: [0, 0, 0, 0, 0, 0, 0, 14, 6, 0, 0, 0, 0],
  grain_sales: [0, 0, 0, 0, 0, 0, 0, 0, 0, 380, 240, 0, 0],
  alfalfa_sales: [0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 40, 0, 0],
  lamb_sales: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 830, 900, 0],
  services_income: [6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

export async function seedFinance(s: SeedContext): Promise<void> {
  /** History entered by the accountant. Large ones go through a real approval by the director. */
  const toApprove: string[] = [];
  const post = async (input: PostTransactionInput) => {
    const row = await postTransaction(input);
    if (row.status === 'pending') toApprove.push(row.id);
    return row;
  };

  await s.run(async () => {
    await saveRate({ date: '2026-10-01', currency: 'USD', rate: 12_640 });
    await saveRate({ date: '2026-10-01', currency: 'EUR', rate: 13_710 });
    await saveRate({ date: '2026-10-01', currency: 'RUB', rate: 153.4 });
    await saveRate({ date: '2026-11-01', currency: 'USD', rate: 12_695 });
    await saveRate({ date: '2026-11-01', currency: 'EUR', rate: 13_790 });
    await saveRate({ date: '2026-11-01', currency: 'RUB', rate: 155.1 });
  }, 'accountant');

  const lender = await s.run(() => findCounterparty(P.bank));
  const loan = await s.run(async () => {
    const bank = await findAccount(SEED.account.bank);
    const created = await createLoan({
      counterpartyId: lender.id,
      name: 'Agrobank imtiyozli krediti',
      principal: 2_500_000_000,
      annualRate: 14,
      termMonths: 36,
      startDate: '2026-09-15',
      method: 'annuity',
      preferential: true,
      terms: "Chorvachilikni rivojlantirish dasturi bo'yicha, garov: ferma mol-mulki",
      disburseToAccountId: bank.id,
    });
    const rows = await tx()
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.sourceType, 'loan'), eq(transactions.sourceId, created.id)));
    toApprove.push(...rows.map((row) => row.id));
    return created;
  }, 'accountant');

  await s.run(async () => {
    const c = ctx();
    const bank = await findAccount(SEED.account.bank);
    const cash = await findAccount(SEED.account.cash);
    const general = await generalCostCenterId();

    const herd = await findHerd(SEED.herd.pregnant);
    const herdCc = herd.costCenterId ?? (await ensureCostCenter('herd', herd.id, herd.name));
    const fieldCc = async (number: string) => {
      const field = await findField(number);
      return field.costCenterId ?? ensureCostCenter('field', field.id, `Dala №${field.number}`);
    };
    const tractor = await findAsset(SEED.asset.tractor1);
    const tractorCc = tractor.costCenterId ?? (await ensureCostCenter('asset', tractor.id, tractor.name));

    const byBank = { paymentMethod: 'bank' as const, accountId: bank.id };
    const byCash = { paymentMethod: 'cash' as const, accountId: cash.id };
    const category = async (key: string) => (await findCategory(key)).id;
    const supplier = async (name: string) => (await findCounterparty(name)).id;

    // Ewes: capitalised into the animals, so the herd's running costs stay separate.
    const [flock] = await tx()
      .select({
        total: sql<string>`coalesce(sum(${animals.purchasePrice}), 0)`,
        firstDate: sql<string | null>`min(${animals.purchaseDate})`,
      })
      .from(animals)
      .where(and(eq(animals.farmId, c.farmId), eq(animals.origin, 'purchased')));
    await post({
      ...byBank,
      date: flock.firstDate ?? '2026-10-20',
      type: 'expense',
      amount: Number(flock.total) || 700 * 4_600_000,
      categoryId: await category('animal_purchase'),
      costCenterId: herdCc,
      costTreatment: 'animal',
      counterpartyId: await supplier(P.sheepSeller),
      description: "Tataristondan 700 bosh Hisori naslli bo'g'oz sovliq",
    });

    // Stock on the shelves was paid for. Everything here is 'inventory': it reaches a field or
    // herd only when issued, so it must not be charged to one now.
    const batches = await tx()
      .select({
        name: items.name,
        category: items.category,
        date: sql<string>`min(${stockBatches.receivedDate})`,
        value: sql<string>`sum(${stockBatches.qtyReceived} * ${stockBatches.unitCost})`,
      })
      .from(stockBatches)
      .innerJoin(items, eq(items.id, stockBatches.itemId))
      .where(and(eq(stockBatches.farmId, c.farmId), inArray(stockBatches.source, ['opening', 'purchase'])))
      .groupBy(items.name, items.category);

    let creditLeft = CREDIT_FEED;
    for (const batch of batches) {
      const rule = STOCK_PURCHASE[batch.category];
      const value = round(Number(batch.value), 2);
      if (!rule || value <= 0) continue;
      const common = {
        // Stock received in late September was paid at the start of the 2026/27 budget year.
        date: batch.date < '2026-10-01' ? '2026-10-02' : batch.date,
        type: 'expense' as const,
        categoryId: await category(rule.category),
        costCenterId: general,
        costTreatment: 'inventory' as const,
        counterpartyId: await supplier(rule.supplier),
        description: batch.name,
      };
      // The largest feed purchase is partly on credit from the feed supplier.
      const onCredit = rule.category === 'feed' && value > creditLeft && creditLeft > 0 ? creditLeft : 0;
      if (onCredit) {
        creditLeft = 0;
        await post({
          ...common,
          amount: onCredit,
          paymentMethod: 'debt',
          dueDate: '2026-11-25',
          description: `${batch.name}: qarzga`,
        });
      }
      await post({ ...common, ...byBank, amount: round(value - onCredit, 2) });
    }

    await post({
      ...byBank,
      date: '2026-10-20',
      type: 'expense',
      amount: TATARSTAN_TRANSPORT,
      categoryId: await category('animal_purchase'),
      costCenterId: herdCc,
      costTreatment: 'animal',
      description: "Qo'ylarni Tataristondan olib kelish: 8 ta chorva tashuvchi",
    });
    await post({
      ...byBank,
      date: '2026-10-20',
      type: 'expense',
      amount: IMPORT_VETERINARY,
      categoryId: await category('animal_purchase'),
      costCenterId: herdCc,
      costTreatment: 'animal',
      description: 'Import karantini va veterinariya rasmiylashtiruvi',
    });
    await post({
      ...byCash,
      date: '2026-10-23',
      type: 'expense',
      amount: 4_550_000,
      categoryId: await category('tags_devices'),
      costCenterId: herdCc,
      description: '700 dona quloq birkasi',
    });
    await post({
      ...byCash,
      date: '2026-10-24',
      type: 'expense',
      amount: 6_700_000,
      categoryId: await category('veterinary'),
      costCenterId: herdCc,
      counterpartyId: await supplier(P.vetSupplier),
      description: 'Kelgan qo\'ylarni veterinariya tekshiruvi',
    });
    await post({
      ...byBank,
      date: '2026-10-14',
      type: 'expense',
      amount: 11_400_000,
      categoryId: await category('insurance'),
      costCenterId: general,
      description: "Chorva mollarini sug'urtalash",
    });
    await post({
      ...byCash,
      date: '2026-10-16',
      type: 'expense',
      amount: 1_800_000,
      categoryId: await category('water'),
      costCenterId: await fieldCc(SEED.field.wheat1),
      description: "Kuzgi sug'orish uchun suv haqi",
    });
    await post({
      ...byBank,
      date: '2026-10-12',
      type: 'expense',
      amount: 9_500_000,
      categoryId: await category('mechanization_service'),
      costCenterId: await fieldCc(SEED.field.barley),
      description: 'Yer haydash xizmati',
    });
    await post({
      ...byCash,
      date: '2026-10-08',
      type: 'expense',
      amount: 4_200_000,
      categoryId: await category('repair'),
      costCenterId: tractorCc,
      description: 'MTZ-82 dvigatel ta\'miri',
    });
    await post({
      ...byCash,
      date: '2026-11-02',
      type: 'expense',
      amount: 2_200_000,
      categoryId: await category('repair'),
      costCenterId: tractorCc,
      description: 'Gidravlika shlangi almashtirildi',
    });
    await post({
      ...byBank,
      date: '2026-10-31',
      type: 'expense',
      amount: 3_900_000,
      categoryId: await category('electricity'),
      costCenterId: general,
      description: 'Oktabr elektr energiyasi',
    });
    await post({
      ...byCash,
      date: '2026-10-31',
      type: 'expense',
      amount: 450_000,
      categoryId: await category('communication'),
      costCenterId: general,
      description: 'Aloqa va internet',
    });
    await post({
      ...byBank,
      date: '2026-10-31',
      type: 'expense',
      amount: 320_000,
      categoryId: await category('bank_fees'),
      costCenterId: general,
      description: 'Bank xizmati',
    });
    await post({
      ...byBank,
      date: '2026-09-20',
      type: 'expense',
      amount: 95_000_000,
      categoryId: await category('barn_construction'),
      costCenterId: general,
      costTreatment: 'capex',
      description: 'Molxonani qayta jihozlash',
    });

    await post({
      ...byBank,
      date: '2026-10-28',
      type: 'income',
      amount: 65_000_000,
      categoryId: await category('subsidies'),
      costCenterId: general,
      description: 'Naslli chorvachilik subsidiyasi',
    });
    // The 2026 harvest, sold through the autumn.
    await post({
      ...byBank,
      date: '2026-08-12',
      type: 'income',
      amount: 374_000_000,
      categoryId: await category('grain_sales'),
      costCenterId: await fieldCc(SEED.field.wheat3),
      counterpartyId: await supplier(P.grainBuyer),
      description: "2026 yil bug'doyi: 110 t",
    });
    await post({
      ...byBank,
      date: '2026-10-09',
      type: 'income',
      amount: 188_700_000,
      categoryId: await category('grain_sales'),
      costCenterId: await fieldCc(SEED.field.wheat1),
      counterpartyId: await supplier(P.grainBuyer),
      description: "2026 yil bug'doyi: 55,5 t",
    });
    await post({
      ...byBank,
      date: '2026-10-18',
      type: 'income',
      amount: 84_000_000,
      categoryId: await category('alfalfa_sales'),
      costCenterId: await fieldCc(SEED.field.alfalfa),
      description: 'Ortiqcha beda pichani: 42 t',
    });
    await post({
      ...byCash,
      date: '2026-10-19',
      type: 'income',
      amount: 6_000_000,
      categoryId: await category('services_income'),
      costCenterId: tractorCc,
      description: "Qo'shni xo'jalikka yer haydab berildi",
    });
  }, 'accountant');

  await s.run(async () => {
    for (const id of toApprove) await approveTransaction(id);

    const bank = await findAccount(SEED.account.bank);
    const first = (await tx()
      .select()
      .from(schema.loanInstalments)
      .where(eq(schema.loanInstalments.loanId, loan.id))
      .orderBy(schema.loanInstalments.period)
      .limit(1))[0];
    await payInstalment(loan.id, first.id, { date: first.dueDate, accountId: bank.id });
  }, 'director');

  // The settlement can only follow the approval of the debt it pays, and needs approval itself.
  const settlement = await s.run(async () => {
    const bank = await findAccount(SEED.account.bank);
    const feedSupplier = await findCounterparty(P.feedSupplier);
    return settle({
      counterpartyId: feedSupplier.id,
      direction: 'payable',
      amount: CREDIT_FEED_PAID,
      date: '2026-10-20',
      accountId: bank.id,
      description: "Qisman to'lov",
    });
  }, 'accountant');
  await s.run(() => approveTransaction(settlement.id), 'director');

  // Waiting for the director, so the approval queue is not empty.
  await s.run(async () => {
    const general = await generalCostCenterId();
    const bank = await findAccount(SEED.account.bank);
    await postTransaction({
      date: addDays(todayIso(), -1),
      type: 'expense',
      amount: 18_500_000,
      paymentMethod: 'bank',
      accountId: bank.id,
      categoryId: (await findCategory('equipment_rent')).id,
      costCenterId: general,
      description: 'Kombayn ijarasi uchun avans',
    });
  }, 'accountant');

  // Budget lines are in million so'm.
  await s.run(async () => {
    const rows = await tx()
      .select({ id: financeCategories.id, key: financeCategories.key })
      .from(financeCategories)
      .where(eq(financeCategories.tenantId, ctx().tenantId));
    const idOf = new Map(rows.map((row) => [row.key, row.id]));
    const entries = Object.entries(BUDGET).flatMap(([key, values]) =>
      values.flatMap((million, index) =>
        million > 0
          ? [{ month: BUDGET_MONTHS[index], categoryId: idOf.get(key)!, amount: round(million * 1_000_000, 2) }]
          : [],
      ),
    );
    await saveEntries({ entries });
  }, 'accountant');

  // Set opening balances last, so the accounts end on realistic figures whatever was posted above.
  await s.run(async () => {
    const balances = await listWithBalances();
    const targets: [string, number][] = [
      [SEED.account.bank, CLOSING_BANK],
      [SEED.account.cash, CLOSING_CASH],
    ];
    for (const [name, target] of targets) {
      const account = balances.find((row) => row.name === name)!;
      await tx()
        .update(accounts)
        .set({ openingBalance: round(account.openingBalance + target - account.balance, 2) })
        .where(eq(accounts.id, account.id));
    }
  }, 'accountant');
}
