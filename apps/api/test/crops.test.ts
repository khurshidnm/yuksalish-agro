import { DEFAULT_ROLE_PERMISSIONS } from '@yap/shared';
import { addDays, todayIso } from '@yap/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tx } from '../src/core/context';
import { ensureCostCenter } from '../src/core/costCenters';
import { receiveStock, stockOnHand } from '../src/core/inventory';
import { schema } from '../src/db/client';
import { createFixture, type Fixture } from './helpers';

const { crops, fields, items, seasons, stockBatches, stockMovements, warehouses } = schema;

const today = todayIso();
const daysAgo = (n: number) => addDays(today, -n);

// Field work must never depend on the network; weather has its own test below.
beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

interface World {
  f: Fixture;
  fieldId: string;
  fieldCc: string;
  seasonId: string;
  wheatId: string;
  warehouseId: string;
  seedId: string;
}

async function makeField(f: Fixture, number: string, areaHa: number, landUse = 'arable') {
  return f.run(async () => {
    const [row] = await tx()
      .insert(fields)
      .values({ tenantId: f.tenantId, farmId: f.farmId, number, areaHa, landUse })
      .returning();
    const costCenterId = await ensureCostCenter('field', row.id, `Dala ${number}`);
    await tx().update(fields).set({ costCenterId }).where(eq(fields.id, row.id));
    return { fieldId: row.id, fieldCc: costCenterId };
  });
}

async function makeItem(f: Fixture, name: string, unit = 'kg', stock?: { qty: number; unitCost: number }, extra: object = {}) {
  return f.run(async () => {
    const [warehouse] = await tx()
      .insert(warehouses)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name: `Ombor ${name}`, type: 'seed_fertilizer' })
      .returning();
    const [item] = await tx()
      .insert(items)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name, category: 'seed', unit, ...extra })
      .returning();
    if (stock) {
      await receiveStock({ itemId: item.id, warehouseId: warehouse.id, ...stock, date: daysAgo(60), source: 'opening' });
    }
    return { itemId: item.id, warehouseId: warehouse.id };
  });
}

async function world(areaHa = 20): Promise<World> {
  const f = await createFixture();
  const { fieldId, fieldCc } = await makeField(f, '1', areaHa);
  const seed = await makeItem(f, "Bug'doy urug'i", 'kg', { qty: 10_000, unitCost: 5000 });
  const { seasonId, wheatId } = await f.run(async () => {
    const [season] = await tx()
      .insert(seasons)
      .values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        name: 'Kuzgi',
        kind: 'autumn',
        startDate: daysAgo(90),
        endDate: addDays(today, 240),
      })
      .returning();
    const [wheat] = await tx()
      .select()
      .from(crops)
      .where(and(eq(crops.tenantId, f.tenantId), eq(crops.key, 'wheat')));
    return { seasonId: season.id, wheatId: wheat.id };
  });
  return { f, fieldId, fieldCc, seasonId, wheatId, warehouseId: seed.warehouseId, seedId: seed.itemId };
}

async function makePlan(w: World, over: object = {}) {
  const owner = await w.f.as('owner');
  const res = await owner.post('/crops/plans', { seasonId: w.seasonId, fieldId: w.fieldId, cropId: w.wheatId, ...over });
  expect(res.status).toBe(201);
  return res.data;
}

const TECH_LINES = [
  { type: 'tillage', name: 'Haydash', offsetDays: -10, costPerHa: 300_000 },
  { type: 'sowing', name: 'Ekish', offsetDays: 0, seedKgHa: 220, costPerHa: 450_000 },
  { type: 'irrigation', name: "Birinchi sug'orish", offsetDays: 7, waterM3Ha: 800, costPerHa: 150_000 },
];

async function makeCard(w: World, over: object = {}) {
  const owner = await w.f.as('owner');
  const res = await owner.post('/crops/tech-cards', {
    cropId: w.wheatId,
    name: "Bug'doy kartasi",
    lines: TECH_LINES,
    expectedYieldTHa: 4.5,
    ...over,
  });
  expect(res.status).toBe(201);
  return res.data;
}

describe('seasons and reference data', () => {
  it('any role can read seasons and crops for dropdowns', async () => {
    const w = await world();
    const shepherd = await w.f.as('shepherd');
    const list = await shepherd.get('/crops/seasons');
    expect(list.status).toBe(200);
    expect(list.data.map((s: any) => s.id)).toEqual([w.seasonId]);
    const cropList = await shepherd.get('/crops/crops');
    expect(cropList.data.map((c: any) => c.key)).toContain('wheat');
  });

  it('treats the season containing today as current when none is flagged', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const list = await owner.get('/crops/seasons');
    expect(list.data[0].isCurrent).toBe(true);
  });

  it('keeps a single current season', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const body = { name: 'Yozgi', kind: 'summer', startDate: addDays(today, 200), endDate: addDays(today, 300), isCurrent: true };
    const second = await owner.post('/crops/seasons', body);
    expect(second.status).toBe(201);
    const third = await owner.post('/crops/seasons', { ...body, name: 'Bahorgi', kind: 'spring' });
    const list = await owner.get('/crops/seasons');
    const current = list.data.filter((s: any) => s.isCurrent).map((s: any) => s.id);
    expect(current).toEqual([third.data.id]);
  });

  it('rejects a season that ends before it starts', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const res = await owner.post('/crops/seasons', { name: 'X', kind: 'autumn', startDate: today, endDate: daysAgo(1) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PERIOD');
  });

  it('a season with plans cannot be deleted', async () => {
    const w = await world();
    await makePlan(w);
    const owner = await w.f.as('owner');
    const res = await owner.delete(`/crops/seasons/${w.seasonId}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IN_USE');
  });

  it('adds a crop to the reference list', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const res = await owner.post('/crops/crops', {
      key: 'sunflower',
      name: { uz: 'Kungaboqar', ru: 'Подсолнечник', en: 'Sunflower' },
      defaultYieldTHa: 2.1,
    });
    expect(res.status).toBe(201);
    expect(res.data.defaultYieldTHa).toBe(2.1);
  });
});

describe('crop plans', () => {
  it('estimates cost and yield from the tech card (spec 7.1)', async () => {
    const w = await world(20);
    const card = await makeCard(w);
    const plan = await makePlan(w);
    // 300 000 + 450 000 + 150 000 = 900 000 per ha × 20 ha
    expect(plan.techCardId).toBe(card.id);
    expect(plan.plannedCost).toBe(18_000_000);
    expect(plan.expectedYieldTHa).toBe(4.5);
    expect(plan.expectedHarvestT).toBe(90);
    expect(plan.seedRateKgHa).toBe(220);
    expect(plan.areaHa).toBe(20);
  });

  it('a typed value wins over the estimate', async () => {
    const w = await world(20);
    await makeCard(w);
    const plan = await makePlan(w, { plannedCost: 7_000_000, expectedYieldTHa: 3 });
    expect(plan.plannedCost).toBe(7_000_000);
    expect(plan.expectedHarvestT).toBe(60);
  });

  it('re-prices when the area changes, unless a cost was typed', async () => {
    const w = await world(20);
    await makeCard(w);
    const plan = await makePlan(w);
    const owner = await w.f.as('owner');
    const res = await owner.patch(`/crops/plans/${plan.id}`, { areaHa: 10 });
    expect(res.data.plannedCost).toBe(9_000_000);
    const typed = await owner.patch(`/crops/plans/${plan.id}`, { areaHa: 12, plannedCost: 1_000_000 });
    expect(typed.data.plannedCost).toBe(1_000_000);
  });

  it('clearing the cost asks for the estimate again', async () => {
    const w = await world(20);
    await makeCard(w);
    const plan = await makePlan(w, { plannedCost: 1_000_000 });
    const owner = await w.f.as('owner');
    const res = await owner.patch(`/crops/plans/${plan.id}`, { plannedCost: null });
    expect(res.data.plannedCost).toBe(18_000_000);
  });

  it('saving the form without changes keeps a typed cost, for those who cannot see it too', async () => {
    const w = await world(20);
    const card = await makeCard(w);
    const plan = await makePlan(w, { plannedCost: 7_000_000 });
    const agronomist = await w.f.as('agronomist');
    // The form always sends the card and area, and leaves out the cost it cannot show.
    const saved = await agronomist.patch(`/crops/plans/${plan.id}`, { techCardId: card.id, areaHa: 20, notes: 'Tekshirildi' });
    expect(saved.status).toBe(200);
    const owner = await w.f.as('owner');
    expect((await owner.get(`/crops/plans/${plan.id}`)).data.plannedCost).toBe(7_000_000);
  });

  it('splits the expected harvest into own use and sale (spec 7.1)', async () => {
    const w = await world(20);
    const plan = await makePlan(w, { expectedYieldTHa: 5, ownUsePct: 75 });
    expect(plan.planned).toEqual({ ownUseT: 75, saleT: 25 });
  });

  it('with no tech card the cost is null, not zero', async () => {
    const w = await world();
    const plan = await makePlan(w);
    expect(plan.plannedCost).toBeNull();
    expect(plan.techCardId).toBeNull();
  });

  it('a field cannot carry more crop than it has land in a season', async () => {
    const w = await world(20);
    const owner = await w.f.as('owner');
    await makePlan(w, { areaHa: 15 });
    const barley = await w.f.run(async () => {
      const [row] = await tx().select().from(crops).where(and(eq(crops.tenantId, w.f.tenantId), eq(crops.key, 'barley')));
      return row;
    });
    const res = await owner.post('/crops/plans', { seasonId: w.seasonId, fieldId: w.fieldId, cropId: barley.id, areaHa: 6 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_AREA_EXCEEDS_FIELD');
    expect(res.body.error.details.freeHa).toBe(5);
    const fits = await owner.post('/crops/plans', { seasonId: w.seasonId, fieldId: w.fieldId, cropId: barley.id, areaHa: 5 });
    expect(fits.status).toBe(201);
  });

  it('refuses a plan on pasture', async () => {
    const w = await world();
    const { fieldId } = await makeField(w.f, 'Y-1', 100, 'pasture');
    const owner = await w.f.as('owner');
    const res = await owner.post('/crops/plans', { seasonId: w.seasonId, fieldId, cropId: w.wheatId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FIELD_NOT_ARABLE');
  });

  it('the same crop twice on one field in one season is a conflict', async () => {
    const w = await world(20);
    const owner = await w.f.as('owner');
    await makePlan(w, { areaHa: 5 });
    const res = await owner.post('/crops/plans', { seasonId: w.seasonId, fieldId: w.fieldId, cropId: w.wheatId, areaHa: 5 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_EXISTS');
  });

  it('a plan with recorded work cannot be deleted; planned work goes with it otherwise', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const plan = await makePlan(w);
    await owner.post('/crops/operations', {
      type: 'tillage',
      status: 'planned',
      date: addDays(today, 5),
      fieldId: w.fieldId,
    });
    const free = await owner.delete(`/crops/plans/${plan.id}`);
    expect(free.status).toBe(200);

    const second = await makePlan(w);
    await owner.post('/crops/operations', { type: 'tillage', date: today, fieldId: w.fieldId, areaDoneHa: 5 });
    const blocked = await owner.delete(`/crops/plans/${second.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PLAN_HAS_WORK');
  });

  it('generates planned operations from the tech card, dated from sowing, once', async () => {
    const w = await world(20);
    await makeCard(w);
    const sowing = addDays(today, 20);
    const plan = await makePlan(w, { sowingDatePlan: sowing });
    const owner = await w.f.as('owner');

    const first = await owner.post(`/crops/plans/${plan.id}/generate-operations`);
    expect(first.data).toEqual({ created: 3, total: 3 });

    const list = await owner.get('/crops/operations', { cropPlanId: plan.id, sort: 'date' });
    expect(list.data.map((o: any) => [o.type, o.date, o.status])).toEqual([
      ['tillage', addDays(sowing, -10), 'planned'],
      ['sowing', sowing, 'planned'],
      ['irrigation', addDays(sowing, 7), 'planned'],
    ]);
    // 800 m³/ha × 20 ha
    expect(list.data[2].waterM3).toBe(16_000);

    const second = await owner.post(`/crops/plans/${plan.id}/generate-operations`);
    expect(second.data).toEqual({ created: 0, total: 3 });
  });

  it('an edited planned operation is still recognised as generated', async () => {
    const w = await world(20);
    await makeCard(w);
    const plan = await makePlan(w, { sowingDatePlan: addDays(today, 20) });
    const owner = await w.f.as('owner');
    await owner.post(`/crops/plans/${plan.id}/generate-operations`);
    const list = await owner.get('/crops/operations', { cropPlanId: plan.id, sort: 'date' });

    const edited = await owner.patch(`/crops/operations/${list.data[0].id}`, { details: { method: 'plowing' }, notes: 'Boshqa kunga' });
    expect(edited.data.details).toMatchObject({ method: 'plowing', name: 'Haydash' });

    expect((await owner.post(`/crops/plans/${plan.id}/generate-operations`)).data).toEqual({ created: 0, total: 3 });
  });

  it('generating needs a card and a sowing date', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const noCard = await makePlan(w);
    const res = await owner.post(`/crops/plans/${noCard.id}/generate-operations`);
    expect(res.body.error.code).toBe('PLAN_HAS_NO_TECH_CARD');
    await makeCard(w);
    await owner.patch(`/crops/plans/${noCard.id}`, { techCardId: (await owner.get('/crops/tech-cards')).data[0].id });
    const noDate = await owner.post(`/crops/plans/${noCard.id}/generate-operations`);
    expect(noDate.body.error.code).toBe('SOWING_DATE_REQUIRED');
  });
});


/** A custom role that may edit crops but is not their cost manager, so rule 7 applies to it. */
async function withoutCostAccess(f: Fixture): Promise<void> {
  await f.run(() =>
    tx()
      .update(schema.roles)
      .set({ permissions: DEFAULT_ROLE_PERMISSIONS.agronomist.filter((p) => p !== 'crops.approve') })
      .where(eq(schema.roles.id, f.roleIds.agronomist)),
  );
}

describe('money rule 7', () => {
  it('the agronomist sees crop costs by default, as the manager of this module', async () => {
    const w = await world(20);
    const card = await makeCard(w);
    const plan = await makePlan(w);
    const agronomist = await w.f.as('agronomist');
    expect((await agronomist.get(`/crops/plans/${plan.id}`)).data.plannedCost).toBe(18_000_000);
    expect((await agronomist.get(`/crops/tech-cards/${card.id}`)).data.costPerHa).toBe(900_000);
    expect((await agronomist.get('/crops/plan-fact')).data.rows[0].plannedCost).toBe(18_000_000);
  });

  it('crop costs stop at the crop module: the agronomist still has no finance access', async () => {
    const w = await world(20);
    const agronomist = await w.f.as('agronomist');
    expect((await agronomist.get('/finance/accounts')).status).toBe(403);
    expect((await agronomist.get('/finance/transactions')).status).toBe(403);
  });

  it('a mechanic reading the same plan gets no money', async () => {
    const w = await world(20);
    await makeCard(w);
    const plan = await makePlan(w);
    const mechanic = await w.f.as('mechanic');
    const res = await mechanic.get(`/crops/plans/${plan.id}`);
    expect(res.status).toBe(200);
    expect(res.data.plannedCost).toBeNull();
  });

  it('without cost access a user sees the plan but no money; an accountant sees it', async () => {
    const w = await world(20);
    await makeCard(w);
    const plan = await makePlan(w);
    await withoutCostAccess(w.f);

    const agronomist = await w.f.as('agronomist');
    const hidden = await agronomist.get(`/crops/plans/${plan.id}`);
    expect(hidden.status).toBe(200);
    expect(hidden.data.plannedCost).toBeNull();
    expect(hidden.data.expectedHarvestT).toBe(90);

    const accountant = await w.f.as('accountant');
    expect((await accountant.get(`/crops/plans/${plan.id}`)).data.plannedCost).toBe(18_000_000);
  });

  it('the estimate endpoint hides cost and leaks no internal field', async () => {
    const w = await world(20);
    await makeCard(w);
    await withoutCostAccess(w.f);
    const agronomist = await w.f.as('agronomist');
    const res = await agronomist.get('/crops/plans/estimate', { cropId: w.wheatId, areaHa: 20 });
    expect(res.data.plannedCost).toBeNull();
    expect(res.data.costPerHa).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('18000000');
    expect(JSON.stringify(res.body)).not.toContain('900000');
  });

  it('tech card line prices are stripped, and an edit by a user without cost access keeps them', async () => {
    const w = await world(20);
    const card = await makeCard(w);
    await withoutCostAccess(w.f);
    const agronomist = await w.f.as('agronomist');

    const seen = await agronomist.get(`/crops/tech-cards/${card.id}`);
    expect(seen.data.costPerHa).toBeNull();
    expect(seen.data.lines[0]).not.toHaveProperty('costPerHa');

    const edited = seen.data.lines.map((l: any) => (l.type === 'irrigation' ? { ...l, waterM3Ha: 900 } : l));
    expect((await agronomist.patch(`/crops/tech-cards/${card.id}`, { lines: edited })).status).toBe(200);

    const owner = await w.f.as('owner');
    const after = await owner.get(`/crops/tech-cards/${card.id}`);
    expect(after.data.costPerHa).toBe(900_000);
    expect(after.data.norms.waterM3Ha).toBe(900);
  });

  it('material cost is hidden from a mechanic in the journal', async () => {
    const w = await world();
    const mechanic = await w.f.as('mechanic');
    const res = await mechanic.post('/crops/operations', {
      type: 'sowing',
      date: today,
      fieldId: w.fieldId,
      materials: [{ itemId: w.seedId, warehouseId: w.warehouseId, qty: 100 }],
    });
    expect(res.status).toBe(201);
    expect(res.data.materials[0].qty).toBe(100);
    expect(res.data.materials[0].totalCost).toBeNull();
  });
});

describe('field operations', () => {
  it('materials leave the warehouse and are charged to the field (spec 9)', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const res = await owner.post('/crops/operations', {
      type: 'sowing',
      date: daysAgo(1),
      fieldId: w.fieldId,
      areaDoneHa: 20,
      details: { variety: 'Grom', seedRateKgHa: 200 },
      materials: [{ itemId: w.seedId, warehouseId: w.warehouseId, qty: 4000, normPerHa: 200 }],
    });
    expect(res.status).toBe(201);
    // 4 000 kg × 5 000
    expect(res.data.materials[0].totalCost).toBe(20_000_000);

    await w.f.run(async () => {
      expect(await stockOnHand(w.seedId)).toBe(6000);
      const moves = await tx()
        .select()
        .from(stockMovements)
        .where(and(eq(stockMovements.refType, 'field_operation'), sql`${stockMovements.refId} = ${res.data.id}`));
      expect(moves).toHaveLength(1);
      expect(moves[0].costCenterId).toBe(w.fieldCc);
      expect(moves[0].reason).toBe('field_operation');
      expect(moves[0].totalCost).toBe(20_000_000);
    });
  });

  it('a shortage fails the whole operation and leaves nothing behind', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const res = await owner.post('/crops/operations', {
      type: 'sowing',
      date: today,
      fieldId: w.fieldId,
      materials: [{ itemId: w.seedId, warehouseId: w.warehouseId, qty: 10_001 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await owner.get('/crops/operations')).body.meta.total).toBe(0);
    expect(await w.f.run(() => stockOnHand(w.seedId))).toBe(10_000);
  });

  it('editing re-posts stock and cost exactly', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const created = await owner.post('/crops/operations', {
      type: 'sowing',
      date: today,
      fieldId: w.fieldId,
      materials: [{ itemId: w.seedId, warehouseId: w.warehouseId, qty: 1000 }],
    });
    const res = await owner.patch(`/crops/operations/${created.data.id}`, {
      materials: [{ itemId: w.seedId, warehouseId: w.warehouseId, qty: 2500 }],
    });
    expect(res.status).toBe(200);
    expect(res.data.materials[0].totalCost).toBe(12_500_000);
    expect(await w.f.run(() => stockOnHand(w.seedId))).toBe(7500);

    // Editing something else leaves the materials as they were.
    const note = await owner.patch(`/crops/operations/${created.data.id}`, { notes: 'Yomg\'irdan keyin' });
    expect(note.data.materials[0].qty).toBe(2500);
    expect(await w.f.run(() => stockOnHand(w.seedId))).toBe(7500);
  });

  it('a failed edit keeps the original record and stock', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const created = await owner.post('/crops/operations', {
      type: 'sowing',
      date: today,
      fieldId: w.fieldId,
      materials: [{ itemId: w.seedId, warehouseId: w.warehouseId, qty: 1000 }],
    });
    const res = await owner.patch(`/crops/operations/${created.data.id}`, {
      materials: [{ itemId: w.seedId, warehouseId: w.warehouseId, qty: 99_999 }],
    });
    expect(res.status).toBe(409);
    const after = await owner.get(`/crops/operations/${created.data.id}`);
    expect(after.data.materials[0].qty).toBe(1000);
    expect(await w.f.run(() => stockOnHand(w.seedId))).toBe(9000);
  });

  it('deleting restores stock', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const created = await owner.post('/crops/operations', {
      type: 'fertilizing',
      date: today,
      fieldId: w.fieldId,
      materials: [{ itemId: w.seedId, warehouseId: w.warehouseId, qty: 500 }],
    });
    expect((await owner.delete(`/crops/operations/${created.data.id}`)).status).toBe(200);
    expect(await w.f.run(() => stockOnHand(w.seedId))).toBe(10_000);
    expect((await owner.get(`/crops/operations/${created.data.id}`)).status).toBe(404);
  });

  it('planned work touches no stock until it is done', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const planned = await owner.post('/crops/operations', {
      type: 'sowing',
      status: 'planned',
      date: daysAgo(2),
      fieldId: w.fieldId,
      materials: [{ itemId: w.seedId, warehouseId: w.warehouseId, qty: 800 }],
    });
    expect(planned.status).toBe(201);
    expect(planned.data.overdue).toBe(true);
    expect(await w.f.run(() => stockOnHand(w.seedId))).toBe(10_000);

    const done = await owner.post(`/crops/operations/${planned.data.id}/complete`, { areaDoneHa: 10 });
    expect(done.status).toBe(200);
    expect(done.data.status).toBe('done');
    expect(done.data.overdue).toBe(false);
    expect(done.data.date).toBe(today);
    expect(done.data.plannedDate).toBe(daysAgo(2));
    expect(done.data.materials[0].totalCost).toBe(4_000_000);
    expect(await w.f.run(() => stockOnHand(w.seedId))).toBe(9200);

    const again = await owner.post(`/crops/operations/${planned.data.id}/complete`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NOT_PLANNED');
    expect(await w.f.run(() => stockOnHand(w.seedId))).toBe(9200);
  });

  it('finds overdue work', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    await owner.post('/crops/operations', { type: 'tillage', status: 'planned', date: daysAgo(3), fieldId: w.fieldId });
    await owner.post('/crops/operations', { type: 'tillage', status: 'planned', date: addDays(today, 3), fieldId: w.fieldId });
    await owner.post('/crops/operations', { type: 'tillage', date: daysAgo(3), fieldId: w.fieldId });
    const list = await owner.get('/crops/operations', { overdue: 'true' });
    expect(list.body.meta.total).toBe(1);
    expect(list.data[0].date).toBe(daysAgo(3));
    const summary = await owner.get('/crops/summary');
    expect(summary.data.overdue).toEqual([{ id: list.data[0].id, type: 'tillage', date: daysAgo(3), fieldNumber: '1' }]);
  });

  it.each([
    [{ type: 'irrigation' }, 'WATER_REQUIRED'],
    [{ type: 'tillage', fuelL: 40 }, 'ASSET_REQUIRED_FOR_FUEL'],
    [{ type: 'tillage', areaDoneHa: 25 }, 'AREA_EXCEEDS_FIELD'],
    [{ type: 'tillage', date: addDays(today, 1) }, 'FUTURE_DATE'],
    [{ type: 'harvest' }, 'USE_HARVEST_FORM'],
  ])('rejects %j', async (over, code) => {
    const w = await world(20);
    const owner = await w.f.as('owner');
    const res = await owner.post('/crops/operations', { date: today, fieldId: w.fieldId, ...over });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  it('validates details by operation type', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const res = await owner.post('/crops/operations', {
      type: 'observation',
      date: today,
      fieldId: w.fieldId,
      details: { condition: 'splendid' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_DETAILS');
    expect(res.body.error.details.fieldErrors).toHaveProperty('details.condition');
  });

  it('accepts a client id and replays by Idempotency-Key without issuing stock twice', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const id = '0190a7e2-7b1c-7c3d-8e4f-aaaaaaaaaaaa';
    const body = {
      id,
      type: 'sowing',
      date: today,
      fieldId: w.fieldId,
      materials: [{ itemId: w.seedId, warehouseId: w.warehouseId, qty: 100 }],
    };
    const headers = { 'idempotency-key': 'phone-outbox-1' };
    expect((await owner.post('/crops/operations', body, headers)).data.id).toBe(id);
    const replay = await owner.post('/crops/operations', body, headers);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(await w.f.run(() => stockOnHand(w.seedId))).toBe(9900);
  });

  it('attaches the weather of the day when known (spec 7.3)', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    await w.f.run(() =>
      tx().insert(schema.weatherDaily).values({
        tenantId: w.f.tenantId,
        farmId: w.f.farmId,
        date: today,
        tempMin: 3,
        tempMax: 14,
        precipitationMm: 1.2,
      }),
    );
    const res = await owner.post('/crops/operations', { type: 'tillage', date: today, fieldId: w.fieldId });
    expect(res.data.weather).toMatchObject({ tempMin: 3, tempMax: 14, precipitationMm: 1.2 });
  });

  it('saves the work when weather is unavailable', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const res = await owner.post('/crops/operations', { type: 'tillage', date: daysAgo(30), fieldId: w.fieldId });
    expect(res.status).toBe(201);
    expect(res.data.weather).toBeNull();
  });

  it('writes a journal event', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const created = await owner.post('/crops/operations', { type: 'tillage', date: today, fieldId: w.fieldId, areaDoneHa: 5 });
    const events = await w.f.run(() =>
      tx().select().from(schema.events).where(sql`${schema.events.type} = 'field.tillage' and ${schema.events.entityId} = ${w.fieldId}`),
    );
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ operationId: created.data.id, areaDoneHa: 5 });
  });
});

describe('plan status follows the journal', () => {
  it('sowing marks the plan sown; removing it puts the plan back', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const plan = await makePlan(w);
    const sowing = await owner.post('/crops/operations', { type: 'sowing', date: daysAgo(4), fieldId: w.fieldId });
    expect(sowing.data.cropPlanId).toBe(plan.id);

    const sown = await owner.get(`/crops/plans/${plan.id}`);
    expect(sown.data.status).toBe('sown');
    expect(sown.data.sowingDateFact).toBe(daysAgo(4));

    await owner.delete(`/crops/operations/${sowing.data.id}`);
    const back = await owner.get(`/crops/plans/${plan.id}`);
    expect(back.data.status).toBe('planned');
    expect(back.data.sowingDateFact).toBeNull();
  });

  it('a sowing date imported without a journal row survives later field work', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    // Spec 23.1: autumn sowing happens before go-live and arrives through Excel.
    const plan = await makePlan(w, { status: 'sown', sowingDateFact: daysAgo(30) });
    await owner.post('/crops/operations', { type: 'irrigation', date: today, fieldId: w.fieldId, waterM3: 500 });
    const after = await owner.get(`/crops/plans/${plan.id}`);
    expect(after.data.status).toBe('sown');
    expect(after.data.sowingDateFact).toBe(daysAgo(30));
  });

  it('marking a plan sown by hand keeps it sown after further work', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const plan = await makePlan(w, { sowingDatePlan: daysAgo(10) });
    await owner.patch(`/crops/plans/${plan.id}`, { status: 'growing' });
    await owner.post('/crops/operations', { type: 'irrigation', date: today, fieldId: w.fieldId, waterM3: 500 });
    const after = await owner.get(`/crops/plans/${plan.id}`);
    expect(after.data.status).toBe('growing');
    expect(after.data.sowingDateFact).toBe(daysAgo(10));
  });

  it('a cancelled plan stays cancelled and takes no new work by date', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const plan = await makePlan(w);
    await owner.patch(`/crops/plans/${plan.id}`, { status: 'cancelled' });
    const op = await owner.post('/crops/operations', { type: 'tillage', date: today, fieldId: w.fieldId });
    expect(op.data.cropPlanId).toBeNull();
    expect((await owner.get(`/crops/plans/${plan.id}`)).data.status).toBe('cancelled');
  });

  it('refuses a plan belonging to another field', async () => {
    const w = await world();
    const plan = await makePlan(w);
    const { fieldId } = await makeField(w.f, '2', 10);
    const owner = await w.f.as('owner');
    const res = await owner.post('/crops/operations', { type: 'tillage', date: today, fieldId, cropPlanId: plan.id });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PLAN_FIELD_MISMATCH');
  });
});

describe('machinery on field work', () => {
  async function tractor(w: World) {
    const owner = await w.f.as('owner');
    const res = await owner.post('/assets', { name: 'MTZ-82', type: 'tractor', motoHours: 100, fuelNormLPerHa: 10 });
    expect(res.status).toBe(201);
    return { assetId: res.data.id as string, assetCc: res.data.costCenterId as string };
  }

  it('logs the shift, adds motor-hours and charges fuel to the machine', async () => {
    const w = await world();
    const { assetId, assetCc } = await tractor(w);
    const diesel = await makeItem(w.f, 'Dizel', 'l', { qty: 1000, unitCost: 12_000 }, { category: 'fuel' });
    const owner = await w.f.as('owner');

    const res = await owner.post('/crops/operations', {
      type: 'tillage',
      date: today,
      fieldId: w.fieldId,
      assetId,
      durationH: 8,
      areaDoneHa: 10,
      fuelL: 100,
    });
    expect(res.status).toBe(201);

    const shifts = await owner.get(`/assets/${assetId}/usage`);
    expect(shifts.body.meta.total).toBe(1);
    expect(shifts.data[0]).toMatchObject({
      operationId: res.data.id,
      fieldNumber: '1',
      workType: 'tillage',
      motoHours: 8,
      volumeHa: 10,
      fuelL: 100,
      fuelCost: 1_200_000,
    });
    expect((await owner.get(`/assets/${assetId}`)).data.motoHours).toBe(108);

    await w.f.run(async () => {
      expect(await stockOnHand(diesel.itemId)).toBe(900);
      const [move] = await tx().select().from(stockMovements).where(eq(stockMovements.itemId, diesel.itemId)).orderBy(sql`${stockMovements.createdAt} desc`).limit(1);
      expect(move.costCenterId).toBe(assetCc);
      expect(move.reason).toBe('fuel');
    });
  });

  it('deleting the work undoes the shift, hours and fuel', async () => {
    const w = await world();
    const { assetId } = await tractor(w);
    const diesel = await makeItem(w.f, 'Dizel', 'l', { qty: 1000, unitCost: 12_000 }, { category: 'fuel' });
    const owner = await w.f.as('owner');
    const op = await owner.post('/crops/operations', {
      type: 'tillage',
      date: today,
      fieldId: w.fieldId,
      assetId,
      durationH: 8,
      fuelL: 100,
    });
    await owner.delete(`/crops/operations/${op.data.id}`);
    expect((await owner.get(`/assets/${assetId}`)).data.motoHours).toBe(100);
    expect((await owner.get(`/assets/${assetId}/usage`)).body.meta.total).toBe(0);
    expect(await w.f.run(() => stockOnHand(diesel.itemId))).toBe(1000);
  });

  it('an edit keeps exactly one shift and the right totals', async () => {
    const w = await world();
    const { assetId } = await tractor(w);
    const diesel = await makeItem(w.f, 'Dizel', 'l', { qty: 1000, unitCost: 12_000 }, { category: 'fuel' });
    const owner = await w.f.as('owner');
    const op = await owner.post('/crops/operations', {
      type: 'tillage',
      date: today,
      fieldId: w.fieldId,
      assetId,
      durationH: 8,
      fuelL: 100,
    });
    await owner.patch(`/crops/operations/${op.data.id}`, { durationH: 5, fuelL: 60 });
    expect((await owner.get(`/assets/${assetId}`)).data.motoHours).toBe(105);
    expect((await owner.get(`/assets/${assetId}/usage`)).body.meta.total).toBe(1);
    expect(await w.f.run(() => stockOnHand(diesel.itemId))).toBe(940);
  });

  it('a shift made by a field operation can only be changed there', async () => {
    const w = await world();
    const { assetId } = await tractor(w);
    const owner = await w.f.as('owner');
    await owner.post('/crops/operations', { type: 'tillage', date: today, fieldId: w.fieldId, assetId, durationH: 8 });
    const logs = await owner.get(`/assets/${assetId}/usage`);
    const res = await owner.delete(`/assets/${assetId}/usage/${logs.data[0].id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('USAGE_LINKED_TO_OPERATION');
  });
});

describe('harvest', () => {
  async function ready(w: World, unit = 'kg', transferPrice: number | null = 2000) {
    const product = await makeItem(w.f, "Bug'doy don", unit, undefined, { category: 'product', transferPrice });
    return product;
  }

  it('receives into the warehouse as a batch at the transfer price (spec 7.2, 7.3)', async () => {
    const w = await world(20);
    const owner = await w.f.as('owner');
    const plan = await makePlan(w, { expectedYieldTHa: 4 });
    const product = await ready(w);

    const res = await owner.post('/crops/harvests', {
      fieldId: w.fieldId,
      date: today,
      grossT: 12.5,
      moisturePct: 13.5,
      quality: '3-sinf',
      ...product,
    });
    expect(res.status).toBe(201);
    expect(res.data.cropPlanId).toBe(plan.id);
    // 12.5 t = 12 500 kg × 2 000
    expect(res.data.value).toBe(25_000_000);

    await w.f.run(async () => {
      const [batch] = await tx().select().from(stockBatches).where(eq(stockBatches.itemId, product.itemId));
      expect(batch).toMatchObject({ qtyReceived: 12_500, unitCost: 2000, source: 'own_harvest', fieldId: w.fieldId, receivedDate: today });
    });
    expect((await owner.get(`/crops/plans/${plan.id}`)).data).toMatchObject({ status: 'harvested', harvestedT: 12.5 });

    const journal = await owner.get('/crops/operations', { type: 'harvest' });
    expect(journal.body.meta.total).toBe(1);
    expect(journal.data[0].details).toMatchObject({ harvestId: res.data.id, grossT: 12.5 });
  });

  it('an item stocked in tons takes the tons as they are', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const product = await ready(w, 't', 2_000_000);
    const res = await owner.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 10, ...product });
    expect(res.data.value).toBe(20_000_000);
    expect(await w.f.run(() => stockOnHand(product.itemId))).toBe(10);
  });

  it('bales need a counted quantity', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const product = await ready(w, 'bale', 30_000);
    const missing = await owner.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 10, ...product });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('STOCK_QTY_REQUIRED');
    expect((await owner.get('/crops/harvests')).body.meta.total).toBe(0);

    const ok = await owner.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 10, stockQty: 400, ...product });
    expect(ok.data.value).toBe(12_000_000);
  });

  it('an item with no transfer price comes in at zero', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const product = await ready(w, 'kg', null);
    const res = await owner.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 1, ...product });
    expect(res.data.value).toBe(0);
    expect(await w.f.run(() => stockOnHand(product.itemId))).toBe(1000);
  });

  it('can be recorded first and received later, once', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const product = await ready(w);
    const harvest = await owner.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 2 });
    expect(harvest.data.batchId).toBeNull();
    expect(await w.f.run(() => stockOnHand(product.itemId))).toBe(0);

    const storekeeper = await w.f.as('storekeeper');
    const received = await storekeeper.post(`/crops/harvests/${harvest.data.id}/receive`, product);
    expect(received.status).toBe(200);
    expect(received.data.batchId).not.toBeNull();
    expect(received.data.value).toBeNull();
    expect(await w.f.run(() => stockOnHand(product.itemId))).toBe(2000);

    const twice = await storekeeper.post(`/crops/harvests/${harvest.data.id}/receive`, product);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('HARVEST_ALREADY_RECEIVED');
  });

  it('needs both the product and the warehouse', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const product = await ready(w);
    const res = await owner.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 2, itemId: product.itemId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DESTINATION_INCOMPLETE');
  });

  it('closes a planned harvest instead of adding a second journal row', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const plan = await makePlan(w);
    const planned = await owner.post('/crops/operations', { type: 'harvest', status: 'planned', date: daysAgo(1), fieldId: w.fieldId });
    expect(planned.status).toBe(201);

    const direct = await owner.post(`/crops/operations/${planned.data.id}/complete`, {});
    expect(direct.body.error.code).toBe('USE_HARVEST_FORM');

    const res = await owner.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 30, operationId: planned.data.id });
    expect(res.status).toBe(201);
    const journal = await owner.get('/crops/operations', { type: 'harvest' });
    expect(journal.body.meta.total).toBe(1);
    expect(journal.data[0]).toMatchObject({ status: 'done', date: today, plannedDate: daysAgo(1) });
    expect((await owner.get(`/crops/plans/${plan.id}`)).data.status).toBe('harvested');
  });

  it('editing the tons re-posts the batch; deleting restores the plan', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const plan = await makePlan(w);
    await owner.post('/crops/operations', { type: 'sowing', date: daysAgo(100 - 20), fieldId: w.fieldId });
    const product = await ready(w);
    const harvest = await owner.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 10, ...product });

    const edited = await owner.patch(`/crops/harvests/${harvest.data.id}`, { grossT: 11 });
    expect(edited.status).toBe(200);
    expect(edited.data.value).toBe(22_000_000);
    expect(await w.f.run(() => stockOnHand(product.itemId))).toBe(11_000);
    expect((await owner.get('/crops/operations', { type: 'harvest' })).data[0].details.grossT).toBe(11);

    expect((await owner.delete(`/crops/harvests/${harvest.data.id}`)).status).toBe(200);
    expect(await w.f.run(() => stockOnHand(product.itemId))).toBe(0);
    expect((await owner.get(`/crops/plans/${plan.id}`)).data.status).toBe('sown');
    expect((await owner.get('/crops/operations', { type: 'harvest' })).body.meta.total).toBe(0);
  });

  it('a harvest already fed to the sheep cannot be deleted', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const product = await ready(w);
    const harvest = await owner.post('/crops/harvests', { fieldId: w.fieldId, date: daysAgo(1), grossT: 1, ...product });
    await w.f.run(async () => {
      const { issueStock } = await import('../src/core/inventory');
      await issueStock({ ...product, qty: 500, date: today, costCenterId: w.fieldCc, reason: 'ration' });
    });
    const res = await owner.delete(`/crops/harvests/${harvest.data.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BATCH_ALREADY_USED');
    expect((await owner.get(`/crops/harvests/${harvest.data.id}`)).status).toBe(200);
  });

  it('warns when harvesting inside a pesticide waiting period (spec 7.2)', async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const treated = await owner.post('/crops/operations', {
      type: 'protection',
      date: daysAgo(3),
      fieldId: w.fieldId,
      details: { dose: 1.5, doseUnit: 'l/ha', withdrawalDays: 10 },
    });
    expect(treated.data.details.safeFrom).toBe(addDays(daysAgo(3), 10));

    const early = await owner.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 1 });
    expect(early.status).toBe(201);
    expect(early.data.withdrawalWarning).toEqual({ safeFrom: addDays(daysAgo(3), 10) });
  });

  it('hides the value from those without cost access', async () => {
    const w = await world();
    const product = await ready(w);
    await withoutCostAccess(w.f);
    const agronomist = await w.f.as('agronomist');
    const res = await agronomist.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 1, ...product });
    expect(res.status).toBe(201);
    expect(res.data.value).toBeNull();
    const list = await agronomist.get('/crops/harvests');
    expect(list.data[0].value).toBeNull();
    const owner = await w.f.as('owner');
    expect((await owner.get('/crops/harvests')).data[0].value).toBe(2_000_000);
  });
});

describe('harvest typing slips', () => {
  it('refuses more area than the field has, or a yield no crop gives', async () => {
    const w = await world(10);
    const owner = await w.f.as('owner');
    const area = await owner.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 50, areaDoneHa: 999 });
    expect(area.body.error).toMatchObject({ code: 'AREA_EXCEEDS_FIELD', details: { fieldAreaHa: 10 } });
    // 42 000 kg typed in the tonnes box.
    const slip = await owner.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 42_000 });
    expect(slip.body.error.code).toBe('YIELD_NOT_PLAUSIBLE');
    expect((await owner.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 42 })).status).toBe(201);
  });
});

describe('plan and fact (spec 7.3)', () => {
  it('compares against hand-computed control numbers, with cost from the finance engine', async () => {
    const w = await world(10);
    const owner = await w.f.as('owner');
    const plan = await makePlan(w, { expectedYieldTHa: 4, plannedCost: 15_000_000 });
    const product = await makeItem(w.f, 'Don', 'kg', undefined, { category: 'product', transferPrice: 2000 });

    // 2 000 kg seed × 5 000 = 10 000 000 of direct field cost
    await owner.post('/crops/operations', {
      type: 'sowing',
      date: daysAgo(50),
      fieldId: w.fieldId,
      materials: [{ itemId: w.seedId, warehouseId: w.warehouseId, qty: 2000 }],
    });
    await owner.post('/crops/operations', { type: 'irrigation', date: daysAgo(20), fieldId: w.fieldId, waterM3: 7200 });
    await owner.post('/crops/harvests', { fieldId: w.fieldId, date: today, grossT: 36, ...product });

    const res = await owner.get('/crops/plan-fact', { seasonId: w.seasonId });
    expect(res.status).toBe(200);
    expect(res.data.rows).toHaveLength(1);
    const row = res.data.rows[0];
    expect(row).toMatchObject({
      planId: plan.id,
      fieldNumber: '1',
      status: 'harvested',
      areaHa: 10,
      expectedHarvestT: 40,
      harvestedT: 36,
      actualYieldTHa: 3.6,
      waterM3: 7200,
      waterM3PerTon: 200,
      plannedCost: 15_000_000,
      actualCost: 10_000_000,
      costDeviation: -5_000_000,
      // 36 000 kg × 2 000
      harvestValue: 72_000_000,
    });
    expect(row.yieldDeviationPercent).toBeCloseTo(-10, 8);
    expect(row.costPerTon).toBeCloseTo(10_000_000 / 36, 2);
    expect(res.data.totals).toMatchObject({ areaHa: 10, expectedHarvestT: 40, harvestedT: 36, plannedCost: 15_000_000 });
  });

  it('an unharvested plan has no actual yield rather than zero', async () => {
    const w = await world(10);
    await makePlan(w, { expectedYieldTHa: 4 });
    const owner = await w.f.as('owner');
    const { rows } = (await owner.get('/crops/plan-fact')).data;
    expect(rows[0].actualYieldTHa).toBeNull();
    expect(rows[0].yieldDeviationPercent).toBeNull();
    expect(rows[0].waterM3PerTon).toBeNull();
  });

  it('shows no cost at all without cost access', async () => {
    const w = await world(10);
    await makePlan(w, { plannedCost: 15_000_000 });
    await withoutCostAccess(w.f);
    const agronomist = await w.f.as('agronomist');
    const res = await agronomist.get('/crops/plan-fact');
    const row = res.data.rows[0];
    expect([row.plannedCost, row.actualCost, row.costDeviation, row.costPerTon, row.harvestValue]).toEqual([null, null, null, null, null]);
    expect(res.data.totals.plannedCost).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('15000000');
  });

  it('with no season there is nothing to compare', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const res = await owner.get('/crops/plan-fact');
    expect(res.data).toEqual({ seasonId: null, rows: [], totals: null });
  });
});

describe('summary', () => {
  it('counts sown, irrigated and harvested fields', async () => {
    const w = await world(20);
    const owner = await w.f.as('owner');
    const second = await makeField(w.f, '2', 15);
    await makeField(w.f, '3', 10);
    await makeField(w.f, 'Y-1', 100, 'pasture');
    await makePlan(w);
    await owner.post('/crops/plans', { seasonId: w.seasonId, fieldId: second.fieldId, cropId: w.wheatId });

    await owner.post('/crops/operations', { type: 'sowing', date: daysAgo(40), fieldId: w.fieldId });
    await owner.post('/crops/operations', { type: 'sowing', date: daysAgo(40), fieldId: second.fieldId });
    await owner.post('/crops/operations', { type: 'irrigation', date: daysAgo(20), fieldId: w.fieldId, waterM3: 100 });
    await owner.post('/crops/harvests', { fieldId: second.fieldId, date: today, grossT: 5 });

    const res = await owner.get('/crops/summary');
    expect(res.data.fields).toEqual({ sown: 2, irrigated: 1, harvested: 1, total: 3 });
    expect(res.data.harvest.actualT).toBe(5);
  });

  it('measures how much planned work was done on time (spec 14.3)', async () => {
    const w = await world(20);
    const owner = await w.f.as('owner');
    await makePlan(w);
    const onTime = await owner.post('/crops/operations', { type: 'tillage', status: 'planned', date: today, fieldId: w.fieldId });
    const late = await owner.post('/crops/operations', { type: 'tillage', status: 'planned', date: daysAgo(5), fieldId: w.fieldId });
    await owner.post(`/crops/operations/${onTime.data.id}/complete`, {});
    await owner.post(`/crops/operations/${late.data.id}/complete`, {});
    const res = await owner.get('/crops/summary');
    expect(res.data.kpis.onTimePercent).toBe(50);
  });

  it('an empty farm has no KPI figures', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const res = await owner.get('/crops/summary');
    expect(res.data.fields).toEqual({ sown: 0, irrigated: 0, harvested: 0, total: 0 });
    expect(res.data.kpis).toEqual({ yieldTHa: null, onTimePercent: null, waterM3PerTon: null });
  });
});

describe('access', () => {
  it('a shepherd has no access to crops', async () => {
    const w = await world();
    const shepherd = await w.f.as('shepherd');
    expect((await shepherd.get('/crops/operations')).status).toBe(403);
    expect((await shepherd.post('/crops/operations', { type: 'tillage', date: today, fieldId: w.fieldId })).status).toBe(403);
    expect((await shepherd.get('/crops/plans')).status).toBe(403);
  });

  it('a mechanic records and completes work but cannot delete it or change plans', async () => {
    const w = await world();
    const plan = await makePlan(w);
    const mechanic = await w.f.as('mechanic');
    const op = await mechanic.post('/crops/operations', { type: 'tillage', status: 'planned', date: today, fieldId: w.fieldId });
    expect(op.status).toBe(201);
    expect((await mechanic.post(`/crops/operations/${op.data.id}/complete`, {})).status).toBe(200);
    expect((await mechanic.delete(`/crops/operations/${op.data.id}`)).status).toBe(403);
    expect((await mechanic.patch(`/crops/plans/${plan.id}`, { notes: 'x' })).status).toBe(403);
  });

  it('a storekeeper can read the journal but not write it', async () => {
    const w = await world();
    const storekeeper = await w.f.as('storekeeper');
    expect((await storekeeper.get('/crops/operations')).status).toBe(200);
    expect((await storekeeper.post('/crops/operations', { type: 'tillage', date: today, fieldId: w.fieldId })).status).toBe(403);
  });

  it("another tenant cannot see, use or change this farm's records", async () => {
    const w = await world();
    const owner = await w.f.as('owner');
    const plan = await makePlan(w);
    const op = await owner.post('/crops/operations', { type: 'tillage', date: today, fieldId: w.fieldId });

    const other = await createFixture();
    const stranger = await other.as('owner');
    expect((await stranger.get('/crops/operations')).body.meta.total).toBe(0);
    expect((await stranger.get('/crops/plans')).body.meta.total).toBe(0);
    expect((await stranger.get(`/crops/operations/${op.data.id}`)).status).toBe(404);
    expect((await stranger.get(`/crops/plans/${plan.id}`)).status).toBe(404);
    expect((await stranger.delete(`/crops/operations/${op.data.id}`)).status).toBe(404);
    const write = await stranger.post('/crops/operations', { type: 'tillage', date: today, fieldId: w.fieldId });
    expect(write.status).toBe(404);
  });
});
