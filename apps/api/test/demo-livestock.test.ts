import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays, todayIso } from '@yap/shared';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { ensureCostCenter } from '../src/core/costCenters';
import { receiveStock } from '../src/core/inventory';
import { createPregnancy } from '../src/modules/livestock/breeding.service';
import { createFixture, type Fixture } from './helpers';

const { animals, breeds, herds, items, species, warehouses } = schema;

const T = todayIso();
const daysAgo = (n: number) => addDays(T, -n);
let counter = 0;

async function makeHerd(f: Fixture, name: string) {
  return f.run(async () => {
    const [herd] = await tx().insert(herds).values({ tenantId: f.tenantId, farmId: f.farmId, name }).returning();
    const costCenterId = await ensureCostCenter('herd', herd.id, name);
    await tx().update(herds).set({ costCenterId }).where(eq(herds.id, herd.id));
    return herd;
  });
}

async function makeEwe(f: Fixture, o: { herdId?: string; purchaseDate?: string } = {}) {
  return f.run(async () => {
    const [sheep] = await tx().select().from(species).where(and(eq(species.tenantId, f.tenantId), eq(species.key, 'sheep')));
    const [breed] = await tx().select().from(breeds).where(and(eq(breeds.tenantId, f.tenantId), eq(breeds.key, 'hisori')));
    const [row] = await tx()
      .insert(animals)
      .values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        tag: `D${++counter}`,
        speciesId: sheep.id,
        breedId: breed.id,
        sex: 'female',
        category: 'ewe',
        origin: 'purchased',
        herdId: o.herdId ?? null,
        status: 'active',
        purchaseDate: o.purchaseDate ?? daysAgo(200),
      })
      .returning();
    return row;
  });
}

async function makeDrug(f: Fixture, name: string, category: 'vet_drug' | 'vaccine') {
  return f.run(async () => {
    const [warehouse] = await tx()
      .insert(warehouses)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name: `Vet ${++counter}`, type: 'vet' })
      .returning();
    const [item] = await tx()
      .insert(items)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name, category, unit: 'dose', withdrawalDays: 14, defaultWarehouseId: warehouse.id })
      .returning();
    await receiveStock({ itemId: item.id, warehouseId: warehouse.id, qty: 100, unitCost: 1000, date: daysAgo(30), source: 'purchase' });
    return { itemId: item.id, warehouseId: warehouse.id };
  });
}

describe('a plan can schedule a dewormer or a test, and the record says which (audit: "Emlash · Albendazol")', () => {
  it('records deworming and a blood test with their own type, and both answer their plans', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const herd = await makeHerd(f, 'Sovliqlar');
    const ewe = await makeEwe(f, { herdId: herd.id });
    await makeEwe(f, { herdId: herd.id });
    const dewormer = await makeDrug(f, 'Fenbendazol', 'vet_drug');

    const deworming = await vet.post('/livestock/health/vaccination-plans', { name: 'Gijjaga qarshi ishlov', itemId: dewormer.itemId, intervalDays: 120 });
    const test = await vet.post('/livestock/health/vaccination-plans', { name: 'Brutsellyoz tekshiruvi', intervalDays: 365 });
    expect((await vet.get('/livestock/health/vaccinations/due')).data.rows).toHaveLength(2);

    const dosed = await vet.post('/livestock/health/vaccinations/herd', { herdId: herd.id, planId: deworming.data.id, type: 'deworming', date: T, dosePerHead: 1 });
    expect(dosed.status, JSON.stringify(dosed.body)).toBe(201);
    expect(dosed.data).toMatchObject({ type: 'deworming', headCount: 2, qtyUsed: 2, itemId: dewormer.itemId, planName: 'Gijjaga qarshi ishlov' });

    const tested = await vet.post('/livestock/health/vaccinations/herd', { herdId: herd.id, planId: test.data.id, type: 'examination', date: T });
    expect(tested.status, JSON.stringify(tested.body)).toBe(201);
    expect(tested.data).toMatchObject({ type: 'examination', itemId: null, nextDueDate: addDays(T, 365) });

    // A test counts towards its plan too: nothing is due any more.
    expect((await vet.get('/livestock/health/vaccinations/due')).data.rows).toEqual([]);

    // The journal can be filtered by what was done, and each row names its plan.
    const journal = await vet.get('/livestock/health/records', { type: 'deworming' });
    expect(journal.data.map((r: any) => [r.type, r.planName])).toEqual([['deworming', 'Gijjaga qarshi ishlov']]);
    expect((await vet.get('/livestock/health/records', { type: 'vaccination' })).body.meta.total).toBe(0);

    // The plan list says what was last done under each plan, for the form's default.
    const plans = await vet.get('/livestock/health/vaccination-plans');
    const byName = Object.fromEntries(plans.data.map((p: any) => [p.name, p]));
    expect(byName['Gijjaga qarshi ishlov']).toMatchObject({ lastType: 'deworming', itemCategory: 'vet_drug' });
    expect(byName['Brutsellyoz tekshiruvi']).toMatchObject({ lastType: 'examination', itemCategory: null });

    // The ewe's card names both plans; two plans without a product stay two reminders.
    const health = await vet.get(`/livestock/animals/${ewe.id}/health`);
    expect(health.data.nextDue).toEqual([
      { date: addDays(T, 120), type: 'deworming', itemName: 'Fenbendazol', planName: 'Gijjaga qarshi ishlov' },
      { date: addDays(T, 365), type: 'examination', itemName: null, planName: 'Brutsellyoz tekshiruvi' },
    ]);
    expect(health.data.records.map((r: any) => r.planName).sort()).toEqual(['Brutsellyoz tekshiruvi', 'Gijjaga qarshi ishlov']);
  });

  it('keeps vaccination as the default, and refuses a dose of nothing', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const herd = await makeHerd(f, 'Poda');
    await makeEwe(f, { herdId: herd.id });
    const vaccine = await makeDrug(f, 'Oqsil vaksinasi', 'vaccine');

    const plain = await vet.post('/livestock/health/vaccinations/herd', { herdId: herd.id, itemId: vaccine.itemId, date: T, dosePerHead: 1 });
    expect(plain.status).toBe(201);
    expect(plain.data).toMatchObject({ type: 'vaccination', planName: null });

    const nothing = await vet.post('/livestock/health/vaccinations/herd', { herdId: herd.id, date: T });
    expect(nothing.status).toBe(400);
    expect(nothing.body.error.code).toBe('VACCINE_REQUIRED');
    // A herd examination needs no product.
    expect((await vet.post('/livestock/health/vaccinations/herd', { herdId: herd.id, type: 'examination', date: T })).status).toBe(201);
    // Treatment is not something a plan schedules.
    expect((await vet.post('/livestock/health/vaccinations/herd', { herdId: herd.id, type: 'treatment', itemId: vaccine.itemId, date: T })).status).toBe(400);
  });
});

describe('a lambing with live lambs months before term (audit: lambing form saved at 60 days)', () => {
  it('is refused before 90 % of gestation, while an early loss and a term lambing are recorded', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');

    // Mated 60 days ago: sheep carry 150 days, so live lambs cannot come before day 135.
    const early = await makeEwe(f);
    await f.run(() => createPregnancy({ eweId: early.id, matingDate: daysAgo(60) }));
    const refused = await zoo.post('/livestock/lambings', { eweId: early.id, date: T, lambs: [{ sex: 'female', alive: true }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('LAMBING_TOO_EARLY');
    expect(refused.body.error.details).toMatchObject({ earliestDate: addDays(daysAgo(60), 135), expectedDate: addDays(daysAgo(60), 150) });

    // Nothing was written: the ewe is still carrying and has no lambs.
    const after = await zoo.get(`/livestock/animals/${early.id}/breeding`);
    expect(after.data.matings[0]).toMatchObject({ status: 'pregnant', lambing: null });

    // Born dead that early is an abortion the form may still record.
    const lost = await zoo.post('/livestock/lambings', { eweId: early.id, date: T, lambs: [{ sex: 'male', alive: false }] });
    expect(lost.status, JSON.stringify(lost.body)).toBe(201);

    // Day 135 is the first day live lambs are accepted; day 148 is a normal lambing.
    const premature = await makeEwe(f);
    await f.run(() => createPregnancy({ eweId: premature.id, matingDate: daysAgo(135) }));
    expect((await zoo.post('/livestock/lambings', { eweId: premature.id, date: T, lambs: [{ sex: 'male' }] })).status).toBe(201);
    const term = await makeEwe(f);
    await f.run(() => createPregnancy({ eweId: term.id, matingDate: daysAgo(148) }));
    expect((await zoo.post('/livestock/lambings', { eweId: term.id, date: T, lambs: [{ sex: 'male' }, { sex: 'female' }] })).status).toBe(201);
  });
});
