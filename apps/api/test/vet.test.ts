import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIso, type RoleKey } from '@yap/shared';
import { schema } from '../src/db/client';
import { ctx, tx } from '../src/core/context';
import { ensureCostCenter } from '../src/core/costCenters';
import { receiveStock, stockOnHand } from '../src/core/inventory';
import { markExited } from '../src/modules/livestock/animals.service';
import { animalsUnderWithdrawal, createRecord } from '../src/modules/livestock/health.service';
import { createPregnancy, recordLambing } from '../src/modules/livestock/breeding.service';
import { SEED } from '../src/seed/names';
import { seedVet } from '../src/seed/vet';
import { createFixture, type Fixture } from './helpers';
import { renderAlert } from '../src/modules/alerts/alerts.service';

const { alerts, animals, breeds, breedingRecords, documents, events, healthRecords, herds, herdTransfers, items, species, stockMovements, costCenters, warehouses, weightRecords } = schema;

const T = todayIso();
const daysAgo = (n: number) => addDays(T, -n);
let tagCounter = 0;

interface AnimalOverrides {
  tag?: string;
  sex?: string;
  category?: string;
  herdId?: string | null;
  status?: string;
  birthDate?: string | null;
  purchaseDate?: string | null;
  origin?: string;
  damId?: string | null;
  sireId?: string | null;
  speciesKey?: string;
  birthWeightKg?: number | null;
}

async function makeAnimal(f: Fixture, o: AnimalOverrides = {}) {
  return f.run(async () => {
    const [kind] = await tx().select().from(species).where(and(eq(species.tenantId, f.tenantId), eq(species.key, o.speciesKey ?? 'sheep')));
    const [breed] = await tx().select().from(breeds).where(and(eq(breeds.tenantId, f.tenantId), eq(breeds.key, 'hisori')));
    const [row] = await tx()
      .insert(animals)
      .values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        tag: o.tag ?? `T${++tagCounter}`,
        speciesId: kind.id,
        breedId: breed.id,
        sex: o.sex ?? 'female',
        category: o.category ?? 'ewe',
        origin: o.origin ?? 'purchased',
        herdId: o.herdId ?? null,
        status: o.status ?? 'active',
        birthDate: o.birthDate ?? null,
        purchaseDate: o.purchaseDate ?? null,
        damId: o.damId ?? null,
        sireId: o.sireId ?? null,
        birthWeightKg: o.birthWeightKg ?? null,
      })
      .returning();
    return row;
  });
}

const makeRam = (f: Fixture, o: AnimalOverrides = {}) => makeAnimal(f, { sex: 'male', category: 'ram', ...o });

async function makeHerd(f: Fixture, name = 'Poda') {
  return f.run(async () => {
    const [herd] = await tx().insert(herds).values({ tenantId: f.tenantId, farmId: f.farmId, name }).returning();
    const costCenterId = await ensureCostCenter('herd', herd.id, name);
    await tx().update(herds).set({ costCenterId }).where(eq(herds.id, herd.id));
    return { ...herd, costCenterId };
  });
}

async function makeDrug(f: Fixture, o: { name?: string; unit?: string; qty?: number; unitCost?: number; withdrawalDays?: number | null } = {}) {
  return f.run(async () => {
    const [warehouse] = await tx()
      .insert(warehouses)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name: `Vet ${++tagCounter}`, type: 'vet' })
      .returning();
    const [item] = await tx()
      .insert(items)
      .values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        name: o.name ?? `Drug ${tagCounter}`,
        category: 'vet_drug',
        unit: o.unit ?? 'vial',
        withdrawalDays: o.withdrawalDays ?? null,
      })
      .returning();
    await receiveStock({ itemId: item.id, warehouseId: warehouse.id, qty: o.qty ?? 10, unitCost: o.unitCost ?? 20_000, date: daysAgo(30), source: 'purchase' });
    return { itemId: item.id, warehouseId: warehouse.id };
  });
}

const statusOf = async (f: Fixture, id: string) =>
  f.run(async () => (await tx().select({ status: animals.status }).from(animals).where(eq(animals.id, id)))[0].status);

const stockOf = (f: Fixture, itemId: string) => f.run(() => stockOnHand(itemId));

async function pregnantEwe(f: Fixture, matingDate: string, o: AnimalOverrides = {}, ramId?: string) {
  const ewe = await makeAnimal(f, o);
  const record = await f.run(() => createPregnancy({ eweId: ewe.id, matingDate, ramId }));
  return { ewe, record };
}

describe('pregnancies', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  it('computes expected dates from the species and marks the ewe pregnant (spec 24.1)', async () => {
    const zoo = await f.as('zootechnician');
    const ewe = await makeAnimal(f);
    const res = await zoo.post('/livestock/breeding', { eweId: ewe.id, matingDate: '2026-10-01', source: 'purchase' });
    expect(res.status).toBe(201);
    expect(res.data.expectedDate).toBe('2027-02-28');
    expect(res.data.expectedEarliest).toBe('2027-02-23');
    expect(res.data.expectedLatest).toBe('2027-03-02');
    expect(res.data.status).toBe('pregnant');
    expect(res.data.source).toBe('purchase');
    expect(await statusOf(f, ewe.id)).toBe('pregnant');
    const journal = await f.run(() => tx().select().from(events).where(and(eq(events.entityId, ewe.id), eq(events.type, 'animal.pregnancy_recorded'))));
    expect(journal).toHaveLength(1);
  });

  it('uses the gestation of the species, not a fixed 150 days', async () => {
    const cow = await makeAnimal(f, { speciesKey: 'cattle' });
    const record = await f.run(() => createPregnancy({ eweId: cow.id, matingDate: '2026-10-01' }));
    expect(record.expectedDate).toBe('2027-07-11');
  });

  it.each([
    ['a male', { sex: 'male', category: 'ram' }, 400, 'ANIMAL_NOT_FEMALE'],
    ['a sold ewe', { status: 'sold' }, 409, 'ANIMAL_NOT_ON_FARM'],
  ])('refuses %s', async (_label, overrides, status, code) => {
    const owner = await f.as('zootechnician');
    const animal = await makeAnimal(f, overrides);
    const res = await owner.post('/livestock/breeding', { eweId: animal.id, matingDate: '2026-10-01' });
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  });

  it('refuses a second open pregnancy, a future date, and a female as the ram', async () => {
    const zoo = await f.as('zootechnician');
    const { ewe } = await pregnantEwe(f, '2026-10-01');
    const second = await zoo.post('/livestock/breeding', { eweId: ewe.id, matingDate: '2026-10-05' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_PREGNANT');

    const fresh = await makeAnimal(f);
    const future = await zoo.post('/livestock/breeding', { eweId: fresh.id, matingDate: addDays(T, 1) });
    expect(future.body.error.code).toBe('FUTURE_DATE');

    const notARam = await makeAnimal(f);
    const res = await zoo.post('/livestock/breeding', { eweId: fresh.id, ramId: notARam.id, matingDate: '2026-10-01' });
    expect(res.body.error.code).toBe('RAM_NOT_MALE');
  });

  it('the database itself refuses two open pregnancies for one ewe', async () => {
    const { ewe, record } = await pregnantEwe(f, '2026-10-01');
    await expect(
      f.run(() =>
        tx().insert(breedingRecords).values({
          tenantId: f.tenantId,
          farmId: f.farmId,
          eweId: ewe.id,
          matingDate: record.matingDate,
          expectedDate: record.expectedDate,
          expectedEarliest: record.expectedEarliest,
          expectedLatest: record.expectedLatest,
        }),
      ),
    ).rejects.toThrow();
  });

  it('a sick ewe stays sick when a pregnancy is recorded', async () => {
    const ewe = await makeAnimal(f, { status: 'sick' });
    await f.run(() => createPregnancy({ eweId: ewe.id, matingDate: '2026-10-01' }));
    expect(await statusOf(f, ewe.id)).toBe('sick');
  });

  it('registers a whole herd at once, skipping those that cannot take one', async () => {
    const zoo = await f.as('zootechnician');
    const herd = await makeHerd(f, 'Bulk');
    const open = [await makeAnimal(f, { herdId: herd.id }), await makeAnimal(f, { herdId: herd.id }), await makeAnimal(f, { herdId: herd.id })];
    await makeRam(f, { herdId: herd.id });
    await makeAnimal(f, { herdId: herd.id, category: 'lamb_female' });
    const { ewe: already } = await pregnantEwe(f, '2026-09-01', { herdId: herd.id });

    const res = await zoo.post('/livestock/breeding/bulk', { herdId: herd.id, matingDate: '2026-10-10', source: 'purchase' });
    expect(res.status).toBe(201);
    expect(res.data.created).toBe(3);
    expect(res.data.skipped).toEqual([{ animalId: already.id, tag: already.tag, reason: 'ALREADY_PREGNANT' }]);
    for (const ewe of open) expect(await statusOf(f, ewe.id)).toBe('pregnant');

    const list = await zoo.get('/livestock/breeding', { herdId: herd.id, status: 'pregnant', pageSize: 10 });
    expect(list.body.meta.total).toBe(4);
    expect(list.data.filter((r: any) => r.matingDate === '2026-10-10').every((r: any) => r.expectedDate === '2027-03-09')).toBe(true);
  });

  it('bulk needs exactly one of herd or animal list', async () => {
    const zoo = await f.as('zootechnician');
    const res = await zoo.post('/livestock/breeding/bulk', { matingDate: '2026-10-10' });
    expect(res.status).toBe(400);
  });

  it('lists with search, status and joins; a corrected date recalculates', async () => {
    const zoo = await f.as('zootechnician');
    const ram = await makeRam(f, { tag: 'RAM-LIST' });
    const { record } = await pregnantEwe(f, '2026-10-01', { tag: 'SEARCH-ME' }, ram.id);

    const found = await zoo.get('/livestock/breeding', { search: 'search-me' });
    expect(found.body.meta.total).toBe(1);
    expect(found.data[0].eweTag).toBe('SEARCH-ME');
    expect(found.data[0].ramTag).toBe('RAM-LIST');
    expect(typeof found.data[0].daysToExpected).toBe('number');

    const fixed = await zoo.patch(`/livestock/breeding/${record.id}`, { matingDate: '2026-10-03' });
    expect(fixed.data.expectedDate).toBe('2027-03-02');
  });

  it('closing a pregnancy returns the ewe to active and cannot happen twice', async () => {
    const zoo = await f.as('zootechnician');
    const { ewe, record } = await pregnantEwe(f, '2026-10-01');
    const closed = await zoo.post(`/livestock/breeding/${record.id}/close`, { status: 'aborted', notes: 'Bola tashladi' });
    expect(closed.data.status).toBe('aborted');
    expect(await statusOf(f, ewe.id)).toBe('active');
    const again = await zoo.post(`/livestock/breeding/${record.id}/close`, { status: 'failed' });
    expect(again.body.error.code).toBe('PREGNANCY_NOT_OPEN');
  });

  it('a pregnancy entered by mistake can be deleted', async () => {
    const owner = await f.as('owner');
    const { ewe, record } = await pregnantEwe(f, '2026-10-01');
    expect((await owner.delete(`/livestock/breeding/${record.id}`)).status).toBe(200);
    expect(await statusOf(f, ewe.id)).toBe('active');
    expect((await owner.get(`/livestock/breeding/${record.id}`)).status).toBe(404);
  });

  it('shepherds can read and record; the vet can register a pregnancy', async () => {
    const vet = await f.as('veterinarian');
    const ewe = await makeAnimal(f);
    expect((await vet.post('/livestock/breeding', { eweId: ewe.id, matingDate: '2026-10-01' })).status).toBe(201);
    const investor = await f.as('investor');
    expect((await investor.get('/livestock/breeding')).status).toBe(403);
  });
});

describe('who can be mated', () => {
  it('refuses a newborn lamb and a wether, and keeps both out of the mating lists', async () => {
    const f = await createFixture();
    const today = todayIso();
    const client = await f.as('zootechnician');
    const lamb = await makeAnimal(f, { category: 'lamb_female', birthDate: addDays(today, -1) });
    const sibling = await makeAnimal(f, { sex: 'male', category: 'lamb_male', birthDate: addDays(today, -1) });
    const wether = await makeAnimal(f, { sex: 'male', category: 'wether', birthDate: addDays(today, -900) });
    const grown = await makeAnimal(f, { category: 'lamb_female', birthDate: addDays(today, -300) });
    const ewe = await makeAnimal(f);

    const refused = await client.post('/livestock/breeding', { eweId: lamb.id, matingDate: today });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('ANIMAL_CANNOT_BREED');
    for (const ramId of [sibling.id, wether.id]) {
      const res = await client.post('/livestock/breeding', { eweId: ewe.id, ramId, matingDate: today });
      expect(res.body.error.code).toBe('ANIMAL_CANNOT_BREED');
    }
    // Grown up, never recategorised: the work must not stop on stale data.
    expect((await client.post('/livestock/breeding', { eweId: grown.id, matingDate: today })).status).toBe(201);

    const offered = async (sex: string) =>
      (await client.get('/livestock/animals/lookup', { sex, forBreeding: 'true' })).data.map((a: any) => a.id);
    expect(await offered('female')).toEqual(expect.arrayContaining([grown.id, ewe.id]));
    expect(await offered('female')).not.toContain(lamb.id);
    expect(await offered('male')).toEqual([]);
  });
});

describe('lambing on a ewe that has left', () => {
  it('is refused after her exit, and allowed on the day itself', async () => {
    const f = await createFixture();
    const today = todayIso();
    const client = await f.as('zootechnician');
    const owner = await f.as('owner');
    const gone = await makeAnimal(f, { birthDate: addDays(today, -900) });
    await owner.post('/livestock/exits', { animalId: gone.id, type: 'death', date: addDays(today, -10) });
    const lamb = { sex: 'female', alive: true };
    const late = await client.post('/livestock/lambings', { eweId: gone.id, date: today, lambs: [lamb] });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ANIMAL_NOT_ON_FARM');
    const sameDay = await client.post('/livestock/lambings', { eweId: gone.id, date: addDays(today, -10), lambs: [lamb] });
    expect(sameDay.body.error?.code).not.toBe('ANIMAL_NOT_ON_FARM');
  });
});

describe('lambing calendar', () => {
  it('counts ewes by day and week, leaves out those gone, and flags the overdue', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    const mating = daysAgo(10);
    await pregnantEwe(f, mating);
    await pregnantEwe(f, mating);
    await pregnantEwe(f, daysAgo(12));
    const { ewe: sold } = await pregnantEwe(f, mating);
    await f.run(() => markExited(sold.id, 'sold', T));
    await pregnantEwe(f, daysAgo(160)); // past its latest date

    const res = await zoo.get('/livestock/breeding/calendar');
    expect(res.status).toBe(200);
    expect(res.data.days).toEqual([
      { date: addDays(T, 138), expected: 1 },
      { date: addDays(T, 140), expected: 2 },
    ]);
    expect(res.data.totalEwes).toBe(3);
    expect(res.data.weeks.reduce((sum: number, w: any) => sum + w.expected, 0)).toBe(3);
    expect(new Date(`${res.data.weeks[0].week}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(res.data.overdue).toBe(1);
    // Without any lambing history there is nothing to base a lamb count on.
    expect(res.data.expectedLambs).toBeNull();
  });
});

describe('lambing', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  it('creates the lambs, closes the pregnancy and returns the ewe to active', async () => {
    const zoo = await f.as('zootechnician');
    const herd = await makeHerd(f, 'Onalar');
    const ram = await makeRam(f);
    const date = daysAgo(3);
    const { ewe, record } = await pregnantEwe(f, addDays(date, -148), { tag: 'E-TWIN', herdId: herd.id }, ram.id);

    const res = await zoo.post('/livestock/lambings', {
      eweId: ewe.id,
      date,
      lambs: [
        { sex: 'male', birthWeightKg: 4.2 },
        { sex: 'female', birthWeightKg: 3.8 },
      ],
      complications: 'Yordam kerak bo\'ldi',
    });
    expect(res.status).toBe(201);
    expect(res.data.lambsBorn).toBe(2);
    expect(res.data.lambsAlive).toBe(2);
    expect(res.data.breedingId).toBe(record.id);

    const yy = date.slice(2, 4);
    const lambs = await f.run(() => tx().select().from(animals).where(eq(animals.damId, ewe.id)).orderBy(animals.tag));
    expect(lambs.map((l) => l.tag)).toEqual([`E-TWIN-${yy}-1`, `E-TWIN-${yy}-2`]);
    expect(lambs.map((l) => l.category)).toEqual(['lamb_male', 'lamb_female']);
    for (const lamb of lambs) {
      expect(lamb.sireId).toBe(ram.id);
      expect(lamb.origin).toBe('born');
      expect(lamb.birthDate).toBe(date);
      expect(lamb.herdId).toBe(herd.id);
      expect(lamb.status).toBe('active');
    }

    const weights = await f.run(() => tx().select().from(weightRecords).where(eq(weightRecords.animalId, lambs[0].id)));
    expect(weights.map((w) => [w.date, w.weightKg])).toEqual([[date, 4.2]]);
    expect(lambs[0].currentWeightKg).toBe(4.2);

    const [closed] = await f.run(() => tx().select().from(breedingRecords).where(eq(breedingRecords.id, record.id)));
    expect(closed.status).toBe('lambed');
    expect(await statusOf(f, ewe.id)).toBe('active');
  });

  it('counts a stillborn lamb but does not add it to the herd', async () => {
    const zoo = await f.as('zootechnician');
    const date = daysAgo(2);
    const { ewe } = await pregnantEwe(f, addDays(date, -150));
    const res = await zoo.post('/livestock/lambings', {
      eweId: ewe.id,
      date,
      lambs: [
        { sex: 'male', birthWeightKg: 4 },
        { sex: 'female', alive: false },
      ],
    });
    expect(res.data.lambsBorn).toBe(2);
    expect(res.data.lambsAlive).toBe(1);
    expect(res.data.lambs[1]).toEqual({ sex: 'female', birthWeightKg: null, alive: false, animalId: null, tag: null });
    const lambs = await f.run(() => tx().select().from(animals).where(eq(animals.damId, ewe.id)));
    expect(lambs).toHaveLength(1);
  });

  it('keeps the tag and id the client supplied', async () => {
    const zoo = await f.as('zootechnician');
    const date = daysAgo(1);
    const { ewe } = await pregnantEwe(f, addDays(date, -150));
    const id = '0190a7e2-7b1c-7c3d-8e4f-0000000000a1';
    const res = await zoo.post('/livestock/lambings', { eweId: ewe.id, date, lambs: [{ id, tag: 'Q-777', sex: 'female' }] });
    expect(res.status).toBe(201);
    const [lamb] = await f.run(() => tx().select().from(animals).where(eq(animals.id, id)));
    expect(lamb.tag).toBe('Q-777');
  });

  it('records a lambing with no pregnancy on file', async () => {
    const zoo = await f.as('zootechnician');
    const ewe = await makeAnimal(f);
    const res = await zoo.post('/livestock/lambings', { eweId: ewe.id, date: daysAgo(1), lambs: [{ sex: 'male' }] });
    expect(res.status).toBe(201);
    expect(res.data.breedingId).toBeNull();
  });

  it('a sick ewe stays sick after lambing', async () => {
    const zoo = await f.as('zootechnician');
    const date = daysAgo(1);
    const ewe = await makeAnimal(f, { status: 'sick' });
    await f.run(() => createPregnancy({ eweId: ewe.id, matingDate: addDays(date, -150) }));
    await zoo.post('/livestock/lambings', { eweId: ewe.id, date, lambs: [{ sex: 'male' }] });
    expect(await statusOf(f, ewe.id)).toBe('sick');
  });

  it('accepts 1 to 3 lambs and refuses more or none', async () => {
    const zoo = await f.as('zootechnician');
    const ewe = await makeAnimal(f);
    const lamb = { sex: 'male' };
    for (const lambs of [[], [lamb, lamb, lamb, lamb]]) {
      const res = await zoo.post('/livestock/lambings', { eweId: ewe.id, date: daysAgo(1), lambs });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const triplets = await makeAnimal(f);
    const ok = await zoo.post('/livestock/lambings', { eweId: triplets.id, date: daysAgo(1), lambs: [lamb, lamb, lamb] });
    expect(ok.data.lambsBorn).toBe(3);
  });

  it('refuses wrong dates, wrong animals, and a repeat of the same birth', async () => {
    const zoo = await f.as('zootechnician');
    const { ewe, record } = await pregnantEwe(f, daysAgo(150));
    const lambs = [{ sex: 'male' }];

    const beforeMating = await zoo.post('/livestock/lambings', { eweId: ewe.id, date: daysAgo(151), lambs });
    expect(beforeMating.body.error.code).toBe('LAMBING_BEFORE_MATING');

    const future = await zoo.post('/livestock/lambings', { eweId: ewe.id, date: addDays(T, 1), lambs });
    expect(future.body.error.code).toBe('FUTURE_DATE');

    const ram = await makeRam(f);
    const male = await zoo.post('/livestock/lambings', { eweId: ram.id, date: daysAgo(1), lambs });
    expect(male.body.error.code).toBe('ANIMAL_NOT_FEMALE');

    const other = await makeAnimal(f);
    const mismatch = await zoo.post('/livestock/lambings', { eweId: other.id, breedingId: record.id, date: daysAgo(1), lambs });
    expect(mismatch.body.error.code).toBe('PREGNANCY_MISMATCH');

    expect((await zoo.post('/livestock/lambings', { eweId: ewe.id, breedingId: record.id, date: daysAgo(1), lambs })).status).toBe(201);
    const repeat = await zoo.post('/livestock/lambings', { eweId: ewe.id, date: daysAgo(1), lambs });
    expect(repeat.status).toBe(409);
    expect(repeat.body.error.code).toBe('LAMBED_RECENTLY');
    const closed = await zoo.post('/livestock/lambings', { eweId: other.id, breedingId: record.id, date: daysAgo(1), lambs });
    expect(closed.body.error.code).toBe('PREGNANCY_NOT_OPEN');
  });

  it('a failed lambing leaves nothing behind', async () => {
    const zoo = await f.as('zootechnician');
    await makeAnimal(f, { tag: 'TAKEN-TAG' });
    const { ewe, record } = await pregnantEwe(f, daysAgo(150));
    const res = await zoo.post('/livestock/lambings', {
      eweId: ewe.id,
      date: daysAgo(1),
      lambs: [{ sex: 'female' }, { sex: 'male', tag: 'TAKEN-TAG' }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TAG_TAKEN');
    const lambs = await f.run(() => tx().select().from(animals).where(eq(animals.damId, ewe.id)));
    expect(lambs).toEqual([]);
    const [still] = await f.run(() => tx().select().from(breedingRecords).where(eq(breedingRecords.id, record.id)));
    expect(still.status).toBe('pregnant');
  });

  it('lists lambings and lets notes be corrected', async () => {
    const zoo = await f.as('zootechnician');
    const owner = await f.as('owner');
    const ewe = await makeAnimal(f, { tag: 'LIST-E' });
    const created = await zoo.post('/livestock/lambings', { eweId: ewe.id, date: daysAgo(4), lambs: [{ sex: 'male' }] });
    const list = await zoo.get('/livestock/lambings', { search: 'list-e' });
    expect(list.data.map((r: any) => r.eweTag)).toEqual(['LIST-E']);
    const fixed = await owner.patch(`/livestock/lambings/${created.data.id}`, { complications: 'Yengil' });
    expect(fixed.data.complications).toBe('Yengil');
  });
});

describe('pedigree and inbreeding', () => {
  it('walks ancestors and descendants', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    const grandsire = await makeRam(f, { tag: 'GS' });
    const granddam = await makeAnimal(f, { tag: 'GD' });
    const dam = await makeAnimal(f, { tag: 'DAM', damId: granddam.id, sireId: grandsire.id });
    const sire = await makeRam(f, { tag: 'SIRE' });
    const animal = await makeAnimal(f, { tag: 'ME', damId: dam.id, sireId: sire.id });
    const child = await makeAnimal(f, { tag: 'CHILD', damId: animal.id });
    const grandchild = await makeAnimal(f, { tag: 'GRANDCHILD', damId: child.id });

    const res = await zoo.get(`/livestock/pedigree/${animal.id}`);
    expect(res.status).toBe(200);
    const tree = res.data.animal;
    expect(tree.tag).toBe('ME');
    expect(tree.dam.tag).toBe('DAM');
    expect(tree.sire.tag).toBe('SIRE');
    expect(tree.dam.dam.tag).toBe('GD');
    expect(tree.dam.sire.tag).toBe('GS');
    expect(tree.sire.dam).toBeNull();
    expect(res.data.descendants.map((d: any) => d.tag)).toEqual(['CHILD']);
    expect(res.data.descendants[0].children.map((d: any) => d.id)).toEqual([grandchild.id]);
    expect(res.data.truncated).toBe(false);
  });

  it('warns on half siblings, on a ram with his daughter, and not on strangers', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    const bigRam = await makeRam(f, { tag: 'BIG' });
    const ewe = await makeAnimal(f, { tag: 'EWE', sireId: bigRam.id });
    const son = await makeRam(f, { tag: 'SON', sireId: bigRam.id });
    const stranger = await makeRam(f, { tag: 'STRANGER' });

    const halfSib = await zoo.get('/livestock/breeding/inbreeding-check', { eweId: ewe.id, ramId: son.id });
    expect(halfSib.data).toEqual({
      related: true,
      common: [{ id: bigRam.id, tag: 'BIG', distanceEwe: 1, distanceRam: 1 }],
    });

    const father = await zoo.get('/livestock/breeding/inbreeding-check', { eweId: ewe.id, ramId: bigRam.id });
    expect(father.data.related).toBe(true);
    expect(father.data.common[0].distanceRam).toBe(0);

    const none = await zoo.get('/livestock/breeding/inbreeding-check', { eweId: ewe.id, ramId: stranger.id });
    expect(none.data).toEqual({ related: false, common: [] });
  });

  it('the warning does not block the mating, and the bulk path reports it too', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    const bigRam = await makeRam(f);
    const ewe = await makeAnimal(f, { sireId: bigRam.id });
    const son = await makeRam(f, { sireId: bigRam.id });
    const created = await zoo.post('/livestock/breeding', { eweId: ewe.id, ramId: son.id, matingDate: '2026-10-01' });
    expect(created.status).toBe(201);
    expect(created.data.inbreeding.related).toBe(true);

    const herd = await makeHerd(f);
    const related = await makeAnimal(f, { herdId: herd.id, sireId: bigRam.id });
    await makeAnimal(f, { herdId: herd.id });
    const bulk = await zoo.post('/livestock/breeding/bulk', { herdId: herd.id, ramId: son.id, matingDate: '2026-10-01' });
    expect(bulk.data.created).toBe(2);
    expect(bulk.data.inbreeding).toEqual([{ animalId: related.id, tag: related.tag }]);
  });
});

describe('reproduction KPIs (hand-computed control numbers)', () => {
  it('lambing percent, lambs per ewe, survival, and 100-day weight', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');

    // Empty farm: nothing to report, and nothing invented.
    const empty = await zoo.get('/livestock/breeding/kpis');
    expect(empty.data).toMatchObject({ lambingPercent: null, survivalPercent: null, lambsPerEwe: null, avgWeight100Kg: null });

    // A: twins 200 days ago; one dies at 30 days, the other is weighed at 120 days.
    const dateA = daysAgo(200);
    const { ewe: a } = await pregnantEwe(f, addDays(dateA, -150));
    await zoo.post('/livestock/lambings', { eweId: a.id, date: dateA, lambs: [{ sex: 'male', birthWeightKg: 4 }, { sex: 'female', birthWeightKg: 4 }] });
    // B: single lamb 150 days ago, weighed at exactly 100 days.
    const dateB = daysAgo(150);
    const { ewe: b } = await pregnantEwe(f, addDays(dateB, -150));
    await zoo.post('/livestock/lambings', { eweId: b.id, date: dateB, lambs: [{ sex: 'male', birthWeightKg: 4 }] });
    // C aborted, D still carrying, E sold while carrying: only C is a breeding loss.
    const { record: c } = await pregnantEwe(f, daysAgo(120));
    await zoo.post(`/livestock/breeding/${c.id}/close`, { status: 'aborted' });
    await pregnantEwe(f, daysAgo(60));
    const { ewe: e } = await pregnantEwe(f, daysAgo(60));
    await f.run(() => markExited(e.id, 'sold', daysAgo(5)));
    // F: unrecorded pregnancy, lamb too young to count for survival.
    const f1 = await makeAnimal(f);
    await zoo.post('/livestock/lambings', { eweId: f1.id, date: daysAgo(10), lambs: [{ sex: 'female' }] });

    const lambsA = await f.run(() => tx().select().from(animals).where(eq(animals.damId, a.id)).orderBy(animals.sex));
    const [dead, keeper] = lambsA;
    await f.run(() => tx().update(animals).set({ status: 'dead', exitDate: addDays(dateA, 30) }).where(eq(animals.id, dead.id)));
    const [lambB] = await f.run(() => tx().select().from(animals).where(eq(animals.damId, b.id)));
    await f.run(() =>
      tx().insert(weightRecords).values([
        { tenantId: f.tenantId, farmId: f.farmId, animalId: keeper.id, date: addDays(dateA, 120), weightKg: 34 },
        { tenantId: f.tenantId, farmId: f.farmId, animalId: lambB.id, date: addDays(dateB, 100), weightKg: 24 },
      ]),
    );

    const res = await zoo.get('/livestock/breeding/kpis');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      ewesPregnant: 1,
      lambings: 3,
      lambsBorn: 4,
      lambsBornAlive: 4,
      // A, B, C with an outcome, plus F's unrecorded pregnancy: 4 lambs from 4 ewes.
      ewesWithOutcome: 4,
      lambingPercent: 100,
      // 4 lambs over 3 lambings.
      lambsPerEwe: 1.33,
      // Born more than 120 days ago: 3 lambs, of which 2 reached weaning.
      survivalPercent: 66.7,
      // 34 kg at 120 days from 4 kg is 29 kg at 100 days; with 24 kg, the mean is 26.5.
      avgWeight100Kg: 26.5,
    });

    const calendar = await zoo.get('/livestock/breeding/calendar');
    // One ewe still carrying, at this farm's 4 lambs per 3 lambings: 1.33, rounded.
    expect(calendar.data.expectedLambs).toBe(1);

    const ewes = await zoo.get('/livestock/breeding/ewes', { search: a.tag });
    expect(ewes.data[0]).toMatchObject({ tag: a.tag, lambings: 1, lambsBorn: 2, lambsAlive: 2, survivalPercent: 50, avgWeight100Kg: 29 });
  });

  it('a lamb sold before weaning still counts as survived', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    const date = daysAgo(200);
    const ewe = await makeAnimal(f);
    await zoo.post('/livestock/lambings', { eweId: ewe.id, date, lambs: [{ sex: 'male' }] });
    await f.run(() => tx().update(animals).set({ status: 'sold', exitDate: addDays(date, 90) }).where(eq(animals.damId, ewe.id)));
    expect((await zoo.get('/livestock/breeding/kpis')).data.survivalPercent).toBe(100);
  });

  it('rates rams by how fast their lambs grow', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    const fast = await makeRam(f, { tag: 'FAST' });
    const slow = await makeRam(f, { tag: 'SLOW' });
    await makeRam(f, { tag: 'YOUNG' });

    const age = 100;
    const birthDate = daysAgo(age);
    for (const [ram, gainKg] of [[fast, 30], [slow, 20]] as const) {
      const lamb = await makeAnimal(f, { sireId: ram.id, origin: 'born', birthDate, birthWeightKg: 4, category: 'lamb_male', sex: 'male' });
      await f.run(() =>
        tx().insert(weightRecords).values({ tenantId: f.tenantId, farmId: f.farmId, animalId: lamb.id, date: T, weightKg: 4 + gainKg }),
      );
    }

    const res = await zoo.get('/livestock/breeding/rams');
    expect(res.status).toBe(200);
    // 300 and 200 g/day around a farm mean of 250 g/day.
    expect(res.data.farmAvgGainGrams).toBe(250);
    expect(res.data.rams.map((r: any) => [r.rank, r.tag, r.avgGainGrams, r.index])).toEqual([
      [1, 'FAST', 300, 120],
      [2, 'SLOW', 200, 80],
      [null, 'YOUNG', null, null],
    ]);
    expect(res.data.rams[0].lowConfidence).toBe(true);
    expect(res.data.rams[0].avgWeight100Kg).toBe(34);
  });
});

describe('veterinary records', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  it('a treatment takes the drug from stock and charges the animal (control: 3 × 20 000)', async () => {
    const vet = await f.as('veterinarian');
    const { itemId, warehouseId } = await makeDrug(f, { withdrawalDays: 14 });
    const ewe = await makeAnimal(f);

    const res = await vet.post('/livestock/health/records', {
      type: 'treatment',
      animalId: ewe.id,
      date: T,
      diagnosis: 'Pnevmoniya',
      itemId,
      warehouseId,
      dose: 1,
      qtyUsed: 3,
    });
    expect(res.status).toBe(201);
    expect(await stockOf(f, itemId)).toBe(7);
    expect(res.data.headCount).toBe(1);
    expect(res.data.withdrawalDays).toBe(14);
    expect(res.data.withdrawalUntil).toBe(addDays(T, 14));

    const movements = await f.run(() =>
      tx()
        .select({ total: stockMovements.totalCost, reason: stockMovements.reason, type: costCenters.type, refId: costCenters.refId, ref: stockMovements.refType })
        .from(stockMovements)
        .innerJoin(costCenters, eq(costCenters.id, stockMovements.costCenterId))
        .where(eq(stockMovements.refId, res.data.id)),
    );
    expect(movements).toEqual([{ total: 60_000, reason: 'treatment', type: 'animal', refId: ewe.id, ref: 'health_record' }]);

    const owner = await f.as('owner');
    expect((await owner.get(`/livestock/health/records/${res.data.id}`)).data.totalCost).toBe(60_000);
  });

  it('a herd treatment multiplies by head count and charges the herd', async () => {
    const vet = await f.as('veterinarian');
    const herd = await makeHerd(f, 'Davolash');
    for (let i = 0; i < 3; i++) await makeAnimal(f, { herdId: herd.id });
    await makeAnimal(f, { herdId: herd.id, status: 'sold' });
    const { itemId, warehouseId } = await makeDrug(f, { unit: 'dose' });

    const res = await vet.post('/livestock/health/records', { type: 'deworming', herdId: herd.id, date: T, itemId, warehouseId, dose: 2 });
    expect(res.status).toBe(201);
    expect(res.data.headCount).toBe(3);
    expect(res.data.qtyUsed).toBe(6);
    expect(await stockOf(f, itemId)).toBe(4);
    const [movement] = await f.run(() => tx().select().from(stockMovements).where(eq(stockMovements.refId, res.data.id)));
    expect(movement.costCenterId).toBe(herd.costCenterId);
  });

  it('a course multiplies by days, and withdrawal counts from the last dose', async () => {
    const vet = await f.as('veterinarian');
    const { itemId, warehouseId } = await makeDrug(f, { withdrawalDays: 14 });
    const ewe = await makeAnimal(f);
    const res = await vet.post('/livestock/health/records', {
      type: 'treatment',
      animalId: ewe.id,
      date: daysAgo(1),
      itemId,
      warehouseId,
      dose: 1,
      courseDays: 5,
    });
    expect(res.data.qtyUsed).toBe(5);
    // First dose yesterday, last dose in 3 days, then 14 days.
    expect(res.data.withdrawalUntil).toBe(addDays(T, 17));
  });

  it('a stated withdrawal overrides the drug default; zero means none', async () => {
    const vet = await f.as('veterinarian');
    const { itemId, warehouseId } = await makeDrug(f, { withdrawalDays: 14 });
    const ewe = await makeAnimal(f);
    const common = { type: 'treatment', animalId: ewe.id, date: T, itemId, warehouseId, qtyUsed: 1 };
    const longer = await vet.post('/livestock/health/records', { ...common, withdrawalDays: 30 });
    expect(longer.data.withdrawalUntil).toBe(addDays(T, 30));
    const none = await vet.post('/livestock/health/records', { ...common, withdrawalDays: 0 });
    expect(none.data.withdrawalUntil).toBeNull();
  });

  it('refuses to guess quantity across units, and needs a warehouse', async () => {
    const vet = await f.as('veterinarian');
    const { itemId, warehouseId } = await makeDrug(f, { unit: 'vial' });
    const ewe = await makeAnimal(f);
    const ml = await vet.post('/livestock/health/records', { type: 'treatment', animalId: ewe.id, date: T, itemId, warehouseId, dose: 5, doseUnit: 'ml' });
    expect(ml.body.error.code).toBe('QTY_REQUIRED');
    const noWarehouse = await vet.post('/livestock/health/records', { type: 'treatment', animalId: ewe.id, date: T, itemId, qtyUsed: 1 });
    expect(noWarehouse.body.error.code).toBe('WAREHOUSE_REQUIRED');
  });

  it('needs exactly one target and no future date', async () => {
    const vet = await f.as('veterinarian');
    const ewe = await makeAnimal(f);
    const herd = await makeHerd(f);
    const both = await vet.post('/livestock/health/records', { type: 'examination', animalId: ewe.id, herdId: herd.id, date: T });
    const neither = await vet.post('/livestock/health/records', { type: 'examination', date: T });
    expect(both.body.error.code).toBe('TARGET_REQUIRED');
    expect(neither.body.error.code).toBe('TARGET_REQUIRED');
    const future = await vet.post('/livestock/health/records', { type: 'examination', animalId: ewe.id, date: addDays(T, 1) });
    expect(future.body.error.code).toBe('FUTURE_DATE');
  });

  it('runs out of stock cleanly: no record, no change', async () => {
    const vet = await f.as('veterinarian');
    const { itemId, warehouseId } = await makeDrug(f, { qty: 2 });
    const ewe = await makeAnimal(f);
    const res = await vet.post('/livestock/health/records', { type: 'treatment', animalId: ewe.id, date: T, itemId, warehouseId, qtyUsed: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(f, itemId)).toBe(2);
    const rows = await f.run(() => tx().select().from(healthRecords).where(eq(healthRecords.animalId, ewe.id)));
    expect(rows).toEqual([]);
  });

  it('editing reverses and re-issues stock; a failed edit changes nothing', async () => {
    const vet = await f.as('veterinarian');
    const { itemId, warehouseId } = await makeDrug(f, { qty: 10, unitCost: 1000 });
    const ewe = await makeAnimal(f);
    const created = await vet.post('/livestock/health/records', { type: 'treatment', animalId: ewe.id, date: T, itemId, warehouseId, qtyUsed: 3 });
    expect(await stockOf(f, itemId)).toBe(7);

    const edited = await vet.patch(`/livestock/health/records/${created.data.id}`, { qtyUsed: 5, diagnosis: 'Yangilandi' });
    expect(edited.status).toBe(200);
    expect(edited.data.qtyUsed).toBe(5);
    expect(edited.data.diagnosis).toBe('Yangilandi');
    expect(await stockOf(f, itemId)).toBe(5);

    const tooMuch = await vet.patch(`/livestock/health/records/${created.data.id}`, { qtyUsed: 11 });
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(f, itemId)).toBe(5);

    const owner = await f.as('owner');
    expect((await owner.get(`/livestock/health/records/${created.data.id}`)).data.totalCost).toBe(5000);
  });

  it('deleting returns the drug to stock', async () => {
    const vet = await f.as('veterinarian');
    const { itemId, warehouseId } = await makeDrug(f);
    const ewe = await makeAnimal(f);
    const created = await vet.post('/livestock/health/records', { type: 'treatment', animalId: ewe.id, date: T, itemId, warehouseId, qtyUsed: 4 });
    expect((await vet.delete(`/livestock/health/records/${created.data.id}`)).status).toBe(200);
    expect(await stockOf(f, itemId)).toBe(10);
    expect((await vet.get(`/livestock/health/records/${created.data.id}`)).status).toBe(404);
  });

  it('an empty update is refused and leaves stock alone', async () => {
    const vet = await f.as('veterinarian');
    const { itemId, warehouseId } = await makeDrug(f);
    const ewe = await makeAnimal(f);
    const created = await vet.post('/livestock/health/records', { type: 'treatment', animalId: ewe.id, date: T, itemId, warehouseId, qtyUsed: 2 });
    const res = await vet.patch(`/livestock/health/records/${created.data.id}`, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOTHING_TO_UPDATE');
    expect(await stockOf(f, itemId)).toBe(8);

    const { record } = await pregnantEwe(f, '2026-10-01');
    const pregnancy = await vet.patch(`/livestock/breeding/${record.id}`, {});
    expect(pregnancy.body.error.code).toBe('NOTHING_TO_UPDATE');
  });

  it('writes the journal event for each type', async () => {
    const vet = await f.as('veterinarian');
    const ewe = await makeAnimal(f);
    for (const type of ['examination', 'prophylaxis', 'deworming', 'vaccination', 'treatment']) {
      expect((await vet.post('/livestock/health/records', { type, animalId: ewe.id, date: T })).status).toBe(201);
    }
    const rows = await f.run(() => tx().select({ type: events.type }).from(events).where(eq(events.entityId, ewe.id)));
    expect(rows.map((r) => r.type).sort()).toEqual([
      'animal.dewormed',
      'animal.examined',
      'animal.prophylaxis',
      'animal.treated',
      'animal.vaccinated',
    ]);
  });

  it('filters the journal by type, animal and tag search', async () => {
    const vet = await f.as('veterinarian');
    const ewe = await makeAnimal(f, { tag: 'JOURNAL-E' });
    await vet.post('/livestock/health/records', { type: 'treatment', animalId: ewe.id, date: T, diagnosis: 'Oqsoqlik' });
    expect((await vet.get('/livestock/health/records', { search: 'journal-e' })).body.meta.total).toBe(1);
    expect((await vet.get('/livestock/health/records', { search: 'oqsoq' })).body.meta.total).toBe(1);
    expect((await vet.get('/livestock/health/records', { animalId: ewe.id, type: 'deworming' })).body.meta.total).toBe(0);
  });
});

describe('money and permissions on health records', () => {
  it('rule 7: nobody without finance.view receives the cost, in any response', async () => {
    const f = await createFixture();
    const zoo = await f.as('zootechnician');
    const shepherd = await f.as('shepherd');
    const owner = await f.as('owner');
    const { itemId, warehouseId } = await makeDrug(f, { unitCost: 12_345 });
    const ewe = await makeAnimal(f);

    const created = await zoo.post('/livestock/health/records', { type: 'treatment', animalId: ewe.id, date: T, itemId, warehouseId, qtyUsed: 1 });
    expect(created.data.totalCost).toBeNull();

    for (const res of [await shepherd.get('/livestock/health/records'), await shepherd.get(`/livestock/health/records/${created.data.id}`)]) {
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('12345');
    }
    const list = await owner.get('/livestock/health/records');
    expect(list.data[0].totalCost).toBe(12_345);
  });

  it('rule 7: sorting cannot reveal which record cost most', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    const { itemId, warehouseId } = await makeDrug(f, { unitCost: 1000 });
    const ewe = await makeAnimal(f);
    const costly = await owner.post('/livestock/health/records', { type: 'treatment', animalId: ewe.id, date: daysAgo(2), itemId, warehouseId, qtyUsed: 5 });
    const cheap = await owner.post('/livestock/health/records', { type: 'treatment', animalId: ewe.id, date: daysAgo(1), itemId, warehouseId, qtyUsed: 1 });

    const order = async (client: typeof owner) => (await client.get('/livestock/health/records', { sort: '-totalCost' })).data.map((r: any) => r.id);
    expect(await order(owner)).toEqual([costly.data.id, cheap.data.id]);
    // Without finance.view the sort is ignored: newest first, as the default.
    expect(await order(shepherd)).toEqual([cheap.data.id, costly.data.id]);
  });

  it('a shepherd may report a sick animal but not write clinical records', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    const ewe = await makeAnimal(f);
    const clinical = await shepherd.post('/livestock/health/records', { type: 'treatment', animalId: ewe.id, date: T });
    expect(clinical.status).toBe(403);
    expect((await shepherd.post('/livestock/health/vaccinations/herd', { herdId: ewe.id, date: T })).status).toBe(403);
    expect((await shepherd.post('/livestock/health/quarantine', { animalIds: [ewe.id] })).status).toBe(403);
    expect((await shepherd.post('/livestock/health/report-sick', { animalId: ewe.id, note: 'Yemayapti' })).status).toBe(201);
  });

  it('roles outside veterinary work cannot read the journal', async () => {
    const f = await createFixture();
    for (const role of ['investor', 'agronomist', 'storekeeper', 'mechanic', 'accountant'] as const) {
      expect((await (await f.as(role)).get('/livestock/health/records')).status).toBe(403);
    }
  });
});

describe('sick reports', () => {
  it('reaches the vet as an urgent alert, by tag or by RFID', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    const { ewe } = await pregnantEwe(f, daysAgo(30), { tag: 'SICK-1' });

    const res = await shepherd.post('/livestock/health/report-sick', { tag: 'SICK-1', note: 'Oqsoqlanyapti' });
    expect(res.status).toBe(201);
    expect(res.data.reportStatus).toBe('open');
    expect(res.data.notes).toBe('Oqsoqlanyapti');
    expect(await statusOf(f, ewe.id)).toBe('sick');

    const [alert] = await f.run(() => tx().select().from(alerts).where(eq(alerts.dedupKey, `sick_report:${ewe.id}`)));
    expect(alert.severity).toBe('urgent');
    expect(alert.status).toBe('open');
    expect(alert.title).toContain('SICK-1');
    expect(renderAlert(alert, 'ru').title).toBe('Больное животное: SICK-1');
    expect(renderAlert(alert, 'ru').body).toBe('Oqsoqlanyapti'); // the reporter's own words stay as written

    await f.run(() =>
      tx().insert(schema.animalIdentifiers).values({ tenantId: f.tenantId, farmId: f.farmId, animalId: ewe.id, type: 'rfid', value: '982000123456789' }),
    );
    const byRfid = await shepherd.post('/livestock/health/report-sick', { tag: '982000123456789', note: 'Yana' });
    expect(byRfid.status).toBe(201);
    expect(byRfid.data.animalId).toBe(ewe.id);
    const stillOne = await f.run(() => tx().select().from(alerts).where(eq(alerts.dedupKey, `sick_report:${ewe.id}`)));
    expect(stillOne).toHaveLength(1);
  });

  it('recovery returns a pregnant ewe to pregnant, closes reports and clears the alert', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    const vet = await f.as('veterinarian');
    const { ewe } = await pregnantEwe(f, daysAgo(30));
    const first = await shepherd.post('/livestock/health/report-sick', { animalId: ewe.id, note: 'Bir' });
    await shepherd.post('/livestock/health/report-sick', { animalId: ewe.id, note: 'Ikki' });

    const open = await vet.get('/livestock/health/sick-reports');
    expect(open.body.meta.total).toBe(2);
    expect(open.data[0].tag).toBe(ewe.tag);
    expect(open.data[0].reportedBy).toContain('shepherd');

    const done = await vet.post(`/livestock/health/sick-reports/${first.data.id}/resolve`, { result: 'Sog\'aydi' });
    expect(done.status).toBe(200);
    expect(done.data.reportStatus).toBe('resolved');
    expect(done.data.result).toBe('Sog\'aydi');
    expect(await statusOf(f, ewe.id)).toBe('pregnant');
    expect((await vet.get('/livestock/health/sick-reports')).body.meta.total).toBe(0);
    expect((await vet.get('/livestock/health/sick-reports', { status: 'resolved' })).body.meta.total).toBe(2);

    const [alert] = await f.run(() => tx().select().from(alerts).where(eq(alerts.dedupKey, `sick_report:${ewe.id}`)));
    expect(alert.status).toBe('resolved');

    const again = await vet.post(`/livestock/health/sick-reports/${first.data.id}/resolve`, {});
    expect(again.body.error.code).toBe('REPORT_NOT_OPEN');
  });

  it('refuses an unknown tag and an animal no longer on the farm', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    expect((await shepherd.post('/livestock/health/report-sick', { tag: 'NOPE', note: 'x' })).status).toBe(404);
    const sold = await makeAnimal(f, { status: 'sold' });
    const res = await shepherd.post('/livestock/health/report-sick', { animalId: sold.id, note: 'x' });
    expect(res.body.error.code).toBe('ANIMAL_NOT_ON_FARM');
    expect((await shepherd.post('/livestock/health/report-sick', { note: 'x' })).status).toBe(400);
  });

  it('an open report cannot be deleted away', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const ewe = await makeAnimal(f);
    const report = await owner.post('/livestock/health/report-sick', { animalId: ewe.id, note: 'x' });
    const res = await owner.delete(`/livestock/health/records/${report.data.id}`);
    expect(res.body.error.code).toBe('REPORT_OPEN');
  });
});

describe('quarantine', () => {
  it('uses the tenant period, and ending returns each animal to its own status', async () => {
    const f = await createFixture({ settings: { livestock: { quarantineDays: 10 } } });
    const vet = await f.as('veterinarian');
    const { ewe: pregnant } = await pregnantEwe(f, daysAgo(30));
    const plain = await makeAnimal(f);

    const started = await vet.post('/livestock/health/quarantine', { animalIds: [pregnant.id, plain.id], reason: 'Yangi kelgan' });
    expect(started.status).toBe(201);
    expect(started.data.until).toBe(addDays(T, 10));
    expect(started.data.started).toHaveLength(2);
    expect(await statusOf(f, pregnant.id)).toBe('quarantine');

    const list = await vet.get('/livestock/health/quarantine');
    expect(list.body.meta.total).toBe(2);
    expect(list.data[0]).toMatchObject({ until: addDays(T, 10), daysLeft: 10, reason: 'Yangi kelgan' });

    const [a, b] = list.data;
    await vet.post(`/livestock/health/quarantine/${a.id}/end`, { result: 'Sog\'lom' });
    await vet.post(`/livestock/health/quarantine/${b.id}/end`, {});
    expect(await statusOf(f, pregnant.id)).toBe('pregnant');
    expect(await statusOf(f, plain.id)).toBe('active');

    const [row] = await f.run(() => tx().select().from(animals).where(eq(animals.id, plain.id)));
    expect(row.quarantineUntil).toBeNull();
    expect((await vet.get('/livestock/health/quarantine')).body.meta.total).toBe(0);
    expect((await vet.get('/livestock/health/quarantine', { state: 'ended' })).body.meta.total).toBe(2);
  });

  it('an open sick report outlasts the quarantine', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const ewe = await makeAnimal(f);
    await vet.post('/livestock/health/report-sick', { animalId: ewe.id, note: 'x' });
    const started = await vet.post('/livestock/health/quarantine', { animalIds: [ewe.id], days: 5 });
    await vet.post(`/livestock/health/quarantine/${started.data.started[0]}/end`, {});
    expect(await statusOf(f, ewe.id)).toBe('sick');
  });

  it('does not double up, and reports who was skipped', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const inside = await makeAnimal(f);
    const outside = await makeAnimal(f);
    await vet.post('/livestock/health/quarantine', { animalIds: [inside.id] });

    const solo = await vet.post('/livestock/health/quarantine', { animalIds: [inside.id] });
    expect(solo.status).toBe(409);
    expect(solo.body.error.code).toBe('ALREADY_IN_QUARANTINE');

    const mixed = await vet.post('/livestock/health/quarantine', { animalIds: [inside.id, outside.id] });
    expect(mixed.status).toBe(201);
    expect(mixed.data.started).toHaveLength(1);
    expect(mixed.data.skipped).toEqual([{ animalId: inside.id, tag: inside.tag, reason: 'ALREADY_IN_QUARANTINE' }]);
  });

  it('checks dates, and active quarantine cannot be deleted', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const ewe = await makeAnimal(f);
    const started = await owner.post('/livestock/health/quarantine', { animalIds: [ewe.id], startDate: daysAgo(5) });
    const id = started.data.started[0];
    expect((await owner.delete(`/livestock/health/records/${id}`)).body.error.code).toBe('QUARANTINE_ACTIVE');
    const early = await owner.post(`/livestock/health/quarantine/${id}/end`, { date: daysAgo(6) });
    expect(early.body.error.code).toBe('QUARANTINE_END_BEFORE_START');
    expect((await owner.post(`/livestock/health/quarantine/${id}/end`, {})).status).toBe(200);
    const twice = await owner.post(`/livestock/health/quarantine/${id}/end`, {});
    expect(twice.body.error.code).toBe('QUARANTINE_ENDED');
    expect((await owner.delete(`/livestock/health/records/${id}`)).status).toBe(200);
  });

  it('the quarantine type on the general form goes through the same path', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const ewe = await makeAnimal(f);
    const res = await vet.post('/livestock/health/records', { type: 'quarantine', animalId: ewe.id, date: T, diagnosis: 'Shubha' });
    expect(res.status).toBe(201);
    expect(res.data.type).toBe('quarantine');
    expect(await statusOf(f, ewe.id)).toBe('quarantine');
  });
});

describe('withdrawal', () => {
  it('lists treated animals, including everyone a herd treatment covered', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const herd = await makeHerd(f, 'W');
    const other = await makeHerd(f, 'W2');
    const stayed = await makeAnimal(f, { herdId: herd.id, tag: 'STAY', birthDate: '2024-03-01' });
    const moved = await makeAnimal(f, { herdId: herd.id, tag: 'MOVED' });
    const { itemId, warehouseId } = await makeDrug(f, { withdrawalDays: 14, qty: 50, name: 'Oksitetratsiklin' });

    const record = await vet.post('/livestock/health/records', { type: 'treatment', herdId: herd.id, date: daysAgo(4), itemId, warehouseId, dose: 1, withdrawalDays: 14 });
    expect(record.data.withdrawalUntil).toBe(addDays(T, 10));

    // Moved to another herd after treatment: the drug went with it.
    await f.run(async () => {
      await tx().update(animals).set({ herdId: other.id }).where(eq(animals.id, moved.id));
      await tx().insert(herdTransfers).values({ tenantId: f.tenantId, farmId: f.farmId, animalId: moved.id, fromHerdId: herd.id, toHerdId: other.id, date: daysAgo(2) });
    });
    // Born after the treatment: never received it.
    await makeAnimal(f, { herdId: herd.id, tag: 'NEWBORN', birthDate: daysAgo(1), origin: 'born', category: 'lamb_male', sex: 'male' });

    const list = await vet.get('/livestock/health/withdrawal');
    expect(list.data.map((r: any) => r.tag).sort()).toEqual(['MOVED', 'STAY']);
    expect(list.data[0]).toMatchObject({ daysLeft: 10, drug: 'Oksitetratsiklin', withdrawalUntil: addDays(T, 10) });

    const check = await vet.get('/livestock/health/withdrawal/check', { animalIds: `${stayed.id},${moved.id}` });
    expect(check.data).toHaveLength(2);
  });

  it('ends on the date sale becomes allowed, and reports the longest period', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const ended = await makeAnimal(f, { tag: 'ENDS-TODAY' });
    const two = await makeAnimal(f, { tag: 'TWO' });
    await vet.post('/livestock/health/records', { type: 'treatment', animalId: ended.id, date: daysAgo(14), withdrawalDays: 14 });
    await vet.post('/livestock/health/records', { type: 'treatment', animalId: two.id, date: daysAgo(1), withdrawalDays: 3 });
    await vet.post('/livestock/health/records', { type: 'treatment', animalId: two.id, date: daysAgo(1), withdrawalDays: 9 });

    const list = await vet.get('/livestock/health/withdrawal');
    expect(list.body.meta.total).toBe(1);
    expect(list.data[0]).toMatchObject({ tag: 'TWO', daysLeft: 8 });

    const blocked = await f.run(() => animalsUnderWithdrawal([ended.id, two.id]));
    expect(blocked.map((r) => r.animalId)).toEqual([two.id]);
    expect(await f.run(() => animalsUnderWithdrawal([]))).toEqual([]);
  });

  it('an animal that left the farm no longer counts', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const ewe = await makeAnimal(f);
    await vet.post('/livestock/health/records', { type: 'treatment', animalId: ewe.id, date: T, withdrawalDays: 5 });
    await f.run(() => markExited(ewe.id, 'dead', T));
    expect((await vet.get('/livestock/health/withdrawal')).body.meta.total).toBe(0);
  });

  it('the check route is open to sales roles but rejects bad ids', async () => {
    const f = await createFixture();
    const accountant = await f.as('accountant');
    const ewe = await makeAnimal(f);
    expect((await accountant.get('/livestock/health/withdrawal')).status).toBe(403);
    expect((await accountant.get('/livestock/health/withdrawal/check', { animalIds: ewe.id })).status).toBe(200);
    expect((await accountant.get('/livestock/health/withdrawal/check', { animalIds: 'nonsense' })).status).toBe(400);
  });
});

describe('vaccination calendar', () => {
  it('a new herd is overdue from arrival; vaccinating it moves the next dose out by the interval', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const { itemId, warehouseId } = await makeDrug(f, { unit: 'dose', qty: 10, unitCost: 3000, name: 'Enterotoksemiya' });
    const herd = await makeHerd(f, 'Yangi');
    for (let i = 0; i < 3; i++) await makeAnimal(f, { herdId: herd.id, purchaseDate: daysAgo(5) });

    const plan = await vet.post('/livestock/health/vaccination-plans', { name: 'Enterotoksemiya', itemId, intervalDays: 180 });
    expect(plan.status).toBe(201);

    const due = await vet.get('/livestock/health/vaccinations/due');
    expect(due.data.totals).toEqual({ overdue: 3, today: 0, upcoming: 0 });
    expect(due.data.rows).toEqual([
      {
        planId: plan.data.id,
        planName: 'Enterotoksemiya',
        mandatory: true,
        itemId,
        herdId: herd.id,
        herdName: 'Yangi',
        dueDate: daysAgo(5),
        state: 'overdue',
        daysOverdue: 5,
        head: 3,
      },
    ]);

    const animalsDue = await vet.get(`/livestock/health/vaccinations/due/${plan.data.id}/animals`);
    expect(animalsDue.data).toHaveLength(3);

    const done = await vet.post('/livestock/health/vaccinations/herd', { herdId: herd.id, planId: plan.data.id, date: T, warehouseId, dosePerHead: 1 });
    expect(done.status).toBe(201);
    expect(done.data).toMatchObject({ type: 'vaccination', headCount: 3, qtyUsed: 3, itemId, nextDueDate: addDays(T, 180) });
    expect(await stockOf(f, itemId)).toBe(7);

    const after = await vet.get('/livestock/health/vaccinations/due');
    expect(after.data.rows).toEqual([]);
    const later = await vet.get('/livestock/health/vaccinations/due', { horizonDays: 200 });
    expect(later.data.rows[0]).toMatchObject({ dueDate: addDays(T, 180), state: 'upcoming', head: 3 });
  });

  it('lambs fall due by age; a plan can target one category', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    await makeAnimal(f, { origin: 'born', birthDate: daysAgo(20), category: 'lamb_female' });
    await makeAnimal(f, { origin: 'born', birthDate: daysAgo(30), category: 'lamb_female' });
    await makeAnimal(f, { origin: 'born', birthDate: daysAgo(45), category: 'lamb_female' });
    await makeAnimal(f, { purchaseDate: daysAgo(400), category: 'ewe' });
    await vet.post('/livestock/health/vaccination-plans', { name: 'Qo\'zilar', ageDays: 30, category: 'lamb_female' });

    const due = await vet.get('/livestock/health/vaccinations/due');
    expect(due.data.totals).toEqual({ overdue: 1, today: 1, upcoming: 1 });
    expect(due.data.rows.map((r: any) => [r.state, r.dueDate])).toEqual([
      ['overdue', daysAgo(15)],
      ['today', T],
      ['upcoming', addDays(T, 10)],
    ]);
  });

  it('a herd dose given before an animal arrived does not protect it', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const herd = await makeHerd(f);
    await makeAnimal(f, { herdId: herd.id, purchaseDate: daysAgo(100), tag: 'OLD' });
    const plan = await vet.post('/livestock/health/vaccination-plans', { name: 'Chechak', intervalDays: 365 });
    await vet.post('/livestock/health/vaccinations/herd', { herdId: herd.id, planId: plan.data.id, date: daysAgo(10) });
    await makeAnimal(f, { herdId: herd.id, purchaseDate: daysAgo(5), tag: 'NEW' });

    const animalsDue = await vet.get(`/livestock/health/vaccinations/due/${plan.data.id}/animals`);
    expect(animalsDue.data.map((a: any) => a.tag)).toEqual(['NEW']);
  });

  it('counts a dose of the same vaccine given without naming the plan, and one per animal', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const { itemId, warehouseId } = await makeDrug(f, { unit: 'dose' });
    const ewe = await makeAnimal(f, { purchaseDate: daysAgo(5) });
    const other = await makeAnimal(f, { purchaseDate: daysAgo(5) });
    await vet.post('/livestock/health/vaccination-plans', { name: 'Bir marta', itemId });
    await vet.post('/livestock/health/records', { type: 'vaccination', animalId: ewe.id, date: T, itemId, warehouseId, qtyUsed: 1 });

    const due = await vet.get('/livestock/health/vaccinations/due');
    expect(due.data.totals.overdue).toBe(1);
    const ids = await vet.get(`/livestock/health/vaccinations/due/${due.data.rows[0].planId}/animals`);
    expect(ids.data.map((a: any) => a.animalId)).toEqual([other.id]);
  });

  it('a deworming done on schedule closes a deworming plan', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const ewe = await makeAnimal(f, { purchaseDate: daysAgo(5) });
    const plan = await vet.post('/livestock/health/vaccination-plans', { name: 'Gijja', intervalDays: 120, mandatory: false });
    await vet.post('/livestock/health/records', { type: 'deworming', animalId: ewe.id, date: T, vaccinationPlanId: plan.data.id });
    expect((await vet.get('/livestock/health/vaccinations/due')).data.rows).toEqual([]);
  });

  it('a removed plan disappears, and plans can be corrected', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await makeAnimal(f, { purchaseDate: daysAgo(5) });
    const plan = await owner.post('/livestock/health/vaccination-plans', { name: 'Eski', intervalDays: 100, mandatory: false });
    const fixed = await owner.patch(`/livestock/health/vaccination-plans/${plan.data.id}`, { name: 'Yangi' });
    expect(fixed.data.name).toBe('Yangi');
    expect((await owner.get('/livestock/health/vaccination-plans')).data.map((p: any) => p.name)).toEqual(['Yangi']);
    expect((await owner.delete(`/livestock/health/vaccination-plans/${plan.data.id}`)).status).toBe(200);
    expect((await owner.get('/livestock/health/vaccination-plans')).data).toEqual([]);
    expect((await owner.get('/livestock/health/vaccinations/due')).data.rows).toEqual([]);
  });
});

describe('vet today', () => {
  it('gathers everything that needs action', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const shepherd = await f.as('shepherd');
    await makeAnimal(f, { purchaseDate: daysAgo(3) });
    await vet.post('/livestock/health/vaccination-plans', { name: 'Oqsil', intervalDays: 180 });
    const sick = await makeAnimal(f, { tag: 'TODAY-SICK', purchaseDate: daysAgo(3) });
    await shepherd.post('/livestock/health/report-sick', { animalId: sick.id, note: 'Yemayapti' });
    const quarantined = await makeAnimal(f, { purchaseDate: daysAgo(3) });
    await vet.post('/livestock/health/quarantine', { animalIds: [quarantined.id], days: 2 });
    const treated = await makeAnimal(f, { tag: 'COURSE', purchaseDate: daysAgo(3) });
    await vet.post('/livestock/health/records', { type: 'treatment', animalId: treated.id, date: daysAgo(1), courseDays: 5, withdrawalDays: 7 });

    const res = await vet.get('/livestock/health/today');
    expect(res.status).toBe(200);
    expect(res.data.date).toBe(T);
    // All four animals arrived three days ago and none has had the vaccine.
    expect(res.data.vaccinations.overdue).toBe(4);
    expect(res.data.vaccinations.animals).toBe(4);
    expect(res.data.vaccinations.plans).toBe(1);
    expect(res.data.sick.open).toBe(1);
    expect(res.data.sick.animals).toBe(1);
    expect(res.data.sick.reports[0].tag).toBe('TODAY-SICK');
    expect(res.data.quarantine.active).toBe(1);
    expect(res.data.quarantine.endingSoon).toHaveLength(1);
    expect(res.data.courses).toHaveLength(1);
    expect(res.data.courses[0]).toMatchObject({ tag: 'COURSE', day: 2, courseDays: 5 });
    expect(res.data.withdrawal.animals).toBe(1);
  });
});

describe('counting what is due', () => {
  it('counts doses per plan, but animals once', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    for (let i = 0; i < 3; i++) await makeAnimal(f, { purchaseDate: daysAgo(5) });
    await vet.post('/livestock/health/vaccination-plans', { name: 'Bir', intervalDays: 180 });
    await vet.post('/livestock/health/vaccination-plans', { name: 'Ikki', intervalDays: 180 });

    const due = await vet.get('/livestock/health/vaccinations/due');
    expect(due.data.totals.overdue).toBe(6);
    expect(due.data.animals).toBe(3);
    expect(due.data.plans).toBe(2);
  });

  it('counts a sick animal that has no report, and it can be marked recovered', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const { ewe } = await pregnantEwe(f, daysAgo(30));
    await f.run(() => tx().update(animals).set({ status: 'sick' }).where(eq(animals.id, ewe.id)));

    const today = await vet.get('/livestock/health/today');
    expect(today.data.sick).toMatchObject({ open: 0, animals: 1 });

    const recovered = await vet.post(`/livestock/health/animals/${ewe.id}/recover`, { result: "Sog'aydi" });
    expect(recovered.data.status).toBe('pregnant');
    expect((await vet.get('/livestock/health/today')).data.sick.animals).toBe(0);
  });
});

describe('veterinary documents', () => {
  it('keeps certificates linked to an animal or herd', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const ewe = await makeAnimal(f);
    const created = await vet.post('/livestock/health/documents', {
      title: 'Veterinariya guvohnomasi',
      number: 'VG-14',
      issueDate: T,
      expiryDate: addDays(T, 30),
      entityType: 'animal',
      entityId: ewe.id,
    });
    expect(created.status).toBe(201);
    expect(created.data.type).toBe('vet_certificate');

    const list = await vet.get('/livestock/health/documents', { entityId: ewe.id });
    expect(list.body.meta.total).toBe(1);
    expect(list.data[0].fileUrl).toBeNull();

    const shepherd = await f.as('shepherd');
    expect((await shepherd.post('/livestock/health/documents', { title: 'x' })).status).toBe(403);
    expect((await vet.delete(`/livestock/health/documents/${created.data.id}`)).status).toBe(200);
    const gone = await f.run(() => tx().select().from(documents).where(eq(documents.id, created.data.id)));
    expect(gone).toEqual([]);
  });

  it("does not touch another module's documents", async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const [land] = await f.run(() =>
      tx().insert(documents).values({ tenantId: f.tenantId, farmId: f.farmId, type: 'land', title: 'Ijara' }).returning(),
    );
    expect((await owner.get('/livestock/health/documents')).body.meta.total).toBe(0);
    expect((await owner.delete(`/livestock/health/documents/${land.id}`)).status).toBe(404);
  });
});

describe('tenant isolation', () => {
  it("cannot read, change, or reference another tenant's animals, drugs and staff", async () => {
    const a = await createFixture();
    const b = await createFixture();
    const vetB = await b.as('veterinarian');
    const zooB = await b.as('zootechnician');
    const ownerB = await b.as('owner');

    const { ewe, record } = await pregnantEwe(a, daysAgo(30));
    const vetA = await a.as('veterinarian');
    const health = await vetA.post('/livestock/health/records', { type: 'treatment', animalId: ewe.id, date: T });

    expect((await zooB.get('/livestock/breeding')).body.meta.total).toBe(0);
    expect((await zooB.get(`/livestock/breeding/${record.id}`)).status).toBe(404);
    expect((await zooB.post(`/livestock/breeding/${record.id}/close`, { status: 'failed' })).status).toBe(404);
    expect((await zooB.get(`/livestock/pedigree/${ewe.id}`)).status).toBe(404);
    expect((await zooB.post('/livestock/breeding', { eweId: ewe.id, matingDate: '2026-10-01' })).status).toBe(404);
    expect((await zooB.post('/livestock/lambings', { eweId: ewe.id, date: T, lambs: [{ sex: 'male' }] })).status).toBe(404);

    expect((await vetB.get('/livestock/health/records')).body.meta.total).toBe(0);
    expect((await vetB.get(`/livestock/health/records/${health.data.id}`)).status).toBe(404);
    expect((await vetB.patch(`/livestock/health/records/${health.data.id}`, { notes: 'x' })).status).toBe(404);
    expect((await ownerB.delete(`/livestock/health/records/${health.data.id}`)).status).toBe(404);
    expect((await vetB.post('/livestock/health/report-sick', { animalId: ewe.id, note: 'x' })).status).toBe(404);
    expect((await vetB.post('/livestock/health/quarantine', { animalIds: [ewe.id] })).status).toBe(404);

    // Postgres FK checks run outside RLS, so a reference to a foreign row must be refused by code.
    const own = await makeAnimal(b);
    const drugA = await makeDrug(a);
    const foreignDrug = await vetB.post('/livestock/health/records', { type: 'treatment', animalId: own.id, date: T, ...drugA, qtyUsed: 1 });
    expect(foreignDrug.status).toBe(404);

    const [employee] = await a.run(() =>
      tx().insert(schema.employees).values({ tenantId: a.tenantId, farmId: a.farmId, fullName: 'V', position: 'Veterinar', hireDate: T }).returning(),
    );
    const foreignVet = await vetB.post('/livestock/health/records', { type: 'examination', animalId: own.id, date: T, vetEmployeeId: employee.id });
    expect(foreignVet.status).toBe(400);
    expect(foreignVet.body.error.code).toBe('INVALID_REFERENCE');

    const plansA = await vetA.post('/livestock/health/vaccination-plans', { name: 'A' });
    const foreignPlan = await vetB.post('/livestock/health/records', { type: 'vaccination', animalId: own.id, date: T, vaccinationPlanId: plansA.data.id });
    expect(foreignPlan.status).toBe(400);
    expect((await vetB.patch(`/livestock/health/vaccination-plans/${plansA.data.id}`, { name: 'x' })).status).toBe(404);
  });
});

describe('seed', () => {
  it('gives every ewe a pregnancy in the spring window, and builds the demo veterinary state', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const vet = await f.as('veterinarian');
    const shepherd = await f.as('shepherd');
    const herd = await makeHerd(f, SEED.herd.pregnant);
    const flock = 120;
    for (let i = 0; i < flock; i++) await makeAnimal(f, { herdId: herd.id, purchaseDate: daysAgo(7), tag: `YA-${i}` });

    await f.run(async () => {
      const common = { tenantId: f.tenantId, farmId: f.farmId };
      const [store] = await tx().insert(warehouses).values({ ...common, name: SEED.warehouse.vet, type: 'vet' }).returning();
      await tx().insert(schema.employees).values({ ...common, fullName: 'Vet', position: SEED.position.veterinarian, hireDate: daysAgo(100) });
      const drugs = [SEED.item.poxVaccine, SEED.item.fmdVaccine, SEED.item.enterotoxemiaVaccine, SEED.item.dewormer, SEED.item.antibiotic, SEED.item.vitamin];
      for (const name of drugs) {
        const [item] = await tx().insert(items).values({ ...common, name, category: 'vaccine', unit: 'dose', withdrawalDays: name === SEED.item.antibiotic ? 21 : null }).returning();
        await receiveStock({ itemId: item.id, warehouseId: store.id, qty: 1000, unitCost: 1000, date: daysAgo(30), source: 'purchase' });
      }
    });

    const users = { owner: owner.userId, veterinarian: vet.userId, shepherd: shepherd.userId, zootechnician: owner.userId } as Record<RoleKey, string>;
    await seedVet({ tenantId: f.tenantId, farmId: f.farmId, users, run: (fn, as = 'owner') => f.run(fn, { userId: users[as] }) });

    const pregnancies = await owner.get('/livestock/breeding', { pageSize: 200, status: 'pregnant' });
    expect(pregnancies.body.meta.total).toBe(flock);
    for (const row of pregnancies.data) {
      expect(row.source).toBe('purchase');
      expect(row.expectedDate >= '2027-02-01' && row.expectedDate <= '2027-03-31').toBe(true);
    }

    const today = await vet.get('/livestock/health/today');
    expect(today.data.sick.open).toBe(1);
    expect(today.data.quarantine.active).toBe(1);
    expect(today.data.courses).toHaveLength(1);
    expect(today.data.withdrawal.animals).toBe(1);

    const plans = await vet.get('/livestock/health/vaccination-plans');
    expect(plans.data.filter((p: any) => p.mandatory)).toHaveLength(4);

    const journal = await vet.get('/livestock/health/records', { type: 'vaccination' });
    expect(journal.data[0]).toMatchObject({ headCount: flock, qtyUsed: flock });
  });
});

describe('services used by other modules', () => {
  it('createPregnancy and recordLambing work in a system context, and createRecord too', async () => {
    const f = await createFixture();
    const ewe = await makeAnimal(f);
    const lambed = await f.run(async () => {
      const date = daysAgo(1);
      await createPregnancy({ eweId: ewe.id, matingDate: addDays(date, -150), source: 'purchase' });
      const record = await recordLambing({ eweId: ewe.id, date, lambs: [{ sex: 'male', alive: true }] });
      await createRecord({ type: 'examination', animalId: ewe.id, date });
      expect(ctx().tenantId).toBe(f.tenantId);
      return record;
    });
    expect(lambed.lambsAlive).toBe(1);
    const rows = await f.run(() => tx().select().from(healthRecords).where(sql`animal_id = ${ewe.id}`));
    expect(rows).toHaveLength(1);
  });
});
