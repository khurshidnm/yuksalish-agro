import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, monthOf, monthRange, todayIso } from '@yap/shared';
import { SCENARIO_DEFAULTS, runScenario, scenarioMonthAt, type ScenarioAssumptions } from '@yap/shared/formulas/scenario';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { ensureCostCenter } from '../src/core/costCenters';
import { issueStock, receiveStock } from '../src/core/inventory';
import { postTransaction } from '../src/core/ledger';
import { monthToDate, operatingCostByMonth } from '../src/modules/finance/summary';
import { createPregnancy } from '../src/modules/livestock/breeding.service';
import { createExit } from '../src/modules/livestock/exits.service';
import { createFixture, type Client, type Fixture } from './helpers';

const { accounts, animals, breedingRecords, breeds, counterparties, events, financeCategories, herds, items, rationLines, rations, species, warehouses } =
  schema;

const T = todayIso();
const M = monthOf(T);
const M1 = scenarioMonthAt(M, -1);
const M2 = scenarioMonthAt(M, -2);
const stallNow = (SCENARIO_DEFAULTS.stallMonths as readonly number[]).includes(Number(M.slice(5)));

/** The tiny herd of formulas/scenario.test.ts: its figures are worked by hand there. */
const plan: ScenarioAssumptions = {
  startMonth: '2027-01',
  openingEwes: 100,
  openingRams: 2,
  openingReplacements: 0,
  openingLambs: 0,
  lambingMonth: 3,
  lambingShare: 0.9,
  lambsPerEweLambing: 1.2,
  lambSurvival: 0.9,
  eweDeathsPerYear: 0,
  eweCullsPerYear: 0,
  replacementShare: 0.4,
  firstLambingAgeMonths: 24,
  saleAgeMonths: 6,
  saleWeightKg: 40,
  pricePerKg: 50,
  cullEwePrice: null,
  feedAdultStallPerMonth: 30,
  feedAdultGrazingPerMonth: 10,
  feedLambPerMonth: 8,
  otherCostPerHeadPerMonth: 2,
  fixedCostPerMonth: 1000,
  openingCash: 20000,
  stallMonths: [11, 12, 1, 2, 3],
  oneOffs: [{ month: 0, amount: 5000 }],
};

describe('scenario planner: who may do what', () => {
  let f: Fixture;
  let accountant: Client;
  let savedId: string;

  beforeAll(async () => {
    f = await createFixture();
    accountant = await f.as('accountant');
    const res = await accountant.post('/finance/scenarios', { name: 'Asosiy reja', assumptions: plan, notes: 'birinchi' });
    expect(res.status).toBe(201);
    savedId = res.data.id;
  });

  it('refuses a shepherd everywhere', async () => {
    const shepherd = await f.as('shepherd');
    expect((await shepherd.get('/finance/scenarios/baseline')).status).toBe(403);
    expect((await shepherd.post('/finance/scenarios/compute', plan)).status).toBe(403);
    expect((await shepherd.get('/finance/scenarios')).status).toBe(403);
    expect((await shepherd.get(`/finance/scenarios/${savedId}`)).status).toBe(403);
    expect((await shepherd.post('/finance/scenarios', { name: 'x', assumptions: plan })).status).toBe(403);
  });

  it.each(['investor', 'auditor'] as const)('lets an %s compute and read, but not save, change or delete', async (role) => {
    const reader = await f.as(role);
    expect((await reader.get('/finance/scenarios/baseline')).status).toBe(200);
    const computed = await reader.post('/finance/scenarios/compute', plan);
    expect(computed.status).toBe(200);
    expect(computed.data.years).toHaveLength(3);
    const listed = await reader.get('/finance/scenarios');
    expect(listed.status).toBe(200);
    expect(listed.data.map((row: any) => row.name)).toEqual(['Asosiy reja']);
    expect((await reader.get(`/finance/scenarios/${savedId}`)).data.assumptions).toEqual(plan);

    expect((await reader.post('/finance/scenarios', { name: 'x', assumptions: plan })).status).toBe(403);
    expect((await reader.patch(`/finance/scenarios/${savedId}`, { name: 'y' })).status).toBe(403);
    expect((await reader.delete(`/finance/scenarios/${savedId}`)).status).toBe(403);
  });

  it('computes what the shared model computes', async () => {
    const res = await accountant.post('/finance/scenarios/compute', plan);
    expect(res.data).toEqual(JSON.parse(JSON.stringify(runScenario(plan))));
    // Hand-worked in formulas/scenario.test.ts.
    expect(res.data.years[0].profit).toBeCloseTo(106_089.28, 6);
    expect(res.data.summary.firstNegativeCashMonth).toBe('2027-04');
    expect(res.data.summary.paybackMonth).toBe('2027-09');
  });

  it('refuses assumptions outside their range', async () => {
    expect((await accountant.post('/finance/scenarios/compute', { ...plan, lambSurvival: 1.2 })).status).toBe(400);
    expect((await accountant.post('/finance/scenarios/compute', { ...plan, lambingMonth: 13 })).status).toBe(400);
    expect((await accountant.post('/finance/scenarios/compute', { ...plan, oneOffs: [{ month: 36, amount: 1 }] })).status).toBe(400);
    expect((await accountant.post('/finance/scenarios', { name: '', assumptions: plan })).status).toBe(400);
  });

  it('saves, changes and deletes a plan, with a journal event for each', async () => {
    const created = await accountant.post('/finance/scenarios', { name: 'Narx tushsa', assumptions: { ...plan, pricePerKg: 40 } });
    expect(created.status).toBe(201);
    const id = created.data.id;
    const changed = await accountant.patch(`/finance/scenarios/${id}`, { name: 'Narx 40', assumptions: { ...plan, pricePerKg: null } });
    expect(changed.status).toBe(200);
    expect(changed.data).toMatchObject({ name: 'Narx 40' });
    expect(changed.data.assumptions.pricePerKg).toBeNull();
    expect((await accountant.delete(`/finance/scenarios/${id}`)).status).toBe(200);
    expect((await accountant.get(`/finance/scenarios/${id}`)).status).toBe(404);

    const types = await f.run(async () => (await tx().select({ type: events.type }).from(events).where(eq(events.entityId, id))).map((e) => e.type));
    expect(types.sort()).toEqual(['scenario.created', 'scenario.deleted', 'scenario.updated']);
  });

  it("keeps one tenant's plans from another", async () => {
    const other = await createFixture();
    const stranger = await other.as('accountant');
    expect((await stranger.get('/finance/scenarios')).data).toEqual([]);
    expect((await stranger.get(`/finance/scenarios/${savedId}`)).status).toBe(404);
    expect((await stranger.patch(`/finance/scenarios/${savedId}`, { name: 'olib qo\'ydim' })).status).toBe(404);
    expect((await stranger.delete(`/finance/scenarios/${savedId}`)).status).toBe(404);
    expect((await accountant.get(`/finance/scenarios/${savedId}`)).data.name).toBe('Asosiy reja');
  });
});

describe('scenario baseline on an empty farm', () => {
  it('states nothing as the farm\'s own figure', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const res = await owner.get('/finance/scenarios/baseline');
    expect(res.status).toBe(200);
    const { startMonth, stallMonths, oneOffs, ...numbers } = res.data.assumptions;
    expect(startMonth).toBe(M);
    expect(stallMonths).toBeNull();
    expect(oneOffs).toEqual([]);
    expect(Object.keys(numbers)).toHaveLength(22);
    for (const [key, value] of Object.entries(numbers)) expect([key, value]).toEqual([key, null]);
    expect(res.data.sources).toEqual({});
    expect(res.data.costGroups).toBeNull();
    // The app's starting values are offered apart, each marked as a default.
    for (const suggestion of Object.values<any>(res.data.suggestions)) expect(suggestion.source).toBe('default');
    expect(res.data.suggestions.lambsPerEweLambing.value).toBe(1.1);
    expect(res.data.suggestions.pricePerKg).toBeUndefined();
    expect(res.data.suggestions.openingEwes).toBeUndefined();
    // And a plan run on the empty baseline knows nothing.
    const computed = await owner.post('/finance/scenarios/compute', res.data.assumptions);
    expect(computed.data.summary.profit).toBeNull();
    expect(computed.data.summary.breakEvenPricePerKg).toBeNull();
  });
});

/**
 * A small farm, by hand. Dates: T is today, M its month, M1 and M2 the two months before.
 *
 * Flock    10 ewes and 1 ram in "Sovliqlar", 2 ewe lambs and 3 ram lambs in "Qo'zilar": 16 head.
 * Lambing  8 of the 10 ewes carry, so the share that lambs is 8 / 10 = 0.8. Four are scanned
 *          with 1, 2, 2 and 1 foetuses: 6 / 4 = 1.5 lambs per ewe. No lambing yet, so no survival.
 * Sales    lambs: 40 kg at 50 000 = 2 000 000, and 44 kg at 45 000 = 1 980 000:
 *            weight 84 / 2 = 42 kg, price 3 980 000 / 84 = 47 380.95.
 *          A lamb sold by the head for 1 500 000 has no weight and enters neither figure. A lamb
 *          at 6 000 000 waits for approval and does not count. A ewe sold for 900 000: cull price.
 * Costs    M2: fuel 300 000, vet 160 000.
 *          M1: fuel 100 000, vet drugs issued 10 x 8 000 = 80 000, bought feed issued 25 x 4 000 = 100 000.
 *          Left out: a tractor (capex 4 000 000), feed bought for stock (400 000), own hay fed
 *          (100 x 1 000), and fuel of 50 000 in M, a month not yet whole.
 *          Two months of record, so the divisor is 2:
 *            per head  (160 000 + 80 000) / 2 / 16 head       =   7 500
 *            fixed     (300 000 + 100 000) / 2                = 200 000
 *            feed      100 000 / 2 = 50 000, shown but not used
 *            all       740 000 / 2                            = 370 000
 * Rations  grown sheep: 0.5 kg bran at 4 000 + 2 kg hay at 1 000 = 4 000 a head a day,
 *            x 365 / 12 = 121 666.67 a month (11 head eat it).
 *          lambs: 0.3 kg bran = 1 200 a head a day, x 365 / 12 = 36 500 a month.
 * Cash     opening 10 000 000 + sales 2 000 000 + 1 980 000 + 1 500 000 + 900 000
 *          - 300 000 - 160 000 - 100 000 - 4 000 000 - 400 000 - 50 000 = 11 370 000.
 */
describe('scenario baseline on a small farm', () => {
  let f: Fixture;
  let lambingMonth: number;

  beforeAll(async () => {
    f = await createFixture();
    await f.run(async () => {
      const base = { tenantId: f.tenantId, farmId: f.farmId };
      const [account] = await tx().insert(accounts).values({ ...base, name: 'Kassa-Maxfiy', type: 'cash', openingBalance: 10_000_000 }).returning();
      const [buyer] = await tx().insert(counterparties).values({ ...base, name: 'Xaridor-Maxfiy', type: 'buyer' }).returning();
      const [warehouse] = await tx().insert(warehouses).values({ ...base, name: 'Ombor', type: 'feed' }).returning();
      const [hay] = await tx().insert(items).values({ ...base, name: 'Beda', category: 'feed', unit: 'kg', transferPrice: 1_000 }).returning();
      const [bran] = await tx().insert(items).values({ ...base, name: 'Kepak', category: 'feed', unit: 'kg' }).returning();
      const [drug] = await tx().insert(items).values({ ...base, name: 'Dori', category: 'vet_drug', unit: 'pcs' }).returning();

      const [adultRation] = await tx().insert(rations).values({ ...base, name: 'Qishki', state: 'maintenance' }).returning();
      const [lambRation] = await tx().insert(rations).values({ ...base, name: 'Qo\'zi', state: 'lamb' }).returning();
      await tx().insert(rationLines).values([
        { ...base, rationId: adultRation.id, itemId: bran.id, kgPerHeadDay: 0.5 },
        { ...base, rationId: adultRation.id, itemId: hay.id, kgPerHeadDay: 2 },
        { ...base, rationId: lambRation.id, itemId: bran.id, kgPerHeadDay: 0.3 },
      ]);
      const [flock] = await tx().insert(herds).values({ ...base, name: 'Sovliqlar', rationId: adultRation.id }).returning();
      const [young] = await tx().insert(herds).values({ ...base, name: 'Qo\'zilar', state: 'lamb', rationId: lambRation.id }).returning();
      const [sold] = await tx().insert(herds).values({ ...base, name: 'Sotuvga' }).returning();
      const center = await ensureCostCenter('herd', flock.id, flock.name);
      await tx().update(herds).set({ costCenterId: center }).where(eq(herds.id, flock.id));

      const [kind] = await tx().select().from(species).where(and(eq(species.tenantId, f.tenantId), eq(species.key, 'sheep')));
      const [breed] = await tx().select().from(breeds).where(and(eq(breeds.tenantId, f.tenantId), eq(breeds.key, 'hisori')));
      let tag = 0;
      const add = async (n: number, category: string, sex: string, herdId: string) =>
        tx()
          .insert(animals)
          .values(
            Array.from({ length: n }, () => ({ ...base, tag: `SC${++tag}`, speciesId: kind.id, breedId: breed.id, sex, category, origin: 'purchased', herdId })),
          )
          .returning();
      const ewes = await add(10, 'ewe', 'female', flock.id);
      await add(1, 'ram', 'male', flock.id);
      await add(2, 'lamb_female', 'female', young.id);
      await add(3, 'lamb_male', 'male', young.id);
      const forSale = await add(4, 'lamb_male', 'male', sold.id);
      const [cull] = await add(1, 'ewe', 'female', sold.id);

      const carrying = [];
      for (const ewe of ewes.slice(0, 8)) carrying.push(await createPregnancy({ eweId: ewe.id, matingDate: addDays(T, -30) }));
      lambingMonth = Number(carrying[0].expectedDate.slice(5, 7));
      const scans = [1, 2, 2, 1];
      for (const [i, fetusCount] of scans.entries()) {
        await tx().update(breedingRecords).set({ fetusCount, scanDate: T }).where(eq(breedingRecords.id, carrying[i].id));
      }

      const sale = { type: 'sale' as const, date: addDays(T, -3), counterpartyId: buyer.id, paymentMethod: 'cash' as const, accountId: account.id };
      await createExit({ ...sale, animalId: forSale[0].id, liveWeightKg: 40, pricePerKg: 50_000 });
      await createExit({ ...sale, animalId: forSale[1].id, liveWeightKg: 44, pricePerKg: 45_000 });
      await createExit({ ...sale, animalId: forSale[2].id, amount: 1_500_000 });
      await createExit({ ...sale, animalId: forSale[3].id, liveWeightKg: 60, amount: 6_000_000 });
      await createExit({ ...sale, animalId: cull.id, amount: 900_000 });

      const category = async (key: string) => {
        const [row] = await tx()
          .select({ id: financeCategories.id })
          .from(financeCategories)
          .where(and(eq(financeCategories.tenantId, f.tenantId), eq(financeCategories.key, key)));
        return row.id;
      };
      const money = { paymentMethod: 'cash' as const, accountId: account.id, costCenterId: center, autoApprove: true, type: 'expense' as const };
      await postTransaction({ ...money, date: `${M2}-10`, amount: 300_000, categoryId: await category('fuel') });
      await postTransaction({ ...money, date: `${M2}-12`, amount: 160_000, categoryId: await category('veterinary') });
      await postTransaction({ ...money, date: `${M1}-10`, amount: 100_000, categoryId: await category('fuel') });
      await postTransaction({ ...money, date: `${M1}-11`, amount: 4_000_000, categoryId: await category('machinery_purchase'), costTreatment: 'capex' });
      await postTransaction({ ...money, date: `${M1}-12`, amount: 400_000, categoryId: await category('feed'), costTreatment: 'inventory' });
      await postTransaction({ ...money, date: `${M}-01`, amount: 50_000, categoryId: await category('fuel') });

      const stock = { warehouseId: warehouse.id, date: `${M1}-12` };
      await receiveStock({ ...stock, itemId: bran.id, qty: 100, unitCost: 4_000, source: 'purchase' });
      await issueStock({ ...stock, itemId: bran.id, qty: 25, costCenterId: center, reason: 'ration' });
      await receiveStock({ ...stock, itemId: drug.id, qty: 20, unitCost: 8_000, source: 'purchase' });
      await issueStock({ ...stock, itemId: drug.id, qty: 10, costCenterId: center, reason: 'treatment' });
      await receiveStock({ ...stock, itemId: hay.id, qty: 1_000, unitCost: 1_000, source: 'own_harvest' });
      await issueStock({ ...stock, itemId: hay.id, qty: 100, costCenterId: center, reason: 'ration' });

      // The sale above the approval threshold is still waiting, and the test rests on that.
      const pending = await tx()
        .select({ status: schema.transactions.status })
        .from(schema.transactions)
        .where(and(eq(schema.transactions.farmId, f.farmId), inArray(schema.transactions.status, ['pending'])));
      expect(pending).toHaveLength(1);
    });
  });

  it('prefills each assumption from the records, and says where it came from', async () => {
    const res = await (await f.as('owner')).get('/finance/scenarios/baseline');
    expect(res.status).toBe(200);
    const { assumptions: a, sources, suggestions, costGroups } = res.data;

    expect(a).toMatchObject({ startMonth: M, openingEwes: 10, openingRams: 1, openingReplacements: 2, openingLambs: 3 });
    expect(sources.openingEwes).toEqual({ source: 'animals', basis: { head: 16 } });

    expect(a.lambingMonth).toBe(lambingMonth);
    expect(a.lambingShare).toBeCloseTo(0.8, 10);
    expect(sources.lambingShare).toEqual({ source: 'pregnancies', basis: { pregnant: 8, ewes: 10 } });
    expect(a.lambsPerEweLambing).toBeCloseTo(1.5, 10);
    expect(sources.lambsPerEweLambing).toEqual({ source: 'scans', basis: { fetuses: 6, ewes: 4 } });
    expect(a.lambSurvival).toBeNull();
    expect(suggestions.lambSurvival).toEqual({ value: 0.92, source: 'default' });

    expect(a.saleWeightKg).toBe(42);
    expect(a.pricePerKg).toBe(47_380.95);
    expect(sources.pricePerKg).toMatchObject({ source: 'sales', basis: { head: 2, kg: 84 } });
    expect(a.cullEwePrice).toBe(900_000);
    expect(suggestions.saleWeightKg).toBeUndefined();

    expect(a.otherCostPerHeadPerMonth).toBe(7_500);
    expect(a.fixedCostPerMonth).toBe(200_000);
    expect(sources.fixedCostPerMonth).toEqual({ source: 'costs', basis: { months: 2, from: M2, to: M1 } });
    expect(costGroups).toMatchObject({ from: M2, to: M1, months: 2, total: 370_000 });
    expect(costGroups.perMonth).toMatchObject({ feed: 50_000, vet: 120_000 });

    const [fromRations, other] = stallNow
      ? (['feedAdultStallPerMonth', 'feedAdultGrazingPerMonth'] as const)
      : (['feedAdultGrazingPerMonth', 'feedAdultStallPerMonth'] as const);
    // Bran is bought: 0.5 kg × 4 000 a day. The 2 kg of hay is the farm's own harvest, and what it cost
    // to grow is already in the fixed cost, so it is not priced again: 2 000 × 365 / 12.
    expect(a[fromRations]).toBe(60_833.33);
    expect(sources[fromRations]).toEqual({ source: 'rations', basis: { head: 11, herds: 1 } });
    // The other season is never the farm's figure: only a suggestion at the stated share.
    expect(a[other]).toBeNull();
    expect(suggestions[other].source).toBe('default');
    expect(suggestions[other].value).toBeCloseTo(stallNow ? 30_416.67 : 121_666.66, 1);
    expect(a.feedLambPerMonth).toBe(36_500);

    expect(a.openingCash).toBe(11_370_000);
    expect(a.eweDeathsPerYear).toBeNull();
    expect(a.eweCullsPerYear).toBeNull();
    expect(a.stallMonths).toBeNull();
    expect(suggestions.stallMonths).toEqual({ value: [11, 12, 1, 2, 3], source: 'default' });
  });

  it('shows an investor the same totals and nothing that names an account or a buyer', async () => {
    const investor = await (await f.as('investor')).get('/finance/scenarios/baseline');
    const owner = await (await f.as('owner')).get('/finance/scenarios/baseline');
    expect(investor.status).toBe(200);
    expect(investor.data).toEqual(owner.data);
    const text = JSON.stringify(investor.body);
    expect(text).not.toContain('Maxfiy');
    expect(text).not.toContain('Sovliqlar');
    expect(Object.keys(investor.data).sort()).toEqual(['asOf', 'assumptions', 'costGroups', 'sources', 'startMonth', 'suggestions']);
  });

  it('counts cost exactly as the farm result does (rule 3)', async () => {
    await f.run(async () => {
      const rows = await operatingCostByMonth(monthRange(M2).from, monthRange(M).to);
      expect(rows.map((row) => [row.month, row.total])).toEqual([
        [M2, 460_000],
        [M1, 280_000],
        [M, 50_000],
      ]);
      for (const row of rows) expect(row.total).toBe((await monthToDate(row.month)).operatingExpense);
    });
  });
});
