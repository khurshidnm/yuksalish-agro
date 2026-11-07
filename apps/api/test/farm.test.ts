import { addDays, todayIso } from '@yap/shared';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tx } from '../src/core/context';
import { generalCostCenterId } from '../src/core/costCenters';
import { postTransaction } from '../src/core/ledger';
import { schema } from '../src/db/client';
import { jobs } from '../src/modules/farm/jobs';
import {
  forecast,
  getWeatherFor,
  refreshWeather,
  resetWeatherBackoff,
} from '../src/modules/farm/weather.service';
import { seedLand } from '../src/seed/land';
import { findCategory, findCrop } from '../src/seed/lookup';
import { SEED } from '../src/seed/names';
import type { SeedContext } from '../src/seed/types';
import { createFixture, type Fixture } from './helpers';

/** Metres per degree at latitude 39.5 on WGS84. */
const M_PER_DEG_LNG = 86_013;
const M_PER_DEG_LAT = 111_025;

function rect(lng: number, lat: number, widthM: number, heightM: number) {
  const dx = widthM / M_PER_DEG_LNG;
  const dy = heightM / M_PER_DEG_LAT;
  return {
    type: 'Polygon',
    coordinates: [[[lng, lat], [lng + dx, lat], [lng + dx, lat + dy], [lng, lat + dy], [lng, lat]]],
  };
}

const today = () => todayIso();
const uniqueTag = () => `T-${Math.random().toString(36).slice(2, 10)}`;

async function seedSeason(f: Fixture, name: string, startDate: string, endDate: string, isCurrent = false) {
  const [row] = await f.run(() =>
    tx()
      .insert(schema.seasons)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name, kind: 'autumn', startDate, endDate, isCurrent })
      .returning(),
  );
  return row;
}

async function seedPlan(
  f: Fixture,
  over: { seasonId: string; fieldId: string; crop: string; areaHa: number; status?: string; variety?: string },
) {
  return f.run(async () => {
    const crop = await findCrop(over.crop);
    const [row] = await tx()
      .insert(schema.cropPlans)
      .values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        seasonId: over.seasonId,
        fieldId: over.fieldId,
        cropId: crop.id,
        areaHa: over.areaHa,
        status: over.status ?? 'harvested',
        variety: over.variety,
      })
      .returning();
    return row;
  });
}

async function seedHarvest(f: Fixture, fieldId: string, cropPlanId: string, grossT: number, date: string) {
  await f.run(() =>
    tx().insert(schema.harvests).values({ tenantId: f.tenantId, farmId: f.farmId, fieldId, cropPlanId, grossT, date }),
  );
}

describe('passport', () => {
  it('balances the land against the farm total, excluding archived contours', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const patched = await owner.patch('/farm/passport', { totalAreaHa: 210 });
    expect(patched.status).toBe(200);
    expect(patched.data.areaBalance.unassignedHa).toBe(210);

    await owner.post('/farm/fields', { number: '1', areaHa: 70, landUse: 'arable' });
    await owner.post('/farm/fields', { number: 'Y-1', areaHa: 110, landUse: 'pasture' });
    await owner.post('/farm/fields', { number: 'Z-1', areaHa: 20, landUse: 'reserve' });
    const old = await owner.post('/farm/fields', { number: 'OLD', areaHa: 5, landUse: 'reserve' });
    await owner.delete(`/farm/fields/${old.data.id}`);

    const { data } = await owner.get('/farm/passport');
    expect(data.areaBalance).toMatchObject({ totalAreaHa: 210, assignedHa: 200, unassignedHa: 10, overAssigned: false });
    const byUse = Object.fromEntries(data.areaBalance.byLandUse.map((r: any) => [r.landUse, r.areaHa]));
    expect(byUse).toEqual({ arable: 70, pasture: 110, reserve: 20, yard: 0, infrastructure: 0 });

    await owner.post('/farm/fields', { number: 'H-1', areaHa: 16, landUse: 'yard' });
    const over = await owner.get('/farm/passport');
    expect(over.data.areaBalance).toMatchObject({ assignedHa: 216, unassignedHa: -6, overAssigned: true });
  });

  it('keeps earlier details when patching part of the passport', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await owner.patch('/farm/passport', { passport: { leaseContractNo: 'L-1', landRightType: 'ijara' } });
    const { data } = await owner.patch('/farm/passport', { passport: { leaseValidUntil: '2036-01-01' } });
    expect(data.passport).toMatchObject({ leaseContractNo: 'L-1', landRightType: 'ijara', leaseValidUntil: '2036-01-01' });
  });

  it('hides responsible people\'s phones without pii.view, and saving does not wipe them', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const agronomist = await f.as('agronomist');
    await owner.patch('/farm/passport', {
      passport: { responsiblePersons: [{ role: 'Rahbar', fullName: 'Ali Valiyev', phone: '+998901112233' }] },
    });

    const seen = await agronomist.get('/farm/passport');
    expect(seen.data.passport.responsiblePersons[0]).toMatchObject({ fullName: 'Ali Valiyev', phone: null });
    expect(JSON.stringify(seen.body)).not.toContain('+998901112233');

    const saved = await agronomist.patch('/farm/passport', {
      passport: { responsiblePersons: seen.data.passport.responsiblePersons },
    });
    expect(saved.status).toBe(200);
    const still = await owner.get('/farm/passport');
    expect(still.data.passport.responsiblePersons[0].phone).toBe('+998901112233');
  });

  it('is limited by role', async () => {
    const f = await createFixture();
    expect((await (await f.as('shepherd')).get('/farm/passport')).status).toBe(403);
    expect((await (await f.as('investor')).get('/farm/passport')).status).toBe(403);
    const mechanic = await f.as('mechanic');
    expect((await mechanic.get('/farm/passport')).status).toBe(200);
    expect((await mechanic.patch('/farm/passport', { totalAreaHa: 1 })).status).toBe(403);
    const accountant = await f.as('accountant');
    expect((await accountant.post('/farm/fields', { number: '9', areaHa: 1 })).status).toBe(403);
  });

  it('journals the change and shows the tenant legal name read-only', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { data } = await owner.patch('/farm/passport', { address: 'Qorovulbozor' });
    expect(data.address).toBe('Qorovulbozor');
    expect(data.tenant.name).toContain('Test');
    const events = await f.run(() => tx().select().from(schema.events).where(eq(schema.events.type, 'farm.passport_updated')));
    expect(events).toHaveLength(1);
    expect(events[0].createdBy).toBe(owner.userId);
  });
});

describe('fields', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  it('measures a drawn boundary with PostGIS (500 m × 400 m = 20 ha)', async () => {
    const owner = await f.as('owner');
    const res = await owner.post('/farm/fields', { number: 'A1', boundary: rect(64.8, 39.5, 500, 400), soilType: "O'tloqi" });
    expect(res.status).toBe(201);
    expect(res.data.areaHa).toBeGreaterThan(19.95);
    expect(res.data.areaHa).toBeLessThan(20.05);
  });

  it('prefers the measured area over a hand-entered one', async () => {
    const owner = await f.as('owner');
    const res = await owner.post('/farm/fields', { number: 'A2', areaHa: 999, boundary: rect(64.81, 39.5, 100, 100) });
    expect(res.data.areaHa).toBeCloseTo(1, 1);
  });

  it('accepts a manual area without a boundary, and refuses neither', async () => {
    const owner = await f.as('owner');
    const manual = await owner.post('/farm/fields', { number: 'A3', areaHa: 12.5 });
    expect(manual.status).toBe(201);
    expect(manual.data.areaHa).toBe(12.5);
    expect(manual.data.boundary).toBeNull();

    const none = await owner.post('/farm/fields', { number: 'A4' });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('AREA_REQUIRED');
  });

  it('remeasures when the boundary changes, and guards a manual area on a drawn field', async () => {
    const owner = await f.as('owner');
    const { data: created } = await owner.post('/farm/fields', { number: 'A5', boundary: rect(64.82, 39.5, 100, 100) });
    const larger = await owner.patch(`/farm/fields/${created.id}`, { boundary: rect(64.82, 39.5, 200, 200) });
    expect(larger.data.areaHa).toBeCloseTo(4, 1);

    const refused = await owner.patch(`/farm/fields/${created.id}`, { areaHa: 7 });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('AREA_FROM_BOUNDARY');

    const same = await owner.patch(`/farm/fields/${created.id}`, { areaHa: larger.data.areaHa, notes: 'x' });
    expect(same.status).toBe(200);

    const cleared = await owner.patch(`/farm/fields/${created.id}`, { boundary: null, areaHa: 7 });
    expect(cleared.data).toMatchObject({ boundary: null, areaHa: 7 });
  });

  it('refuses a self-crossing outline rather than measuring it', async () => {
    const owner = await f.as('owner');
    const bowTie = { type: 'Polygon', coordinates: [[[64.8, 39.5], [64.81, 39.51], [64.81, 39.5], [64.8, 39.51], [64.8, 39.5]]] };
    const res = await owner.post('/farm/fields', { number: 'B1', boundary: bowTie });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_GEOMETRY');
  });

  it.each([
    ['open ring', { type: 'Polygon', coordinates: [[[64.8, 39.5], [64.81, 39.5], [64.81, 39.51], [64.8, 39.51]]] }],
    ['too few points', { type: 'Polygon', coordinates: [[[64.8, 39.5], [64.81, 39.5], [64.8, 39.5]]] }],
    ['longitude out of range', { type: 'Polygon', coordinates: [[[500, 39.5], [64.81, 39.5], [64.81, 39.51], [500, 39.5]]] }],
    ['a point is not an area', { type: 'Point', coordinates: [64.8, 39.5] }],
  ])('validates geometry: %s', async (_label, boundary) => {
    const owner = await f.as('owner');
    const res = await owner.post('/farm/fields', { number: 'B2', boundary });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('gives arable fields a cost center that follows renames', async () => {
    const owner = await f.as('owner');
    const { data: field } = await owner.post('/farm/fields', { number: 'C1', name: 'Katta', areaHa: 3 });
    expect(field.costCenterId).toBeTruthy();
    await owner.patch(`/farm/fields/${field.id}`, { name: 'Kichik' });
    const [cc] = await f.run(() => tx().select().from(schema.costCenters).where(eq(schema.costCenters.id, field.costCenterId)));
    expect(cc).toMatchObject({ type: 'field', refId: field.id, name: '№C1 Kichik', active: true });
  });

  it.each(['pasture', 'reserve'])('gives %s land a cost center that the expense form offers', async (landUse) => {
    const owner = await f.as('owner');
    const { data: land } = await owner.post('/farm/fields', { number: `L-${landUse}`, name: 'Janubiy', areaHa: 3, landUse });
    expect(land.costCenterId).toBeTruthy();
    const offered = await owner.get('/finance/cost-centers/lookup', { type: 'field', search: `L-${landUse}` });
    expect(offered.data).toEqual([{ id: land.costCenterId, name: `№L-${landUse} Janubiy`, type: 'field', refId: land.id }]);
  });

  it('gives a yard or a road no cost center until it becomes land that has one', async () => {
    const owner = await f.as('owner');
    const { data: yard } = await owner.post('/farm/fields', { number: 'C2', areaHa: 3, landUse: 'yard' });
    expect(yard.costCenterId).toBeNull();
    const { data: road } = await owner.post('/farm/fields', { number: 'C3', areaHa: 1, landUse: 'infrastructure' });
    expect(road.costCenterId).toBeNull();
    const converted = await owner.patch(`/farm/fields/${yard.id}`, { landUse: 'pasture' });
    expect(converted.data.costCenterId).toBeTruthy();
  });

  it('keeps the cost center of a pasture in step when it is renamed or archived', async () => {
    const owner = await f.as('owner');
    const { data: pasture } = await owner.post('/farm/fields', { number: 'C4', name: 'Eski', areaHa: 3, landUse: 'pasture' });
    await owner.patch(`/farm/fields/${pasture.id}`, { name: 'Yangi' });
    const center = () => f.run(() => tx().select().from(schema.costCenters).where(eq(schema.costCenters.id, pasture.costCenterId)));
    expect((await center())[0]).toMatchObject({ name: '№C4 Yangi', active: true });
    expect((await owner.delete(`/farm/fields/${pasture.id}`)).status).toBe(200);
    expect((await center())[0].active).toBe(false);
  });

  it('charges a fence to the pasture, while overhead by area stays on arable land', async () => {
    const g = await createFixture({ settings: { finance: { overheadBase: 'area' } } });
    const owner = await g.as('owner');
    const { data: arable } = await owner.post('/farm/fields', { number: 'A1', areaHa: 30 });
    const { data: pasture } = await owner.post('/farm/fields', { number: 'Y1', areaHa: 70, landUse: 'pasture' });
    const [till, general, repair] = await g.run(async () => {
      const [account] = await tx().insert(schema.accounts).values({ tenantId: g.tenantId, farmId: g.farmId, name: 'Kassa', type: 'cash', openingBalance: 5_000_000 }).returning();
      const [category] = await tx().select().from(schema.financeCategories).where(sql`tenant_id = ${g.tenantId} and key = 'repair'`);
      return [account.id, await generalCostCenterId(), category.id];
    });
    const spend = (amount: number, costCenterId: string) =>
      owner.post('/finance/transactions', { date: todayIso(), type: 'expense', amount, categoryId: repair, costCenterId, paymentMethod: 'cash', accountId: till });
    expect((await spend(400_000, pasture.costCenterId)).status).toBe(201);
    expect((await spend(1_000_000, general)).status).toBe(201);

    const costs = (await owner.get('/finance/costs/centers')).data;
    const of = (id: string) => costs.find((row: any) => row.costCenterId === id);
    // The pasture holds 70 of 100 ha, but overhead by area is shared over arable land only: all of it on A1.
    expect(of(pasture.costCenterId)).toMatchObject({ direct: 400_000, overhead: 0, total: 400_000 });
    expect(of(arable.costCenterId)).toMatchObject({ direct: 0, overhead: 1_000_000, total: 1_000_000 });
    expect(of(general).total).toBe(0);
  });

  it('refuses a duplicate number with a clear code', async () => {
    const owner = await f.as('owner');
    await owner.post('/farm/fields', { number: 'D1', areaHa: 1 });
    const again = await owner.post('/farm/fields', { number: 'D1', areaHa: 1 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('FIELD_NUMBER_TAKEN');
    const other = await owner.post('/farm/fields', { number: 'D2', areaHa: 1 });
    const renamed = await owner.patch(`/farm/fields/${other.data.id}`, { number: 'D1' });
    expect(renamed.status).toBe(409);
  });

  it('keeps a client-supplied id', async () => {
    const owner = await f.as('owner');
    const id = '0190a7e2-7b1c-7c3d-8e4f-1234567890aa';
    const res = await owner.post('/farm/fields', { id, number: 'E1', areaHa: 1 });
    expect(res.data.id).toBe(id);
  });

  it('lists in natural number order with filters, without sending outlines', async () => {
    const g = await createFixture();
    const owner = await g.as('owner');
    for (const number of ['10', '2', '1']) await owner.post('/farm/fields', { number, areaHa: 1 });
    await owner.post('/farm/fields', { number: 'Y-1', landUse: 'pasture', boundary: rect(64.8, 39.5, 300, 300) });

    const all = await owner.get('/farm/fields');
    expect(all.body.data.map((x: any) => x.number)).toEqual(['1', '2', '10', 'Y-1']);
    expect(all.body.data[3].hasBoundary).toBe(true);
    expect(all.body.data[3].boundary).toBeUndefined();

    const pasture = await owner.get('/farm/fields', { landUse: 'pasture' });
    expect(pasture.body.meta.total).toBe(1);
    expect((await owner.get('/farm/fields', { search: 'Y-' })).body.meta.total).toBe(1);
    expect((await owner.get('/farm/fields', { sort: '-areaHa' })).body.data[0].number).toBe('Y-1');
  });

  it('archives a field but not while a crop is in progress', async () => {
    const owner = await f.as('owner');
    const { data: field } = await owner.post('/farm/fields', { number: 'F1', areaHa: 4 });
    const season = await seedSeason(f, 'Mavsum F', '2026-10-01', '2027-07-01', true);
    const plan = await seedPlan(f, { seasonId: season.id, fieldId: field.id, crop: 'wheat', areaHa: 4, status: 'sown' });

    const blocked = await owner.delete(`/farm/fields/${field.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('FIELD_HAS_ACTIVE_CROP');

    await f.run(() => tx().update(schema.cropPlans).set({ status: 'cancelled' }).where(eq(schema.cropPlans.id, plan.id)));
    expect((await owner.delete(`/farm/fields/${field.id}`)).status).toBe(200);

    const list = await owner.get('/farm/fields', { search: 'F1' });
    expect(list.body.data).toEqual([]);
    expect((await owner.get('/farm/fields', { search: 'F1', status: 'archived' })).body.meta.total).toBe(1);
    expect((await owner.get('/farm/fields/lookup', { search: 'F1' })).data).toEqual([]);
    // The card stays reachable: old operations and reports link to it.
    expect((await owner.get(`/farm/fields/${field.id}`)).status).toBe(200);
  });

  it('only owner and director may archive; an agronomist may edit', async () => {
    const owner = await f.as('owner');
    const agronomist = await f.as('agronomist');
    const { data: field } = await owner.post('/farm/fields', { number: 'G1', areaHa: 1 });
    expect((await agronomist.patch(`/farm/fields/${field.id}`, { notes: 'ok' })).status).toBe(200);
    expect((await agronomist.delete(`/farm/fields/${field.id}`)).status).toBe(403);
  });

  it('reports contours sharing ground, ignoring neighbours that only touch', async () => {
    const g = await createFixture();
    const owner = await g.as('owner');
    const west = rect(64.8, 39.5, 500, 400);
    const { data: first } = await owner.post('/farm/fields', { number: '1', boundary: west });
    expect(first.overlaps).toEqual([]);

    // Starts exactly where the first one ends: a shared edge, no shared ground.
    const neighbour = await owner.post('/farm/fields', { number: '2', boundary: rect(64.8 + 500 / M_PER_DEG_LNG, 39.5, 300, 400) });
    expect(neighbour.data.overlaps).toEqual([]);

    // 100 m wide strip of the first field, 400 m long: 4 ha.
    const overlapping = await owner.post('/farm/fields', { number: '3', boundary: rect(64.8 + 400 / M_PER_DEG_LNG, 39.5, 200, 400) });
    expect(overlapping.status).toBe(201);
    const [one, two] = [...overlapping.data.overlaps].sort((a: any, b: any) => a.number.localeCompare(b.number));
    expect(one.number).toBe('1');
    expect(one.overlapHa).toBeCloseTo(4, 1);
    expect(two.number).toBe('2');
    expect(two.overlapHa).toBeCloseTo(4, 1);

    const moved = await owner.patch(`/farm/fields/${overlapping.data.id}`, { boundary: rect(64.9, 39.5, 200, 400) });
    expect(moved.data.overlaps).toEqual([]);

    await owner.delete(`/farm/fields/${neighbour.data.id}`);
    const overArchived = await owner.patch(`/farm/fields/${moved.data.id}`, { boundary: rect(64.8 + 500 / M_PER_DEG_LNG, 39.5, 300, 400) });
    expect(overArchived.data.overlaps).toEqual([]);
  });

  it('has no overlaps to report for a contour with no outline', async () => {
    const owner = await f.as('owner');
    const res = await owner.post('/farm/fields', { number: 'NB', areaHa: 2 });
    expect(res.data.overlaps).toEqual([]);
  });

  it('writes journal and audit entries', async () => {
    const owner = await f.as('owner');
    const { data: field } = await owner.post('/farm/fields', { number: 'H1', areaHa: 1 });
    await owner.patch(`/farm/fields/${field.id}`, { notes: 'changed' });
    const { events, audit } = await f.run(async () => ({
      events: await tx().select().from(schema.events).where(eq(schema.events.entityId, field.id)),
      audit: await tx().select().from(schema.auditLogs).where(sql`entity = 'fields' and entity_id = ${field.id}`),
    }));
    expect(events.map((e) => e.type).sort()).toEqual(['field.created', 'field.updated']);
    expect(audit.some((a) => a.action === 'update' && (a.after as any).notes === 'changed')).toBe(true);
  });
});

describe('field card', () => {
  it('shows the current crop, five years of rotation with yield, and soil history', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { data: field } = await owner.post('/farm/fields', { number: '1', areaHa: 12, soilType: 'Bo\'z tuproq' });

    const year = Number(today().slice(0, 4));
    const old = await seedSeason(f, 'Eski', `${year - 7}-03-01`, `${year - 7}-10-01`);
    const past = await seedSeason(f, 'Oldingi', `${year - 1}-03-01`, `${year - 1}-10-01`);
    const prior = await seedSeason(f, 'Undan oldingi', `${year - 2}-03-01`, `${year - 2}-10-01`);
    const current = await seedSeason(f, 'Joriy', `${year}-10-01`, `${year + 1}-07-01`, true);

    await seedPlan(f, { seasonId: old.id, fieldId: field.id, crop: 'rice', areaHa: 12 });
    const alfalfa = await seedPlan(f, { seasonId: past.id, fieldId: field.id, crop: 'alfalfa', areaHa: 12, variety: 'Toshkent-1' });
    await seedHarvest(f, field.id, alfalfa.id, 40, `${year - 1}-06-01`);
    await seedHarvest(f, field.id, alfalfa.id, 20, `${year - 1}-08-01`);
    await seedPlan(f, { seasonId: prior.id, fieldId: field.id, crop: 'barley', areaHa: 12 });
    const wheat = await seedPlan(f, { seasonId: current.id, fieldId: field.id, crop: 'wheat', areaHa: 12, status: 'sown' });

    await owner.post(`/farm/fields/${field.id}/soil`, { date: '2026-09-01', ph: 7.6, humus: 1.2, n: 18, p: 22, k: 210, salinity: 0.4, lab: 'Buxoro AgroLab' });
    await owner.post(`/farm/fields/${field.id}/soil`, { date: '2024-09-01', ph: 7.9, humus: 1.0 });

    const { data, status } = await owner.get(`/farm/fields/${field.id}`);
    expect(status).toBe(200);
    expect(data.currentCrop).toMatchObject({ planId: wheat.id, cropKey: 'wheat', status: 'sown', seasonName: 'Joriy' });
    expect(data.currentCrop.cropName.uz).toBe("Bug'doy");

    // The season from seven years ago is out of range.
    expect(data.rotation.map((r: any) => r.cropKey)).toEqual(['wheat', 'alfalfa', 'barley']);
    const row = data.rotation.find((r: any) => r.cropKey === 'alfalfa');
    expect(row).toMatchObject({ variety: 'Toshkent-1', harvestT: 60, yieldTHa: 5 });
    // No harvest recorded is unknown, not zero.
    expect(data.rotation.find((r: any) => r.cropKey === 'barley')).toMatchObject({ harvestT: null, yieldTHa: null });

    expect(data.soilAnalyses.map((s: any) => s.date)).toEqual(['2024-09-01', '2026-09-01']);
    expect(data.soilAnalyses[1]).toMatchObject({ ph: 7.6, k: 210 });
  });

  it('does not call a harvested past crop current, but shows what is planned next', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { data: field } = await owner.post('/farm/fields', { number: '2', areaHa: 5 });
    const past = await seedSeason(f, 'Oldingi', '2025-03-01', '2025-10-01');
    await seedPlan(f, { seasonId: past.id, fieldId: field.id, crop: 'barley', areaHa: 5 });
    expect((await owner.get(`/farm/fields/${field.id}`)).data.currentCrop).toBeNull();

    const next = await seedSeason(f, 'Keyingi', '2027-05-01', '2027-10-01');
    await seedPlan(f, { seasonId: next.id, fieldId: field.id, crop: 'rice', areaHa: 5, status: 'planned' });
    const list = await owner.get('/farm/fields');
    expect(list.body.data[0].currentCrop).toMatchObject({ cropKey: 'rice', status: 'planned' });
  });
});

describe('field cost in the rotation', () => {
  it('shows cost per ton from the finance engine, to finance roles only (rule 7)', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const agronomist = await f.as('agronomist');
    const { data: field } = await owner.post('/farm/fields', { number: '1', areaHa: 12 });
    const season = await seedSeason(f, 'Oldingi', '2025-10-01', '2026-07-01');
    const plan = await seedPlan(f, { seasonId: season.id, fieldId: field.id, crop: 'wheat', areaHa: 12 });
    await seedHarvest(f, field.id, plan.id, 60, '2026-06-15');
    await f.run(async () => {
      const seed = await findCategory('seed');
      await postTransaction({
        date: '2025-10-20',
        type: 'expense',
        amount: 12_000_000,
        categoryId: seed.id,
        costCenterId: field.costCenterId,
        paymentMethod: 'non_cash',
        autoApprove: true,
      });
    });

    // 12 000 000 so'm of seed over 60 t of grain: 200 000 so'm per ton.
    const row = (await owner.get(`/farm/fields/${field.id}`)).data.rotation[0];
    expect(row).toMatchObject({ harvestT: 60, yieldTHa: 5, costPerTon: 200_000 });

    const hidden = await agronomist.get(`/farm/fields/${field.id}`);
    expect(hidden.data.rotation[0]).toMatchObject({ harvestT: 60, costPerTon: null });
    expect(JSON.stringify(hidden.body)).not.toContain('200000');
  });

  it('calls a harvest with no recorded cost unknown, not free (rule 5)', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { data: field } = await owner.post('/farm/fields', { number: '1', areaHa: 12 });
    const season = await seedSeason(f, 'Oldingi', '2025-10-01', '2026-07-01');
    const plan = await seedPlan(f, { seasonId: season.id, fieldId: field.id, crop: 'wheat', areaHa: 12 });
    await seedHarvest(f, field.id, plan.id, 60, '2026-06-15');
    expect((await owner.get(`/farm/fields/${field.id}`)).data.rotation[0]).toMatchObject({ harvestT: 60, costPerTon: null });
  });

  it('has no cost per ton before a harvest', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { data: field } = await owner.post('/farm/fields', { number: '1', areaHa: 12 });
    const season = await seedSeason(f, 'Joriy', '2026-10-01', '2027-07-01', true);
    await seedPlan(f, { seasonId: season.id, fieldId: field.id, crop: 'wheat', areaHa: 12, status: 'sown' });
    expect((await owner.get(`/farm/fields/${field.id}`)).data.rotation[0]).toMatchObject({ harvestT: null, costPerTon: null });
  });
});

describe('soil analyses', () => {
  it('validates ranges, and edits and deletes', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { data: field } = await owner.post('/farm/fields', { number: '1', areaHa: 5 });

    const bad = await owner.post(`/farm/fields/${field.id}/soil`, { date: '2026-09-01', ph: 15 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fieldErrors.ph).toBeTruthy();

    const { data: soil } = await owner.post(`/farm/fields/${field.id}/soil`, { date: '2026-09-01', ph: 7 });
    const edited = await owner.patch(`/farm/soil/${soil.id}`, { ph: 7.5 });
    expect(edited.data.ph).toBe(7.5);
    expect((await owner.delete(`/farm/soil/${soil.id}`)).status).toBe(200);
    expect((await owner.get(`/farm/fields/${field.id}/soil`)).data).toEqual([]);
    expect((await owner.patch(`/farm/soil/${soil.id}`, { ph: 7 })).status).toBe(404);
  });

  it('refuses a missing field', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const res = await owner.post('/farm/fields/0190a7e2-7b1c-7c3d-8e4f-123456789000/soil', { date: '2026-09-01' });
    expect(res.status).toBe(404);
  });
});

describe('facilities', () => {
  async function seedAnimals(f: Fixture, facilityId: string, sectionId: string) {
    return f.run(async () => {
      const [species] = await tx().select().from(schema.species).where(eq(schema.species.key, 'sheep'));
      const [herd] = await tx()
        .insert(schema.herds)
        .values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Poda', facilityId })
        .returning();
      const base = { tenantId: f.tenantId, farmId: f.farmId, speciesId: species.id, sex: 'female', category: 'ewe', origin: 'purchased', herdId: herd.id };
      await tx().insert(schema.animals).values([
        { ...base, tag: uniqueTag(), status: 'active' },
        { ...base, tag: uniqueTag(), status: 'pregnant' },
        { ...base, tag: uniqueTag(), status: 'sick' },
        { ...base, tag: uniqueTag(), status: 'sold' },
        { ...base, tag: uniqueTag(), status: 'dead' },
        { ...base, tag: uniqueTag(), status: 'quarantine', facilityId: sectionId },
      ]);
    });
  }

  it('counts animals on the farm against capacity, rolling sections up to the barn', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { data: barn } = await owner.post('/farm/facilities', { type: 'barn', name: 'Molxona №1', capacity: 1000, capacityUnit: 'bosh' });
    const { data: section } = await owner.post('/farm/facilities', { type: 'barn', name: 'A bo\'lim', capacity: 100, parentId: barn.id });
    await seedAnimals(f, barn.id, section.id);

    // Herd in the barn: active, pregnant, sick. Sold and dead do not count. One is in section A.
    const { data } = await owner.get(`/farm/facilities/${barn.id}`);
    expect(data).toMatchObject({ occupiedHead: 4, capacityUsePercent: 0.4 });
    expect(data.sections).toHaveLength(1);
    expect(data.sections[0]).toMatchObject({ name: "A bo'lim", occupiedHead: 1, capacityUsePercent: 1 });

    const list = await owner.get('/farm/facilities', { type: 'barn' });
    expect(list.body.data.find((x: any) => x.id === barn.id).occupiedHead).toBe(4);
  });

  it('will not archive a barn with animals or with sections', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { data: barn } = await owner.post('/farm/facilities', { type: 'barn', name: 'B', capacity: 10 });
    const { data: section } = await owner.post('/farm/facilities', { type: 'barn', name: 'S', parentId: barn.id });
    await seedAnimals(f, barn.id, section.id);
    const occupied = await owner.delete(`/farm/facilities/${barn.id}`);
    expect(occupied.status).toBe(409);
    expect(occupied.body.error.code).toBe('FACILITY_OCCUPIED');

    const { data: empty } = await owner.post('/farm/facilities', { type: 'barn', name: 'E' });
    await owner.post('/farm/facilities', { type: 'barn', name: 'E1', parentId: empty.id });
    const withSections = await owner.delete(`/farm/facilities/${empty.id}`);
    expect(withSections.body.error.code).toBe('FACILITY_HAS_SECTIONS');
  });

  it('validates parents and coordinates', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { data: barn } = await owner.post('/farm/facilities', { type: 'barn', name: 'B' });
    const { data: section } = await owner.post('/farm/facilities', { type: 'barn', name: 'S', parentId: barn.id });

    const nested = await owner.post('/farm/facilities', { type: 'barn', name: 'N', parentId: section.id });
    expect(nested.body.error.code).toBe('INVALID_PARENT');
    const self = await owner.patch(`/farm/facilities/${barn.id}`, { parentId: barn.id });
    expect(self.body.error.code).toBe('INVALID_PARENT');
    const half = await owner.post('/farm/facilities', { type: 'well', name: 'Q', lat: 39.5 });
    expect(half.body.error.code).toBe('COORDINATES_INCOMPLETE');
  });

  it('measures a building outline; a road is a line with no area', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const building = await owner.post('/farm/facilities', { type: 'warehouse', name: 'Ombor', boundary: rect(64.8, 39.5, 100, 100) });
    expect(building.data.areaHa).toBeCloseTo(1, 1);
    const road = await owner.post('/farm/facilities', {
      type: 'road',
      name: "Yo'l",
      boundary: { type: 'LineString', coordinates: [[64.8, 39.5], [64.81, 39.51]] },
    });
    expect(road.status).toBe(201);
    expect(road.data.areaHa).toBeNull();
    const removed = await owner.patch(`/farm/facilities/${building.data.id}`, { boundary: null });
    expect(removed.data.areaHa).toBeNull();
  });

  it('archives an empty facility and hides it from the lookup', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    const { data: well } = await owner.post('/farm/facilities', { type: 'well', name: 'Quduq', lat: 39.5, lng: 64.8 });
    const seen = await shepherd.get('/farm/facilities/lookup', { type: 'well' });
    expect(seen.status).toBe(200);
    expect(seen.data).toEqual([{ id: well.id, name: 'Quduq', type: 'well', parentId: null }]);
    expect((await owner.delete(`/farm/facilities/${well.id}`)).status).toBe(200);
    expect((await shepherd.get('/farm/facilities/lookup', { type: 'well' })).data).toEqual([]);
  });
});

describe('irrigation network', () => {
  it('compares the water limit with actual use from the irrigation journal', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { data: a } = await owner.post('/farm/fields', { number: 'A', areaHa: 5 });
    const { data: b } = await owner.post('/farm/fields', { number: 'B', areaHa: 5 });
    const { data: c } = await owner.post('/farm/fields', { number: 'C', areaHa: 5 });
    const { data: node } = await owner.post('/farm/irrigation', {
      type: 'canal',
      name: 'Kanal',
      limitM3: 1000,
      capacityM3h: 50,
      fieldIds: [a.id, b.id],
    });

    await f.run(() => {
      const op = (fieldId: string, date: string, waterM3: number, type = 'irrigation', status = 'done') => ({
        tenantId: f.tenantId, farmId: f.farmId, fieldId, date, waterM3, type, status,
      });
      return tx().insert(schema.fieldOperations).values([
        op(a.id, '2026-06-01', 400),
        op(b.id, '2026-07-01', 700),
        op(a.id, '2026-07-02', 999, 'irrigation', 'planned'), // not done
        op(a.id, '2026-07-03', 999, 'fertilizing'), // not irrigation
        op(c.id, '2026-07-04', 300), // field not on this node
        op(a.id, '2025-07-01', 500), // outside the period
      ]);
    });

    const { body } = await owner.get('/farm/irrigation', { from: '2026-01-01', to: '2026-12-31' });
    const row = body.data.find((n: any) => n.id === node.id);
    expect(row).toMatchObject({ actualM3: 1100, usedPercent: 110, overLimit: true, limitM3: 1000 });

    const half = await owner.get('/farm/irrigation', { from: '2026-01-01', to: '2026-06-30' });
    expect(half.body.data[0]).toMatchObject({ actualM3: 400, usedPercent: 40, overLimit: false });
  });

  it('has no percentage without a limit, and refuses unknown fields', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { data: node } = await owner.post('/farm/irrigation', { type: 'pump', name: 'Nasos' });
    expect((await owner.get('/farm/irrigation')).body.data[0]).toMatchObject({ limitM3: null, usedPercent: null, overLimit: false });

    const bad = await owner.patch(`/farm/irrigation/${node.id}`, { fieldIds: ['0190a7e2-7b1c-7c3d-8e4f-123456789001'] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_FIELD');
  });

  it('keeps linked fields on a partial update, then deletes', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { data: a } = await owner.post('/farm/fields', { number: 'A', areaHa: 5 });
    const { data: node } = await owner.post('/farm/irrigation', { type: 'ditch', name: 'Ariq', fieldIds: [a.id] });
    const patched = await owner.patch(`/farm/irrigation/${node.id}`, { limitM3: 5 });
    expect(patched.data.fieldIds).toEqual([a.id]);
    expect((await owner.delete(`/farm/irrigation/${node.id}`)).status).toBe(200);
    expect((await owner.delete(`/farm/irrigation/${node.id}`)).status).toBe(404);
  });
});

describe('documents', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
    const owner = await f.as('owner');
    const now = today();
    for (const doc of [
      { title: 'Muddati o\'tgan', expiryDate: addDays(now, -1) },
      { title: 'Tez tugaydi', expiryDate: addDays(now, 10) },
      { title: 'Uzoq muddat', expiryDate: addDays(now, 100) },
      { title: 'Muddatsiz' },
    ]) {
      await owner.post('/farm/documents', { type: 'land', ...doc });
    }
  });

  it('marks and filters by expiry', async () => {
    const owner = await f.as('owner');
    const titles = (r: any) => r.body.data.map((d: any) => d.title);

    expect(titles(await owner.get('/farm/documents', { expiry: 'expired' }))).toEqual(["Muddati o'tgan"]);
    expect(titles(await owner.get('/farm/documents', { expiry: 'expiring' }))).toEqual(['Tez tugaydi']);
    expect(titles(await owner.get('/farm/documents', { expiry: 'expiring', withinDays: 5 }))).toEqual([]);

    const all = await owner.get('/farm/documents');
    const state = Object.fromEntries(all.body.data.map((d: any) => [d.title, d.expiryState]));
    expect(state).toEqual({
      "Muddati o'tgan": 'expired',
      'Tez tugaydi': 'expiring',
      'Uzoq muddat': 'valid',
      Muddatsiz: null,
    });
    // Whatever needs attention comes first.
    expect(all.body.data[0].title).toBe("Muddati o'tgan");
    expect(all.body.data.at(-1).title).toBe('Muddatsiz');
  });

  it('links to any object and filters by it', async () => {
    const owner = await f.as('owner');
    const entityId = '0190a7e2-7b1c-7c3d-8e4f-123456789002';
    await owner.post('/farm/documents', { type: 'vet_certificate', title: 'Guvohnoma', entityType: 'animal', entityId });
    const res = await owner.get('/farm/documents', { entityType: 'animal', entityId });
    expect(res.body.data.map((d: any) => d.title)).toEqual(['Guvohnoma']);

    const half = await owner.post('/farm/documents', { type: 'other', title: 'X', entityType: 'animal' });
    expect(half.body.error.code).toBe('ENTITY_INCOMPLETE');
  });

  it('refuses dates in the wrong order, also when patching one date', async () => {
    const owner = await f.as('owner');
    const bad = await owner.post('/farm/documents', { type: 'permit', title: 'X', issueDate: '2026-02-01', expiryDate: '2026-01-01' });
    expect(bad.body.error.code).toBe('EXPIRY_BEFORE_ISSUE');
    const { data: doc } = await owner.post('/farm/documents', { type: 'permit', title: 'Y', issueDate: '2026-02-01' });
    const patch = await owner.patch(`/farm/documents/${doc.id}`, { expiryDate: '2026-01-01' });
    expect(patch.body.error.code).toBe('EXPIRY_BEFORE_ISSUE');
  });

  it('returns a signed link for an own file, and refuses another tenant\'s file', async () => {
    const owner = await f.as('owner');
    const other = await createFixture();
    const insertFile = (fx: Fixture, name: string) =>
      fx.run(async () => {
        const [file] = await tx()
          .insert(schema.files)
          .values({ tenantId: fx.tenantId, farmId: fx.farmId, storageKey: `k/${name}`, name, mimeType: 'application/pdf', sizeBytes: 10 })
          .returning();
        return file;
      });
    const mine = await insertFile(f, 'mine.pdf');
    const theirs = await insertFile(other, 'theirs.pdf');

    const { data: doc } = await owner.post('/farm/documents', { type: 'contract', title: 'Fayl bilan', fileId: mine.id });
    const { data } = await owner.get(`/farm/documents/${doc.id}`);
    expect(data.fileUrl).toContain(`/api/v1/files/${mine.id}/content?token=`);
    const listed = await owner.get('/farm/documents', { search: 'Fayl bilan' });
    expect(listed.body.data[0]).toMatchObject({ fileName: 'mine.pdf', fileMimeType: 'application/pdf' });

    const stolen = await owner.post('/farm/documents', { type: 'contract', title: 'Begona', fileId: theirs.id });
    expect(stolen.status).toBe(400);
    expect(stolen.body.error.code).toBe('FILE_NOT_FOUND');
  });

  it('deletes', async () => {
    const owner = await f.as('owner');
    const { data: doc } = await owner.post('/farm/documents', { type: 'other', title: 'Vaqtinchalik' });
    expect((await owner.delete(`/farm/documents/${doc.id}`)).status).toBe(200);
    expect((await owner.get(`/farm/documents/${doc.id}`)).status).toBe(404);
  });
});

describe('map', () => {
  it('returns drawn contours and facilities as GeoJSON, and lists what is not drawn', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const mechanic = await f.as('mechanic');
    const { data: drawn } = await owner.post('/farm/fields', { number: '1', boundary: rect(64.8, 39.5, 200, 200) });
    const { data: undrawn } = await owner.post('/farm/fields', { number: '2', areaHa: 4, landUse: 'pasture' });
    await owner.post('/farm/facilities', { type: 'well', name: 'Quduq', lat: 39.5, lng: 64.8 });
    await owner.post('/farm/facilities', { type: 'barn', name: 'Molxona', boundary: rect(64.81, 39.5, 100, 50) });
    await owner.post('/farm/facilities', { type: 'guardhouse', name: 'Joylashuvsiz' });

    const season = await seedSeason(f, 'Joriy', '2026-10-01', '2027-07-01', true);
    await seedPlan(f, { seasonId: season.id, fieldId: drawn.id, crop: 'wheat', areaHa: 4, status: 'sown' });

    const { data, status } = await mechanic.get('/farm/map');
    expect(status).toBe(200);
    expect(data.type).toBe('FeatureCollection');
    expect(data.center).toEqual({ lat: 39.5, lng: 64.8 });
    expect(data.features).toHaveLength(3);

    const field = data.features.find((x: any) => x.properties.kind === 'field');
    expect(field.geometry.type).toBe('Polygon');
    expect(field.properties).toMatchObject({ number: '1', landUse: 'arable', cropKey: 'wheat', cropStatus: 'sown' });

    const well = data.features.find((x: any) => x.properties.name === 'Quduq');
    expect(well.geometry).toEqual({ type: 'Point', coordinates: [64.8, 39.5] });

    expect(data.unmappedFields).toEqual([
      { id: undrawn.id, number: '2', name: null, areaHa: 4, landUse: 'pasture' },
    ]);
    expect((await (await f.as('shepherd')).get('/farm/map')).status).toBe(403);
  });
});

describe('empty updates', () => {
  it('are refused everywhere, and journal nothing', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { data: field } = await owner.post('/farm/fields', { number: '1', areaHa: 5 });
    const { data: facility } = await owner.post('/farm/facilities', { type: 'barn', name: 'M' });
    const { data: node } = await owner.post('/farm/irrigation', { type: 'canal', name: 'K' });
    const { data: doc } = await owner.post('/farm/documents', { type: 'land', title: 'H' });
    const { data: soil } = await owner.post(`/farm/fields/${field.id}/soil`, { date: '2026-09-01' });

    for (const path of ['/farm/passport', `/farm/fields/${field.id}`, `/farm/facilities/${facility.id}`, `/farm/irrigation/${node.id}`, `/farm/documents/${doc.id}`, `/farm/soil/${soil.id}`]) {
      const res = await owner.patch(path, {});
      expect([path, res.status, res.body.error?.code]).toEqual([path, 400, 'NOTHING_TO_UPDATE']);
    }
    const events = await f.run(() => tx().select().from(schema.events).where(eq(schema.events.type, 'farm.passport_updated')));
    expect(events).toEqual([]);
  });
});

describe('lookups', () => {
  it('are open to any signed-in role, and label fields by number', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    await owner.post('/farm/fields', { number: '1', name: 'Katta', areaHa: 20 });
    await owner.post('/farm/fields', { number: '2', areaHa: 15 });
    await owner.post('/farm/fields', { number: 'Y-1', areaHa: 100, landUse: 'pasture' });

    const res = await shepherd.get('/farm/fields/lookup', { landUse: 'arable' });
    expect(res.status).toBe(200);
    expect(res.data.map((x: any) => x.name)).toEqual(['№1 Katta', '№2']);
    expect(res.data[0]).toMatchObject({ number: '1', areaHa: 20 });
    expect((await shepherd.get('/farm/fields/lookup', { search: 'Y-' })).data).toHaveLength(1);
  });
});

describe('tenant isolation', () => {
  it("cannot read or change another tenant's land", async () => {
    const a = await createFixture();
    const b = await createFixture();
    const ownerA = await a.as('owner');
    const ownerB = await b.as('owner');
    const { data: field } = await ownerA.post('/farm/fields', { number: '1', boundary: rect(64.8, 39.5, 100, 100) });
    const { data: facility } = await ownerA.post('/farm/facilities', { type: 'barn', name: 'M' });
    const { data: doc } = await ownerA.post('/farm/documents', { type: 'land', title: 'Sir' });

    expect((await ownerB.get(`/farm/fields/${field.id}`)).status).toBe(404);
    expect((await ownerB.patch(`/farm/fields/${field.id}`, { notes: 'x' })).status).toBe(404);
    expect((await ownerB.delete(`/farm/fields/${field.id}`)).status).toBe(404);
    expect((await ownerB.post(`/farm/fields/${field.id}/soil`, { date: '2026-01-01' })).status).toBe(404);
    expect((await ownerB.get(`/farm/facilities/${facility.id}`)).status).toBe(404);
    expect((await ownerB.get(`/farm/documents/${doc.id}`)).status).toBe(404);
    expect((await ownerB.get('/farm/map')).data.features).toEqual([]);
    expect((await ownerB.get('/farm/fields/lookup')).data).toEqual([]);
    expect((await ownerB.post('/farm/irrigation', { type: 'canal', name: 'K', fieldIds: [field.id] })).status).toBe(400);
    expect((await ownerB.post('/farm/facilities', { type: 'barn', name: 'S', parentId: facility.id })).status).toBe(400);
  });
});

describe('weather', () => {
  const day = (offset: number) => addDays(today(), offset);

  function payload(offsets: number[], over: Partial<Record<string, (number | null)[]>> = {}) {
    return {
      daily: {
        time: offsets.map(day),
        temperature_2m_min: offsets.map((o) => -2 + o),
        temperature_2m_max: offsets.map((o) => 10 + o),
        precipitation_sum: offsets.map(() => 1.5),
        wind_speed_10m_max: offsets.map(() => 12),
        weather_code: offsets.map(() => 3),
        ...over,
      },
    };
  }

  const respondWith = (body: unknown, status = 200) =>
    vi.fn(async (_url: URL) => new Response(JSON.stringify(body), { status }));

  beforeEach(() => {
    resetWeatherBackoff();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stores the rolling window for the farm and serves the forecast from today', async () => {
    const f = await createFixture();
    const fetchMock = respondWith(payload([-1, 0, 1, 2]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await f.run(() => refreshWeather());
    expect(result).toEqual({ updated: 4, unavailable: false });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.hostname).toBe('api.open-meteo.com');
    expect(url.searchParams.get('latitude')).toBe('39.5');
    expect(url.searchParams.get('longitude')).toBe('64.8');
    expect(url.searchParams.get('timezone')).toBe('Asia/Tashkent');

    const rows = await f.run(() => forecast(2));
    expect(rows.map((r) => r.date)).toEqual([day(0), day(1)]);
    expect(rows[0]).toMatchObject({ tempMin: -2, tempMax: 10, precipitationMm: 1.5, windMaxKmh: 12, weatherCode: 3, isForecast: false, frost: true, source: 'open-meteo' });
    expect(rows[1]).toMatchObject({ tempMin: -1, isForecast: true, frost: true });
  });

  it('runs as a farm job', async () => {
    const f = await createFixture();
    vi.stubGlobal('fetch', respondWith(payload([0])));
    const job = jobs.find((j) => j.name === 'farm.weather')!;
    expect(job.cron).toBe('15 */6 * * *');
    await f.run(() => job.run());
    expect(await f.run(() => forecast(1))).toHaveLength(1);
  });

  it('updates in place: a forecast becomes an observation, and a gap keeps the old value', async () => {
    const f = await createFixture();
    vi.stubGlobal('fetch', respondWith(payload([1])));
    await f.run(() => refreshWeather());
    await f.run(() =>
      tx().update(schema.weatherDaily).set({ date: day(-1), isForecast: true }).where(eq(schema.weatherDaily.farmId, f.farmId)),
    );

    vi.stubGlobal('fetch', respondWith(payload([-1], { temperature_2m_max: [null], precipitation_sum: [9] })));
    await f.run(() => refreshWeather());

    const rows = await f.run(() => tx().select().from(schema.weatherDaily).where(eq(schema.weatherDaily.farmId, f.farmId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isForecast: false, precipitationMm: 9, tempMax: 11 });
  });

  it.each([
    ['network down', () => vi.fn(async () => { throw new Error('ECONNREFUSED'); })],
    ['server error', () => respondWith({ error: true }, 500)],
    ['unexpected body', () => respondWith({ daily: { time: 'nope' } })],
  ])('degrades quietly: %s', async (_label, makeFetch) => {
    const f = await createFixture();
    vi.stubGlobal('fetch', makeFetch());
    await expect(f.run(() => refreshWeather())).resolves.toEqual({ updated: 0, unavailable: true });
    expect(await f.run(() => forecast(7))).toEqual([]);
  });

  it('backs off after a failure so saves are not delayed', async () => {
    const f = await createFixture();
    const failing = vi.fn(async () => {
      throw new Error('down');
    });
    vi.stubGlobal('fetch', failing);
    await f.run(() => refreshWeather());
    await f.run(() => refreshWeather());
    await f.run(() => getWeatherFor(day(-3)));
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('skips a farm without coordinates', async () => {
    const f = await createFixture();
    await f.run(() => tx().update(schema.farms).set({ lat: null, lng: null }).where(eq(schema.farms.id, f.farmId)));
    const fetchMock = respondWith(payload([0]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await f.run(() => refreshWeather())).toEqual({ updated: 0, unavailable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getWeatherFor uses stored data without touching the network', async () => {
    const f = await createFixture();
    vi.stubGlobal('fetch', respondWith(payload([0])));
    await f.run(() => refreshWeather());

    const fetchMock = respondWith(payload([0]));
    vi.stubGlobal('fetch', fetchMock);
    const snapshot = await f.run(() => getWeatherFor(day(0)));
    expect(snapshot).toMatchObject({ date: day(0), tempMin: -2 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getWeatherFor fetches a missing recent date and stores it', async () => {
    const f = await createFixture();
    const fetchMock = respondWith(payload([-20]));
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await f.run(() => getWeatherFor(day(-20)));
    expect(snapshot).toMatchObject({ date: day(-20), isForecast: false });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.hostname).toBe('api.open-meteo.com');
    expect(url.searchParams.get('start_date')).toBe(day(-20));
    expect(url.searchParams.get('end_date')).toBe(day(-20));

    await f.run(() => getWeatherFor(day(-20)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getWeatherFor uses the archive for old dates', async () => {
    const f = await createFixture();
    const fetchMock = respondWith(payload([-200]));
    vi.stubGlobal('fetch', fetchMock);
    await f.run(() => getWeatherFor(day(-200)));
    expect(new URL(String(fetchMock.mock.calls[0][0])).hostname).toBe('archive-api.open-meteo.com');
  });

  it('getWeatherFor returns null rather than guessing', async () => {
    const f = await createFixture();
    const fetchMock = respondWith(payload([0]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await f.run(() => getWeatherFor(day(60)))).toBeNull();
    expect(await f.run(() => getWeatherFor(day(-1), { fetchMissing: false }))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await f.run(() => getWeatherFor(day(-2)))).toBeNull();
  });

  it('unknown temperature gives unknown frost, not "no frost"', async () => {
    const f = await createFixture();
    vi.stubGlobal('fetch', respondWith(payload([0], { temperature_2m_min: [null] })));
    await f.run(() => refreshWeather());
    expect((await f.run(() => forecast(1)))[0]).toMatchObject({ tempMin: null, frost: null });
  });

  it('serves weather through the API, and reports an outage as a result', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const refreshed = await owner.post('/farm/weather/refresh');
    expect(refreshed.status).toBe(200);
    expect(refreshed.data).toEqual({ updated: 0, unavailable: true });

    resetWeatherBackoff();
    vi.stubGlobal('fetch', respondWith(payload([0, 1, 2])));
    expect((await owner.post('/farm/weather/refresh')).data).toEqual({ updated: 3, unavailable: false });

    const res = await owner.get('/farm/weather/forecast', { days: 2 });
    expect(res.data.map((r: any) => r.date)).toEqual([day(0), day(1)]);
    expect((await owner.get('/farm/weather', { from: day(0), to: day(2) })).data).toHaveLength(3);

    // The dashboard shows the forecast to investors; a shepherd has no such screen.
    expect((await (await f.as('investor')).get('/farm/weather/forecast')).status).toBe(200);
    expect((await (await f.as('shepherd')).get('/farm/weather/forecast')).status).toBe(403);
    expect((await (await f.as('agronomist')).post('/farm/weather/refresh')).status).toBe(200);
    expect((await (await f.as('investor')).post('/farm/weather/refresh')).status).toBe(403);
  });
});

describe('pilot seed', () => {
  it('lays out 210 ha: 90 arable, no overlaps, measured area matching the plan', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetWeatherBackoff();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    try {
      const seed: SeedContext = {
        tenantId: f.tenantId,
        farmId: f.farmId,
        users: { owner: owner.userId } as SeedContext['users'],
        run: (fn) => f.run(fn, { userId: owner.userId }) as never,
      };
      await seedLand(seed);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      resetWeatherBackoff();
    }

    await owner.patch('/farm/passport', { totalAreaHa: 210 });
    const { data } = await owner.get('/farm/passport');
    const byUse = Object.fromEntries(data.areaBalance.byLandUse.map((r: any) => [r.landUse, r.areaHa]));
    expect(byUse.arable).toBe(90);
    expect(data.areaBalance).toMatchObject({ assignedHa: 210, unassignedHa: 0, overAssigned: false });

    const geometry = await f.run(async () => {
      const measured = await tx().execute(
        sql`select number, area_ha, ST_Area(geom::geography) / 10000 as measured, ST_IsValid(geom) as valid from fields`,
      );
      const overlaps = await tx().execute(sql`
        select a.number as a, b.number as b from fields a join fields b on a.id < b.id
        where ST_Intersects(a.geom, b.geom) and ST_Area(ST_Intersection(a.geom, b.geom)) > 0`);
      return { measured: measured.rows, overlaps: overlaps.rows };
    });
    expect(geometry.measured).toHaveLength(10);
    for (const row of geometry.measured as { area_ha: string; measured: number; valid: boolean }[]) {
      expect(row.valid).toBe(true);
      expect(Math.abs(Number(row.area_ha) - Number(row.measured))).toBeLessThan(0.001);
    }
    expect(geometry.overlaps).toEqual([]);

    const map = await owner.get('/farm/map');
    expect(map.data.unmappedFields).toEqual([]);
    const barn = (await owner.get('/farm/facilities', { type: 'barn', search: 'Molxona №1', pageSize: 200 })).body.data;
    expect(barn.find((b: any) => b.name === SEED.facility.barn)).toMatchObject({ capacity: 1000, capacityUnit: 'bosh' });

    const expiring = await owner.get('/farm/documents', { expiry: 'expiring' });
    expect(expiring.body.data.map((d: any) => d.title)).toEqual(['Suvdan foydalanish ruxsatnomasi']);
    expect((await owner.get('/farm/documents', { expiry: 'expired' })).body.meta.total).toBe(0);

    const card = (await owner.get('/farm/fields/lookup', { search: '1' })).data[0];
    expect((await owner.get(`/farm/fields/${card.id}`)).data.soilAnalyses).toHaveLength(2);
    const nodes = (await owner.get('/farm/irrigation')).body.data;
    expect(nodes.map((n: any) => n.name).sort()).toEqual(['Ariq №1', 'Magistral kanal', 'Nasos stansiyasi']);
  });
});

describe('openapi', () => {
  it('documents the farm routes', async () => {
    const f = await createFixture();
    const spec = f.app.swagger() as { paths: Record<string, unknown> };
    for (const path of ['/api/v1/farm/passport', '/api/v1/farm/fields', '/api/v1/farm/map', '/api/v1/farm/documents', '/api/v1/farm/weather/forecast']) {
      expect(spec.paths[path]).toBeTruthy();
    }
  });
});
