import { and, eq, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { addDays, monthOf, todayIso } from '@yap/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { ctx, tx } from '../src/core/context';
import { ensureCostCenter, generalCostCenterId } from '../src/core/costCenters';
import { issueStock, receiveStock } from '../src/core/inventory';
import { postTransaction } from '../src/core/ledger';
import { DEFAULT_SETTINGS, type TenantSettings } from '../src/core/settings';
import { signAccessToken } from '../src/core/tokens';
import { machineryCostByField } from '../src/modules/assets/costs.service';
import { costCenterCosts, fieldCosts, herdCost } from '../src/modules/finance/summary';
import { csvCell, doubleEntry, toCsv } from '../src/modules/finance/export';
import { addMonths } from '../src/modules/finance/loans.service';
import { seedFinance } from '../src/seed/finance';
import { seedFinanceBase } from '../src/seed/finance-base';
import { SEED } from '../src/seed/names';
import { createFixture, type Client, type Fixture } from './helpers';

const {
  accounts,
  animals,
  assetUsageLogs,
  assets,
  cropPlans,
  crops,
  employees,
  fieldOperations,
  fields,
  financeCategories,
  harvests,
  herds,
  items,
  seasons,
  species,
  timesheets,
  transactions,
  warehouses,
} = schema;

const DAY = '2026-10-15';

/** A real token for raw requests, where the test client's JSON handling gets in the way. */
function tokenOf(f: Fixture, client: Client) {
  return signAccessToken({ userId: client.userId, membershipId: client.membershipId, tenantId: f.tenantId, farmId: f.farmId });
}

function withBase(base: TenantSettings['finance']['overheadBase']): TenantSettings {
  return { ...DEFAULT_SETTINGS, finance: { ...DEFAULT_SETTINGS.finance, overheadBase: base } };
}

interface World {
  f: Fixture;
  accountId: string;
  generalId: string;
  herdId: string;
  herdCc: string;
  fieldF: string;
  fieldFCc: string;
  fieldG: string;
  fieldGCc: string;
  category: (key: string) => string;
}

/**
 * Control scenario, computed by hand. See the expected values in the tests below.
 *
 *   Opening cash                                  30 000 000
 *   10 ewes bought        10 000 000  'animal'    herd
 *   Feed 1000 kg @ 2000    2 000 000  'inventory' general; 500 kg issued to the herd = 1 000 000
 *   Seed  200 kg @ 5000    1 000 000  'inventory' general; 100 kg issued to field F =  500 000
 *   Vet services             300 000  'expense'   herd
 *   Herd wages               200 000  'expense'   herd
 *   Fertilizer service       400 000  'expense'   field F
 *   Electricity            1 000 000  'expense'   general
 *   Tractor bought         5 000 000  'capex'     general
 *   Large repair, pending  6 000 000  'expense'   herd     must not count anywhere
 */
async function world(): Promise<World> {
  const f = await createFixture();
  const refs = await f.run(async () => {
    const c = ctx();
    const base = { tenantId: c.tenantId, farmId: c.farmId };
    const [account] = await tx().insert(accounts).values({ ...base, name: 'Kassa', type: 'cash', openingBalance: 30_000_000 }).returning();
    const categories = await tx().select().from(financeCategories).where(eq(financeCategories.tenantId, c.tenantId));
    const category = (key: string) => categories.find((row) => row.key === key)!.id;
    const generalId = await generalCostCenterId();

    const [sheep] = await tx().select().from(species).where(and(eq(species.tenantId, c.tenantId), eq(species.key, 'sheep')));
    const [herd] = await tx().insert(herds).values({ ...base, name: 'Sovliqlar' }).returning();
    const herdCc = await ensureCostCenter('herd', herd.id, herd.name);
    await tx()
      .insert(animals)
      .values(
        Array.from({ length: 10 }, (_, i) => ({
          ...base,
          tag: `T-${i}`,
          speciesId: sheep.id,
          sex: 'female',
          category: 'ewe',
          origin: 'purchased',
          herdId: herd.id,
          purchaseDate: '2026-10-01',
          purchasePrice: 1_000_000,
        })),
      );

    const [fieldF] = await tx().insert(fields).values({ ...base, number: 'F', areaHa: 10 }).returning();
    const [fieldG] = await tx().insert(fields).values({ ...base, number: 'G', areaHa: 30 }).returning();
    const fieldFCc = await ensureCostCenter('field', fieldF.id, 'Dala F');
    const fieldGCc = await ensureCostCenter('field', fieldG.id, 'Dala G');

    const [warehouse] = await tx().insert(warehouses).values({ ...base, name: 'Ombor', type: 'feed' }).returning();
    const [feed] = await tx().insert(items).values({ ...base, name: 'Beda', category: 'feed', unit: 'kg' }).returning();
    const [seed] = await tx().insert(items).values({ ...base, name: 'Urug', category: 'seed', unit: 'kg' }).returning();

    const pay = { date: DAY, paymentMethod: 'cash' as const, accountId: account.id, autoApprove: true };
    await postTransaction({ ...pay, type: 'expense', amount: 10_000_000, categoryId: category('animal_purchase'), costCenterId: herdCc, costTreatment: 'animal' });
    await postTransaction({ ...pay, type: 'expense', amount: 2_000_000, categoryId: category('feed'), costCenterId: generalId, costTreatment: 'inventory' });
    await postTransaction({ ...pay, type: 'expense', amount: 1_000_000, categoryId: category('seed'), costCenterId: generalId, costTreatment: 'inventory' });
    await postTransaction({ ...pay, type: 'expense', amount: 300_000, categoryId: category('veterinary'), costCenterId: herdCc });
    await postTransaction({ ...pay, type: 'expense', amount: 200_000, categoryId: category('salary'), costCenterId: herdCc });
    await postTransaction({ ...pay, type: 'expense', amount: 400_000, categoryId: category('fertilizer'), costCenterId: fieldFCc });
    await postTransaction({ ...pay, type: 'expense', amount: 1_000_000, categoryId: category('electricity'), costCenterId: generalId });
    await postTransaction({ ...pay, type: 'expense', amount: 5_000_000, categoryId: category('machinery_purchase'), costCenterId: generalId, costTreatment: 'capex' });
    await postTransaction({ date: DAY, type: 'expense', amount: 6_000_000, categoryId: category('repair'), costCenterId: herdCc, paymentMethod: 'cash', accountId: account.id });

    await receiveStock({ itemId: feed.id, warehouseId: warehouse.id, qty: 1000, unitCost: 2000, date: DAY, source: 'purchase' });
    await receiveStock({ itemId: seed.id, warehouseId: warehouse.id, qty: 200, unitCost: 5000, date: DAY, source: 'purchase' });
    await issueStock({ itemId: feed.id, warehouseId: warehouse.id, qty: 500, date: DAY, costCenterId: herdCc, reason: 'ration' });
    await issueStock({ itemId: seed.id, warehouseId: warehouse.id, qty: 100, date: DAY, costCenterId: fieldFCc, reason: 'field_operation' });

    return { accountId: account.id, generalId, herdId: herd.id, herdCc, fieldF: fieldF.id, fieldFCc, fieldG: fieldG.id, fieldGCc, category };
  });
  return { f, ...refs };
}

const centerOf = (rows: Awaited<ReturnType<typeof costCenterCosts>>, id: string) =>
  rows.find((row) => row.costCenterId === id)!;

describe('cost engine: control scenario', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });

  it('with the head base, all overhead lands on the herd', async () => {
    const rows = await w.f.run(() => costCenterCosts());
    const herd = centerOf(rows, w.herdCc);
    expect(herd).toMatchObject({ direct: 500_000, materials: 1_000_000, overhead: 1_000_000, total: 2_500_000 });
    const field = centerOf(rows, w.fieldFCc);
    expect(field).toMatchObject({ direct: 400_000, materials: 500_000, overhead: 0, total: 900_000 });
    const general = centerOf(rows, w.generalId);
    expect(general).toMatchObject({ direct: 1_000_000, overhead: -1_000_000, total: 0 });
  });

  it("does not count 'inventory' purchases on top of their issues, nor 'animal', 'capex' or pending", async () => {
    const rows = await w.f.run(() => costCenterCosts());
    // Purchases total 10m + 2m + 1m + 5m plus the pending 6m. None of it may appear as direct cost.
    const direct = rows.reduce((sum, row) => sum + row.direct, 0);
    expect(direct).toBe(1_900_000); // 300k + 200k + 400k + 1m
    const materials = rows.reduce((sum, row) => sum + row.materials, 0);
    expect(materials).toBe(1_500_000); // 1m + 500k, not the 3m bought
  });

  it('conserves the total however costs are moved between centers', async () => {
    for (const base of ['head', 'area', 'direct_cost', 'hours'] as const) {
      const rows = await w.f.run(() => costCenterCosts(), { settings: withBase(base) });
      const total = rows.reduce((sum, row) => sum + row.total, 0);
      expect(total, base).toBe(3_400_000);
    }
  });

  it('answers the cost of one ewe (spec 24.1)', async () => {
    const cost = await w.f.run(() => herdCost(w.herdId));
    expect(cost).toMatchObject({
      head: 10,
      purchaseCost: 10_000_000,
      accumulated: 2_500_000,
      costPerHead: 1_250_000,
      breakdown: { feed: 1_000_000, vet: 300_000, labor: 200_000, overhead: 1_000_000, other: 0 },
    });
  });

  it('shares overhead by area', async () => {
    const rows = await w.f.run(() => costCenterCosts(), { settings: withBase('area') });
    expect(centerOf(rows, w.fieldFCc).overhead).toBe(250_000); // 10 of 40 ha
    expect(centerOf(rows, w.fieldGCc).overhead).toBe(750_000);
    expect(centerOf(rows, w.herdCc).overhead).toBe(0);
  });

  it('shares overhead by direct cost', async () => {
    const rows = await w.f.run(() => costCenterCosts(), { settings: withBase('direct_cost') });
    // herd 1 500 000 and field F 900 000 of 2 400 000.
    expect(centerOf(rows, w.herdCc).overhead).toBe(625_000);
    expect(centerOf(rows, w.fieldFCc).overhead).toBe(375_000);
    expect(centerOf(rows, w.fieldGCc).overhead).toBe(0);
  });

  it('respects a date range', async () => {
    const rows = await w.f.run(() => costCenterCosts('2026-11-01', '2026-11-30'));
    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(0);
  });

  it('cash leaves the account for approved entries only', async () => {
    const owner = await w.f.as('owner');
    const cash = await owner.get('/finance/summary/cash');
    // 30m − 10m − 2m − 1m − 0.3m − 0.2m − 0.4m − 1m − 5m. The pending 6m has not moved.
    expect(cash.data.total).toBe(10_100_000);
  });
});

describe('cost engine: hours base', () => {
  it('uses field operation hours and livestock timesheets', async () => {
    const w = await world();
    await w.f.run(async () => {
      const c = ctx();
      const base = { tenantId: c.tenantId, farmId: c.farmId };
      const [shepherd] = await tx()
        .insert(employees)
        .values({ ...base, fullName: 'Ali', position: 'Cho\'pon', division: 'livestock', hireDate: '2026-01-01' })
        .returning();
      await tx().insert(timesheets).values({ ...base, employeeId: shepherd.id, date: DAY, status: 'present', hours: 10 });
      await tx().insert(fieldOperations).values([
        { ...base, type: 'tillage', date: DAY, fieldId: w.fieldF, durationH: 6 },
        { ...base, type: 'tillage', date: DAY, fieldId: w.fieldG, durationH: 4 },
      ]);
    });
    const rows = await w.f.run(() => costCenterCosts(), { settings: withBase('hours') });
    // 20 hours in all: herd 10, field F 6, field G 4.
    expect(centerOf(rows, w.herdCc).overhead).toBe(500_000);
    expect(centerOf(rows, w.fieldFCc).overhead).toBe(300_000);
    expect(centerOf(rows, w.fieldGCc).overhead).toBe(200_000);
  });
});

describe('cost engine: machinery', () => {
  it('charges asset cost to the fields it worked on, without counting an operation twice', async () => {
    const w = await world();
    const assetCc = await w.f.run(async () => {
      const c = ctx();
      const base = { tenantId: c.tenantId, farmId: c.farmId };
      const [asset] = await tx().insert(assets).values({ ...base, name: 'MTZ', type: 'tractor', inventoryNo: 'A1' }).returning();
      const assetCcId = await ensureCostCenter('asset', asset.id, asset.name);
      // Asset cost: repair 200 000 + fuel 100 l at 10 000.
      const [warehouse] = await tx().insert(warehouses).values({ ...base, name: 'Yoqilgi', type: 'fuel' }).returning();
      const [diesel] = await tx().insert(items).values({ ...base, name: 'Dizel', category: 'fuel', unit: 'l' }).returning();
      await receiveStock({ itemId: diesel.id, warehouseId: warehouse.id, qty: 100, unitCost: 10_000, date: DAY, source: 'purchase' });
      await issueStock({ itemId: diesel.id, warehouseId: warehouse.id, qty: 100, date: DAY, costCenterId: assetCcId, reason: 'fuel' });
      await postTransaction({
        date: DAY, type: 'expense', amount: 200_000, categoryId: w.category('repair'), costCenterId: assetCcId,
        paymentMethod: 'cash', accountId: w.accountId, autoApprove: true,
      });

      const [logged] = await tx()
        .insert(fieldOperations)
        .values({ ...base, type: 'tillage', date: DAY, fieldId: w.fieldF, assetId: asset.id, durationH: 6 })
        .returning();
      // The same 6 hours again in the usage log, linked to the operation: must count once.
      await tx().insert(assetUsageLogs).values({ ...base, assetId: asset.id, date: DAY, fieldId: w.fieldF, operationId: logged.id, motoHours: 6 });
      await tx().insert(fieldOperations).values({ ...base, type: 'tillage', date: DAY, fieldId: w.fieldG, assetId: asset.id, durationH: 3 });
      await tx().insert(assetUsageLogs).values({ ...base, assetId: asset.id, date: DAY, fieldId: w.fieldG, motoHours: 3 });
      return assetCcId;
    });

    const rows = await w.f.run(() => costCenterCosts());
    // 1 200 000 over 12 hours: field F 6 h, field G 6 h (3 logged + 3 from the unlogged operation).
    expect(centerOf(rows, w.fieldFCc).machinery).toBe(600_000);
    expect(centerOf(rows, w.fieldGCc).machinery).toBe(600_000);
    const asset = centerOf(rows, assetCc);
    expect(asset).toMatchObject({ direct: 200_000, materials: 1_000_000, machinery: -1_200_000, total: 0 });
    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(3_400_000 + 1_200_000);
  });
});

describe('machine cost reaches the fields (spec 25.1, X_texnika)', () => {
  /**
   * The control scenario, plus a tractor working a season through the real shift log:
   *   6 h on field F, 3 h on field G, 1 h on no field (a run to the fuel depot).
   *   100 l of diesel at 10 000 is issued to the machine by those shifts: 1 000 000.
   * Field F keeps its 900 000 of seed and fertilizer from the scenario.
   */
  async function tractorWorld() {
    const w = await world();
    const owner = await w.f.as('owner');
    const before = await farmFigures(w, owner);

    const seasonId = await w.f.run(async () => {
      const c = ctx();
      const base = { tenantId: c.tenantId, farmId: c.farmId };
      const [warehouse] = await tx().insert(warehouses).values({ ...base, name: 'Yoqilgi', type: 'fuel' }).returning();
      const [diesel] = await tx().insert(items).values({ ...base, name: 'Dizel', category: 'fuel', unit: 'l' }).returning();
      await receiveStock({ itemId: diesel.id, warehouseId: warehouse.id, qty: 500, unitCost: 10_000, date: '2026-09-01', source: 'opening' });

      const [season] = await tx()
        .insert(seasons)
        .values({ ...base, name: 'Kuzgi', kind: 'autumn', startDate: '2026-09-01', endDate: '2027-07-31', isCurrent: true })
        .returning();
      const [wheat] = await tx().select().from(crops).where(and(eq(crops.tenantId, c.tenantId), eq(crops.key, 'wheat')));
      const [plan] = await tx()
        .insert(cropPlans)
        .values({ ...base, seasonId: season.id, fieldId: w.fieldF, cropId: wheat.id, areaHa: 10 })
        .returning();
      await tx().insert(cropPlans).values({ ...base, seasonId: season.id, fieldId: w.fieldG, cropId: wheat.id, areaHa: 30 });
      await tx().insert(harvests).values({ ...base, fieldId: w.fieldF, cropPlanId: plan.id, date: '2027-06-20', grossT: 30 });
      return season.id;
    });

    const asset = (await owner.post('/assets', { name: 'MTZ-82', type: 'tractor' })).data;
    const shift = (fieldId: string | undefined, motoHours: number, fuelL: number) =>
      owner.post(`/assets/${asset.id}/usage`, { date: DAY, fieldId, motoHours, fuelL });
    expect((await shift(w.fieldF, 6, 60)).status).toBe(201);
    expect((await shift(w.fieldG, 3, 30)).status).toBe(201);
    expect((await shift(undefined, 1, 10)).status).toBe(201);
    return { w, owner, seasonId, assetCc: asset.costCenterId as string, before };
  }

  async function farmFigures(w: World, owner: Client) {
    return {
      expense: (await owner.get('/finance/costs/categories')).data.expense,
      cash: (await owner.get('/finance/summary/cash')).data.total,
      centers: (await w.f.run(() => costCenterCosts())).reduce((sum, row) => sum + row.total, 0),
    };
  }

  const byField = (rows: { fieldId: string; amount: number }[]) => Object.fromEntries(rows.map((r) => [r.fieldId, r.amount]));

  it("charges a machine's fuel to the fields it worked, in cost per ton", async () => {
    const { w, seasonId } = await tractorWorld();
    const rows = await w.f.run(() => fieldCosts(seasonId));
    const f = rows.find((row) => row.number === 'F')!;
    const g = rows.find((row) => row.number === 'G')!;
    // 1 000 000 over 10 hours: F 6 h, G 3 h.
    expect(f.breakdown.machinery).toBe(600_000);
    expect(g.breakdown.machinery).toBe(300_000);
    // Seed 500 000 + fertilizer 400 000 + machinery 600 000 over 30 t.
    expect(f.actual).toBe(1_500_000);
    expect(f.costPerTon).toBe(50_000);
    expect(g.actual).toBe(300_000);
  });

  it('leaves work on no field with the machine', async () => {
    const { w, assetCc } = await tractorWorld();
    const asset = centerOf(await w.f.run(() => costCenterCosts()), assetCc);
    expect(asset).toMatchObject({ materials: 1_000_000, machinery: -900_000, total: 100_000 });
  });

  it('counts the fuel once and does not change the farm total', async () => {
    const { w, owner, before } = await tractorWorld();
    const after = await farmFigures(w, owner);
    // Farm figures come from transactions, and the diesel was already paid for.
    expect(after.expense).toBe(before.expense);
    expect(after.cash).toBe(before.cash);
    // Across centers the fuel appears exactly once, moved rather than copied.
    expect(after.centers).toBe(before.centers + 1_000_000);
  });

  it('carries repairs and depreciation the same way', async () => {
    const { w, seasonId, assetCc } = await tractorWorld();
    await w.f.run(async () => {
      const common = { date: DAY, type: 'expense' as const, costCenterId: assetCc, autoApprove: true };
      await postTransaction({ ...common, amount: 200_000, categoryId: w.category('repair'), paymentMethod: 'cash', accountId: w.accountId });
      await postTransaction({ ...common, amount: 100_000, categoryId: w.category('depreciation'), paymentMethod: 'non_cash' });
    });
    const rows = await w.f.run(() => fieldCosts(seasonId));
    // 1 300 000 over 10 hours.
    expect(rows.find((row) => row.number === 'F')!.breakdown.machinery).toBe(780_000);
    expect(rows.find((row) => row.number === 'G')!.breakdown.machinery).toBe(390_000);
  });

  it('agrees with the assets module to the so\'m: its shares are already in the field, not on top', async () => {
    const { w, seasonId } = await tractorWorld();
    const [rows, shares] = await w.f.run(async () => [await fieldCosts(seasonId), await machineryCostByField('2026-09-01', '2027-07-31')] as const);
    const theirs = byField(shares);
    expect(theirs).toEqual({ [w.fieldF]: 600_000, [w.fieldG]: 300_000 });
    for (const row of rows) expect(row.breakdown.machinery, row.number).toBe(theirs[row.fieldId]);
  });
});

describe('field costs', () => {
  it('computes plan vs fact, yield and cost per ton', async () => {
    const w = await world();
    const seasonId = await w.f.run(async () => {
      const c = ctx();
      const base = { tenantId: c.tenantId, farmId: c.farmId };
      const [season] = await tx()
        .insert(seasons)
        .values({ ...base, name: 'Kuzgi', kind: 'autumn', startDate: '2026-09-01', endDate: '2027-07-31', isCurrent: true })
        .returning();
      const [wheat] = await tx().select().from(crops).where(and(eq(crops.tenantId, c.tenantId), eq(crops.key, 'wheat')));
      const [plan] = await tx()
        .insert(cropPlans)
        .values({ ...base, seasonId: season.id, fieldId: w.fieldF, cropId: wheat.id, areaHa: 10, plannedCost: 1_000_000, expectedYieldTHa: 4 })
        .returning();
      await tx().insert(harvests).values({ ...base, fieldId: w.fieldF, cropPlanId: plan.id, date: '2027-06-20', grossT: 23 });
      return season.id;
    });

    const [row] = await w.f.run(() => fieldCosts(seasonId), { settings: withBase('area') });
    // Seed 500 000 + fertilizer 400 000 + overhead 250 000 over 23 t.
    expect(row).toMatchObject({
      number: 'F',
      actual: 1_150_000,
      planned: 1_000_000,
      deviation: 150_000,
      harvestT: 23,
      yieldTHa: 2.3,
      costPerTon: 50_000,
    });
    expect(row.breakdown).toMatchObject({ seed: 500_000, fertilizer: 400_000, overheadShare: 250_000 });
  });

  it('gives no cost per ton before harvest', async () => {
    const w = await world();
    const seasonId = await w.f.run(async () => {
      const c = ctx();
      const base = { tenantId: c.tenantId, farmId: c.farmId };
      const [season] = await tx()
        .insert(seasons)
        .values({ ...base, name: 'Kuzgi', kind: 'autumn', startDate: '2026-09-01', endDate: '2027-07-31' })
        .returning();
      const [wheat] = await tx().select().from(crops).where(and(eq(crops.tenantId, c.tenantId), eq(crops.key, 'wheat')));
      await tx().insert(cropPlans).values({ ...base, seasonId: season.id, fieldId: w.fieldF, cropId: wheat.id, areaHa: 10 });
      return season.id;
    });
    const [row] = await w.f.run(() => fieldCosts(seasonId));
    expect(row.costPerTon).toBeNull();
    expect(row.yieldTHa).toBeNull();
    expect(row.planned).toBeNull();
    expect(row.deviation).toBeNull();
  });
});

describe('herd cost edge cases', () => {
  it('is null for an empty herd and rolls animal-level costs into the herd', async () => {
    const f = await createFixture();
    const empty = await f.run(async () => {
      const c = ctx();
      const [herd] = await tx().insert(herds).values({ tenantId: c.tenantId, farmId: c.farmId, name: 'Bosh' }).returning();
      return herdCost(herd.id);
    });
    expect(empty.costPerHead).toBeNull();
    expect(empty.costPerKg).toBeNull();

    const w = await world();
    await w.f.run(async () => {
      const [animal] = await tx().select().from(animals).where(eq(animals.herdId, w.herdId)).limit(1);
      const cc = await ensureCostCenter('animal', animal.id, animal.tag);
      await postTransaction({
        date: DAY, type: 'expense', amount: 100_000, categoryId: w.category('veterinary'), costCenterId: cc,
        paymentMethod: 'cash', accountId: w.accountId, autoApprove: true,
      });
    });
    const cost = await w.f.run(() => herdCost(w.herdId));
    expect(cost.breakdown.vet).toBe(400_000);
    expect(cost.accumulated).toBe(2_600_000);
  });

  async function weigh(w: World, animalCount: number, kg = 25) {
    await w.f.run(async () => {
      const c = ctx();
      const list = await tx().select().from(animals).where(eq(animals.herdId, w.herdId)).limit(animalCount);
      const base = { tenantId: c.tenantId, farmId: c.farmId };
      for (const animal of list) {
        await tx().insert(schema.weightRecords).values([
          { ...base, animalId: animal.id, date: '2026-10-01', weightKg: 50 },
          { ...base, animalId: animal.id, date: '2026-11-01', weightKg: 50 + kg },
        ]);
      }
    });
  }

  it('computes the cost of a kilogram gained when the whole herd is weighed', async () => {
    const w = await world();
    await weigh(w, 10);
    const cost = await w.f.run(() => herdCost(w.herdId));
    // 10 animals gained 25 kg each. 2 500 000 of feed, vet, labor and overhead over 250 kg.
    expect(cost).toMatchObject({ weightGainKg: 250, weighedHead: 10, costPerKg: 10_000 });
  });

  it('scales a sample of at least half the herd up by its average', async () => {
    const w = await world();
    await weigh(w, 6);
    const cost = await w.f.run(() => herdCost(w.herdId));
    // 6 weighed animals gained 150 kg, which stands for 250 kg across all 10.
    expect(cost).toMatchObject({ weightGainKg: 150, weighedHead: 6, costPerKg: 10_000 });
  });

  it('refuses to quote a figure from a few weighed animals', async () => {
    const w = await world();
    await weigh(w, 2);
    const cost = await w.f.run(() => herdCost(w.herdId));
    // Measured gain stays visible, but 2 of 10 cannot carry the whole herd's cost.
    expect(cost).toMatchObject({ weightGainKg: 50, weighedHead: 2, costPerKg: null });
  });
});

describe('budget', () => {
  it('compares plan with fact by category and month', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const saved = await owner.put('/finance/budget', {
      entries: [
        { month: '2026-10', categoryId: w.category('feed'), amount: 3_000_000 },
        { month: '2026-11', categoryId: w.category('feed'), amount: 1_000_000 },
        { month: '2026-10', categoryId: w.category('electricity'), amount: 800_000 },
      ],
    });
    expect(saved.data).toEqual({ saved: 3, removed: 0 });

    const grid = await owner.get('/finance/budget', { from: '2026-10', to: '2026-11' });
    expect(grid.data.months).toEqual(['2026-10', '2026-11']);
    const feed = grid.data.rows.find((row: any) => row.key === 'feed');
    // The whole 2 000 000 purchase counts here: a budget controls spending, whatever the treatment.
    expect(feed.cells['2026-10']).toEqual({ planned: 3_000_000, actual: 2_000_000 });
    expect(feed.cells['2026-11']).toEqual({ planned: 1_000_000, actual: 0 });
    expect(feed.planned).toBe(4_000_000);
    expect(feed.deviation).toBe(-2_000_000);
    expect(feed.percent).toBe(50);

    const electricity = grid.data.rows.find((row: any) => row.key === 'electricity');
    expect(electricity.deviation).toBe(200_000);
    expect(electricity.percent).toBeCloseTo(125, 5);
  });

  it('counts only approved transactions as fact', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const grid = await owner.get('/finance/budget', { from: '2026-10', to: '2026-10' });
    const repair = grid.data.rows.find((row: any) => row.key === 'repair');
    expect(repair).toBeUndefined(); // the only repair is the pending 6 000 000
  });

  it('saving again corrects a line, and amount 0 removes it', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const entry = { month: '2026-12', categoryId: w.category('gas') };
    await owner.put('/finance/budget', { entries: [{ ...entry, amount: 500 }] });
    await owner.put('/finance/budget', { entries: [{ ...entry, amount: 700 }] });
    let grid = await owner.get('/finance/budget', { from: '2026-12', to: '2026-12' });
    expect(grid.data.rows[0].planned).toBe(700);

    expect((await owner.put('/finance/budget', { entries: [{ ...entry, amount: 0 }] })).data).toEqual({ saved: 0, removed: 1 });
    grid = await owner.get('/finance/budget', { from: '2026-12', to: '2026-12' });
    expect(grid.data.rows).toEqual([]);
  });

  it('keeps separate lines per cost center and filters by them', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    await owner.put('/finance/budget', {
      entries: [
        { month: '2026-10', categoryId: w.category('veterinary'), costCenterId: w.herdCc, amount: 500_000 },
        { month: '2026-10', categoryId: w.category('veterinary'), amount: 100_000 },
      ],
    });
    const all = await owner.get('/finance/budget', { from: '2026-10', to: '2026-10' });
    expect(all.data.rows.find((row: any) => row.key === 'veterinary').planned).toBe(600_000);
    const herd = await owner.get('/finance/budget', { from: '2026-10', to: '2026-10', costCenterId: w.herdCc });
    const row = herd.data.rows.find((r: any) => r.key === 'veterinary');
    expect(row.planned).toBe(500_000);
    expect(row.actual).toBe(300_000);
  });

  it('exports plan, fact and totals to Excel', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    await owner.put('/finance/budget', { entries: [{ month: '2026-10', categoryId: w.category('feed'), amount: 3_000_000 }] });
    const res = await w.f.app.inject({
      method: 'GET',
      url: '/api/v1/finance/budget/export.xlsx?from=2026-10&to=2026-10',
      headers: { authorization: `Bearer ${await tokenOf(w.f, owner)}` },
    });
    expect(res.statusCode).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.rawPayload as never);
    const sheet = workbook.getWorksheet('Byudjet')!;
    const rows = sheet.getSheetValues().filter(Boolean) as unknown[][];
    const feed = rows.find((row) => row[1] === 'Ozuqa')!;
    expect(feed.slice(1, 8)).toEqual(['Ozuqa', 3_000_000, 2_000_000, 3_000_000, 2_000_000, -1_000_000, 66.7]);
    expect(rows.some((row) => row[1] === 'Jami xarajat')).toBe(true);
  });

  it('rejects a reversed period', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const res = await owner.get('/finance/budget', { from: '2027-01', to: '2026-01' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PERIOD');
  });
});

describe('transactions through the API', () => {
  let w: World;
  let accountant: Client;
  let director: Client;

  beforeAll(async () => {
    w = await world();
    accountant = await w.f.as('accountant');
    director = await w.f.as('director');
  });

  const expense = (over: object = {}) => ({
    date: '2026-10-20',
    type: 'expense',
    amount: 100_000,
    paymentMethod: 'cash',
    accountId: w.accountId,
    categoryId: w.category('gas'),
    costCenterId: w.generalId,
    ...over,
  });

  it('runs maker-checker end to end, and balances move only on approval', async () => {
    const before = (await director.get('/finance/summary/cash')).data.total;
    const created = await accountant.post('/finance/transactions', expense({ amount: 7_000_000 }));
    expect(created.status).toBe(201);
    expect(created.data.status).toBe('pending');
    expect((await director.get('/finance/summary/cash')).data.total).toBe(before);

    const selfApprove = await accountant.post(`/finance/transactions/${created.data.id}/approve`);
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe('SAME_MAKER_CHECKER');

    const approved = await director.post(`/finance/transactions/${created.data.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.data.status).toBe('approved');
    expect((await director.get('/finance/summary/cash')).data.total).toBe(before - 7_000_000);
  });

  it('a rejected entry never counts', async () => {
    const before = (await director.get('/finance/summary/cash')).data.total;
    const created = await accountant.post('/finance/transactions', expense({ amount: 8_000_000 }));
    const rejected = await director.post(`/finance/transactions/${created.data.id}/reject`, { reason: 'Hujjat yo\'q' });
    expect(rejected.data.status).toBe('rejected');
    expect(rejected.data.rejectedReason).toBe("Hujjat yo'q");
    expect((await director.get('/finance/summary/cash')).data.total).toBe(before);
  });

  it('filters the journal and totals only approved entries', async () => {
    const res = await director.get('/finance/transactions', { categoryId: w.category('veterinary') });
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({ amountBase: 300_000, accountName: 'Kassa', costCenterName: 'Sovliqlar' });
    expect(res.body.data[0].categoryName.en).toBe('Veterinary');

    const pending = await director.get('/finance/transactions', { status: 'pending', categoryId: w.category('repair') });
    expect(pending.body.data).toHaveLength(1);

    const totals = await director.get('/finance/transactions/totals', { categoryId: w.category('repair') });
    expect(totals.data.expense).toBe(0);
  });

  it('edits a pending entry through the ledger, and the editor becomes the maker', async () => {
    const created = await accountant.post('/finance/transactions', expense({ amount: 9_000_000 }));
    const edited = await director.patch(`/finance/transactions/${created.data.id}`, { amount: 9_500_000, description: 'Tuzatildi' });
    expect(edited.status).toBe(200);
    expect(edited.data).toMatchObject({ id: created.data.id, amountBase: 9_500_000, description: 'Tuzatildi', status: 'pending' });

    const selfApprove = await director.post(`/finance/transactions/${created.data.id}/approve`);
    expect(selfApprove.body.error.code).toBe('SAME_MAKER_CHECKER');
    const owner = await w.f.as('owner');
    expect((await owner.post(`/finance/transactions/${created.data.id}/approve`)).status).toBe(200);
  });

  describe('an edit or a decision stands for what the person read', () => {
    /** A 150 mln entry waiting for approval, as the queue reads it. */
    const waiting = async () => {
      const made = await accountant.post('/finance/transactions', expense({ amount: 150_000_000 }));
      expect(made.data.status).toBe('pending');
      const queue = await director.get('/finance/transactions', { status: 'pending', pageSize: 200 });
      return queue.data.find((row: { id: string }) => row.id === made.data.id) as { id: string; updatedAt: string; amount: number };
    };
    const edit = (id: string, changes: object) => accountant.patch(`/finance/transactions/${id}`, changes);
    const reread = async (id: string) => (await director.get(`/finance/transactions/${id}`)).data;

    it('the queue says which version it holds', async () => {
      const row = await waiting();
      expect(Date.parse(row.updatedAt)).not.toBeNaN();
      expect(row.amount).toBe(150_000_000);
    });

    it('an approval from a stale queue is refused, with the figure it would have booked', async () => {
      const read = await waiting();
      expect((await edit(read.id, { amount: 480_000_000 })).status).toBe(200);

      const res = await director.post(`/finance/transactions/${read.id}/approve`, { baseUpdatedAt: read.updatedAt });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TRANSACTION_CHANGED');
      expect(res.body.error.details).toMatchObject({ amount: 480_000_000, currency: 'UZS' });
      expect(res.body.error.details.transaction).toMatchObject({ id: read.id, amount: 480_000_000, status: 'pending' });
      expect((await reread(read.id)).status).toBe('pending');
    });

    it('the same approval passes once the new figure has been read', async () => {
      const read = await waiting();
      await edit(read.id, { amount: 480_000_000 });
      const stale = await director.post(`/finance/transactions/${read.id}/approve`, { baseUpdatedAt: read.updatedAt });
      const fresh = stale.body.error.details.transaction.updatedAt as string;
      const res = await director.post(`/finance/transactions/${read.id}/approve`, { baseUpdatedAt: fresh });
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ status: 'approved', amount: 480_000_000 });
    });

    it('a change that leaves the amount alone counts too: the screen named another account', async () => {
      const read = await waiting();
      const other = await director.post('/finance/accounts', { name: 'Zaxira', type: 'cash', currency: 'UZS', openingBalance: 0 });
      expect(other.status).toBe(201);
      expect((await edit(read.id, { accountId: other.data.id })).status).toBe(200);
      const res = await director.post(`/finance/transactions/${read.id}/approve`, { baseUpdatedAt: read.updatedAt });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TRANSACTION_CHANGED');
    });

    it('a refusal is decided on the same version, and leaves a changed entry waiting', async () => {
      const read = await waiting();
      await edit(read.id, { amount: 180_000_000 });
      const stale = await director.post(`/finance/transactions/${read.id}/reject`, { reason: 'Hujjat yo\'q', baseUpdatedAt: read.updatedAt });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('TRANSACTION_CHANGED');
      expect((await reread(read.id)).status).toBe('pending');

      const { updatedAt } = await reread(read.id);
      const res = await director.post(`/finance/transactions/${read.id}/reject`, { reason: 'Hujjat yo\'q', baseUpdatedAt: updatedAt });
      expect(res.status).toBe(200);
      expect(res.data.status).toBe('rejected');
    });

    it('an Edit form opened before a correction does not put the old amount back', async () => {
      const read = await waiting();
      expect((await director.patch(`/finance/transactions/${read.id}`, { amount: 180_000_000 })).status).toBe(200);
      const res = await edit(read.id, { amount: 150_000_000, description: 'izoh', baseUpdatedAt: read.updatedAt });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TRANSACTION_CHANGED');
      expect(res.body.error.details.amount).toBe(180_000_000);
      expect(await reread(read.id)).toMatchObject({ amount: 180_000_000, description: null });
    });

    it('an Edit form that read the current version saves', async () => {
      const read = await waiting();
      const res = await edit(read.id, { description: 'izoh', baseUpdatedAt: read.updatedAt });
      expect(res.status).toBe(200);
      expect(await reread(read.id)).toMatchObject({ amount: 150_000_000, description: 'izoh' });
    });

    it('an entry already decided answers as before: the version is no longer the point', async () => {
      const read = await waiting();
      expect((await director.post(`/finance/transactions/${read.id}/approve`, { baseUpdatedAt: read.updatedAt })).status).toBe(200);
      const again = await (await w.f.as('owner')).post(`/finance/transactions/${read.id}/approve`, { baseUpdatedAt: read.updatedAt });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('NOT_PENDING');
    });

    it('the maker cannot approve through a fresh version either', async () => {
      const read = await waiting();
      const res = await accountant.post(`/finance/transactions/${read.id}/approve`, { baseUpdatedAt: read.updatedAt });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SAME_MAKER_CHECKER');
    });

    it('a refusal shows no figures to someone without finance.view', async () => {
      const read = await waiting();
      await edit(read.id, { amount: 480_000_000 });
      await w.f.run(() => tx().update(schema.roles).set({ permissions: ['finance.approve'] }).where(eq(schema.roles.id, w.f.roleIds.agronomist)));
      const limited = await w.f.as('agronomist');
      const res = await limited.post(`/finance/transactions/${read.id}/approve`, { baseUpdatedAt: read.updatedAt });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).not.toContain('480000000');
    });
  });

  it('refuses to edit or delete an approved entry', async () => {
    const created = await accountant.post('/finance/transactions', expense());
    expect(created.data.status).toBe('approved');
    const edit = await director.patch(`/finance/transactions/${created.data.id}`, { amount: 1 });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('TRANSACTION_APPROVED');
    const remove = await director.delete(`/finance/transactions/${created.data.id}`);
    expect(remove.status).toBe(409);
  });

  it('refuses to edit an entry owned by another module', async () => {
    const row = await w.f.run(() =>
      postTransaction({
        date: DAY, type: 'expense', amount: 6_000_000, categoryId: w.category('feed'), costCenterId: w.generalId,
        paymentMethod: 'cash', accountId: w.accountId, sourceType: 'sale', sourceId: w.herdId,
      }),
    );
    const res = await director.patch(`/finance/transactions/${row.id}`, { amount: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRANSACTION_HAS_SOURCE');
  });

  it('deletes a pending entry, leaving the audit trail', async () => {
    const owner = await w.f.as('owner');
    const created = await accountant.post('/finance/transactions', expense({ amount: 6_000_000 }));
    expect((await owner.delete(`/finance/transactions/${created.data.id}`)).status).toBe(200);
    expect((await director.get(`/finance/transactions/${created.data.id}`)).status).toBe(404);
    const log = await w.f.run(() =>
      tx().select().from(schema.auditLogs).where(sql`entity = 'transactions' and entity_id = ${created.data.id} and action = 'delete'`),
    );
    expect(log).toHaveLength(1);
  });

  it('voids an approved mistake, by a second person only', async () => {
    const before = (await director.get('/finance/summary/cash')).data.total;
    const created = await accountant.post('/finance/transactions', expense({ amount: 200_000 }));
    expect((await director.get('/finance/summary/cash')).data.total).toBe(before - 200_000);

    const self = await accountant.post(`/finance/transactions/${created.data.id}/void`, { reason: 'Xato' });
    expect(self.status).toBe(403);
    const voided = await director.post(`/finance/transactions/${created.data.id}/void`, { reason: 'Xato' });
    expect(voided.data.status).toBe('rejected');
    expect((await director.get('/finance/summary/cash')).data.total).toBe(before);
    expect((await director.post(`/finance/transactions/${created.data.id}/void`, { reason: 'Yana' })).status).toBe(409);
  });

  it('refuses a category of the wrong kind', async () => {
    const res = await accountant.post('/finance/transactions', expense({ categoryId: w.category('lamb_sales') }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CATEGORY_KIND_MISMATCH');
  });

  it('refuses a transfer on credit', async () => {
    const other = await director.post('/finance/accounts', { name: 'Ikkinchi', type: 'cash' });
    const res = await accountant.post('/finance/transactions', {
      date: DAY, type: 'transfer', amount: 10, paymentMethod: 'debt', accountId: w.accountId, toAccountId: other.data.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYMENT_METHOD');
  });

  it('refuses a foreign currency on a base account only when the account holds another currency', async () => {
    const usd = await director.post('/finance/accounts', { name: 'Dollar', type: 'bank', currency: 'USD' });
    const res = await accountant.post('/finance/transactions', expense({ accountId: usd.data.id, currency: 'RUB', fxRate: 150 }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ACCOUNT_CURRENCY_MISMATCH');

    const transfer = await accountant.post('/finance/transactions', {
      date: DAY, type: 'transfer', amount: 10, paymentMethod: 'bank', accountId: w.accountId, toAccountId: usd.data.id,
    });
    expect(transfer.status).toBe(400);
    expect(transfer.body.error.code).toBe('ACCOUNT_CURRENCY_MISMATCH');
  });

  it('refuses a cost center from another tenant', async () => {
    const other = await world();
    const res = await accountant.post('/finance/transactions', expense({ costCenterId: other.generalId }));
    expect(res.status).toBe(404);
  });

  it('replays an offline create with its Idempotency-Key', async () => {
    const id = '0190a7e2-7b1c-7c3d-8e4f-22222222aaaa';
    const headers = { 'idempotency-key': 'tx-1' };
    await accountant.post('/finance/transactions', expense({ id }), headers);
    const second = await accountant.post('/finance/transactions', expense({ id }), headers);
    expect(second.headers['idempotent-replay']).toBe('true');
    const list = await director.get('/finance/transactions', { search: undefined, categoryId: w.category('gas'), pageSize: 200 });
    expect(list.body.data.filter((row: any) => row.id === id)).toHaveLength(1);
  });
});

describe('transfers and foreign currency', () => {
  it('moves money between accounts without touching income or expense', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const bank = await owner.post('/finance/accounts', { name: 'Bank', type: 'bank', openingBalance: 1_000_000, openingDate: '2026-10-01' });
    const before = (await owner.get('/finance/summary/cash')).data.total;
    await owner.post('/finance/transactions', {
      date: '2026-10-20', type: 'transfer', amount: 400_000, paymentMethod: 'bank', accountId: bank.data.id, toAccountId: w.accountId,
    });
    const cash = (await owner.get('/finance/summary/cash')).data;
    expect(cash.total).toBe(before);
    expect(cash.accounts.find((a: any) => a.name === 'Bank').balance).toBe(600_000);

    const month = await owner.get('/finance/summary/month', { month: '2026-10' });
    expect(month.data.expense).toBe(19_900_000); // all approved expenses of the scenario
    expect(month.data.operatingExpense).toBe(4_900_000); // without animals (10m) and capex (5m)
  });

  it('keeps a foreign account in its own currency and values it in base', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    await owner.put('/finance/fx-rates', { date: '2026-10-01', currency: 'USD', rate: 12_500 });
    const usd = await owner.post('/finance/accounts', { name: 'Dollar', type: 'bank', currency: 'USD', openingBalance: 1000 });
    await owner.post('/finance/transactions', {
      date: DAY, type: 'expense', amount: 100, currency: 'USD', paymentMethod: 'bank', accountId: usd.data.id,
      categoryId: w.category('licenses'), costCenterId: w.generalId,
    });
    const accounts_ = (await owner.get('/finance/accounts')).data;
    const account = accounts_.find((a: any) => a.name === 'Dollar');
    expect(account.balance).toBe(900);
    // 1000 × 12 500 − 100 × 12 500
    expect(account.balanceBase).toBe(11_250_000);
  });

  it('ignores movements dated before the opening date', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const bank = await owner.post('/finance/accounts', { name: 'Bank2', type: 'bank', openingBalance: 500, openingDate: '2026-11-01' });
    await w.f.run(() =>
      postTransaction({
        date: '2026-10-05', type: 'income', amount: 100, categoryId: w.category('other'), costCenterId: w.generalId,
        paymentMethod: 'bank', accountId: bank.data.id,
      }),
    );
    const account = (await owner.get('/finance/accounts')).data.find((a: any) => a.name === 'Bank2');
    expect(account.balance).toBe(500);
  });

  it('gives a daily statement with a running balance', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const bank = await owner.post('/finance/accounts', { name: 'Bank3', type: 'bank', openingBalance: 1000 });
    const post = (date: string, type: 'income' | 'expense', amount: number) =>
      w.f.run(() =>
        postTransaction({
          date, type, amount, categoryId: w.category(type === 'income' ? 'other' : 'gas'), costCenterId: w.generalId,
          paymentMethod: 'bank', accountId: bank.data.id,
        }),
      );
    await post('2026-10-01', 'income', 500);
    await post('2026-10-05', 'expense', 200);
    await post('2026-10-05', 'income', 50);
    await post('2026-10-09', 'expense', 100);

    const res = await owner.get(`/finance/accounts/${bank.data.id}/daily`, { from: '2026-10-05', to: '2026-10-06' });
    expect(res.data.opening).toBe(1500);
    expect(res.data.days).toEqual([{ date: '2026-10-05', inflow: 50, outflow: 200, closing: 1350 }]);
    expect(res.data.closing).toBe(1350);
  });

  it('will not close an account that still holds money', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const full = await owner.delete(`/finance/accounts/${w.accountId}`);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('ACCOUNT_NOT_EMPTY');
    const empty = await owner.post('/finance/accounts', { name: 'Empty', type: 'cash' });
    expect((await owner.delete(`/finance/accounts/${empty.data.id}`)).status).toBe(200);
    expect((await owner.get('/finance/accounts')).data.some((a: any) => a.name === 'Empty')).toBe(false);
  });
});

describe('debts', () => {
  async function setup() {
    const w = await world();
    const owner = await w.f.as('owner');
    const supplier = await owner.post('/finance/counterparties', { name: 'Yem Savdo', type: 'supplier' });
    const buyer = await owner.post('/finance/counterparties', { name: 'Xaridor', type: 'buyer' });
    const debt = (over: object) => ({
      date: '2026-10-01',
      type: 'expense',
      paymentMethod: 'debt',
      counterpartyId: supplier.data.id,
      categoryId: w.category('gas'),
      costCenterId: w.generalId,
      costTreatment: 'expense',
      ...over,
    });
    return { w, owner, supplierId: supplier.data.id, buyerId: buyer.data.id, debt };
  }

  it('a debt does not move cash, a settlement does, and the oldest document is paid first', async () => {
    const { owner, w, supplierId, debt } = await setup();
    const today = todayIso();
    const cashBefore = (await owner.get('/finance/summary/cash')).data.total;

    await owner.post('/finance/transactions', debt({ amount: 2_000_000, dueDate: addDays(today, -45), date: addDays(today, -60) }));
    await owner.post('/finance/transactions', debt({ amount: 1_000_000, dueDate: addDays(today, 10), date: addDays(today, -5) }));
    expect((await owner.get('/finance/summary/cash')).data.total).toBe(cashBefore);

    let list = await owner.get('/finance/debts', { direction: 'payable' });
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ outstanding: 3_000_000, overdue: 2_000_000 });
    expect(list.data[0].aging).toMatchObject({ d31_60: 2_000_000, notDue: 1_000_000 });

    const paid = await owner.post('/finance/debts/settle', {
      counterpartyId: supplierId, direction: 'payable', amount: 500_000, date: today, accountId: w.accountId,
    });
    expect(paid.status).toBe(201);
    expect(paid.data.type).toBe('debt_payment');
    expect((await owner.get('/finance/summary/cash')).data.total).toBe(cashBefore - 500_000);

    list = await owner.get('/finance/debts');
    expect(list.data[0]).toMatchObject({ paid: 500_000, outstanding: 2_500_000, overdue: 1_500_000 });
    expect(list.data[0].documents[0]).toMatchObject({ amount: 2_000_000, outstanding: 1_500_000, daysOverdue: 45 });

    const summary = await owner.get('/finance/debts/summary');
    expect(summary.data).toMatchObject({ payable: 2_500_000, receivable: 0, overdue: 1_500_000, overduePayable: 1_500_000 });
  });

  it('a settlement is not an expense, so it reaches neither costs nor the budget', async () => {
    const { owner, w, supplierId, debt } = await setup();
    await owner.post('/finance/transactions', debt({ amount: 1_000_000, date: DAY }));
    await owner.post('/finance/debts/settle', {
      counterpartyId: supplierId, direction: 'payable', amount: 1_000_000, date: DAY, accountId: w.accountId,
    });
    const rows = await w.f.run(() => costCenterCosts());
    // The debt itself is the 1 000 000 expense on the general center. Paying it adds nothing.
    expect(centerOf(rows, w.generalId).direct).toBe(2_000_000);
    expect((await owner.get('/finance/debts')).data).toEqual([]);
  });

  it('refuses to settle more than is owed, counting settlements still awaiting approval', async () => {
    const { owner, w, supplierId, debt } = await setup();
    const accountant = await w.f.as('accountant');
    // 8m needs approval too: a debt nobody confirmed is not owed yet.
    const unconfirmed = await owner.post('/finance/transactions', debt({ amount: 8_000_000 }));
    expect(unconfirmed.data.status).toBe('pending');
    expect((await owner.get('/finance/debts')).data).toEqual([]);
    const director = await w.f.as('director');
    await director.post(`/finance/transactions/${unconfirmed.data.id}/approve`);

    const settle = (amount: number) =>
      accountant.post('/finance/debts/settle', {
        counterpartyId: supplierId, direction: 'payable', amount, date: DAY, accountId: w.accountId,
      });

    const tooMuch = await settle(8_000_001);
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('AMOUNT_EXCEEDS_DEBT');
    expect(tooMuch.body.error.details.outstanding).toBe(8_000_000);

    const first = await settle(6_000_000);
    expect(first.data.status).toBe('pending');
    const second = await settle(6_000_000);
    expect(second.status).toBe(409);
    expect(second.body.error.details.outstanding).toBe(2_000_000);

    const edit = await owner.patch(`/finance/transactions/${first.data.id}`, { amount: 8_000_000 });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('SETTLEMENT_NOT_EDITABLE');
  });

  it('tracks what buyers owe us separately', async () => {
    const { owner, w, buyerId } = await setup();
    await owner.post('/finance/transactions', {
      date: DAY, type: 'income', amount: 3_000_000, paymentMethod: 'debt', counterpartyId: buyerId,
      categoryId: w.category('lamb_sales'), costCenterId: w.herdCc, dueDate: addDays(todayIso(), 20),
    });
    const before = (await owner.get('/finance/summary/cash')).data.total;
    await owner.post('/finance/debts/settle', {
      counterpartyId: buyerId, direction: 'receivable', amount: 1_000_000, date: todayIso(), accountId: w.accountId,
    });
    expect((await owner.get('/finance/summary/cash')).data.total).toBe(before + 1_000_000);
    const summary = await owner.get('/finance/debts/summary');
    expect(summary.data).toMatchObject({ receivable: 2_000_000, payable: 0 });
  });
});

describe('loans', () => {
  async function setup() {
    const w = await world();
    const owner = await w.f.as('owner');
    const bank = await owner.post('/finance/counterparties', { name: 'Agrobank', type: 'bank' });
    const account = await owner.post('/finance/accounts', { name: 'Hisob', type: 'bank' });
    return { w, owner, lender: bank.data.id, accountId: account.data.id };
  }

  const loanBody = (lender: string, over: object = {}) => ({
    counterpartyId: lender,
    name: 'Imtiyozli kredit',
    principal: 12_000_000,
    annualRate: 12,
    termMonths: 12,
    startDate: '2026-01-31',
    preferential: true,
    ...over,
  });

  it('addMonths clamps to the end of a short month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 2)).toBe('2027-01-15');
    expect(addMonths('2027-12-31', 2)).toBe('2028-02-29');
    expect(addMonths('2026-03-10', -3)).toBe('2025-12-10');
  });

  it('builds the schedule, and disbursement is cash but neither income nor a trade debt', async () => {
    const { w, owner, lender, accountId } = await setup();
    const res = await owner.post('/finance/loans', loanBody(lender, { disburseToAccountId: accountId }));
    expect(res.status).toBe(201);
    expect(res.data.instalments).toHaveLength(12);
    const first = res.data.instalments[0];
    expect(first).toMatchObject({ period: 1, dueDate: '2026-02-28', interest: 120_000 });
    expect(res.data.instalments[11].balance).toBe(0);
    expect(res.data.outstanding).toBe(12_000_000);

    // 12m is above the threshold, so the money waits for a second person.
    const pending = await owner.get('/finance/transactions', { status: 'pending', type: 'debt_receipt' });
    expect(pending.body.data).toHaveLength(1);
    const director = await w.f.as('director');
    await director.post(`/finance/transactions/${pending.body.data[0].id}/approve`);

    const cash = (await owner.get('/finance/accounts')).data.find((a: any) => a.id === accountId);
    expect(cash.balance).toBe(12_000_000);
    expect((await owner.get('/finance/debts')).data).toEqual([]);
    const month = await owner.get('/finance/summary/month', { month: '2026-01' });
    expect(month.data.income).toBe(0);
    const summary = await owner.get('/finance/debts/summary');
    expect(summary.data.loansOutstanding).toBe(12_000_000);
  });

  it('pays an instalment: principal is not an expense, interest is', async () => {
    const { owner, lender, accountId, w } = await setup();
    const created = await owner.post('/finance/loans', loanBody(lender));
    const first = created.data.instalments[0];

    const paid = await owner.post(`/finance/loans/${created.data.id}/instalments/${first.id}/pay`, { date: '2026-02-28', accountId });
    expect(paid.status).toBe(200);
    expect(paid.data.instalments[0].paidDate).toBe('2026-02-28');
    expect(paid.data.outstanding).toBe(12_000_000 - first.principal);

    const account = (await owner.get('/finance/accounts')).data.find((a: any) => a.id === accountId);
    expect(account.balance).toBe(-first.payment);

    const month = await owner.get('/finance/summary/month', { month: '2026-02' });
    expect(month.data.expense).toBe(120_000);

    const rows = await w.f.run(() => costCenterCosts('2026-02-01', '2026-02-28'));
    expect(centerOf(rows, w.generalId).direct).toBe(120_000);
    // Paying the bank must not create a negative trade payable.
    expect((await owner.get('/finance/debts')).data).toEqual([]);
  });

  it('refuses paying twice or out of order, and closes the loan after the last instalment', async () => {
    const { owner, lender, accountId } = await setup();
    const created = await owner.post('/finance/loans', loanBody(lender, { termMonths: 2, principal: 1000, annualRate: 0 }));
    const [one, two] = created.data.instalments;
    const pay = (id: string) =>
      owner.post(`/finance/loans/${created.data.id}/instalments/${id}/pay`, { date: '2026-03-01', accountId });

    const outOfOrder = await pay(two.id);
    expect(outOfOrder.status).toBe(409);
    expect(outOfOrder.body.error.code).toBe('EARLIER_INSTALMENT_UNPAID');

    expect((await pay(one.id)).status).toBe(200);
    expect((await pay(one.id)).body.error.code).toBe('ALREADY_PAID');
    const last = await pay(two.id);
    expect(last.data.status).toBe('closed');
    expect(last.data.outstanding).toBe(0);
  });

  it('only someone with approval rights can pay, and a paid loan cannot be deleted', async () => {
    const { w, owner, lender, accountId } = await setup();
    const created = await owner.post('/finance/loans', loanBody(lender));
    const first = created.data.instalments[0];
    const zootechnician = await w.f.as('zootechnician');
    const denied = await zootechnician.post(`/finance/loans/${created.data.id}/instalments/${first.id}/pay`, {
      date: '2026-03-01',
      accountId,
    });
    expect(denied.status).toBe(403);

    await owner.post(`/finance/loans/${created.data.id}/instalments/${first.id}/pay`, { date: '2026-02-28', accountId });
    const remove = await owner.delete(`/finance/loans/${created.data.id}`);
    expect(remove.status).toBe(409);
    expect(remove.body.error.code).toBe('LOAN_HAS_PAYMENTS');
  });

  it('deletes an unused loan with its pending disbursement', async () => {
    const { owner, lender, accountId } = await setup();
    const created = await owner.post('/finance/loans', loanBody(lender, { disburseToAccountId: accountId }));
    expect((await owner.delete(`/finance/loans/${created.data.id}`)).status).toBe(200);
    const pending = await owner.get('/finance/transactions', { status: 'pending', type: 'debt_receipt' });
    expect(pending.body.data).toEqual([]);
  });

  it('lists upcoming instalments, overdue ones first', async () => {
    const { owner, lender } = await setup();
    await owner.post('/finance/loans', loanBody(lender, { startDate: addDays(todayIso(), -40), termMonths: 3 }));
    const res = await owner.get('/finance/loans/upcoming', { days: 30 });
    expect(res.data.length).toBeGreaterThanOrEqual(2);
    expect(res.data[0].dueDate <= res.data[1].dueDate).toBe(true);
    const list = await owner.get('/finance/loans');
    expect(list.data[0].overdue).toBe(true);
  });
});

describe('cash-flow forecast', () => {
  const plus = (months: number) => monthOf(addMonths(`${monthOf(todayIso())}-01`, months));

  async function setup() {
    const f = await createFixture();
    const refs = await f.run(async () => {
      const c = ctx();
      const [account] = await tx()
        .insert(accounts)
        .values({ tenantId: c.tenantId, farmId: c.farmId, name: 'Kassa', type: 'cash', openingBalance: 1_000_000 })
        .returning();
      const categories = await tx().select().from(financeCategories).where(eq(financeCategories.tenantId, c.tenantId));
      return {
        accountId: account.id,
        category: (key: string) => categories.find((row) => row.key === key)!.id,
        generalId: await generalCostCenterId(),
      };
    });
    return { f, owner: await f.as('owner'), ...refs };
  }

  it('says it is statistical and starts from the real cash position', async () => {
    const { owner } = await setup();
    const res = await owner.get('/finance/cashflow/forecast', { months: 3 });
    expect(res.data.method).toBe('statistical');
    expect(res.data.opening).toBe(1_000_000);
    expect(res.data.rows).toHaveLength(3);
    expect(res.data.rows[0].month).toBe(monthOf(todayIso()));
    expect(res.data.rows[2].closing).toBe(1_000_000);
    expect(res.data.lowConfidence).toBe(true);
    expect(res.data.firstNegativeMonth).toBeNull();
  });

  it('adds budget lines, loan instalments and debts by due date, and flags negative months', async () => {
    const { owner, f, category, generalId } = await setup();
    await owner.put('/finance/budget', {
      entries: [
        { month: plus(1), categoryId: category('electricity'), amount: 300_000 },
        { month: plus(2), categoryId: category('electricity'), amount: 300_000 },
        { month: plus(2), categoryId: category('grants'), amount: 100_000 },
      ],
    });
    const supplier = await owner.post('/finance/counterparties', { name: 'S', type: 'supplier' });
    await owner.post('/finance/transactions', {
      date: todayIso(), type: 'expense', amount: 500_000, paymentMethod: 'debt', counterpartyId: supplier.data.id,
      categoryId: category('gas'), costCenterId: generalId, dueDate: `${plus(1)}-15`,
    });
    const bank = await owner.post('/finance/counterparties', { name: 'B', type: 'bank' });
    await owner.post('/finance/loans', {
      counterpartyId: bank.data.id, name: 'L', principal: 1_000_000, annualRate: 0, termMonths: 1, startDate: `${plus(1)}-10`,
    });

    const res = await owner.get('/finance/cashflow/forecast', { months: 4 });
    const [m0, m1, m2, m3] = res.data.rows;
    expect(m0).toMatchObject({ inflow: 0, outflow: 0, closing: 1_000_000, negative: false });
    // Month +1: electricity 300k, payable 500k. The loan's only instalment is due in month +2.
    expect(m1).toMatchObject({ outflow: 800_000, closing: 200_000, negative: false });
    expect(m1.parts).toMatchObject({ budgetExpense: 300_000, payables: 500_000 });
    // Month +2: electricity 300k, instalment 1m, grant +100k.
    expect(m2).toMatchObject({ inflow: 100_000, outflow: 1_300_000, closing: -1_000_000, negative: true });
    expect(m3.closing).toBe(-1_000_000);
    expect(res.data.firstNegativeMonth).toBe(plus(2));
    await f.run(async () => undefined);
  });

  it('brings overdue debts and instalments into the current month', async () => {
    const { owner, category, generalId } = await setup();
    const supplier = await owner.post('/finance/counterparties', { name: 'S', type: 'supplier' });
    await owner.post('/finance/transactions', {
      date: addDays(todayIso(), -60), type: 'expense', amount: 200_000, paymentMethod: 'debt', counterpartyId: supplier.data.id,
      categoryId: category('gas'), costCenterId: generalId, dueDate: addDays(todayIso(), -40),
    });
    const res = await owner.get('/finance/cashflow/forecast', { months: 2 });
    expect(res.data.rows[0].parts.payables).toBe(200_000);
  });

  it('subtracts what the current month has already spent from its estimate', async () => {
    const { owner, f, category, generalId, accountId } = await setup();
    await owner.put('/finance/budget', {
      entries: [{ month: monthOf(todayIso()), categoryId: category('electricity'), amount: 300_000 }],
    });
    await f.run(() =>
      postTransaction({
        date: todayIso(), type: 'expense', amount: 100_000, categoryId: category('electricity'), costCenterId: generalId,
        paymentMethod: 'cash', accountId,
      }),
    );
    const res = await owner.get('/finance/cashflow/forecast', { months: 1 });
    expect(res.data.rows[0].parts.budgetExpense).toBe(200_000);
    expect(res.data.rows[0].closing).toBe(700_000);
  });

  it('does not repeat a budgeted one-off already bought this month', async () => {
    const { owner, f, category, generalId, accountId } = await setup();
    await owner.put('/finance/budget', {
      entries: [{ month: monthOf(todayIso()), categoryId: category('animal_purchase'), amount: 300_000 }],
    });
    await f.run(() =>
      postTransaction({
        date: todayIso(), type: 'expense', amount: 300_000, categoryId: category('animal_purchase'), costCenterId: generalId,
        costTreatment: 'animal', paymentMethod: 'cash', accountId,
      }),
    );
    const res = await owner.get('/finance/cashflow/forecast', { months: 1 });
    expect(res.data.rows[0].parts.budgetExpense).toBe(0);
    expect(res.data.rows[0].closing).toBe(700_000);
  });

  it('uses a moving average only for categories that really recur', async () => {
    const { owner, f, category, generalId, accountId } = await setup();
    const post = (date: string, key: string, amount: number) =>
      f.run(() =>
        postTransaction({
          date, type: 'expense', amount, categoryId: category(key), costCenterId: generalId,
          paymentMethod: 'cash', accountId,
        }),
      );
    // Electricity in two recent months, gas once: only electricity recurs.
    await post(`${plus(-1)}-05`, 'electricity', 600_000);
    await post(`${plus(-2)}-05`, 'electricity', 600_000);
    await post(`${plus(-2)}-06`, 'gas', 5_000_000);
    const res = await owner.get('/finance/cashflow/forecast', { months: 2 });
    // 1 200 000 over a 6-month window.
    expect(res.data.rows[1].parts.recurringExpense).toBe(200_000);
    expect(res.data.historyMonths).toBe(2);
  });

  it('does not count planned income twice when a month has an income budget', async () => {
    const { owner, f, category } = await setup();
    const buyer = await owner.post('/finance/counterparties', { name: 'B', type: 'buyer' });
    await f.run(async () => {
      const c = ctx();
      await tx().insert(schema.sales).values([
        { tenantId: c.tenantId, farmId: c.farmId, date: `${plus(1)}-10`, counterpartyId: buyer.data.id, totalAmount: 400_000 },
        { tenantId: c.tenantId, farmId: c.farmId, date: `${plus(2)}-10`, counterpartyId: buyer.data.id, totalAmount: 400_000 },
      ]);
    });
    await owner.put('/finance/budget', { entries: [{ month: plus(2), categoryId: category('lamb_sales'), amount: 900_000 }] });
    const res = await owner.get('/finance/cashflow/forecast', { months: 3 });
    expect(res.data.rows[1].parts.plannedSales).toBe(400_000);
    expect(res.data.rows[2].parts).toMatchObject({ plannedSales: 0, budgetIncome: 900_000 });
  });

  it('reports actual money per month, without transfers or credit', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const res = await owner.get('/finance/cashflow/actual', { from: '2026-10-01', to: '2026-10-31' });
    expect(res.data).toEqual([{ month: '2026-10', inflow: 0, outflow: 19_900_000, net: -19_900_000 }]);
  });
});

describe('income and expense report', () => {
  it('sums by category, approved only', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const res = await owner.get('/finance/costs/categories', { from: '2026-10-01', to: '2026-10-31' });
    expect(res.data.expense).toBe(19_900_000);
    expect(res.data.income).toBe(0);
    expect(res.data.rows[0]).toMatchObject({ key: 'animal_purchase', amount: 10_000_000 });
    expect(res.data.rows.some((row: any) => row.key === 'repair')).toBe(false);
  });
});

describe('fx rates', () => {
  it('saves one rate per day, corrects it, and removes it', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await owner.put('/finance/fx-rates', { date: '2026-11-01', currency: 'USD', rate: 12_700 });
    await owner.put('/finance/fx-rates', { date: '2026-11-01', currency: 'USD', rate: 12_750 });
    let rows = await owner.get('/finance/fx-rates');
    expect(rows.data).toEqual([{ date: '2026-11-01', currency: 'USD', rate: 12_750 }]);
    expect((await owner.delete('/finance/fx-rates/2026-11-01/USD')).status).toBe(200);
    rows = await owner.get('/finance/fx-rates');
    expect(rows.data).toEqual([]);
    expect((await owner.delete('/finance/fx-rates/2026-11-01/USD')).status).toBe(404);
  });

  it('refuses the base currency', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    expect((await owner.put('/finance/fx-rates', { date: '2026-11-01', currency: 'UZS', rate: 1 })).status).toBe(400);
  });
});

describe('categories', () => {
  it('adds a tenant category, hides a retired one, and validates kind against group', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const name = { uz: 'Boshqa', ru: 'Прочее', en: 'Misc' };
    const bad = await owner.post('/finance/categories', { kind: 'income', group: 'labor', key: 'misc', name });
    expect(bad.body.error.code).toBe('CATEGORY_KIND_MISMATCH');

    const created = await owner.post('/finance/categories', { kind: 'expense', group: 'admin', key: 'misc', name });
    expect(created.status).toBe(201);
    await owner.patch(`/finance/categories/${created.data.id}`, { active: false });
    const list = await owner.get('/finance/categories', { kind: 'expense' });
    expect(list.data.some((row: any) => row.key === 'misc')).toBe(false);
    const all = await owner.get('/finance/categories', { includeInactive: true });
    expect(all.data.some((row: any) => row.key === 'misc')).toBe(true);
  });
});

describe('lookups', () => {
  it('are open to any role and never carry money', async () => {
    const w = await world();
    const shepherd = await w.f.as('shepherd');
    const accountsLookup = await shepherd.get('/finance/accounts/lookup');
    expect(accountsLookup.status).toBe(200);
    expect(Object.keys(accountsLookup.data[0]).sort()).toEqual(['currency', 'id', 'name', 'type']);

    const centers = await shepherd.get('/finance/cost-centers/lookup', { type: 'herd' });
    expect(centers.data).toEqual([{ id: w.herdCc, name: 'Sovliqlar', type: 'herd', refId: w.herdId }]);

    const categories = await shepherd.get('/finance/categories', { kind: 'income' });
    expect(categories.data.length).toBeGreaterThan(5);
    expect(categories.data.every((row: any) => row.kind === 'income')).toBe(true);
  });
});

describe('money visibility (CLAUDE.md rule 7, spec 24.1)', () => {
  const ROUTES = [
    '/finance/accounts',
    '/finance/transactions',
    '/finance/transactions/totals',
    '/finance/transactions/pending-count',
    '/finance/transactions/export.csv',
    '/finance/transactions/export.xlsx',
    '/finance/debts',
    '/finance/debts/summary',
    '/finance/budget?from=2026-10&to=2026-10',
    '/finance/fx-rates',
    '/finance/loans',
    '/finance/loans/upcoming',
    '/finance/summary/cash',
    '/finance/summary/month',
    '/finance/costs/centers',
    '/finance/costs/herds',
    '/finance/costs/fields',
    '/finance/costs/categories',
    '/finance/cashflow/forecast',
    '/finance/cashflow/actual',
  ];

  it.each(['shepherd', 'storekeeper', 'mechanic', 'zootechnician', 'investor'] as const)(
    '%s is refused every money endpoint',
    async (role) => {
      const w = await world();
      const client = await w.f.as(role);
      for (const route of ROUTES) {
        const res = await client.get(route);
        expect(res.status, route).toBe(403);
        expect(JSON.stringify(res.body), route).not.toContain('balance');
      }
    },
  );

  it('an auditor reads but cannot write', async () => {
    const w = await world();
    const auditor = await w.f.as('auditor');
    expect((await auditor.get('/finance/transactions')).status).toBe(200);
    expect((await auditor.post('/finance/accounts', { name: 'X', type: 'cash' })).status).toBe(403);
    expect((await auditor.put('/finance/budget', { entries: [{ month: '2026-10', categoryId: w.category('gas'), amount: 1 }] })).status).toBe(403);
  });

  it('a user without approval rights cannot approve', async () => {
    const w = await world();
    const [pending] = await w.f.run(() =>
      tx().select().from(transactions).where(and(eq(transactions.farmId, ctx().farmId), eq(transactions.status, 'pending'))),
    );
    const agronomist = await w.f.as('agronomist');
    expect((await agronomist.post(`/finance/transactions/${pending.id}/approve`)).status).toBe(403);
  });
});

describe('personal data (CLAUDE.md rule 8)', () => {
  it('hides staff names from a role that sees money but not people', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const created = await owner.post('/finance/transactions', {
      date: DAY, type: 'expense', amount: 1000, paymentMethod: 'cash', accountId: w.accountId,
      categoryId: w.category('gas'), costCenterId: w.generalId,
    });
    const employeeCc = await w.f.run(async () => {
      const c = ctx();
      const [employee] = await tx()
        .insert(employees)
        .values({ tenantId: c.tenantId, farmId: c.farmId, fullName: 'Ali Valiyev', position: 'Omborchi', hireDate: '2026-01-01' })
        .returning();
      return ensureCostCenter('employee', employee.id, employee.fullName);
    });

    // A custom role: finance.view without pii.view.
    await w.f.run(() =>
      tx().update(schema.roles).set({ permissions: ['finance.view'] }).where(eq(schema.roles.id, w.f.roleIds.investor)),
    );
    const viewer = await w.f.as('investor');
    const row = (await viewer.get(`/finance/transactions/${created.data.id}`)).data;
    expect(row.createdByName).toBeNull();
    const list = await viewer.get('/finance/transactions', { pageSize: 1 });
    expect(list.body.data[0].createdByName).toBeNull();
    const centers = (await viewer.get('/finance/costs/centers')).data;
    expect(centers.find((c: any) => c.costCenterId === employeeCc).name).toBeNull();

    expect((await owner.get(`/finance/transactions/${created.data.id}`)).data.createdByName).not.toBeNull();
  });
});

describe('tenant isolation', () => {
  it("another tenant sees none of this tenant's money", async () => {
    const a = await world();
    const b = await world();
    const ownerB = await b.f.as('owner');
    const accountsB = (await ownerB.get('/finance/accounts')).data;
    expect(accountsB.map((row: any) => row.id)).toEqual([b.accountId]);

    const [txA] = await a.f.run(() => tx().select().from(transactions).limit(1));
    expect((await ownerB.get(`/finance/transactions/${txA.id}`)).status).toBe(404);
    expect((await ownerB.post(`/finance/transactions/${txA.id}/approve`)).status).toBe(404);
    expect((await ownerB.get(`/finance/accounts/${a.accountId}`)).status).toBe(404);
    expect((await ownerB.get('/finance/costs/centers')).data.some((row: any) => row.costCenterId === a.herdCc)).toBe(false);
  });
});

describe('pilot seed', () => {
  it('runs against real prerequisites and leaves the books in the intended state', async () => {
    const f = await createFixture();
    const roles = ['owner', 'accountant', 'director'] as const;
    const users = {} as Record<(typeof roles)[number], string>;
    for (const role of roles) users[role] = (await f.as(role)).userId;
    const seed = {
      tenantId: f.tenantId,
      farmId: f.farmId,
      users: users as never,
      run: <T,>(fn: () => Promise<T>, as: keyof typeof users = 'owner') => f.run(fn, { userId: users[as] }),
    };

    await seedFinanceBase(seed);
    await f.run(async () => {
      const c = ctx();
      const base = { tenantId: c.tenantId, farmId: c.farmId };
      const [herd] = await tx().insert(herds).values({ ...base, name: SEED.herd.pregnant }).returning();
      const [sheep] = await tx().select().from(species).where(and(eq(species.tenantId, c.tenantId), eq(species.key, 'sheep')));
      await tx().insert(animals).values(
        Array.from({ length: 3 }, (_, i) => ({
          ...base, tag: `S-${i}`, speciesId: sheep.id, sex: 'female', category: 'ewe', origin: 'purchased',
          herdId: herd.id, purchaseDate: '2026-10-20', purchasePrice: 4_200_000,
        })),
      );
      await tx().insert(fields).values([
        { ...base, number: SEED.field.wheat1, areaHa: 20 },
        { ...base, number: SEED.field.barley, areaHa: 15 },
      ]);
      await tx().insert(assets).values({ ...base, name: SEED.asset.tractor1, type: 'tractor', inventoryNo: 'T1' });
      const [warehouse] = await tx().insert(warehouses).values({ ...base, name: 'Ombor', type: 'feed' }).returning();
      const [hay] = await tx().insert(items).values({ ...base, name: 'Beda', category: 'feed', unit: 'kg' }).returning();
      const [fuel] = await tx().insert(items).values({ ...base, name: 'Dizel', category: 'fuel', unit: 'l' }).returning();
      await receiveStock({ itemId: hay.id, warehouseId: warehouse.id, qty: 50_000, unitCost: 2000, date: '2026-09-25', source: 'opening' });
      await receiveStock({ itemId: fuel.id, warehouseId: warehouse.id, qty: 1000, unitCost: 12_500, date: '2026-09-25', source: 'opening' });
    });

    await seedFinance(seed);

    const owner = await f.as('owner');
    const cash = (await owner.get('/finance/summary/cash')).data;
    expect(cash.accounts.find((a: any) => a.name === SEED.account.bank).balance).toBe(940_000_000);
    expect(cash.accounts.find((a: any) => a.name === SEED.account.cash).balance).toBe(38_000_000);

    const pending = await owner.get('/finance/transactions', { status: 'pending' });
    expect(pending.body.data).toHaveLength(1);
    expect(pending.body.data[0].amountBase).toBe(18_500_000);

    // History really went through approval, by someone other than the person who entered it.
    const ewes = await owner.get('/finance/transactions', { search: 'Hisori' });
    expect(ewes.body.data[0]).toMatchObject({ amountBase: 12_600_000, status: 'approved', costTreatment: 'animal' });

    const debts = (await owner.get('/finance/debts/summary')).data;
    expect(debts.payable).toBe(14_000_000); // 24m on credit, 10m settled
    expect(debts.overduePayable).toBe(14_000_000);
    expect(debts.loansOutstanding).toBeGreaterThan(1_460_000_000);

    const loans = (await owner.get('/finance/loans')).data;
    expect(loans[0]).toMatchObject({ annualRate: 14, preferential: true, status: 'active' });
    expect(loans[0].paidInterest).toBe(17_500_000);

    // Stock bought is not a cost until it is issued, and nothing has been issued here.
    const rows = await f.run(() => costCenterCosts());
    const materials = rows.reduce((sum, row) => sum + row.materials, 0);
    expect(materials).toBe(0);

    const budget = (await owner.get('/finance/budget', { from: '2026-10', to: '2027-10' })).data;
    expect(budget.months).toHaveLength(13);
    const feed = budget.rows.find((row: any) => row.key === 'feed');
    expect(feed.cells['2026-10'].actual).toBe(100_000_000);
    expect(budget.totals.income.planned).toBeGreaterThan(1_000_000_000);

    const forecast = (await owner.get('/finance/cashflow/forecast')).data;
    expect(forecast.opening).toBe(978_000_000);
    expect(forecast.rows).toHaveLength(12);
  });
});

describe('Keeping export', () => {
  const base = {
    id: 'x',
    date: '2026-10-01',
    amount: 100,
    currency: 'UZS',
    fxRate: 1,
    amountBase: 100,
    description: null,
    sourceType: null,
    categoryGroup: 'livestock',
    categoryName: { uz: 'Ozuqa' },
    accountName: 'Kassa',
    accountType: 'cash',
    toAccountName: null,
    toAccountType: null,
    counterpartyName: null,
    counterpartyTin: null,
    costCenterName: null,
  };

  it.each([
    [{ type: 'expense', paymentMethod: 'cash', costTreatment: 'expense' }, '2010', '5010'],
    [{ type: 'expense', paymentMethod: 'debt', costTreatment: 'inventory' }, '1000', '6010'],
    [{ type: 'expense', paymentMethod: 'bank', costTreatment: 'animal', accountType: 'bank' }, '1200', '5110'],
    [{ type: 'expense', paymentMethod: 'bank', costTreatment: 'capex', accountType: 'bank' }, '0800', '5110'],
    [{ type: 'expense', paymentMethod: 'non_cash', costTreatment: 'expense' }, '2010', '0200'],
    [{ type: 'income', paymentMethod: 'cash', costTreatment: 'expense' }, '5010', '9010'],
    [{ type: 'income', paymentMethod: 'debt', costTreatment: 'expense' }, '4010', '9010'],
    [{ type: 'income', paymentMethod: 'bank', costTreatment: 'expense', categoryGroup: 'subsidy', accountType: 'bank' }, '5110', '9390'],
    [{ type: 'debt_payment', paymentMethod: 'bank', costTreatment: 'expense', accountType: 'bank' }, '6010', '5110'],
    [{ type: 'debt_receipt', paymentMethod: 'cash', costTreatment: 'expense' }, '5010', '4010'],
    [{ type: 'debt_receipt', paymentMethod: 'bank', costTreatment: 'expense', sourceType: 'loan', accountType: 'bank' }, '5110', '7810'],
    [{ type: 'debt_payment', paymentMethod: 'bank', costTreatment: 'expense', sourceType: 'loan_instalment', accountType: 'bank' }, '7810', '5110'],
    [{ type: 'transfer', paymentMethod: 'bank', costTreatment: 'expense', accountType: 'bank', toAccountType: 'cash' }, '5010', '5110'],
    [{ type: 'transfer', paymentMethod: 'cash', costTreatment: 'expense', accountType: 'cash', toAccountType: 'card' }, '5210', '5010'],
  ])('%j → Dt %s Ct %s', (over, debit, credit) => {
    expect(doubleEntry({ ...base, ...over } as never)).toEqual({ debit, credit });
  });

  it('neutralises spreadsheet formulas in free text', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+998901234567')).toBe("'+998901234567");
    expect(csvCell('oddiy matn')).toBe('oddiy matn');
    expect(csvCell('vergul, bor')).toBe('"vergul, bor"');
    expect(csvCell(-100)).toBe('-100');
  });

  it('writes a BOM and a header row', () => {
    const csv = toCsv([{ ...base, type: 'expense', paymentMethod: 'cash', costTreatment: 'expense' } as never]);
    expect(csv.startsWith('﻿date,document,debit,credit,amount')).toBe(true);
    expect(csv).toContain('2026-10-01,x,2010,5010,100,UZS,1,100');
  });

  it('exports approved entries only', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const res = await owner.get('/finance/transactions/export.csv', { from: '2026-10-01', to: '2026-10-31' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = String(res.body).trim().split('\r\n');
    expect(lines).toHaveLength(1 + 8); // header + 8 approved, the pending repair left out

    const xlsx = await owner.get('/finance/transactions/export.xlsx');
    expect(xlsx.status).toBe(200);
  });
});
