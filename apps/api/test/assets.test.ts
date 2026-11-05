import { addDays, monthOf, monthRange, todayIso } from '@yap/shared';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tx, withPlatform } from '../src/core/context';
import { ensureCostCenter } from '../src/core/costCenters';
import { receiveStock, stockOnHand } from '../src/core/inventory';
import { postTransaction } from '../src/core/ledger';
import { schema } from '../src/db/client';
import { monthsToRun, previousMonth, runDepreciation } from '../src/modules/assets/depreciation.service';
import { jobs } from '../src/modules/assets/jobs';
import { machineryCostByField } from '../src/modules/assets/costs.service';
import { dueMaintenance } from '../src/modules/assets/maintenance.service';
import { assetStatus, fuelUsage } from '../src/modules/assets/summary';
import { createFixture, type Fixture } from './helpers';
import { renderAlert } from '../src/modules/alerts/alerts.service';

const { accounts, alerts, counterparties, depreciationEntries, financeCategories, fields, items, stockMovements, transactions, warehouses } = schema;

const today = todayIso();
const lastMonth = previousMonth(monthOf(today));
const twoMonthsAgo = previousMonth(lastMonth);

async function setup() {
  const f = await createFixture();
  const owner = await f.as('owner');
  return { f, owner };
}

async function newAsset(owner: Awaited<ReturnType<Fixture['as']>>, over: object = {}) {
  const res = await owner.post('/assets', { name: 'MTZ-82', type: 'tractor', ...over });
  expect(res.status).toBe(201);
  return res.data;
}

async function stock(f: Fixture, name: string, category: string, unit: string, qty: number, unitCost: number) {
  return f.run(async () => {
    const [warehouse] = await tx()
      .insert(warehouses)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name: `Ombor ${name}`, type: 'fuel' })
      .returning();
    const [item] = await tx()
      .insert(items)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name, category, unit })
      .returning();
    await receiveStock({ itemId: item.id, warehouseId: warehouse.id, qty, unitCost, date: addDays(today, -90), source: 'opening' });
    return { itemId: item.id, warehouseId: warehouse.id };
  });
}

async function field(f: Fixture, number: string, areaHa = 20) {
  return f.run(async () => {
    const [row] = await tx()
      .insert(fields)
      .values({ tenantId: f.tenantId, farmId: f.farmId, number, areaHa })
      .returning();
    return { fieldId: row.id, costCenterId: await ensureCostCenter('field', row.id, number) };
  });
}

async function moneyRefs(f: Fixture) {
  return f.run(async () => {
    const [account] = await tx()
      .insert(accounts)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Kassa', type: 'cash' })
      .returning();
    const [contractor] = await tx()
      .insert(counterparties)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Kombayn xizmati', type: 'service' })
      .returning();
    return { accountId: account.id, counterpartyId: contractor.id };
  });
}

describe('registry', () => {
  it('creates the machine with its own cost center (spec 4.1 p.5)', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner, { inventoryNo: 'T-001', purchasePrice: 180_000_000, purchaseDate: '2024-03-10' });
    expect(asset.costCenterId).toBeTruthy();
    const center = await f.run(async () => {
      const [row] = await tx().select().from(schema.costCenters).where(eq(schema.costCenters.id, asset.costCenterId));
      return row;
    });
    expect(center).toMatchObject({ type: 'asset', refId: asset.id, name: 'MTZ-82' });
  });

  it('renaming also renames the cost center', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    await owner.patch(`/assets/${asset.id}`, { name: 'TTZ-80' });
    const name = await f.run(async () => {
      const [row] = await tx().select().from(schema.costCenters).where(eq(schema.costCenters.id, asset.costCenterId));
      return row.name;
    });
    expect(name).toBe('TTZ-80');
  });

  it('lists, filters and searches', async () => {
    const { owner } = await setup();
    await newAsset(owner, { name: 'MTZ-82', inventoryNo: 'T-001' });
    await newAsset(owner, { name: 'Seyalka', type: 'seeder', inventoryNo: 'S-001' });
    expect((await owner.get('/assets')).body.meta.total).toBe(2);
    expect((await owner.get('/assets', { type: 'seeder' })).data[0].name).toBe('Seyalka');
    expect((await owner.get('/assets', { search: 't-0' })).data[0].name).toBe('MTZ-82');
  });

  it('an inventory number is unique on a farm', async () => {
    const { owner } = await setup();
    await newAsset(owner, { inventoryNo: 'T-001' });
    const res = await owner.post('/assets', { name: 'Boshqa', type: 'tractor', inventoryNo: 'T-001' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_EXISTS');
  });

  it('a machine with history cannot be deleted, an unused one can', async () => {
    const { owner } = await setup();
    const used = await newAsset(owner, { name: 'A' });
    await owner.post(`/assets/${used.id}/usage`, { date: today, motoHours: 2 });
    const blocked = await owner.delete(`/assets/${used.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('IN_USE');

    const free = await newAsset(owner, { name: 'B' });
    expect((await owner.delete(`/assets/${free.id}`)).status).toBe(200);
    expect((await owner.get(`/assets/${free.id}`)).status).toBe(404);
  });

  it('lookup works for any role, without money or written-off machines', async () => {
    const { f, owner } = await setup();
    await newAsset(owner, { name: 'Ishlaydi', purchasePrice: 100 });
    await newAsset(owner, { name: 'Hisobdan chiqqan', status: 'written_off' });
    const shepherd = await f.as('shepherd');
    const res = await shepherd.get('/assets/lookup');
    expect(res.status).toBe(200);
    expect(res.data.map((a: any) => a.name)).toEqual(['Ishlaydi']);
    expect(res.data[0]).not.toHaveProperty('purchasePrice');
  });
});

describe('money rule 7', () => {
  it('a mechanic sees the machine but no prices', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner, {
      purchasePrice: 180_000_000,
      salvageValue: 10_000_000,
      rented: true,
      rentalPrice: 450_000,
    });
    const mechanic = await f.as('mechanic');

    const one = await mechanic.get(`/assets/${asset.id}`);
    expect(one.status).toBe(200);
    expect(one.data.name).toBe('MTZ-82');
    for (const key of ['purchasePrice', 'salvageValue', 'rentalPrice', 'accumulatedDepreciation', 'bookValue']) {
      expect(one.data[key]).toBeNull();
    }
    const list = await mechanic.get('/assets');
    expect(list.data[0].purchasePrice).toBeNull();
    expect(JSON.stringify(list.body)).not.toContain('180000000');
  });

  it('fuel and repair costs are hidden; the cost screens are refused', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    await stock(f, 'Dizel', 'fuel', 'l', 500, 12_000);
    await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 4, fuelL: 40 });
    await owner.post(`/assets/${asset.id}/maintenance`, { date: today, type: 'repair', cost: 900_000 });

    const mechanic = await f.as('mechanic');
    expect((await mechanic.get(`/assets/${asset.id}/usage`)).data[0].fuelCost).toBeNull();
    expect((await mechanic.get(`/assets/${asset.id}/maintenance`)).data[0].cost).toBeNull();
    expect((await mechanic.get(`/assets/${asset.id}`)).data.lastMaintenance.cost).toBeNull();
    expect((await mechanic.get(`/assets/${asset.id}/costs`)).status).toBe(403);
    expect((await mechanic.get(`/assets/${asset.id}/depreciation`)).status).toBe(403);
  });
});

describe('shifts and fuel (spec 12.2, 12.3)', () => {
  it('adds hours, and charges fuel to the machine at FIFO cost', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner, { motoHours: 1000 });
    const diesel = await stock(f, 'Dizel', 'fuel', 'l', 500, 12_000);
    const { fieldId } = await field(f, '1');

    const res = await owner.post(`/assets/${asset.id}/usage`, {
      date: today,
      fieldId,
      workType: 'Haydash',
      motoHours: 8,
      volumeHa: 12,
      fuelL: 96,
    });
    expect(res.status).toBe(201);
    // 96 l × 12 000
    expect(res.data.fuelCost).toBe(1_152_000);
    expect((await owner.get(`/assets/${asset.id}`)).data.motoHours).toBe(1008);

    await f.run(async () => {
      expect(await stockOnHand(diesel.itemId)).toBe(404);
      const [move] = await tx()
        .select()
        .from(stockMovements)
        .where(and(eq(stockMovements.refType, 'asset_usage'), sql`${stockMovements.refId} = ${res.data.id}`));
      expect(move).toMatchObject({ reason: 'fuel', costCenterId: asset.costCenterId, totalCost: 1_152_000 });
    });
  });

  it('a mechanic can log a shift, but not change the registry', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    const mechanic = await f.as('mechanic');
    expect((await mechanic.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 3 })).status).toBe(201);
    expect((await mechanic.patch(`/assets/${asset.id}`, { name: 'X' })).status).toBe(403);
    expect((await mechanic.post('/assets', { name: 'X', type: 'other' })).status).toBe(403);
    expect((await mechanic.post(`/assets/${asset.id}/maintenance`, { date: today, type: 'repair' })).status).toBe(403);
  });

  it('asks where the fuel came from when no fuel is in stock', async () => {
    const { owner } = await setup();
    const asset = await newAsset(owner);
    const res = await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 4, fuelL: 30 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FUEL_ITEM_REQUIRED');
    expect((await owner.get(`/assets/${asset.id}/usage`)).body.meta.total).toBe(0);
    expect((await owner.get(`/assets/${asset.id}`)).data.motoHours).toBe(0);

    const outside = await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 4, fuelL: 30, skipFuelIssue: true });
    expect(outside.status).toBe(201);
    expect(outside.data.fuelCost).toBe(0);
  });

  it('too little fuel in stock fails the shift, and adds no hours', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    await stock(f, 'Dizel', 'fuel', 'l', 10, 12_000);
    const res = await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 4, fuelL: 30 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await owner.get(`/assets/${asset.id}`)).data.motoHours).toBe(0);
  });

  it('prefers the per-hectare norm and raises an alert above 15% (spec 12.3)', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner, { fuelNormLPerHa: 8, fuelNormLPerHour: 100 });
    await stock(f, 'Dizel', 'fuel', 'l', 500, 12_000);

    // Norm 10 ha × 8 l = 80 l. 96 l is exactly 20% over.
    const res = await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 8, volumeHa: 10, fuelL: 96 });
    expect(res.data.fuelNormL).toBe(80);
    expect(res.data.fuelDeviationPercent).toBeCloseTo(20, 8);

    const open = await f.run(() => tx().select().from(alerts).where(eq(alerts.entityId, asset.id)));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ ruleKey: 'asset_fuel_deviation', severity: 'attention', status: 'open', link: `/assets/${asset.id}` });
    expect(renderAlert(open[0], 'en').title).toMatch(/^Fuel use 20(\.0+)?% over the norm: /);
    expect(renderAlert(open[0], 'en').body).toContain('used 96 l, norm 80 l');

    const events = await f.run(() =>
      tx().select().from(schema.events).where(sql`${schema.events.type} = 'asset.fuel_deviation' and ${schema.events.entityId} = ${asset.id}`),
    );
    expect(events[0].severity).toBe('attention');
  });

  it('stays quiet within the norm, below it, and when there is no norm', async () => {
    const { f, owner } = await setup();
    const normal = await newAsset(owner, { name: 'A', fuelNormLPerHour: 10 });
    const noNorm = await newAsset(owner, { name: 'B' });
    await stock(f, 'Dizel', 'fuel', 'l', 500, 12_000);

    // 8 h × 10 l = 80 l. 92 l is 15%, on the limit, and the limit itself is fine.
    const within = await owner.post(`/assets/${normal.id}/usage`, { date: today, motoHours: 8, fuelL: 92 });
    expect(within.data.fuelDeviationPercent).toBeCloseTo(15, 8);
    await owner.post(`/assets/${normal.id}/usage`, { date: today, motoHours: 8, fuelL: 20 });
    const none = await owner.post(`/assets/${noNorm.id}/usage`, { date: today, motoHours: 8, fuelL: 90 });
    expect(none.data.fuelNormL).toBeNull();
    expect(none.data.fuelDeviationPercent).toBeNull();

    expect(await f.run(() => tx().select().from(alerts))).toEqual([]);
  });

  it('the journal shows the deviation for each shift', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner, { fuelNormLPerHour: 10 });
    await stock(f, 'Dizel', 'fuel', 'l', 500, 12_000);
    await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 10, fuelL: 110 });
    const list = await owner.get(`/assets/${asset.id}/usage`);
    expect(list.data[0].fuelNormL).toBe(100);
    expect(list.data[0].fuelDeviationPercent).toBeCloseTo(10, 8);
  });

  it('an edit re-posts hours and fuel; a delete takes them back', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner, { motoHours: 100 });
    const diesel = await stock(f, 'Dizel', 'fuel', 'l', 500, 12_000);
    const log = await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 8, fuelL: 80 });

    const edited = await owner.patch(`/assets/${asset.id}/usage/${log.data.id}`, { motoHours: 6, fuelL: 50 });
    expect(edited.status).toBe(200);
    expect(edited.data.id).toBe(log.data.id);
    expect(edited.data.fuelCost).toBe(600_000);
    expect((await owner.get(`/assets/${asset.id}`)).data.motoHours).toBe(106);
    expect(await f.run(() => stockOnHand(diesel.itemId))).toBe(450);

    expect((await owner.delete(`/assets/${asset.id}/usage/${log.data.id}`)).status).toBe(200);
    expect((await owner.get(`/assets/${asset.id}`)).data.motoHours).toBe(100);
    expect(await f.run(() => stockOnHand(diesel.itemId))).toBe(500);
  });

  it('an edit keeps fuel that did not come from stock out of the warehouse', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    const diesel = await stock(f, 'Dizel', 'fuel', 'l', 500, 12_000);
    const log = await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 4, fuelL: 30, skipFuelIssue: true });
    await owner.patch(`/assets/${asset.id}/usage/${log.data.id}`, { motoHours: 5 });
    expect(await f.run(() => stockOnHand(diesel.itemId))).toBe(500);
    expect((await owner.get(`/assets/${asset.id}/usage`)).data[0].fuelItemId).toBeNull();
  });

  it('a written-off machine takes no more shifts', async () => {
    const { owner } = await setup();
    const asset = await newAsset(owner, { status: 'written_off' });
    const res = await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ASSET_WRITTEN_OFF');
  });

  it('rejects an odometer reading typed as shift hours', async () => {
    const { owner } = await setup();
    const asset = await newAsset(owner);
    const res = await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 1200 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('maintenance (spec 12.4)', () => {
  it('records a repair with spare parts charged to the machine', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    const filter = await stock(f, 'Moy filtri', 'spare_part', 'pcs', 10, 85_000);

    const res = await owner.post(`/assets/${asset.id}/maintenance`, {
      date: today,
      type: 'planned',
      description: 'TO-2',
      cost: 400_000,
      nextDueMotoHours: 500,
      parts: [{ ...filter, qty: 2 }],
    });
    expect(res.status).toBe(201);
    await f.run(async () => {
      expect(await stockOnHand(filter.itemId)).toBe(8);
      const [move] = await tx()
        .select()
        .from(stockMovements)
        .where(and(eq(stockMovements.refType, 'maintenance'), sql`${stockMovements.refId} = ${res.data.id}`));
      expect(move).toMatchObject({ costCenterId: asset.costCenterId, reason: 'maintenance', totalCost: 170_000 });
    });
  });

  it('records the payment in finance when given, as a repair on the machine', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    const { accountId } = await moneyRefs(f);

    const res = await owner.post(`/assets/${asset.id}/maintenance`, {
      date: today,
      type: 'repair',
      cost: 750_000,
      payment: { paymentMethod: 'cash', accountId },
    });
    expect(res.status).toBe(201);
    expect(res.data.transactionId).toBeTruthy();

    const [row] = await f.run(() => tx().select().from(transactions).where(eq(transactions.id, res.data.transactionId)));
    expect(row).toMatchObject({
      type: 'expense',
      amountBase: 750_000,
      costCenterId: asset.costCenterId,
      costTreatment: 'expense',
      sourceType: 'maintenance',
      sourceId: res.data.id,
      status: 'approved',
    });
  });

  it('a large repair waits for approval like any other expense', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    const { accountId } = await moneyRefs(f);
    const res = await owner.post(`/assets/${asset.id}/maintenance`, {
      date: today,
      type: 'repair',
      cost: 8_000_000,
      payment: { paymentMethod: 'cash', accountId },
    });
    const [row] = await f.run(() => tx().select().from(transactions).where(eq(transactions.id, res.data.transactionId)));
    expect(row.status).toBe('pending');
  });

  it('a rejected payment leaves no repair and no stock movement', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    const filter = await stock(f, 'Filtr', 'spare_part', 'pcs', 10, 85_000);
    const res = await owner.post(`/assets/${asset.id}/maintenance`, {
      date: today,
      type: 'repair',
      cost: 750_000,
      parts: [{ ...filter, qty: 1 }],
      payment: { paymentMethod: 'cash' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ACCOUNT_REQUIRED');
    expect((await owner.get(`/assets/${asset.id}/maintenance`)).body.meta.total).toBe(0);
    expect(await f.run(() => stockOnHand(filter.itemId))).toBe(10);
  });

  it('a payment needs an amount, and permission to post money', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    const { accountId } = await moneyRefs(f);
    const empty = await owner.post(`/assets/${asset.id}/maintenance`, {
      date: today,
      type: 'repair',
      payment: { paymentMethod: 'cash', accountId },
    });
    expect(empty.body.error.code).toBe('INVALID_AMOUNT');

    // A custom role that may log repairs but holds no finance permission.
    const director = await f.as('director');
    await f.run(() =>
      tx()
        .update(schema.roles)
        .set({ permissions: sql`${schema.roles.permissions} - 'finance.create'` })
        .where(and(eq(schema.roles.tenantId, f.tenantId), eq(schema.roles.key, 'director'))),
    );
    const denied = await director.post(`/assets/${asset.id}/maintenance`, {
      date: today,
      type: 'repair',
      cost: 100,
      payment: { paymentMethod: 'cash', accountId },
    });
    expect(denied.status).toBe(403);
  });

  it('a paid repair keeps its amount, and cannot be deleted; an unpaid one can', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    const { accountId } = await moneyRefs(f);
    const filter = await stock(f, 'Filtr', 'spare_part', 'pcs', 10, 85_000);

    const paid = await owner.post(`/assets/${asset.id}/maintenance`, {
      date: today,
      type: 'repair',
      cost: 500_000,
      payment: { paymentMethod: 'cash', accountId },
    });
    const change = await owner.patch(`/assets/${asset.id}/maintenance/${paid.data.id}`, { cost: 1 });
    expect(change.body.error.code).toBe('MAINTENANCE_HAS_PAYMENT');
    expect((await owner.delete(`/assets/${asset.id}/maintenance/${paid.data.id}`)).body.error.code).toBe('MAINTENANCE_HAS_PAYMENT');
    expect((await owner.patch(`/assets/${asset.id}/maintenance/${paid.data.id}`, { description: 'Motor' })).status).toBe(200);

    const unpaid = await owner.post(`/assets/${asset.id}/maintenance`, { date: today, type: 'repair', parts: [{ ...filter, qty: 3 }] });
    expect((await owner.delete(`/assets/${asset.id}/maintenance/${unpaid.data.id}`)).status).toBe(200);
    expect(await f.run(() => stockOnHand(filter.itemId))).toBe(10);
  });

  it('reports service due by date and by motor-hours, from the latest record only', async () => {
    const { f, owner } = await setup();
    const byDate = await newAsset(owner, { name: 'Sana' });
    await owner.post(`/assets/${byDate.id}/maintenance`, { date: addDays(today, -30), type: 'planned', nextDueDate: addDays(today, -1) });

    const byHours = await newAsset(owner, { name: 'Soat', motoHours: 505 });
    await owner.post(`/assets/${byHours.id}/maintenance`, { date: addDays(today, -30), type: 'planned', nextDueMotoHours: 500 });

    const superseded = await newAsset(owner, { name: 'Yangilangan' });
    await owner.post(`/assets/${superseded.id}/maintenance`, { date: addDays(today, -60), type: 'planned', nextDueDate: addDays(today, -20) });
    await owner.post(`/assets/${superseded.id}/maintenance`, { date: addDays(today, -2), type: 'planned', nextDueDate: addDays(today, 200) });

    const soon = await newAsset(owner, { name: 'Yaqinda' });
    await owner.post(`/assets/${soon.id}/maintenance`, { date: today, type: 'planned', nextDueDate: addDays(today, 7) });

    const due = await f.run(() => dueMaintenance(14));
    const byName = Object.fromEntries(due.map((d) => [d.name, d.overdue]));
    expect(byName).toEqual({ Sana: true, Soat: true, Yaqinda: false });

    const card = await owner.get(`/assets/${byHours.id}`);
    expect(card.data.maintenanceDue).toMatchObject({ nextDueMotoHours: 500, overdue: true });

    const route = await owner.get('/assets/maintenance/due', { withinDays: 0 });
    expect(route.data.map((d: any) => d.name).sort()).toEqual(['Sana', 'Soat']);
  });
});

describe('depreciation (spec 12.5)', () => {
  it('posts straight-line depreciation as a non-cash cost on the machine', async () => {
    const { f, owner } = await setup();
    const { accountId } = await moneyRefs(f);
    // (120 000 000 − 12 000 000) / 60 = 1 800 000 a month
    const asset = await newAsset(owner, {
      purchasePrice: 120_000_000,
      salvageValue: 12_000_000,
      purchaseDate: '2025-01-15',
      usefulLifeMonths: 60,
    });

    const result = await f.run(() => runDepreciation(lastMonth));
    expect(result).toEqual({ month: lastMonth, posted: 1, total: 1_800_000 });

    const [row] = await f.run(() => tx().select().from(transactions).where(eq(transactions.sourceType, 'depreciation')));
    expect(row).toMatchObject({
      type: 'expense',
      status: 'approved',
      paymentMethod: 'non_cash',
      accountId: null,
      amountBase: 1_800_000,
      costCenterId: asset.costCenterId,
      costTreatment: 'expense',
      date: monthRange(lastMonth).to,
    });
    const [category] = await f.run(() => tx().select().from(financeCategories).where(eq(financeCategories.id, row.categoryId!)));
    expect(category.key).toBe('depreciation');

    // No money moved.
    await f.run(async () => {
      const moved = await tx().select().from(transactions).where(eq(transactions.accountId, accountId));
      expect(moved).toEqual([]);
    });

    const card = await owner.get(`/assets/${asset.id}`);
    expect(card.data.accumulatedDepreciation).toBe(1_800_000);
    expect(card.data.bookValue).toBe(118_200_000);
    const entries = await owner.get(`/assets/${asset.id}/depreciation`);
    expect(entries.data).toHaveLength(1);
    expect(entries.data[0].transactionId).toBe(row.id);
  });

  it('repeating a month posts nothing new', async () => {
    const { f, owner } = await setup();
    await newAsset(owner, { purchasePrice: 60_000_000, purchaseDate: '2025-01-15', usefulLifeMonths: 60 });
    await f.run(() => runDepreciation(lastMonth));
    const again = await f.run(() => runDepreciation(lastMonth));
    expect(again).toEqual({ month: lastMonth, posted: 0, total: 0 });
    const rows = await f.run(() => tx().select().from(transactions).where(eq(transactions.sourceType, 'depreciation')));
    expect(rows).toHaveLength(1);
  });

  it('starts the month after purchase and skips machines it cannot value', async () => {
    const { f, owner } = await setup();
    await newAsset(owner, { name: 'Shu oyda', purchasePrice: 60_000_000, purchaseDate: `${lastMonth}-05`, usefulLifeMonths: 60 });
    await newAsset(owner, { name: 'Narxsiz', purchaseDate: '2024-01-01', usefulLifeMonths: 60 });
    await newAsset(owner, { name: 'Sanasiz', purchasePrice: 60_000_000, usefulLifeMonths: 60 });
    await newAsset(owner, { name: 'Muddatsiz', purchasePrice: 60_000_000, purchaseDate: '2024-01-01' });
    await newAsset(owner, { name: 'Ijara', purchasePrice: 60_000_000, purchaseDate: '2024-01-01', usefulLifeMonths: 60, rented: true });
    await newAsset(owner, { name: 'Chiqqan', purchasePrice: 60_000_000, purchaseDate: '2024-01-01', usefulLifeMonths: 60, status: 'written_off' });
    expect(await f.run(() => runDepreciation(lastMonth))).toEqual({ month: lastMonth, posted: 0, total: 0 });
  });

  it('stops at the end of the useful life, even for a machine older than the platform', async () => {
    const { f, owner } = await setup();
    await newAsset(owner, { purchasePrice: 60_000_000, purchaseDate: '2015-01-10', usefulLifeMonths: 60 });
    expect((await f.run(() => runDepreciation(lastMonth))).posted).toBe(0);
  });

  it('never goes below the salvage value', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner, {
      purchasePrice: 10_000_000,
      salvageValue: 1_000_000,
      purchaseDate: '2025-01-15',
      usefulLifeMonths: 60,
    });
    await f.run(async () => {
      await tx().insert(depreciationEntries).values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        assetId: asset.id,
        month: twoMonthsAgo,
        amount: 8_900_000,
      });
    });
    // Monthly would be 150 000, only 100 000 is left above salvage.
    expect(await f.run(() => runDepreciation(lastMonth))).toMatchObject({ total: 100_000 });
    const card = await owner.get(`/assets/${asset.id}`);
    expect(card.data.bookValue).toBe(1_000_000);
  });

  it('units of production follows the hours worked that month', async () => {
    const { f, owner } = await setup();
    // (100 000 000 − 0) / 10 000 h = 10 000 per hour
    const asset = await newAsset(owner, {
      purchasePrice: 100_000_000,
      purchaseDate: '2025-01-15',
      depreciationMethod: 'units',
      totalUnits: 10_000,
    });
    const { from } = monthRange(lastMonth);
    await owner.post(`/assets/${asset.id}/usage`, { date: from, motoHours: 8 });
    await owner.post(`/assets/${asset.id}/usage`, { date: addDays(from, 1), motoHours: 7 });
    await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 5 });
    expect(await f.run(() => runDepreciation(lastMonth))).toMatchObject({ posted: 1, total: 150_000 });
    expect((await f.run(() => runDepreciation(twoMonthsAgo))).posted).toBe(0);
  });

  it('two months posted at the same moment stop at what is left to depreciate', async () => {
    const { f, owner } = await setup();
    // 1 000 000 / 10 h = 100 000 per hour, so 7 h in each month would come to 1 400 000.
    const asset = await newAsset(owner, {
      purchasePrice: 1_000_000,
      purchaseDate: '2025-01-15',
      depreciationMethod: 'units',
      totalUnits: 10,
    });
    await owner.post(`/assets/${asset.id}/usage`, { date: monthRange(twoMonthsAgo).from, motoHours: 7 });
    await owner.post(`/assets/${asset.id}/usage`, { date: monthRange(lastMonth).from, motoHours: 7 });

    let second: Promise<unknown> = Promise.resolve();
    await f.run(async () => {
      await runDepreciation(twoMonthsAgo);
      second = f.run(() => runDepreciation(lastMonth));
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    await second;

    const rows = await f.run(() => tx().select().from(depreciationEntries).where(eq(depreciationEntries.assetId, asset.id)));
    expect(rows.map((r) => [r.month, r.amount]).sort()).toEqual([[twoMonthsAgo, 700_000], [lastMonth, 300_000]]);
  });

  it('refuses a month that has not ended', async () => {
    const { f } = await setup();
    await expect(f.run(() => runDepreciation(monthOf(today)))).rejects.toMatchObject({ code: 'MONTH_NOT_CLOSED' });
  });

  it('the route needs finance approval rights', async () => {
    const { f, owner } = await setup();
    await newAsset(owner, { purchasePrice: 60_000_000, purchaseDate: '2025-01-15', usefulLifeMonths: 60 });
    const accountant = await f.as('accountant');
    expect((await accountant.post('/assets/depreciation/run', { month: lastMonth })).data.posted).toBe(1);
    const mechanic = await f.as('mechanic');
    expect((await mechanic.post('/assets/depreciation/run', { month: lastMonth })).status).toBe(403);
  });

  it('a new farm starts from last month, an existing one catches up on gaps', async () => {
    const { f, owner } = await setup();
    expect(await f.run(() => monthsToRun())).toEqual([lastMonth]);

    const asset = await newAsset(owner, { purchasePrice: 60_000_000, purchaseDate: '2024-01-15', usefulLifeMonths: 120 });
    const threeMonthsAgo = previousMonth(twoMonthsAgo);
    await f.run(() =>
      tx().insert(depreciationEntries).values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        assetId: asset.id,
        month: threeMonthsAgo,
        amount: 500_000,
      }),
    );
    expect(await f.run(() => monthsToRun())).toEqual([twoMonthsAgo, lastMonth]);
  });

  it('the monthly job posts last month', async () => {
    const { f, owner } = await setup();
    await newAsset(owner, { purchasePrice: 60_000_000, purchaseDate: '2025-01-15', usefulLifeMonths: 60 });
    const job = jobs.find((j) => j.name === 'assets.monthly-depreciation')!;
    expect(job.cron).toBe('30 2 1 * *');
    await f.run(() => job.run());
    await f.run(() => job.run());
    const rows = await f.run(() => tx().select().from(depreciationEntries).where(eq(depreciationEntries.farmId, f.farmId)));
    expect(rows.map((r) => [r.month, r.amount])).toEqual([[lastMonth, 1_000_000]]);
  });
});

describe('cost per hour and hectare (spec 12.7)', () => {
  it('adds fuel, labour, repairs and depreciation, against control numbers', async () => {
    const { f, owner } = await setup();
    const { accountId } = await moneyRefs(f);
    const asset = await newAsset(owner);
    const diesel = await stock(f, 'Dizel', 'fuel', 'l', 500, 10_000);
    const filter = await stock(f, 'Filtr', 'spare_part', 'pcs', 10, 100_000);

    // Fuel: 100 l × 10 000 = 1 000 000 over 100 h and 50 ha.
    await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 24, volumeHa: 25, fuelL: 50, fuelItemId: diesel.itemId, fuelWarehouseId: diesel.warehouseId });
    await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 24, volumeHa: 25, fuelL: 50 });
    for (let i = 0; i < 2; i++) await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 24 });
    await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 4 });

    // Repairs 1 500 000: paid 900 000, unpaid 400 000 on the card, parts 200 000.
    await owner.post(`/assets/${asset.id}/maintenance`, { date: today, type: 'repair', cost: 900_000, payment: { paymentMethod: 'cash', accountId } });
    await owner.post(`/assets/${asset.id}/maintenance`, { date: today, type: 'planned', cost: 400_000, parts: [{ ...filter, qty: 2 }] });

    await f.run(async () => {
      // Labour on the machine: 1 000 000.
      const [salary] = await tx()
        .select()
        .from(financeCategories)
        .where(and(eq(financeCategories.tenantId, f.tenantId), eq(financeCategories.key, 'salary')));
      await postTransaction({
        date: today,
        type: 'expense',
        amount: 1_000_000,
        categoryId: salary.id,
        paymentMethod: 'cash',
        accountId,
        costCenterId: asset.costCenterId,
      });
      // Depreciation: 500 000.
      await tx().insert(depreciationEntries).values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        assetId: asset.id,
        month: monthOf(today),
        amount: 500_000,
      });
    });

    const res = await owner.get(`/assets/${asset.id}/costs`);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      fuel: 1_000_000,
      labor: 1_000_000,
      repairs: 1_500_000,
      depreciation: 500_000,
      total: 4_000_000,
      hours: 100,
      hectares: 50,
      fuelL: 100,
      costPerHour: 40_000,
      costPerHectare: 80_000,
      fuelPerHectare: 2,
    });
  });

  it('an unapproved repair is not a cost yet', async () => {
    const { f, owner } = await setup();
    const { accountId } = await moneyRefs(f);
    const asset = await newAsset(owner);
    await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 10 });
    await owner.post(`/assets/${asset.id}/maintenance`, { date: today, type: 'repair', cost: 9_000_000, payment: { paymentMethod: 'cash', accountId } });
    expect((await owner.get(`/assets/${asset.id}/costs`)).data.repairs).toBe(0);
  });

  it('respects the period', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    await stock(f, 'Dizel', 'fuel', 'l', 500, 10_000);
    await owner.post(`/assets/${asset.id}/usage`, { date: addDays(today, -40), motoHours: 5, fuelL: 10 });
    await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 7, fuelL: 20 });
    const res = await owner.get(`/assets/${asset.id}/costs`, { from: addDays(today, -10), to: today });
    expect(res.data).toMatchObject({ hours: 7, fuelL: 20, fuel: 200_000 });
  });

  it('with no work done, unit costs are null, not zero', async () => {
    const { owner } = await setup();
    const asset = await newAsset(owner);
    const res = await owner.get(`/assets/${asset.id}/costs`);
    expect(res.data).toMatchObject({ total: 0, costPerHour: null, costPerHectare: null, fuelPerHectare: null });
  });

  it('shares a machine among fields by hours, leaving non-field work on the machine', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    await stock(f, 'Dizel', 'fuel', 'l', 500, 10_000);
    const one = await field(f, '1');
    const two = await field(f, '2');
    // 100 l = 1 000 000 total. 6 h on field 1, 3 h on field 2, 1 h with no field.
    await owner.post(`/assets/${asset.id}/usage`, { date: today, fieldId: one.fieldId, motoHours: 6, fuelL: 60 });
    await owner.post(`/assets/${asset.id}/usage`, { date: today, fieldId: two.fieldId, motoHours: 3, fuelL: 30 });
    await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 1, fuelL: 10 });

    const shares = await f.run(() => machineryCostByField());
    const byField = Object.fromEntries(shares.map((s) => [s.fieldId, s.amount]));
    expect(byField).toEqual({ [one.fieldId]: 600_000, [two.fieldId]: 300_000 });
  });
});

describe('rented machinery (spec 12.6)', () => {
  async function rented(f: Fixture, owner: Awaited<ReturnType<Fixture['as']>>, over: object = {}) {
    const { counterpartyId } = await moneyRefs(f);
    const asset = await newAsset(owner, {
      name: 'Kombayn (ijara)',
      type: 'combine',
      rented: true,
      rentalCounterpartyId: counterpartyId,
      rentalPrice: 450_000,
      rentalUnit: 'ha',
      ...over,
    });
    return { asset, counterpartyId };
  }

  it('bills unbilled shifts as a debt, charged to the fields worked, once', async () => {
    const { f, owner } = await setup();
    const { asset, counterpartyId } = await rented(f, owner);
    const one = await field(f, '1');
    const two = await field(f, '2');
    await owner.post(`/assets/${asset.id}/usage`, { date: addDays(today, -2), fieldId: one.fieldId, volumeHa: 2 });
    await owner.post(`/assets/${asset.id}/usage`, { date: addDays(today, -1), fieldId: one.fieldId, volumeHa: 1 });
    await owner.post(`/assets/${asset.id}/usage`, { date: today, fieldId: two.fieldId, volumeHa: 4 });

    const res = await owner.post(`/assets/${asset.id}/rental-act`, { from: addDays(today, -7), to: today });
    expect(res.status).toBe(201);
    // 7 ha × 450 000
    expect(res.data.total).toBe(3_150_000);
    expect(res.data.lines.map((l: any) => [l.fieldNumber, l.quantity, l.amount]).sort()).toEqual([
      ['1', 3, 1_350_000],
      ['2', 4, 1_800_000],
    ]);

    const posted = await f.run(() => tx().select().from(transactions).where(eq(transactions.sourceType, 'rental_act')));
    expect(posted).toHaveLength(2);
    const onFieldOne = posted.find((p) => p.costCenterId === one.costCenterId)!;
    expect(onFieldOne).toMatchObject({ paymentMethod: 'debt', counterpartyId, amountBase: 1_350_000, type: 'expense' });

    const again = await owner.post(`/assets/${asset.id}/rental-act`, { from: addDays(today, -7), to: today });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NOTHING_TO_BILL');

    const log = (await owner.get(`/assets/${asset.id}/usage`)).data[0];
    const locked = await owner.delete(`/assets/${asset.id}/usage/${log.id}`);
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('USAGE_ALREADY_BILLED');
  });

  it('bills by the hour', async () => {
    const { f, owner } = await setup();
    const { asset } = await rented(f, owner, { rentalPrice: 200_000, rentalUnit: 'hour' });
    await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 5 });
    const res = await owner.post(`/assets/${asset.id}/rental-act`, { from: today, to: today });
    expect(res.data.total).toBe(1_000_000);
  });

  it('a large act waits for approval', async () => {
    const { f, owner } = await setup();
    const { asset } = await rented(f, owner);
    const { fieldId } = await field(f, '1');
    await owner.post(`/assets/${asset.id}/usage`, { date: today, fieldId, volumeHa: 20 });
    const res = await owner.post(`/assets/${asset.id}/rental-act`, { from: today, to: today });
    expect(res.data.lines[0].status).toBe('pending');
  });

  it.each([
    [{ rented: false }, 'ASSET_NOT_RENTED'],
    [{ rentalPrice: null }, 'RENTAL_TERMS_REQUIRED'],
  ])('refuses without the terms: %j', async (over, code) => {
    const { f, owner } = await setup();
    const { asset } = await rented(f, owner, over);
    const res = await owner.post(`/assets/${asset.id}/rental-act`, { from: today, to: today });
    expect(res.body.error.code).toBe(code);
  });

  it('refuses a shift with nothing to bill, and an inverted period', async () => {
    const { f, owner } = await setup();
    const { asset } = await rented(f, owner);
    await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 5 });
    const res = await owner.post(`/assets/${asset.id}/rental-act`, { from: today, to: today });
    expect(res.body.error.code).toBe('RENTAL_QUANTITY_MISSING');
    const inverted = await owner.post(`/assets/${asset.id}/rental-act`, { from: today, to: addDays(today, -1) });
    expect(inverted.body.error.code).toBe('INVALID_PERIOD');
  });

  it('a mechanic cannot issue an act', async () => {
    const { f, owner } = await setup();
    const { asset } = await rented(f, owner);
    const mechanic = await f.as('mechanic');
    expect((await mechanic.post(`/assets/${asset.id}/rental-act`, { from: today, to: today })).status).toBe(403);
  });
});

describe('a rental act as one document', () => {
  /** 500 000 a hectare on two fields, so each row alone can stay under the 5 000 000 threshold. */
  async function hired(f: Fixture, owner: Awaited<ReturnType<Fixture['as']>>, hectares: [number, number]) {
    const { counterpartyId } = await moneyRefs(f);
    const asset = await newAsset(owner, {
      name: 'Kombayn (ijara)', type: 'combine', rented: true, rentalCounterpartyId: counterpartyId, rentalPrice: 500_000, rentalUnit: 'ha',
    });
    const one = await field(f, '1');
    const two = await field(f, '2');
    await owner.post(`/assets/${asset.id}/usage`, { date: today, fieldId: one.fieldId, volumeHa: hectares[0] });
    await owner.post(`/assets/${asset.id}/usage`, { date: today, fieldId: two.fieldId, volumeHa: hectares[1] });
    return asset;
  }
  const bill = (owner: Awaited<ReturnType<Fixture['as']>>, assetId: string) => owner.post(`/assets/${assetId}/rental-act`, { from: today, to: today });
  const statuses = (res: { data: { lines: { status: string }[] } }) => res.data.lines.map((line) => line.status);

  it('waits for a second person on its total, though no field reaches the threshold', async () => {
    const { f, owner } = await setup();
    // 6 ha x 500 000 = 3 000 000 twice: 6 000 000 together.
    const asset = await hired(f, owner, [6, 6]);
    const res = await bill(owner, asset.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.total).toBe(6_000_000);
    expect(statuses(res)).toEqual(['pending', 'pending']);
  });

  it('counts exactly at the threshold', async () => {
    const { f, owner } = await setup();
    // 5 ha + 5 ha = 10 ha x 500 000 = 5 000 000.
    const asset = await hired(f, owner, [5, 5]);
    expect(statuses(await bill(owner, asset.id))).toEqual(['pending', 'pending']);
  });

  it('just under it goes straight through', async () => {
    const { f, owner } = await setup();
    // 2 500 000 + 4.9999 ha x 500 000 = 2 499 950: 4 999 950 together.
    const asset = await hired(f, owner, [5, 4.9999]);
    const res = await bill(owner, asset.id);
    expect(res.data.total).toBe(4_999_950);
    expect(statuses(res)).toEqual(['approved', 'approved']);
  });

  it('each row still carries only its own amount', async () => {
    const { f, owner } = await setup();
    const asset = await hired(f, owner, [6, 6]);
    await bill(owner, asset.id);
    const rows = await f.run(() => tx().select().from(transactions).where(eq(transactions.sourceType, 'rental_act')));
    expect(rows.map((row) => row.amountBase)).toEqual([3_000_000, 3_000_000]);
  });

  it('a refused field can be billed again on its own, and the other field stays billed', async () => {
    const { f, owner } = await setup();
    const director = await f.as('director');
    const asset = await hired(f, owner, [6, 6]);
    const { data: act } = await bill(owner, asset.id);
    const [refused, kept] = act.lines;
    expect((await director.post(`/finance/transactions/${refused.transactionId}/reject`, { reason: 'xato' })).status).toBe(200);

    const again = await bill(owner, asset.id);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.data.total).toBe(3_000_000);
    expect(again.data.lines[0].fieldId).toBe(refused.fieldId);
    expect(again.data.lines[0].fieldId).not.toBe(kept.fieldId);
  });
});

describe('references on a rented machine', () => {
  const secondFarm = (f: Fixture) =>
    withPlatform(async (trx) => {
      const [row] = await trx.insert(schema.farms).values({ tenantId: f.tenantId, name: 'Ikkinchi ferma' }).returning();
      return row.id;
    });

  it('a contractor of another farm is refused, on a new machine and on an edit', async () => {
    const { f, owner } = await setup();
    const farmId = await secondFarm(f);
    const theirs = await f.run(async () => {
      const [row] = await tx().insert(counterparties).values({ tenantId: f.tenantId, farmId, name: 'Boshqa', type: 'service' }).returning();
      return row.id;
    });
    const created = await owner.post('/assets', { name: 'Kombayn', type: 'combine', rented: true, rentalCounterpartyId: theirs });
    expect(created.status).toBe(404);
    const asset = await newAsset(owner);
    expect((await owner.patch(`/assets/${asset.id}`, { rentalCounterpartyId: theirs })).status).toBe(404);
  });

  it('a contractor or contract of another tenant is refused', async () => {
    const { owner } = await setup();
    const other = await createFixture();
    const { counterpartyId } = await moneyRefs(other);
    const contractId = await other.run(async () => {
      const [row] = await tx()
        .insert(schema.contracts)
        .values({ tenantId: other.tenantId, farmId: other.farmId, number: 'K-1', title: 'Ijara', counterpartyId })
        .returning();
      return row.id;
    });
    expect((await owner.post('/assets', { name: 'Kombayn', type: 'combine', rentalCounterpartyId: counterpartyId })).status).toBe(404);
    expect((await owner.post('/assets', { name: 'Kombayn', type: 'combine', rentalContractId: contractId })).status).toBe(404);
  });

  it('a contractor of this farm is taken', async () => {
    const { f, owner } = await setup();
    const { counterpartyId } = await moneyRefs(f);
    const asset = await newAsset(owner, { name: 'Kombayn', type: 'combine', rented: true, rentalCounterpartyId: counterpartyId });
    expect(asset.rentalCounterpartyId).toBe(counterpartyId);
  });

  it('a repair cannot name a counterparty of another farm', async () => {
    const { f, owner } = await setup();
    const farmId = await secondFarm(f);
    const { accountId } = await moneyRefs(f);
    const theirs = await f.run(async () => {
      const [row] = await tx().insert(counterparties).values({ tenantId: f.tenantId, farmId, name: 'Boshqa', type: 'service' }).returning();
      return row.id;
    });
    const asset = await newAsset(owner);
    const res = await owner.post(`/assets/${asset.id}/maintenance`, {
      date: today, type: 'repair', cost: 900_000, payment: { paymentMethod: 'cash', accountId, counterpartyId: theirs },
    });
    expect(res.status).toBe(404);
    expect((await f.run(() => tx().select().from(transactions))).length).toBe(0);
  });

  it('a shift cannot name a field of another farm, so an act cannot charge it', async () => {
    const { f, owner } = await setup();
    const farmId = await secondFarm(f);
    const theirs = await f.run(async () => {
      const [row] = await tx().insert(fields).values({ tenantId: f.tenantId, farmId, number: '9', areaHa: 5 }).returning();
      return row.id;
    });
    const asset = await newAsset(owner);
    expect((await owner.post(`/assets/${asset.id}/usage`, { date: today, fieldId: theirs, motoHours: 1 })).status).toBe(404);
  });
});

describe('summary', () => {
  it('counts machines by status, without written-off ones in the total', async () => {
    const { f, owner } = await setup();
    await newAsset(owner, { name: 'A' });
    await newAsset(owner, { name: 'B', status: 'repair' });
    await newAsset(owner, { name: 'C', status: 'written_off' });
    const summary = await f.run(() => assetStatus());
    expect(summary).toEqual({ total: 2, byStatus: { working: 1, repair: 1, written_off: 1 }, maintenanceDue: 0 });
  });

  it('adds up fuel over a period', async () => {
    const { f, owner } = await setup();
    const asset = await newAsset(owner);
    await stock(f, 'Dizel', 'fuel', 'l', 500, 10_000);
    await owner.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 5, fuelL: 40 });
    await owner.post(`/assets/${asset.id}/usage`, { date: addDays(today, -6), motoHours: 5, fuelL: 30 });
    await owner.post(`/assets/${asset.id}/usage`, { date: addDays(today, -20), motoHours: 5, fuelL: 100 });
    expect(await f.run(() => fuelUsage(7))).toEqual({ liters: 70 });
  });
});

describe('tenant isolation', () => {
  it("another tenant cannot see or touch this farm's machines", async () => {
    const { owner } = await setup();
    const asset = await newAsset(owner);
    const other = await createFixture();
    const stranger = await other.as('owner');
    expect((await stranger.get('/assets')).body.meta.total).toBe(0);
    expect((await stranger.get('/assets/lookup')).data).toEqual([]);
    expect((await stranger.get(`/assets/${asset.id}`)).status).toBe(404);
    expect((await stranger.patch(`/assets/${asset.id}`, { name: 'Hack' })).status).toBe(404);
    expect((await stranger.post(`/assets/${asset.id}/usage`, { date: today, motoHours: 1 })).status).toBe(404);
    expect((await stranger.get(`/assets/${asset.id}/costs`)).status).toBe(404);
  });
});
