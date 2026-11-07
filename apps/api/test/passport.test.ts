import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIso } from '@yap/shared';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { receiveStock } from '../src/core/inventory';
import { markExited } from '../src/modules/livestock/animals.service';
import { closePregnancy, createPregnancy, recordLambing } from '../src/modules/livestock/breeding.service';
import { createRecord, endQuarantine, startQuarantine, type HealthRecordInput } from '../src/modules/livestock/health.service';
import { transfer } from '../src/modules/livestock/herds.service';
import { createFixture, type Fixture } from './helpers';

const { animals, breeds, employees, farms, herds, items, species, warehouses, weightRecords } = schema;

const T = todayIso();
const daysAgo = (n: number) => addDays(T, -n);
const daysAhead = (n: number) => addDays(T, n);
let tagCounter = 0;

interface AnimalOverrides {
  tag?: string;
  sex?: string;
  category?: string;
  origin?: string;
  herdId?: string | null;
  farmId?: string;
  birthDate?: string | null;
  purchaseDate?: string | null;
}

async function makeAnimal(f: Fixture, o: AnimalOverrides = {}) {
  return f.run(async () => {
    const [kind] = await tx().select().from(species).where(and(eq(species.tenantId, f.tenantId), eq(species.key, 'sheep')));
    const [breed] = await tx().select().from(breeds).where(and(eq(breeds.tenantId, f.tenantId), eq(breeds.key, 'hisori')));
    const [row] = await tx()
      .insert(animals)
      .values({
        tenantId: f.tenantId,
        farmId: o.farmId ?? f.farmId,
        tag: o.tag ?? `P${++tagCounter}`,
        speciesId: kind.id,
        breedId: breed.id,
        sex: o.sex ?? 'female',
        category: o.category ?? 'ewe',
        origin: o.origin ?? 'purchased',
        herdId: o.herdId ?? null,
        birthDate: o.birthDate ?? null,
        purchaseDate: o.purchaseDate ?? null,
      })
      .returning();
    return row;
  });
}

const makeRam = (f: Fixture, tag: string) => makeAnimal(f, { tag, sex: 'male', category: 'ram' });

async function makeHerd(f: Fixture, name: string) {
  return f.run(async () => {
    const [row] = await tx().insert(herds).values({ tenantId: f.tenantId, farmId: f.farmId, name }).returning();
    return row;
  });
}

async function makeDrug(f: Fixture, name: string) {
  return f.run(async () => {
    const [warehouse] = await tx()
      .insert(warehouses)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name: `Vet ${name}`, type: 'vet' })
      .returning();
    const [item] = await tx()
      .insert(items)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name, category: 'vet_drug', unit: 'vial' })
      .returning();
    await receiveStock({ itemId: item.id, warehouseId: warehouse.id, qty: 100, unitCost: 20_000, date: daysAgo(400), source: 'purchase' });
    return { itemId: item.id, warehouseId: warehouse.id };
  });
}

const breedingOf = (client: { get: (url: string) => Promise<any> }, id: string) => client.get(`/livestock/animals/${id}/breeding`);
const healthOf = (client: { get: (url: string) => Promise<any> }, id: string) => client.get(`/livestock/animals/${id}/health`);

describe('GET /animals/:id/breeding', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  it('gives the rams and the figures of a ewe with two matings and two lambings', async () => {
    const zoo = await f.as('zootechnician');
    const ewe = await makeAnimal(f);
    const ramA = await makeRam(f, 'RAM-A');
    const ramB = await makeRam(f, 'RAM-B');

    const first = await f.run(() => createPregnancy({ eweId: ewe.id, ramId: ramA.id, matingDate: daysAgo(500) }));
    const twins = await f.run(() =>
      recordLambing({
        eweId: ewe.id,
        date: daysAgo(350),
        complications: "Og'ir tug'ruq",
        lambs: [
          { sex: 'female', birthWeightKg: 4, alive: true },
          { sex: 'male', birthWeightKg: 3, alive: false },
        ],
      }),
    );
    const second = await f.run(() => createPregnancy({ eweId: ewe.id, ramId: ramB.id, matingDate: daysAgo(300), notes: 'Kuzgi' }));
    const single = await f.run(() =>
      recordLambing({ eweId: ewe.id, date: daysAgo(150), lambs: [{ sex: 'male', birthWeightKg: 5, alive: true }] }),
    );

    const twin = twins.lambs[0];
    const lamb = single.lambs[0];
    await f.run(() =>
      tx()
        .insert(weightRecords)
        .values([
          // 100 days old: 4 + (24 − 4) / 100 × 100 = 24.0
          { tenantId: f.tenantId, farmId: f.farmId, animalId: twin.animalId!, date: daysAgo(250), weightKg: 24 },
          // 80 days old: 5 + (21 − 5) / 80 × 100 = 25.0
          { tenantId: f.tenantId, farmId: f.farmId, animalId: lamb.animalId!, date: daysAgo(70), weightKg: 21 },
        ]),
    );

    const res = await breedingOf(zoo, ewe.id);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      summary: {
        lambings: 2,
        lambsBorn: 3,
        lambsAlive: 2,
        // Both births are past weaning: 2 of 3 lambs lived.
        survivalPercent: 66.7,
        // (24.0 + 25.0) / 2
        avgWeight100Kg: 24.5,
        lastLambingDate: daysAgo(150),
      },
      matings: [
        {
          id: second.id,
          source: 'mating',
          matingDate: daysAgo(300),
          expectedDate: daysAgo(150),
          status: 'lambed',
          ramId: ramB.id,
          ramTag: 'RAM-B',
          notes: 'Kuzgi',
          canSetRam: false,
          lambing: { id: single.id, date: daysAgo(150), lambsBorn: 1, lambsAlive: 1 },
        },
        {
          id: first.id,
          source: 'mating',
          matingDate: daysAgo(500),
          expectedDate: daysAgo(350),
          status: 'lambed',
          ramId: ramA.id,
          ramTag: 'RAM-A',
          notes: null,
          canSetRam: false,
          lambing: { id: twins.id, date: daysAgo(350), lambsBorn: 2, lambsAlive: 1 },
        },
      ],
      lambings: [
        {
          id: single.id,
          breedingId: second.id,
          date: daysAgo(150),
          lambsBorn: 1,
          lambsAlive: 1,
          complications: null,
          ramId: ramB.id,
          ramTag: 'RAM-B',
          lambs: [{ sex: 'male', birthWeightKg: 5, alive: true, animalId: lamb.animalId, tag: lamb.tag }],
        },
        {
          id: twins.id,
          breedingId: first.id,
          date: daysAgo(350),
          lambsBorn: 2,
          lambsAlive: 1,
          complications: "Og'ir tug'ruq",
          ramId: ramA.id,
          ramTag: 'RAM-A',
          lambs: [
            { sex: 'female', birthWeightKg: 4, alive: true, animalId: twin.animalId, tag: twin.tag },
            { sex: 'male', birthWeightKg: 3, alive: false, animalId: null, tag: null },
          ],
        },
      ],
    });
  });

  it('still names a ram that has left the farm', async () => {
    const ewe = await makeAnimal(f);
    const ram = await makeRam(f, 'RAM-SOLD');
    await f.run(() => createPregnancy({ eweId: ewe.id, ramId: ram.id, matingDate: daysAgo(160) }));
    await f.run(() => recordLambing({ eweId: ewe.id, date: daysAgo(10), lambs: [{ sex: 'male', alive: true }] }));
    await f.run(() => markExited(ram.id, 'dead', daysAgo(5)));

    const { data } = await breedingOf(await f.as('owner'), ewe.id);
    expect(data.matings[0]).toMatchObject({ ramId: ram.id, ramTag: 'RAM-SOLD' });
    expect(data.lambings[0]).toMatchObject({ ramId: ram.id, ramTag: 'RAM-SOLD' });
  });

  it('gives a lamb its tag of today, and drops the link to one deleted as a mistake', async () => {
    const owner = await f.as('owner');
    const ewe = await makeAnimal(f);
    const birth = await f.run(() =>
      recordLambing({
        eweId: ewe.id,
        date: daysAgo(10),
        lambs: [
          { sex: 'male', alive: true },
          { sex: 'female', alive: true },
        ],
      }),
    );
    const [renamed, deleted] = birth.lambs;
    expect((await owner.patch(`/livestock/animals/${renamed.animalId}`, { tag: 'NEW-TAG' })).status).toBe(200);
    expect((await owner.delete(`/livestock/animals/${deleted.animalId}`)).status).toBe(200);

    const { data } = await breedingOf(owner, ewe.id);
    expect(data.lambings[0].lambs).toEqual([
      { sex: 'male', birthWeightKg: null, alive: true, animalId: renamed.animalId, tag: 'NEW-TAG' },
      { sex: 'female', birthWeightKg: null, alive: true, animalId: null, tag: deleted.tag },
    ]);
  });

  it('has no ram for a pregnancy bought with the ewe, and offers none', async () => {
    const ewe = await makeAnimal(f);
    await f.run(() => createPregnancy({ eweId: ewe.id, matingDate: daysAgo(40), source: 'purchase' }));

    const { data } = await breedingOf(await f.as('zootechnician'), ewe.id);
    expect(data.matings).toHaveLength(1);
    expect(data.matings[0]).toMatchObject({ source: 'purchase', status: 'pregnant', ramId: null, ramTag: null, canSetRam: false, lambing: null });
  });

  it('offers to set a missing ram to those who may, and the offer works', async () => {
    const zoo = await f.as('zootechnician');
    const ewe = await makeAnimal(f);
    const ram = await makeRam(f, 'RAM-LATE');
    const record = await f.run(() => createPregnancy({ eweId: ewe.id, matingDate: daysAgo(40) }));

    expect((await breedingOf(zoo, ewe.id)).data.matings[0].canSetRam).toBe(true);
    expect((await breedingOf(await f.as('veterinarian'), ewe.id)).data.matings[0].canSetRam).toBe(true);
    const shepherd = await f.as('shepherd');
    expect((await breedingOf(shepherd, ewe.id)).data.matings[0].canSetRam).toBe(false);
    expect((await shepherd.patch(`/livestock/breeding/${record.id}`, { ramId: ram.id })).status).toBe(403);

    expect((await zoo.patch(`/livestock/breeding/${record.id}`, { ramId: ram.id })).status).toBe(200);
    expect((await breedingOf(zoo, ewe.id)).data.matings[0]).toMatchObject({ ramId: ram.id, ramTag: 'RAM-LATE', canSetRam: false });
  });

  it('does not offer it on a closed pregnancy, because PATCH would refuse', async () => {
    const zoo = await f.as('zootechnician');
    const ewe = await makeAnimal(f);
    const ram = await makeRam(f, 'RAM-CLOSED');
    const record = await f.run(() => createPregnancy({ eweId: ewe.id, matingDate: daysAgo(40) }));
    await f.run(() => closePregnancy(record.id, { status: 'failed' }));

    expect((await breedingOf(zoo, ewe.id)).data.matings[0]).toMatchObject({ status: 'failed', ramId: null, canSetRam: false });
    const refused = await zoo.patch(`/livestock/breeding/${record.id}`, { ramId: ram.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PREGNANCY_NOT_OPEN');
  });

  describe('a lambing with no pregnancy on record', () => {
    async function birthWithTwoLambs() {
      const ewe = await makeAnimal(f);
      const birth = await f.run(() =>
        recordLambing({
          eweId: ewe.id,
          date: daysAgo(30),
          lambs: [
            { sex: 'male', alive: true },
            { sex: 'female', alive: true },
            { sex: 'female', alive: false },
          ],
        }),
      );
      expect(birth.breedingId).toBeNull();
      return { ewe, lambIds: birth.lambs.flatMap((lamb) => (lamb.animalId ? [lamb.animalId] : [])) };
    }
    const setSire = (animalId: string, sireId: string) => f.run(() => tx().update(animals).set({ sireId }).where(eq(animals.id, animalId)));
    const ramOfBirth = async (eweId: string) => {
      const { data } = await breedingOf(await f.as('owner'), eweId);
      return { ramId: data.lambings[0].ramId, ramTag: data.lambings[0].ramTag };
    };

    it('takes the sire the lambs share, leaving the stillborn lamb out of it', async () => {
      const { ewe, lambIds } = await birthWithTwoLambs();
      const ram = await makeRam(f, 'RAM-SHARED');
      for (const id of lambIds) await setSire(id, ram.id);
      expect(await ramOfBirth(ewe.id)).toEqual({ ramId: ram.id, ramTag: 'RAM-SHARED' });
    });

    it('names no ram when no lamb has a sire', async () => {
      const { ewe } = await birthWithTwoLambs();
      expect(await ramOfBirth(ewe.id)).toEqual({ ramId: null, ramTag: null });
    });

    it('names no ram when the lambs have different sires', async () => {
      const { ewe, lambIds } = await birthWithTwoLambs();
      await setSire(lambIds[0], (await makeRam(f, 'RAM-ONE')).id);
      await setSire(lambIds[1], (await makeRam(f, 'RAM-TWO')).id);
      expect(await ramOfBirth(ewe.id)).toEqual({ ramId: null, ramTag: null });
    });

    it('names no ram when only one of the lambs has a sire', async () => {
      const { ewe, lambIds } = await birthWithTwoLambs();
      await setSire(lambIds[0], (await makeRam(f, 'RAM-HALF')).id);
      expect(await ramOfBirth(ewe.id)).toEqual({ ramId: null, ramTag: null });
    });
  });

  it('lets the sire set on the lambs answer when the pregnancy never named a ram', async () => {
    const ewe = await makeAnimal(f);
    const ram = await makeRam(f, 'RAM-AFTER');
    await f.run(() => createPregnancy({ eweId: ewe.id, matingDate: daysAgo(160) }));
    const birth = await f.run(() => recordLambing({ eweId: ewe.id, date: daysAgo(10), lambs: [{ sex: 'male', alive: true }] }));
    await f.run(() => tx().update(animals).set({ sireId: ram.id }).where(eq(animals.id, birth.lambs[0].animalId!)));

    const { data } = await breedingOf(await f.as('owner'), ewe.id);
    expect(data.lambings[0]).toMatchObject({ ramId: ram.id, ramTag: 'RAM-AFTER' });
    expect(data.matings[0].ramId).toBeNull();
  });

  it.each([
    ['a male', { sex: 'male', category: 'ram' }],
    ['a female with no records', {}],
  ])('gives %s empty lists, zero counts and null figures', async (_label, overrides) => {
    const animal = await makeAnimal(f, overrides);
    const res = await breedingOf(await f.as('owner'), animal.id);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      summary: { lambings: 0, lambsBorn: 0, lambsAlive: 0, survivalPercent: null, avgWeight100Kg: null, lastLambingDate: null },
      matings: [],
      lambings: [],
    });
  });

  it('has the access of GET /breeding', async () => {
    const ewe = await makeAnimal(f);
    expect((await breedingOf(await f.as('shepherd'), ewe.id)).status).toBe(200);
    const investor = await breedingOf(await f.as('investor'), ewe.id);
    expect(investor.status).toBe(403);
    expect(investor.data).toBeUndefined();
  });
});

describe('GET /animals/:id/health', () => {
  let f: Fixture;
  let drug: { itemId: string; warehouseId: string };

  const recordIds = async (animalId: string) => {
    const res = await healthOf(await f.as('owner'), animalId);
    expect(res.status).toBe(200);
    return res.data.records.map((r: { id: string }) => r.id);
  };
  const vaccinate = (herdId: string, date: string, nextDueDate?: string) =>
    f.run(() => createRecord({ type: 'vaccination', herdId, date, nextDueDate, ...drug, qtyUsed: 2 }));
  const moveTo = (animalId: string, toHerdId: string, date: string) => f.run(() => transfer({ animalIds: [animalId], toHerdId, date }));

  beforeAll(async () => {
    f = await createFixture();
    drug = await makeDrug(f, "Qo'y chechagi vaksinasi");
  });

  describe('whether a whole-herd record reached this animal', () => {
    let herd: { id: string };
    let other: { id: string };
    let shot: { id: string };
    const shotDate = daysAgo(50);

    beforeAll(async () => {
      herd = await makeHerd(f, 'Sovliqlar');
      other = await makeHerd(f, 'Erkaklar');
      shot = await vaccinate(herd.id, shotDate);
    });

    it('shows a vaccination given while the animal was in the herd', async () => {
      const animal = await makeAnimal(f, { herdId: herd.id, purchaseDate: daysAgo(100) });
      expect(await recordIds(animal.id)).toEqual([shot.id]);
    });

    it('does not show one given before it moved in', async () => {
      const animal = await makeAnimal(f, { herdId: other.id, purchaseDate: daysAgo(100) });
      await moveTo(animal.id, herd.id, daysAgo(10));
      expect(await recordIds(animal.id)).toEqual([]);
    });

    it('shows one given after it moved in', async () => {
      const animal = await makeAnimal(f, { herdId: other.id, purchaseDate: daysAgo(100) });
      await moveTo(animal.id, herd.id, daysAgo(60));
      expect(await recordIds(animal.id)).toEqual([shot.id]);
    });

    it('still shows one given before it moved out', async () => {
      const animal = await makeAnimal(f, { herdId: herd.id, purchaseDate: daysAgo(100) });
      await moveTo(animal.id, other.id, daysAgo(10));
      expect(await recordIds(animal.id)).toEqual([shot.id]);
    });

    it('does not show one given after it moved out', async () => {
      const animal = await makeAnimal(f, { herdId: herd.id, purchaseDate: daysAgo(100) });
      await moveTo(animal.id, other.id, daysAgo(60));
      expect(await recordIds(animal.id)).toEqual([]);
    });

    it('does not show one given before it was born', async () => {
      const animal = await makeAnimal(f, { herdId: herd.id, origin: 'born', category: 'lamb_female', birthDate: daysAgo(20) });
      expect(await recordIds(animal.id)).toEqual([]);
    });

    it('does not show one given before it was bought', async () => {
      const animal = await makeAnimal(f, { herdId: herd.id, birthDate: daysAgo(900), purchaseDate: daysAgo(20) });
      expect(await recordIds(animal.id)).toEqual([]);
    });

    it('does not show one given after it left the farm', async () => {
      const animal = await makeAnimal(f, { herdId: herd.id, purchaseDate: daysAgo(100) });
      await f.run(() => markExited(animal.id, 'sold', daysAgo(51)));
      expect(await recordIds(animal.id)).toEqual([]);
    });

    it('shows one given on the very day it left', async () => {
      const animal = await makeAnimal(f, { herdId: herd.id, purchaseDate: daysAgo(100) });
      await f.run(() => markExited(animal.id, 'sold', shotDate));
      expect(await recordIds(animal.id)).toEqual([shot.id]);
    });

    it('counts an animal with no birth or purchase date as present', async () => {
      const animal = await makeAnimal(f, { herdId: herd.id });
      expect(await recordIds(animal.id)).toEqual([shot.id]);
    });

    it('never shows the record of a herd the animal has not been in', async () => {
      const animal = await makeAnimal(f, { herdId: other.id, purchaseDate: daysAgo(100) });
      expect(await recordIds(animal.id)).toEqual([]);
    });

    it('follows an animal through two moves, herd by herd', async () => {
      const first = await makeHerd(f, 'Bir');
      const second = await makeHerd(f, 'Ikki');
      const third = await makeHerd(f, 'Uch');
      const animal = await makeAnimal(f, { herdId: first.id, purchaseDate: daysAgo(100) });
      await moveTo(animal.id, second.id, daysAgo(60));
      await moveTo(animal.id, third.id, daysAgo(40));

      const before = await vaccinate(first.id, daysAgo(70));
      await vaccinate(first.id, daysAgo(50));
      const between = await vaccinate(second.id, daysAgo(50));
      await vaccinate(second.id, daysAgo(30));
      await vaccinate(third.id, daysAgo(50));
      const after = await vaccinate(third.id, daysAgo(30));

      expect(await recordIds(animal.id)).toEqual([after.id, between.id, before.id]);
    });

    it('an edit that moves it counts from the day of the edit, the same as a transfer', async () => {
      const owner = await f.as('owner');
      const third = await makeHerd(f, 'Boquv');
      const animal = await makeAnimal(f, { herdId: other.id, purchaseDate: daysAgo(100) });
      await moveTo(animal.id, herd.id, daysAgo(60));
      expect((await owner.patch(`/livestock/animals/${animal.id}`, { herdId: third.id })).status).toBe(200);
      await vaccinate(third.id, daysAgo(3));
      const fresh = await vaccinate(third.id, T);
      expect(await recordIds(animal.id)).toEqual([fresh.id, shot.id]);
    });
  });

  it('lists its own records and its herds together, newest first, in the agreed shape', async () => {
    const owner = await f.as('owner');
    const herd = await makeHerd(f, 'Birinchi');
    const animal = await makeAnimal(f, { herdId: herd.id, purchaseDate: daysAgo(100) });
    const [vet] = await f.run(() =>
      tx().insert(employees).values({ tenantId: f.tenantId, farmId: f.farmId, fullName: 'Aliyev Vali', position: 'Veterinar', hireDate: daysAgo(400) }).returning(),
    );
    const older = await vaccinate(herd.id, daysAgo(30));
    const newer = await f.run(() =>
      createRecord({
        type: 'treatment',
        animalId: animal.id,
        date: daysAgo(4),
        diagnosis: 'Oqsoqlik',
        itemId: drug.itemId,
        warehouseId: drug.warehouseId,
        dose: 5,
        doseUnit: 'ml',
        qtyUsed: 2,
        courseDays: 3,
        vetEmployeeId: vet.id,
        result: 'Tuzaldi',
        withdrawalDays: 10,
        notes: 'Chap oyoq',
      }),
    );

    const res = await healthOf(owner, animal.id);
    expect(res.data).toEqual({
      nextDue: [],
      records: [
        {
          id: newer.id,
          type: 'treatment',
          date: daysAgo(4),
          scope: 'animal',
          herdName: null,
          diagnosis: 'Oqsoqlik',
          itemName: "Qo'y chechagi vaksinasi",
          itemUnit: 'vial',
          dose: 5,
          doseUnit: 'ml',
          courseDays: 3,
          vetName: 'Aliyev Vali',
          result: 'Tuzaldi',
          // Last of 3 course days, then 10 days of withdrawal.
          withdrawalUntil: daysAhead(8),
          nextDueDate: null,
          reportStatus: null,
          endedOn: null,
          notes: 'Chap oyoq',
          // 2 vials × 20 000
          totalCost: 40_000,
        },
        {
          id: older.id,
          type: 'vaccination',
          date: daysAgo(30),
          scope: 'herd',
          herdName: 'Birinchi',
          diagnosis: null,
          itemName: "Qo'y chechagi vaksinasi",
          itemUnit: 'vial',
          dose: null,
          doseUnit: null,
          courseDays: null,
          vetName: null,
          result: null,
          withdrawalUntil: null,
          nextDueDate: null,
          reportStatus: null,
          endedOn: null,
          notes: null,
          // The record cost 40 000 for the whole herd, which is not this animal's cost.
          totalCost: null,
        },
      ],
    });
  });

  it('shows an open sick report and an ended quarantine as they stand', async () => {
    const animal = await makeAnimal(f);
    const quarantine = await f.run(() => startQuarantine({ animalIds: [animal.id], startDate: daysAgo(20), days: 21, reason: 'Yangi keltirilgan' }));
    await f.run(() => endQuarantine(quarantine.started[0], { date: daysAgo(2), result: "Sog'lom" }));
    const sick = await (await f.as('shepherd')).post('/livestock/health/report-sick', { animalId: animal.id, note: 'Ovqat yemayapti' });
    expect(sick.status).toBe(201);

    const { data } = await healthOf(await f.as('owner'), animal.id);
    expect(data.records).toHaveLength(2);
    expect(data.records[0]).toMatchObject({ type: 'examination', scope: 'animal', reportStatus: 'open', endedOn: null, notes: 'Ovqat yemayapti' });
    expect(data.records[1]).toMatchObject({ type: 'quarantine', scope: 'animal', endedOn: daysAgo(2), result: "Sog'lom", nextDueDate: daysAhead(1) });
  });

  it('a move on the edit form leaves a transfer, so the passport can tell which herd it was in', async () => {
    const owner = await f.as('owner');
    const animal = await makeAnimal(f, { purchaseDate: daysAgo(100) });
    const other = await makeHerd(f, "Tahrirda ko'chirilgan");
    expect((await owner.patch(`/livestock/animals/${animal.id}`, { herdId: other.id })).status).toBe(200);
    const transfers = await f.run(() => tx().select().from(schema.herdTransfers).where(eq(schema.herdTransfers.animalId, animal.id)));
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ fromHerdId: animal.herdId, toHerdId: other.id, date: T });
    expect((await owner.patch(`/livestock/animals/${animal.id}`, { notes: 'Faqat izoh' })).status).toBe(200);
    expect(await f.run(() => tx().select().from(schema.herdTransfers).where(eq(schema.herdTransfers.animalId, animal.id)))).toHaveLength(1);
  });

  it('the vet journal hides the name without pii.view, the same as the passport', async () => {
    const animal = await makeAnimal(f);
    const [vet] = await f.run(() =>
      tx().insert(employees).values({ tenantId: f.tenantId, farmId: f.farmId, fullName: 'Karimov Salim', position: 'Veterinar', hireDate: daysAgo(400) }).returning(),
    );
    const record = await f.run(() => createRecord({ type: 'examination', animalId: animal.id, date: T, vetEmployeeId: vet.id }));
    const shepherd = await f.as('shepherd');
    const owner = await f.as('owner');
    const inList = async (who: typeof owner) =>
      (await who.get('/livestock/health/records', { animalId: animal.id })).data.find((row: any) => row.id === record.id);
    expect((await inList(owner)).vetName).toBeTruthy();
    expect((await inList(shepherd)).vetName).toBeNull();
    expect((await shepherd.get(`/livestock/health/records/${record.id}`)).data.vetName).toBeNull();
  });

  describe('nextDue', () => {
    const own = (animalId: string, type: HealthRecordInput['type'], date: string, nextDueDate: string | null, given: typeof drug | null = drug) =>
      f.run(() => createRecord({ type, animalId, date, nextDueDate, ...(given ? { ...given, qtyUsed: 1 } : {}) }));
    const nextOf = async (animalId: string) => (await healthOf(await f.as('owner'), animalId)).data.nextDue;

    it('lists what is still ahead, soonest first', async () => {
      const animal = await makeAnimal(f);
      await own(animal.id, 'vaccination', daysAgo(5), daysAhead(100));
      await own(animal.id, 'deworming', daysAgo(5), daysAhead(30), null);
      expect(await nextOf(animal.id)).toEqual([
        { date: daysAhead(30), type: 'deworming', itemName: null },
        { date: daysAhead(100), type: 'vaccination', itemName: "Qo'y chechagi vaksinasi" },
      ]);
    });

    it('keeps a reminder that has passed, because that dose is still owed, and one due today', async () => {
      const passed = await makeAnimal(f);
      await own(passed.id, 'vaccination', daysAgo(50), daysAgo(1));
      expect(await nextOf(passed.id)).toEqual([{ date: daysAgo(1), type: 'vaccination', itemName: "Qo'y chechagi vaksinasi" }]);

      const dueToday = await makeAnimal(f);
      await own(dueToday.id, 'vaccination', daysAgo(50), T);
      expect(await nextOf(dueToday.id)).toEqual([{ date: T, type: 'vaccination', itemName: "Qo'y chechagi vaksinasi" }]);
    });

    it('drops an old reminder once a later dose of the same item is on record', async () => {
      const animal = await makeAnimal(f);
      await own(animal.id, 'vaccination', daysAgo(200), daysAhead(10));
      await own(animal.id, 'vaccination', daysAgo(5), daysAhead(180));
      expect(await nextOf(animal.id)).toEqual([{ date: daysAhead(180), type: 'vaccination', itemName: "Qo'y chechagi vaksinasi" }]);
    });

    it('drops it even when the later dose set no date of its own', async () => {
      const animal = await makeAnimal(f);
      await own(animal.id, 'vaccination', daysAgo(200), daysAhead(10));
      await own(animal.id, 'vaccination', daysAgo(5), null);
      expect(await nextOf(animal.id)).toEqual([]);
    });

    it('keeps reminders of different items and of different types apart', async () => {
      const second = await makeDrug(f, 'Ikkinchi vaksina');
      const animal = await makeAnimal(f);
      await own(animal.id, 'vaccination', daysAgo(20), daysAhead(10));
      await own(animal.id, 'vaccination', daysAgo(5), daysAhead(20), second);
      await own(animal.id, 'prophylaxis', daysAgo(4), daysAhead(30));
      expect((await nextOf(animal.id)).map((d: { date: string }) => d.date)).toEqual([daysAhead(10), daysAhead(20), daysAhead(30)]);
    });

    it('counts a dose given to the herd and a dose given to the animal as the same thing', async () => {
      const herd = await makeHerd(f, 'Ikkinchi');
      const animal = await makeAnimal(f, { herdId: herd.id, purchaseDate: daysAgo(100) });
      await vaccinate(herd.id, daysAgo(40), daysAhead(5));
      expect(await nextOf(animal.id)).toEqual([{ date: daysAhead(5), type: 'vaccination', itemName: "Qo'y chechagi vaksinasi" }]);

      await own(animal.id, 'vaccination', daysAgo(3), daysAhead(50));
      expect(await nextOf(animal.id)).toEqual([{ date: daysAhead(50), type: 'vaccination', itemName: "Qo'y chechagi vaksinasi" }]);
    });

    it('takes nothing from a herd record that did not reach the animal', async () => {
      const herd = await makeHerd(f, 'Uchinchi');
      const animal = await makeAnimal(f, { herdId: herd.id, purchaseDate: daysAgo(20) });
      await vaccinate(herd.id, daysAgo(40), daysAhead(5));
      expect(await nextOf(animal.id)).toEqual([]);
    });

    it('shows when a running quarantine is due to end, and forgets it once it has ended', async () => {
      const animal = await makeAnimal(f);
      const { started } = await f.run(() => startQuarantine({ animalIds: [animal.id], startDate: daysAgo(2), days: 21 }));
      expect(await nextOf(animal.id)).toEqual([{ date: daysAhead(19), type: 'quarantine', itemName: null }]);

      await f.run(() => endQuarantine(started[0], { date: T }));
      expect(await nextOf(animal.id)).toEqual([]);
    });

    it('is empty for an animal that has left the farm, though its history stays', async () => {
      const animal = await makeAnimal(f);
      const record = await own(animal.id, 'vaccination', daysAgo(30), daysAhead(40));
      await f.run(() => markExited(animal.id, 'sold', daysAgo(1)));
      const { data } = await healthOf(await f.as('owner'), animal.id);
      expect(data.nextDue).toEqual([]);
      expect(data.records.map((r: { id: string }) => r.id)).toEqual([record.id]);
    });
  });

  describe('who sees what', () => {
    let animal: { id: string };
    let vetId: string;

    beforeAll(async () => {
      animal = await makeAnimal(f);
      const [vet] = await f.run(() =>
        tx().insert(employees).values({ tenantId: f.tenantId, farmId: f.farmId, fullName: 'Karimova Nodira', position: 'Veterinar', hireDate: daysAgo(400) }).returning(),
      );
      vetId = vet.id;
      await f.run(() =>
        createRecord({ type: 'treatment', animalId: animal.id, date: daysAgo(4), itemId: drug.itemId, warehouseId: drug.warehouseId, qtyUsed: 3, vetEmployeeId: vet.id }),
      );
    });

    it('gives the cost and the vet to whoever may see them', async () => {
      const { data } = await healthOf(await f.as('director'), animal.id);
      expect(data.records[0]).toMatchObject({ totalCost: 60_000, vetName: 'Karimova Nodira' });
    });

    it('hides money and the vet from a shepherd, in the API and not just the page', async () => {
      const res = await healthOf(await f.as('shepherd'), animal.id);
      expect(res.status).toBe(200);
      expect(res.data.records[0]).toMatchObject({ type: 'treatment', totalCost: null, vetName: null });
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('60000');
      expect(raw).not.toContain('Karimova');
      expect(raw).not.toContain(vetId);
    });

    it.each(['zootechnician', 'veterinarian'] as const)('a %s has health.view but neither finance.view nor pii.view', async (role) => {
      const { data } = await healthOf(await f.as(role), animal.id);
      expect(data.records[0]).toMatchObject({ totalCost: null, vetName: null });
    });

    it.each(['accountant', 'auditor', 'investor', 'storekeeper'] as const)('refuses a %s, who has no health.view', async (role) => {
      const res = await healthOf(await f.as(role), animal.id);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.data).toBeUndefined();
    });
  });

  it('answers 404 for an animal that does not exist', async () => {
    const owner = await f.as('owner');
    expect((await healthOf(owner, '0190b7e0-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await breedingOf(owner, '0190b7e0-0000-7000-8000-000000000000')).status).toBe(404);
  });
});

describe('the passport stays inside the farm', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  it('answers 404 for an animal of another tenant', async () => {
    const ewe = await makeAnimal(f);
    await f.run(() => createPregnancy({ eweId: ewe.id, matingDate: daysAgo(40), source: 'purchase' }));
    const stranger = await (await createFixture()).as('owner');
    const breeding = await breedingOf(stranger, ewe.id);
    const health = await healthOf(stranger, ewe.id);
    expect(breeding.status).toBe(404);
    expect(health.status).toBe(404);
    expect(breeding.data).toBeUndefined();
    expect(health.data).toBeUndefined();
  });

  it('answers 404 for an animal on another farm of the same tenant', async () => {
    const [second] = await f.run(() => tx().insert(farms).values({ tenantId: f.tenantId, name: 'Ikkinchi ferma' }).returning());
    const elsewhere = await makeAnimal(f, { farmId: second.id });
    const owner = await f.as('owner');
    expect((await breedingOf(owner, elsewhere.id)).status).toBe(404);
    expect((await healthOf(owner, elsewhere.id)).status).toBe(404);
  });
});
