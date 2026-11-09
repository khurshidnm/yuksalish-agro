import { addDays, todayIso } from '@yap/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tx } from '../src/core/context';
import { ensureCostCenter } from '../src/core/costCenters';
import { schema } from '../src/db/client';
import { createFixture, type Fixture } from './helpers';

const { crops, fields, seasons } = schema;

const today = todayIso();
const daysAgo = (n: number) => addDays(today, -n);

// Field work must never depend on the network.
beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

async function makeField(f: Fixture, number: string, areaHa: number) {
  return f.run(async () => {
    const [row] = await tx().insert(fields).values({ tenantId: f.tenantId, farmId: f.farmId, number, areaHa, landUse: 'arable' }).returning();
    const costCenterId = await ensureCostCenter('field', row.id, `Dala ${number}`);
    await tx().update(fields).set({ costCenterId }).where(eq(fields.id, row.id));
    return row.id;
  });
}

/**
 * A summer season that ended ten days ago and an autumn season that began sixty days ago: they
 * overlap by fifty days, as Yozgi and Kuzgi do here, where autumn sowing starts before the
 * summer crops are off.
 */
async function overlappingWorld() {
  const f = await createFixture();
  const field1 = await makeField(f, '1', 10);
  const field2 = await makeField(f, '2', 5);
  const ids = await f.run(async () => {
    const [summer] = await tx()
      .insert(seasons)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Yozgi', kind: 'summer', startDate: daysAgo(200), endDate: daysAgo(10) })
      .returning();
    const [autumn] = await tx()
      .insert(seasons)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Kuzgi', kind: 'autumn', startDate: daysAgo(60), endDate: addDays(today, 240) })
      .returning();
    const cropId = async (key: string) =>
      (await tx().select().from(crops).where(and(eq(crops.tenantId, f.tenantId), eq(crops.key, key))))[0].id;
    return { summerId: summer.id, autumnId: autumn.id, cornId: await cropId('corn'), alfalfaId: await cropId('alfalfa'), wheatId: await cropId('wheat') };
  });
  return { f, field1, field2, ...ids };
}

describe('crop figures follow the season chosen (audit crops.0, crops.1, crops.2)', () => {
  it('counts sown, irrigated and harvested fields in the chosen season, watering by its crop plan', async () => {
    const w = await overlappingWorld();
    const owner = await w.f.as('owner');
    // Last summer: corn on field 1 and alfalfa on field 2, both harvested, no watering recorded.
    const corn = await owner.post('/crops/plans', { seasonId: w.summerId, fieldId: w.field1, cropId: w.cornId });
    expect(corn.status).toBe(201);
    expect((await owner.post('/crops/plans', { seasonId: w.summerId, fieldId: w.field2, cropId: w.alfalfaId })).status).toBe(201);
    expect((await owner.post('/crops/harvests', { fieldId: w.field1, cropPlanId: corn.data.id, date: daysAgo(30), grossT: 30 })).status).toBe(201);
    const alfalfa = (await owner.get('/crops/plans', { seasonId: w.summerId })).data.find((p: any) => p.fieldId === w.field2);
    expect((await owner.post('/crops/harvests', { fieldId: w.field2, cropPlanId: alfalfa.id, date: daysAgo(20), grossT: 50 })).status).toBe(201);

    // This autumn: wheat on field 1, sown and watered on a day that both seasons' dates cover.
    const wheat = await owner.post('/crops/plans', { seasonId: w.autumnId, fieldId: w.field1, cropId: w.wheatId });
    expect(wheat.status).toBe(201);
    expect((await owner.post('/crops/operations', { type: 'sowing', date: daysAgo(15), fieldId: w.field1, areaDoneHa: 10 })).status).toBe(201);
    const watering = await owner.post('/crops/operations', { type: 'irrigation', date: daysAgo(12), fieldId: w.field1, waterM3: 9000 });
    expect(watering.status).toBe(201);
    expect(watering.data.cropPlanId).toBe(wheat.data.id);

    const summer = await owner.get('/crops/summary', { seasonId: w.summerId });
    expect(summer.status).toBe(200);
    // Before: the current season's 1 sown / 0 harvested, and the autumn watering counted in summer.
    expect(summer.data.fields).toEqual({ sown: 2, irrigated: 0, harvested: 2, total: 2 });
    expect(summer.data.harvest.actualT).toBe(80);

    const autumn = await owner.get('/crops/summary', { seasonId: w.autumnId });
    expect(autumn.data.fields).toEqual({ sown: 1, irrigated: 1, harvested: 0, total: 2 });
    // No season named: the current one, as the dashboard and investor report read it.
    expect((await owner.get('/crops/summary')).data.fields).toEqual(autumn.data.fields);

    // Hay and silage do not average: each crop's own yield, largest harvest first.
    expect(summer.data.yields.map((c: any) => [c.cropKey, c.harvestedT, c.areaHa, c.yieldTHa])).toEqual([
      ['alfalfa', 50, 5, 10],
      ['corn', 30, 10, 3],
    ]);

    // The season list says which season has a crop in, for the harvest page to open on.
    const list = await owner.get('/crops/seasons');
    expect(Object.fromEntries(list.data.map((s: any) => [s.name, s.lastHarvestDate]))).toEqual({ Yozgi: daysAgo(20), Kuzgi: null });
    expect((await owner.get('/crops/harvests', { seasonId: w.summerId })).body.meta.total).toBe(2);
    expect((await owner.get('/crops/harvests', { seasonId: w.autumnId })).body.meta.total).toBe(0);

    // A season of another farm is not found, never silently the current one.
    const other = await createFixture();
    const stranger = await other.as('owner');
    expect((await stranger.get('/crops/summary', { seasonId: w.summerId })).status).toBe(404);
  });

  it('plan against fact: no watering or cost recorded is unknown, not 0 m³ and 0 so\'m a ton', async () => {
    const w = await overlappingWorld();
    const owner = await w.f.as('owner');
    const corn = await owner.post('/crops/plans', { seasonId: w.summerId, fieldId: w.field1, cropId: w.cornId, expectedYieldTHa: 3 });
    await owner.post('/crops/harvests', { fieldId: w.field1, cropPlanId: corn.data.id, date: daysAgo(30), grossT: 30 });

    const fact = await owner.get('/crops/plan-fact', { seasonId: w.summerId });
    expect(fact.status).toBe(200);
    expect(fact.data.rows[0]).toMatchObject({
      cropKey: 'corn',
      harvestedT: 30,
      actualYieldTHa: 3,
      waterM3: null,
      waterM3PerTon: null,
      actualCost: null,
      costDeviation: null,
      costPerTon: null,
    });
    expect(fact.data.totals.waterM3).toBeNull();
    const summary = await owner.get('/crops/summary', { seasonId: w.summerId });
    expect(summary.data.kpis.waterM3PerTon).toBeNull();

    // Once watering is recorded, it counts: 9 000 m³ for 30 t is 300 m³ a ton.
    await owner.post('/crops/operations', { type: 'irrigation', date: daysAgo(100), fieldId: w.field1, cropPlanId: corn.data.id, waterM3: 9000 });
    const watered = await owner.get('/crops/plan-fact', { seasonId: w.summerId });
    expect(watered.data.rows[0]).toMatchObject({ waterM3: 9000, waterM3PerTon: 300 });
  });
});

describe('tech card work on a plan already under way (audit crops.11)', () => {
  const LINES = [
    { type: 'tillage', name: 'Haydash', offsetDays: -10 },
    { type: 'sowing', name: 'Ekish', offsetDays: 0, seedKgHa: 220 },
    { type: 'irrigation', name: 'Ekish suvi', offsetDays: 4, waterM3Ha: 900 },
    { type: 'fertilizing', name: 'Karbamid', offsetDays: 120 },
    { type: 'irrigation', name: "Bahorgi sug'orish", offsetDays: 150, waterM3Ha: 1000 },
  ];

  it('adds only the work from today on, dated from the actual sowing, and never a second sowing', async () => {
    const w = await overlappingWorld();
    const owner = await w.f.as('owner');
    const card = await owner.post('/crops/tech-cards', { cropId: w.wheatId, name: "Kuzgi bug'doy", lines: LINES, expectedYieldTHa: 5.5 });
    expect(card.status).toBe(201);
    const plan = await owner.post('/crops/plans', {
      seasonId: w.autumnId,
      fieldId: w.field1,
      cropId: w.wheatId,
      techCardId: card.data.id,
      sowingDatePlan: daysAgo(18),
    });
    expect(plan.status).toBe(201);
    // Sown three days after the plan said, with ploughing and the first watering recorded.
    await owner.post('/crops/operations', { type: 'tillage', date: daysAgo(25), fieldId: w.field1, areaDoneHa: 10 });
    await owner.post('/crops/operations', { type: 'sowing', date: daysAgo(15), fieldId: w.field1, areaDoneHa: 10 });
    await owner.post('/crops/operations', { type: 'irrigation', date: daysAgo(11), fieldId: w.field1, waterM3: 9000 });
    expect((await owner.get(`/crops/plans/${plan.data.id}`)).data.status).toBe('sown');

    const res = await owner.post(`/crops/plans/${plan.data.id}/generate-operations`);
    expect(res.status).toBe(200);
    // Before: all 5 lines, the ploughing, sowing and first watering at once overdue.
    expect(res.data).toEqual({ created: 2, total: 5 });

    const planned = await owner.get('/crops/operations', { cropPlanId: plan.data.id, status: 'planned', sort: 'date' });
    expect(planned.data.map((o: any) => [o.type, o.date])).toEqual([
      ['fertilizing', addDays(daysAgo(15), 120)],
      ['irrigation', addDays(daysAgo(15), 150)],
    ]);
    expect(planned.data.every((o: any) => !o.overdue)).toBe(true);

    // Repeating adds nothing.
    expect((await owner.post(`/crops/plans/${plan.data.id}/generate-operations`)).data).toEqual({ created: 0, total: 5 });
  });

  it('a harvested plan has nothing left to plan', async () => {
    const w = await overlappingWorld();
    const owner = await w.f.as('owner');
    const card = await owner.post('/crops/tech-cards', { cropId: w.cornId, name: 'Silos', lines: LINES.slice(0, 2) });
    const plan = await owner.post('/crops/plans', {
      seasonId: w.summerId,
      fieldId: w.field1,
      cropId: w.cornId,
      techCardId: card.data.id,
      sowingDatePlan: daysAgo(150),
    });
    await owner.post('/crops/harvests', { fieldId: w.field1, cropPlanId: plan.data.id, date: daysAgo(30), grossT: 30 });
    const res = await owner.post(`/crops/plans/${plan.data.id}/generate-operations`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_CLOSED');
  });
});
