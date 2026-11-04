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

/** Feed bought on credit, part of it paid, the rest past its due date. */
const CREDIT_FEED = 24_000_000;
const CREDIT_FEED_PAID = 10_000_000;

const CLOSING_BANK = 940_000_000;
const CLOSING_CASH = 38_000_000;

const BUDGET_MONTHS = [
  '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04',
  '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10',
];

/**
 * Budget 2026/27 in million so'm, one value per month in BUDGET_MONTHS. Income starts in summer,
 * after harvest and the first lamb sales, so the forecast shows a shortfall before then.
 */
const BUDGET: Record<string, number[]> = {
  animal_purchase: [2150, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  feed: [570, 14, 12, 12, 20, 25, 15, 6, 4, 4, 35, 90, 120],
  veterinary: [18, 5, 5, 5, 10, 10, 6, 5, 5, 5, 5, 5, 8],
  tags_devices: [4, 0, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0],
  shearing: [0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0],
  seed: [120, 0, 0, 0, 0, 20, 10, 0, 0, 0, 0, 0, 90],
  fertilizer: [210, 0, 0, 0, 0, 30, 20, 0, 0, 0, 0, 0, 120],
  crop_protection: [0, 0, 0, 0, 0, 5, 6, 4, 0, 0, 0, 0, 0],
  water: [2, 1, 0, 0, 0, 2, 5, 6, 6, 6, 5, 2, 2],
  mechanization_service: [10, 0, 0, 0, 0, 4, 0, 0, 28, 16, 0, 0, 8],
  salary: [32, 33, 33, 33, 36, 36, 36, 34, 34, 34, 34, 34, 34],
  fuel: [130, 5, 3, 3, 4, 14, 12, 8, 18, 14, 8, 6, 80],
  repair: [7, 3, 3, 3, 3, 5, 4, 3, 4, 3, 3, 3, 5],
  electricity: [4, 4, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4],
  communication: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  transport: [13, 2, 2, 2, 2, 3, 3, 2, 3, 3, 3, 3, 3],
  bank_fees: [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4],
  insurance: [8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8],
  loan_interest: [18, 17, 17, 16, 16, 16, 15, 15, 15, 14, 14, 14, 13],
  subsidies: [45, 0, 0, 0, 0, 60, 0, 0, 0, 0, 0, 0, 0],
  wool_sales: [0, 0, 0, 0, 0, 0, 0, 18, 6, 0, 0, 0, 0],
  grain_sales: [0, 0, 0, 0, 0, 0, 0, 0, 0, 230, 120, 0, 0],
  alfalfa_sales: [0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 40, 0, 0],
  lamb_sales: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 340, 460, 220],
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
      principal: 1_500_000_000,
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
      amount: Number(flock.total) || 500 * 4_200_000,
      categoryId: await category('animal_purchase'),
      costCenterId: herdCc,
      costTreatment: 'animal',
      counterpartyId: await supplier(P.sheepSeller),
      description: "500 bosh Hisori bo'g'oz sovliq xaridi",
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
          dueDate: '2026-10-25',
          description: `${batch.name}: qarzga`,
        });
      }
      await post({ ...common, ...byBank, amount: round(value - onCredit, 2) });
    }

    await post({
      ...byBank,
      date: '2026-10-22',
      type: 'expense',
      amount: 12_400_000,
      categoryId: await category('transport'),
      costCenterId: herdCc,
      description: "Qo'ylarni Sherobodan olib kelish",
    });
    await post({
      ...byCash,
      date: '2026-10-23',
      type: 'expense',
      amount: 3_250_000,
      categoryId: await category('tags_devices'),
      costCenterId: herdCc,
      description: '500 dona quloq birkasi',
    });
    await post({
      ...byCash,
      date: '2026-10-24',
      type: 'expense',
      amount: 4_800_000,
      categoryId: await category('veterinary'),
      costCenterId: herdCc,
      counterpartyId: await supplier(P.vetSupplier),
      description: 'Kelgan qo\'ylarni veterinariya tekshiruvi',
    });
    await post({
      ...byBank,
      date: '2026-10-14',
      type: 'expense',
      amount: 7_600_000,
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
      amount: 45_000_000,
      categoryId: await category('subsidies'),
      costCenterId: herdCc,
      description: 'Naslli chorvachilik subsidiyasi',
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
