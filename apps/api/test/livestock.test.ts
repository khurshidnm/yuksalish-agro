import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, herdCount, todayIso } from '@yap/shared';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { receiveStock, stockOnHand } from '../src/core/inventory';
import * as breeding from '../src/modules/livestock/breeding.summary';
import * as summary from '../src/modules/livestock/summary';
import { herdMovement, herdSummary, growthKpis, mortality, reproductionKpis, weightTrend, lambingCalendar } from '../src/modules/livestock/summary';
import { createFixture, type Fixture } from './helpers';
import { renderAlert } from '../src/modules/alerts/alerts.service';

const { accounts, counterparties, facilities, fields, items, rationLines, rations, species, warehouses } = schema;

const today = todayIso();
const daysAgo = (n: number) => addDays(today, -n);

interface Farm {
  f: Fixture;
  speciesId: string;
  herdId: string;
  itemId: string;
  barleyId: string;
  warehouseId: string;
  rationId: string;
}

let tagCounter = 0;
const nextTag = () => `T-${String(++tagCounter).padStart(5, '0')}`;

async function sheepSpecies(f: Fixture) {
  const [row] = await f.run(() => tx().select().from(species).where(eq(species.key, 'sheep')));
  return row.id;
}

async function ewe(farm: Farm, over: Record<string, unknown> = {}) {
  const owner = await farm.f.as('owner');
  const res = await owner.post('/livestock/animals', {
    tag: nextTag(),
    speciesId: farm.speciesId,
    sex: 'female',
    category: 'ewe',
    origin: 'purchased',
    purchaseDate: daysAgo(60),
    purchasePrice: 4_000_000,
    herdId: farm.herdId,
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data as { id: string; tag: string };
}

/**
 * A farm with: a herd on a ration of 1.2 kg hay + 0.3 kg barley per head per day,
 * 10 000 kg of hay at 1 000 so'm/kg and 5 000 kg of barley at 3 000 so'm/kg.
 */
async function makeFarm(settings?: Record<string, unknown>): Promise<Farm> {
  const f = await createFixture({ settings });
  const speciesId = await sheepSpecies(f);
  const owner = await f.as('owner');
  const ids = await f.run(async () => {
    const base = { tenantId: f.tenantId, farmId: f.farmId };
    const [warehouse] = await tx().insert(warehouses).values({ ...base, name: 'Ozuqa', type: 'feed' }).returning();
    const [hay] = await tx()
      .insert(items)
      .values({ ...base, name: 'Beda', category: 'feed', unit: 'kg', dryMatterPct: 85, defaultWarehouseId: warehouse.id })
      .returning();
    const [barley] = await tx()
      .insert(items)
      .values({ ...base, name: 'Arpa', category: 'feed', unit: 'kg', dryMatterPct: 88, defaultWarehouseId: warehouse.id })
      .returning();
    await receiveStock({ itemId: hay.id, warehouseId: warehouse.id, qty: 10_000, unitCost: 1_000, date: daysAgo(100), source: 'opening' });
    await receiveStock({ itemId: barley.id, warehouseId: warehouse.id, qty: 5_000, unitCost: 3_000, date: daysAgo(100), source: 'opening' });
    const [ration] = await tx().insert(rations).values({ ...base, name: 'Qishlov', state: 'pregnant' }).returning();
    await tx().insert(rationLines).values([
      { ...base, rationId: ration.id, itemId: hay.id, kgPerHeadDay: 1.2 },
      { ...base, rationId: ration.id, itemId: barley.id, kgPerHeadDay: 0.3 },
    ]);
    return { warehouseId: warehouse.id, itemId: hay.id, barleyId: barley.id, rationId: ration.id };
  });
  const herd = await owner.post('/livestock/herds', { name: "Bo'g'oz sovliqlar", state: 'pregnant', rationId: ids.rationId });
  expect(herd.status).toBe(201);
  return { f, speciesId, herdId: herd.data.id, ...ids };
}

async function herdWith(farm: Farm, head: number) {
  for (let i = 0; i < head; i++) await ewe(farm);
}

describe('animal registry', () => {
  let farm: Farm;
  beforeAll(async () => {
    farm = await makeFarm();
  });

  it('registers an animal, mirrors the tag into identifiers, and keeps extra identifiers', async () => {
    const owner = await farm.f.as('owner');
    const res = await owner.post('/livestock/animals', {
      tag: 'R-1',
      speciesId: farm.speciesId,
      sex: 'female',
      category: 'ewe',
      origin: 'purchased',
      purchaseDate: daysAgo(10),
      purchasePrice: 4_200_000,
      herdId: farm.herdId,
      currentWeightKg: 62.5,
      identifiers: [
        { type: 'rfid', value: '982000123456789' },
        { type: 'qr', value: 'QR-R1' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.data.currentWeightKg).toBe(62.5);
    expect(res.data.lastWeighedOn).toBe(daysAgo(10));

    const card = await owner.get(`/livestock/animals/${res.data.id}`);
    expect(card.data.identifiers.map((i: any) => i.type).sort()).toEqual(['ear_tag', 'qr', 'rfid']);
    expect(card.data.weights).toHaveLength(1);
    expect(card.data.herdName).toBe("Bo'g'oz sovliqlar");
  });

  it('finds an animal by tag, RFID and QR, in search and by scan', async () => {
    const owner = await farm.f.as('owner');
    const byRfid = await owner.get('/livestock/animals', { search: '98200012' });
    expect(byRfid.body.data.map((a: any) => a.tag)).toEqual(['R-1']);
    expect((await owner.get('/livestock/animals', { search: 'r-1' })).body.data.map((a: any) => a.tag)).toEqual(['R-1']);

    expect((await owner.get('/livestock/animals/scan', { code: 'QR-R1' })).data.tag).toBe('R-1');
    expect((await owner.get('/livestock/animals/scan', { code: '982000123456789' })).data.tag).toBe('R-1');
    expect((await owner.get('/livestock/animals/scan', { code: 'r-1' })).data.tag).toBe('R-1');
    expect((await owner.get('/livestock/animals/scan', { code: 'NOPE' })).status).toBe(404);
  });

  it('a bare number resolves the ear tag number, but only when it is unambiguous', async () => {
    const f = await makeFarm();
    const owner = await f.f.as('owner');
    await ewe(f, { tag: 'YA-0123' });
    await ewe(f, { tag: 'YA-0007' });
    await ewe(f, { tag: 'QB-0007' });
    expect((await owner.get('/livestock/animals/scan', { code: '123' })).data.tag).toBe('YA-0123');
    expect((await owner.get('/livestock/animals/scan', { code: '7' })).status).toBe(404);
  });

  it('refuses a tag or identifier already in use', async () => {
    const owner = await farm.f.as('owner');
    const base = { speciesId: farm.speciesId, sex: 'female', category: 'ewe', origin: 'purchased', purchaseDate: daysAgo(1) };
    const sameTag = await owner.post('/livestock/animals', { ...base, tag: 'R-1' });
    expect(sameTag.status).toBe(409);
    expect(sameTag.body.error.code).toBe('TAG_TAKEN');

    const sameRfid = await owner.post('/livestock/animals', {
      ...base,
      tag: 'R-2',
      identifiers: [{ type: 'rfid', value: '982000123456789' }],
    });
    expect(sameRfid.status).toBe(409);
    expect(sameRfid.body.error.code).toBe('IDENTIFIER_TAKEN');
    expect(sameRfid.body.error.details.tag).toBe('R-1');
  });

  it.each([
    [{ sex: 'male', category: 'ewe' }, 'CATEGORY_SEX_MISMATCH'],
    [{ sex: 'female', category: 'ram' }, 'CATEGORY_SEX_MISMATCH'],
    [{ origin: 'purchased', purchaseDate: null }, 'PURCHASE_DATE_REQUIRED'],
    [{ origin: 'born', purchaseDate: null, birthDate: null }, 'BIRTH_DATE_REQUIRED'],
    [{ purchaseDate: addDays(today, 2) }, 'FUTURE_DATE'],
  ])('rejects %j', async (over, code) => {
    const owner = await farm.f.as('owner');
    const res = await owner.post('/livestock/animals', {
      tag: nextTag(),
      speciesId: farm.speciesId,
      sex: 'female',
      category: 'ewe',
      origin: 'purchased',
      purchaseDate: daysAgo(1),
      ...over,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  it('checks parents: right sex, on this farm, not itself', async () => {
    const owner = await farm.f.as('owner');
    const dam = await ewe(farm);
    const wrong = await owner.post('/livestock/animals', {
      tag: nextTag(),
      speciesId: farm.speciesId,
      sex: 'male',
      category: 'lamb_male',
      origin: 'born',
      birthDate: daysAgo(1),
      sireId: dam.id,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('INVALID_PARENT');

    const self = await owner.patch(`/livestock/animals/${dam.id}`, { damId: dam.id });
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe('INVALID_PARENT');
  });

  it('a new tag follows the animal into its identifiers', async () => {
    const owner = await farm.f.as('owner');
    const animal = await ewe(farm);
    await owner.patch(`/livestock/animals/${animal.id}`, { tag: 'RENAMED-1' });
    expect((await owner.get('/livestock/animals/scan', { code: 'RENAMED-1' })).data.id).toBe(animal.id);
    const card = await owner.get(`/livestock/animals/${animal.id}`);
    expect(card.data.identifiers.find((i: any) => i.type === 'ear_tag').value).toBe('RENAMED-1');
  });

  it('adds and removes identifiers, but never the main tag', async () => {
    const owner = await farm.f.as('owner');
    const animal = await ewe(farm);
    const added = await owner.post(`/livestock/animals/${animal.id}/identifiers`, { type: 'rfid', value: 'RF-77' });
    expect(added.status).toBe(201);
    expect((await owner.delete(`/livestock/animals/${animal.id}/identifiers/${added.data.id}`)).status).toBe(200);

    const card = await owner.get(`/livestock/animals/${animal.id}`);
    const main = card.data.identifiers.find((i: any) => i.type === 'ear_tag');
    const refused = await owner.delete(`/livestock/animals/${animal.id}/identifiers/${main.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PRIMARY_TAG');
  });

  it('filters by herd, status, category and sex, paginates, and sorts', async () => {
    const f = await makeFarm();
    const owner = await f.f.as('owner');
    await ewe(f, { tag: 'F-1' });
    await ewe(f, { tag: 'F-2', status: 'sick' });
    await ewe(f, { tag: 'F-3', herdId: null, sex: 'male', category: 'ram' });

    expect((await owner.get('/livestock/animals', { herdId: f.herdId })).body.meta.total).toBe(2);
    expect((await owner.get('/livestock/animals', { status: 'sick' })).body.data.map((a: any) => a.tag)).toEqual(['F-2']);
    expect((await owner.get('/livestock/animals', { sex: 'male' })).body.data.map((a: any) => a.tag)).toEqual(['F-3']);
    expect((await owner.get('/livestock/animals', { category: 'ram' })).body.meta.total).toBe(1);
    const page = await owner.get('/livestock/animals', { pageSize: 2, sort: '-tag' });
    expect(page.body.data.map((a: any) => a.tag)).toEqual(['F-3', 'F-2']);
    expect(page.body.meta.total).toBe(3);
  });

  it('references from another tenant are refused, although a foreign key would accept them', async () => {
    const other = await makeFarm();
    const owner = await farm.f.as('owner');
    const res = await owner.post('/livestock/animals', {
      tag: nextTag(),
      speciesId: farm.speciesId,
      sex: 'female',
      category: 'ewe',
      origin: 'purchased',
      purchaseDate: daysAgo(1),
      herdId: other.herdId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REFERENCE');

    const foreignSpecies = await owner.post('/livestock/animals', {
      tag: nextTag(),
      speciesId: other.speciesId,
      sex: 'female',
      category: 'ewe',
      origin: 'purchased',
      purchaseDate: daysAgo(1),
    });
    expect(foreignSpecies.status).toBe(400);
  });

  it("another tenant cannot see this tenant's animals or herds", async () => {
    const other = await makeFarm();
    const stranger = await other.f.as('owner');
    const animal = await ewe(farm);
    expect((await stranger.get(`/livestock/animals/${animal.id}`)).status).toBe(404);
    expect((await stranger.get(`/livestock/herds/${farm.herdId}`)).status).toBe(404);
    expect((await stranger.get('/livestock/animals', { search: animal.tag })).body.data).toEqual([]);
  });

  it('removes an animal registered by mistake, but not one with history', async () => {
    const owner = await farm.f.as('owner');
    const mistake = await ewe(farm);
    expect((await owner.delete(`/livestock/animals/${mistake.id}`)).status).toBe(200);
    expect((await owner.get(`/livestock/animals/${mistake.id}`)).status).toBe(404);

    const lost = await ewe(farm);
    await owner.post('/livestock/exits', { animalId: lost.id, type: 'loss', reason: 'Yaylovda yo\'qoldi' });
    const refused = await owner.delete(`/livestock/animals/${lost.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('IN_USE');
  });
});

describe('money and role rules (spec 24.1, CLAUDE.md rule 7)', () => {
  let farm: Farm;
  let animalId: string;
  beforeAll(async () => {
    farm = await makeFarm();
    ({ id: animalId } = await ewe(farm, { purchasePrice: 4_200_000 }));
  });

  it('owner sees the purchase price', async () => {
    const owner = await farm.f.as('owner');
    expect((await owner.get('/livestock/animals')).body.data[0].purchasePrice).toBe(4_200_000);
    const card = await owner.get(`/livestock/animals/${animalId}`);
    expect(card.data.purchasePrice).toBe(4_200_000);
    expect(card.data.cost.purchasePrice).toBe(4_200_000);
  });

  it.each(['shepherd', 'zootechnician', 'veterinarian'] as const)('%s never receives money fields', async (role) => {
    const client = await farm.f.as(role);
    const list = await client.get('/livestock/animals');
    expect(list.status).toBe(200);
    expect(list.body.data[0].purchasePrice).toBeNull();
    expect(list.body.data[0].sellerId).toBeNull();

    const card = await client.get(`/livestock/animals/${animalId}`);
    expect(card.data.purchasePrice).toBeNull();
    expect(card.data.sellerName).toBeNull();
    expect(card.data.cost).toBeNull();
    expect(JSON.stringify(card.body)).not.toContain('4200000');

    const scan = await client.get('/livestock/animals/scan', { code: list.body.data[0].tag });
    expect(scan.data.purchasePrice).toBeNull();
  });

  it('an update response does not leak the price to a role that may edit but not see money', async () => {
    const vet = await farm.f.as('veterinarian');
    const res = await vet.patch(`/livestock/animals/${animalId}`, { notes: 'Tekshirildi' });
    expect(res.status).toBe(200);
    expect(res.data.purchasePrice).toBeNull();
  });

  it('a role that cannot read money cannot write it either', async () => {
    const zoo = await farm.f.as('zootechnician');
    const owner = await farm.f.as('owner');
    await zoo.patch(`/livestock/animals/${animalId}`, { purchasePrice: 1 });
    expect((await owner.get(`/livestock/animals/${animalId}`)).data.purchasePrice).toBe(4_200_000);

    const created = await zoo.post('/livestock/animals', {
      tag: nextTag(),
      speciesId: farm.speciesId,
      sex: 'female',
      category: 'ewe',
      origin: 'purchased',
      purchaseDate: daysAgo(1),
      purchasePrice: 999,
    });
    expect(created.status).toBe(201);
    expect((await owner.get(`/livestock/animals/${created.data.id}`)).data.purchasePrice).toBeNull();
  });

  it('a shepherd cannot change the registry or weights', async () => {
    const shepherd = await farm.f.as('shepherd');
    const body = { tag: nextTag(), speciesId: farm.speciesId, sex: 'female', category: 'ewe', origin: 'purchased', purchaseDate: daysAgo(1) };
    expect((await shepherd.post('/livestock/animals', body)).status).toBe(403);
    expect((await shepherd.patch(`/livestock/animals/${animalId}`, { notes: 'x' })).status).toBe(403);
    expect((await shepherd.delete(`/livestock/animals/${animalId}`)).status).toBe(403);
    expect((await shepherd.post('/livestock/weights', { animalId, weightKg: 60 })).status).toBe(403);
    expect((await shepherd.post('/livestock/herds', { name: 'X' })).status).toBe(403);
  });

  it('an investor has no access to the registry', async () => {
    const investor = await farm.f.as('investor');
    expect((await investor.get('/livestock/animals')).status).toBe(403);
    expect((await investor.get('/livestock/summary')).status).toBe(403);
  });

  it('lookups work for any role and carry no money', async () => {
    const storekeeper = await farm.f.as('storekeeper');
    const animals = await storekeeper.get('/livestock/animals/lookup');
    expect(animals.status).toBe(200);
    expect(animals.body.data[0]).toEqual({
      id: expect.any(String),
      tag: expect.any(String),
      name: expect.any(String),
      category: 'ewe',
      sex: 'female',
      herdId: farm.herdId,
    });
    const herds = await storekeeper.get('/livestock/herds/lookup');
    expect(herds.body.data[0]).toMatchObject({ id: farm.herdId, headCount: expect.any(Number) });
    const list = await storekeeper.get('/livestock/species');
    const sheep = list.body.data.find((s: any) => s.key === 'sheep');
    expect(sheep.gestationDays).toBe(150);
    expect(sheep.breeds.map((b: any) => b.key)).toContain('hisori');
  });
});

describe('herds', () => {
  it('creates the cost center with the herd, and a rename reaches cost reports', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const created = await owner.post('/livestock/herds', { name: 'Eski nom' });
    expect(created.data.costCenterId).toBeTruthy();

    await owner.patch(`/livestock/herds/${created.data.id}`, { name: 'Yangi nom' });
    const [center] = await farm.f.run(() =>
      tx().select().from(schema.costCenters).where(eq(schema.costCenters.id, created.data.costCenterId)),
    );
    expect(center.type).toBe('herd');
    expect(center.refId).toBe(created.data.id);
    expect(center.name).toBe('Yangi nom');
  });

  it('counts head by composition, and only animals on the farm', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    await ewe(farm, { currentWeightKg: 60 });
    await ewe(farm, { currentWeightKg: 70, status: 'sick' });
    const gone = await ewe(farm, { currentWeightKg: 80 });
    await owner.post('/livestock/exits', { animalId: gone.id, type: 'death', reason: 'Kasallik' });

    const card = await owner.get(`/livestock/herds/${farm.herdId}`);
    expect(card.data.headCount).toBe(2);
    expect(card.data.averageKg).toBe(65);
    expect(card.data.totalKg).toBe(130);
    expect(card.data.composition).toHaveLength(2);
    expect((await owner.get('/livestock/herds')).body.data[0].headCount).toBe(2);
  });

  it('shows the ration with the daily total: 1.2 kg × 2 head = 2.4 kg', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    await herdWith(farm, 2);
    const card = await owner.get(`/livestock/herds/${farm.herdId}`);
    const hay = card.data.ration.lines.find((l: any) => l.itemName === 'Beda');
    expect(hay.dailyKg).toBeCloseTo(2.4, 5);
  });

  it('reports occupancy of the building across herds', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const barn = await farm.f.run(async () => {
      const [row] = await tx()
        .insert(facilities)
        .values({ tenantId: farm.f.tenantId, farmId: farm.f.farmId, type: 'barn', name: 'Molxona', capacity: 1000 })
        .returning();
      return row;
    });
    await owner.patch(`/livestock/herds/${farm.herdId}`, { facilityId: barn.id });
    const other = await owner.post('/livestock/herds', { name: 'Ikkinchi', facilityId: barn.id });
    await ewe(farm);
    await ewe(farm, { herdId: other.data.id });
    const card = await owner.get(`/livestock/herds/${farm.herdId}`);
    expect(card.data.facility).toMatchObject({ capacity: 1000, occupied: 2 });
  });

  it('a herd with animals cannot be archived; an empty one can', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    await ewe(farm);
    const refused = await owner.delete(`/livestock/herds/${farm.herdId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('HERD_NOT_EMPTY');

    const empty = await owner.post('/livestock/herds', { name: 'Bo\'sh' });
    expect((await owner.delete(`/livestock/herds/${empty.data.id}`)).data.status).toBe('archived');
    expect((await owner.get('/livestock/herds/lookup')).body.data.map((h: any) => h.id)).not.toContain(empty.data.id);
  });

  it('moves selected animals, with a history row and the new building', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const a = await ewe(farm);
    const b = await ewe(farm);
    const barn = await farm.f.run(async () => {
      const [row] = await tx()
        .insert(facilities)
        .values({ tenantId: farm.f.tenantId, farmId: farm.f.farmId, type: 'barn', name: 'Boshqa' })
        .returning();
      return row;
    });
    const target = await owner.post('/livestock/herds', { name: 'Emizikli', facilityId: barn.id });

    const moved = await owner.post('/livestock/transfers', { animalIds: [a.id, b.id], toHerdId: target.data.id, reason: "Qo'zilashdan keyin" });
    expect(moved.data.moved).toBe(2);

    const card = await owner.get(`/livestock/animals/${a.id}`);
    expect(card.data.herdId).toBe(target.data.id);
    expect(card.data.facilityId).toBe(barn.id);
    expect(card.data.transfers[0]).toMatchObject({
      fromHerdName: "Bo'g'oz sovliqlar",
      toHerdName: 'Emizikli',
      reason: "Qo'zilashdan keyin",
    });
  });

  it('moves a whole herd, and picks up animals that had no herd', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    await herdWith(farm, 3);
    const target = await owner.post('/livestock/herds', { name: 'Yangi' });
    const moved = await owner.post('/livestock/transfers', { fromHerdId: farm.herdId, toHerdId: target.data.id });
    expect(moved.data.moved).toBe(3);

    const stray = await ewe(farm, { herdId: null });
    const placed = await owner.post('/livestock/transfers', { animalIds: [stray.id], toHerdId: target.data.id });
    expect(placed.data.moved).toBe(1);
    expect((await owner.get(`/livestock/herds/${target.data.id}`)).data.headCount).toBe(4);
  });

  it('an animal already in the target herd is not moved twice, and an exited one is refused', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const stays = await ewe(farm);
    expect((await owner.post('/livestock/transfers', { animalIds: [stays.id], toHerdId: farm.herdId })).data.moved).toBe(0);

    const gone = await ewe(farm);
    await owner.post('/livestock/exits', { animalId: gone.id, type: 'death' });
    const target = await owner.post('/livestock/herds', { name: 'Boshqa' });
    const refused = await owner.post('/livestock/transfers', { animalIds: [gone.id], toHerdId: target.data.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('ANIMAL_NOT_ON_FARM');
  });

  it('needs exactly one way of choosing animals', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const res = await owner.post('/livestock/transfers', { toHerdId: farm.herdId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('empty updates', () => {
  it('an empty PATCH is refused everywhere, and changes nothing', async () => {
    const farm = await makeFarm();
    const zoo = await farm.f.as('zootechnician');
    const animal = await ewe(farm);
    const log = await zoo.post('/livestock/daily-logs', { herdId: farm.herdId, lines: [] });

    for (const url of [`/livestock/animals/${animal.id}`, `/livestock/herds/${farm.herdId}`, `/livestock/daily-logs/${log.data.id}`]) {
      const res = await zoo.patch(url, {});
      expect(res.status, url).toBe(400);
      expect(res.body.error.code).toBe('NOTHING_TO_UPDATE');
    }

    // Sending only the version is not a change: it must not bump updatedAt or journal a correction.
    const versionOnly = await zoo.patch(`/livestock/daily-logs/${log.data.id}`, { baseUpdatedAt: log.data.updatedAt });
    expect(versionOnly.status).toBe(400);
    expect((await zoo.get(`/livestock/daily-logs/${log.data.id}`)).data.updatedAt).toBe(log.data.updatedAt);
    const events = await farm.f.run(() => tx().select().from(schema.events).where(sql`type = 'herd.daily_log_corrected'`));
    expect(events).toEqual([]);
  });

  it('a patch holding only a money field the caller may not write is an empty update', async () => {
    const farm = await makeFarm();
    const zoo = await farm.f.as('zootechnician');
    const animal = await ewe(farm);
    const res = await zoo.patch(`/livestock/animals/${animal.id}`, { purchasePrice: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOTHING_TO_UPDATE');
  });
});

describe('weights', () => {
  it('computes daily gain: 30 kg to 36 kg over 30 days is 200 g/day', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const animal = await ewe(farm);
    await owner.post('/livestock/weights', { animalId: animal.id, date: daysAgo(40), weightKg: 30 });
    await owner.post('/livestock/weights', { animalId: animal.id, date: daysAgo(10), weightKg: 36 });
    const card = await owner.get(`/livestock/animals/${animal.id}`);
    expect(card.data.adgG).toBe(200);
    expect(card.data.weights.map((w: any) => w.adgG)).toEqual([null, 200]);
    expect(card.data.currentWeightKg).toBe(36);
    expect(card.data.lastWeighedOn).toBe(daysAgo(10));
  });

  it('an older weight entered late does not replace the current one', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const animal = await ewe(farm);
    await owner.post('/livestock/weights', { animalId: animal.id, date: daysAgo(5), weightKg: 50 });
    await owner.post('/livestock/weights', { animalId: animal.id, date: daysAgo(50), weightKg: 40 });
    const card = await owner.get(`/livestock/animals/${animal.id}`);
    expect(card.data.currentWeightKg).toBe(50);
    expect(card.data.lastWeighedOn).toBe(daysAgo(5));
  });

  it('deleting the newest weight falls back to the one before', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const animal = await ewe(farm);
    await owner.post('/livestock/weights', { animalId: animal.id, date: daysAgo(30), weightKg: 40 });
    const wrong = await owner.post('/livestock/weights', { animalId: animal.id, date: daysAgo(1), weightKg: 400 });
    await owner.delete(`/livestock/weights/${wrong.data.id}`);
    expect((await owner.get(`/livestock/animals/${animal.id}`)).data.currentWeightKg).toBe(40);
  });

  it('refuses a future date, a zero weight, and an animal that has left', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const animal = await ewe(farm);
    const future = await owner.post('/livestock/weights', { animalId: animal.id, date: addDays(today, 1), weightKg: 50 });
    expect(future.body.error.code).toBe('FUTURE_DATE');
    expect((await owner.post('/livestock/weights', { animalId: animal.id, weightKg: 0 })).status).toBe(400);

    await owner.post('/livestock/exits', { animalId: animal.id, type: 'death' });
    const gone = await owner.post('/livestock/weights', { animalId: animal.id, weightKg: 50 });
    expect(gone.status).toBe(409);
    expect(gone.body.error.code).toBe('ANIMAL_NOT_ON_FARM');
  });
});

describe('weighing campaign', () => {
  it('weighs a herd by tag, RFID or typed number, and tracks progress and gain', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const a = await ewe(farm, { tag: 'W-0001', identifiers: [{ type: 'rfid', value: 'RFID-A' }] });
    await ewe(farm, { tag: 'W-0002' });
    await ewe(farm, { tag: 'W-0003' });
    await owner.post('/livestock/weights', { animalId: a.id, date: daysAgo(30), weightKg: 50 });

    const campaign = await owner.post('/livestock/weighing-campaigns', { herdId: farm.herdId, name: 'Noyabr', date: today });
    const url = `/livestock/weighing-campaigns/${campaign.data.id}`;

    const first = await owner.post(`${url}/entries`, { code: 'RFID-A', weightKg: 53 });
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ tag: 'W-0001', previousKg: 50, gainKg: 3, updated: false });
    expect(first.data.progress).toMatchObject({ weighed: 1, total: 3 });

    expect((await owner.post(`${url}/entries`, { code: '2', weightKg: 60 })).data.tag).toBe('W-0002');
    expect((await owner.post(`${url}/entries`, { code: 'w-0003', weightKg: 64 })).data.tag).toBe('W-0003');

    const detail = await owner.get(url);
    expect(detail.data.weighed).toBe(3);
    expect(detail.data.averageKg).toBe(59);
    const entry = detail.data.entries.find((e: any) => e.tag === 'W-0001');
    expect(entry.gainKg).toBe(3);
    expect(entry.adgG).toBe(100);

    const list = await owner.get('/livestock/weighing-campaigns');
    expect(list.body.data[0]).toMatchObject({ weighed: 3, total: 3, averageKg: 59, herdName: "Bo'g'oz sovliqlar" });
  });

  it('re-entering an animal corrects it rather than adding a record', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const a = await ewe(farm, { tag: 'C-1' });
    const campaign = await owner.post('/livestock/weighing-campaigns', { herdId: farm.herdId, name: 'X' });
    const url = `/livestock/weighing-campaigns/${campaign.data.id}/entries`;
    await owner.post(url, { code: 'C-1', weightKg: 600 });
    const fixed = await owner.post(url, { code: 'C-1', weightKg: 60 });
    expect(fixed.data.updated).toBe(true);
    expect(fixed.data.progress.weighed).toBe(1);
    const card = await owner.get(`/livestock/animals/${a.id}`);
    expect(card.data.weights).toHaveLength(1);
    expect(card.data.currentWeightKg).toBe(60);
  });

  it('flags an animal from another herd but still records it', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    await ewe(farm, { tag: 'S-1', herdId: null });
    const campaign = await owner.post('/livestock/weighing-campaigns', { herdId: farm.herdId, name: 'X' });
    const res = await owner.post(`/livestock/weighing-campaigns/${campaign.data.id}/entries`, { code: 'S-1', weightKg: 60 });
    expect(res.data.otherHerd).toBe(true);
  });

  it('an unknown code is an error, and bulk entry reports it without stopping', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    await ewe(farm, { tag: 'B-1' });
    const left = await ewe(farm, { tag: 'B-2' });
    await owner.post('/livestock/exits', { animalId: left.id, type: 'death' });
    const campaign = await owner.post('/livestock/weighing-campaigns', { herdId: farm.herdId, name: 'X' });
    const url = `/livestock/weighing-campaigns/${campaign.data.id}/entries`;

    const unknown = await owner.post(url, { code: 'NOPE', weightKg: 50 });
    expect(unknown.status).toBe(409);
    expect(unknown.body.error.code).toBe('ANIMAL_NOT_FOUND');

    const bulk = await owner.post(`${url}/bulk`, {
      entries: [
        { code: 'B-1', weightKg: 50 },
        { code: 'NOPE', weightKg: 50 },
        { code: 'B-2', weightKg: 50 },
      ],
    });
    expect(bulk.data.applied).toBe(1);
    expect(bulk.data.failed).toEqual([
      { code: 'NOPE', error: 'ANIMAL_NOT_FOUND' },
      { code: 'B-2', error: 'ANIMAL_NOT_ON_FARM' },
    ]);
  });

  it('a closed campaign takes no more entries', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    await ewe(farm, { tag: 'Z-1' });
    const campaign = await owner.post('/livestock/weighing-campaigns', { herdId: farm.herdId, name: 'X' });
    const url = `/livestock/weighing-campaigns/${campaign.data.id}`;
    expect((await owner.post(`${url}/close`)).data.status).toBe('closed');
    const res = await owner.post(`${url}/entries`, { code: 'Z-1', weightKg: 50 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_CLOSED');
  });
});

describe('daily logs (MVP acceptance 24.1)', () => {
  async function feedStock(farm: Farm, itemId: string) {
    return farm.f.run(() => stockOnHand(itemId));
  }

  it('plans ration × head: 10 head × 1.2 kg = 12 kg hay, 10 × 0.3 kg = 3 kg barley', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 10);
    const plan = await shepherd.get('/livestock/daily-logs/plan', { herdId: farm.herdId });
    expect(plan.status).toBe(200);
    expect(plan.data.herd.headCount).toBe(10);
    expect(plan.data.logId).toBeNull();
    const byName = Object.fromEntries(plan.data.lines.map((l: any) => [l.itemName, l]));
    expect(byName.Beda.plannedQty).toBe(12);
    expect(byName.Arpa.plannedQty).toBe(3);
    expect(byName.Beda.qtyOnHand).toBe(10_000);
  });

  it('a log issues the feed and charges the herd: 12 × 1000 + 3 × 3000 = 21 000', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    const owner = await farm.f.as('owner');
    await herdWith(farm, 10);

    const res = await shepherd.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      waterL: 400,
      lines: [
        { itemId: farm.itemId, actualQty: 12 },
        { itemId: farm.barleyId, actualQty: 3 },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.date).toBe(today);
    expect(res.data.headCount).toBe(10);
    expect(res.data.deviations).toEqual([]);

    expect(await feedStock(farm, farm.itemId)).toBe(9_988);
    expect(await feedStock(farm, farm.barleyId)).toBe(4_997);

    const movements = await farm.f.run(() =>
      tx().select().from(schema.stockMovements).where(sql`ref_type = 'daily_log' and ref_id = ${res.data.id}`),
    );
    expect(movements).toHaveLength(2);
    expect(movements.reduce((sum, m) => sum + m.totalCost, 0)).toBe(21_000);
    const herd = await owner.get(`/livestock/herds/${farm.herdId}`);
    expect(new Set(movements.map((m) => m.costCenterId))).toEqual(new Set([herd.data.costCenterId]));

    const list = await owner.get('/livestock/daily-logs', { herdId: farm.herdId });
    expect(list.body.data[0]).toMatchObject({ plannedKg: 15, actualKg: 15, deviationPercent: 0, totalCost: 21_000 });
  });

  it('a shepherd enters feed but does not receive its cost', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 1);
    const res = await shepherd.post('/livestock/daily-logs', { herdId: farm.herdId, lines: [{ itemId: farm.itemId, actualQty: 1.2 }] });
    expect(res.data.lines.every((l: any) => l.totalCost === null)).toBe(true);
    const list = await shepherd.get('/livestock/daily-logs');
    expect(list.body.data[0].totalCost).toBeNull();
    const single = await shepherd.get(`/livestock/daily-logs/${res.data.id}`);
    expect(single.data.lines[0].totalCost).toBeNull();
  });

  it('one record per herd per day; a retry with the same id is a success', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 1);
    const id = '0190a7e2-7b1c-7c3d-8e4f-aaaaaaaaaa01';
    const body = { id, herdId: farm.herdId, lines: [{ itemId: farm.itemId, actualQty: 1.2 }] };

    expect((await shepherd.post('/livestock/daily-logs', body)).status).toBe(201);
    const retry = await shepherd.post('/livestock/daily-logs', body);
    expect(retry.status).toBe(201);
    expect(retry.data.id).toBe(id);
    expect(await feedStock(farm, farm.itemId)).toBeCloseTo(9_998.8, 3);

    const clash = await shepherd.post('/livestock/daily-logs', { herdId: farm.herdId, lines: [] });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('DAILY_LOG_EXISTS');
    expect(clash.body.error.details.id).toBe(id);
  });

  it('the offline outbox can replay with an Idempotency-Key and spends stock once', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 1);
    const body = { herdId: farm.herdId, lines: [{ itemId: farm.itemId, actualQty: 2 }] };
    const headers = { 'idempotency-key': 'outbox-log-1' };
    const first = await shepherd.post('/livestock/daily-logs', body, headers);
    const replay = await shepherd.post('/livestock/daily-logs', body, headers);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.data.id).toBe(first.data.id);
    expect(await feedStock(farm, farm.itemId)).toBe(9_998);
  });

  it('a late offline log for a past date is accepted; a future one is not', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 1);
    const past = await shepherd.post('/livestock/daily-logs', { herdId: farm.herdId, date: daysAgo(3), lines: [] });
    expect(past.status).toBe(201);
    const movementDate = await shepherd.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      date: daysAgo(2),
      lines: [{ itemId: farm.itemId, actualQty: 1 }],
    });
    const [movement] = await farm.f.run(() =>
      tx().select().from(schema.stockMovements).where(sql`ref_id = ${movementDate.data.id}`),
    );
    expect(movement.date).toBe(daysAgo(2));
    const future = await shepherd.post('/livestock/daily-logs', { herdId: farm.herdId, date: addDays(today, 1), lines: [] });
    expect(future.body.error.code).toBe('FUTURE_DATE');
  });

  it('20 % over ration is flagged; exactly 15 % is not (threshold is "more than")', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 10);
    const over = await shepherd.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      date: daysAgo(2),
      lines: [
        { itemId: farm.itemId, actualQty: 14.4 },
        { itemId: farm.barleyId, actualQty: 3 },
      ],
    });
    expect(over.data.deviations).toEqual([
      { itemId: farm.itemId, itemName: 'Beda', plannedQty: 12, actualQty: 14.4, percent: 20 },
    ]);
    const events = await farm.f.run(() =>
      tx().select().from(schema.events).where(sql`type = 'herd.feed_deviation' and entity_id = ${farm.herdId}`),
    );
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('attention');

    const onLimit = await shepherd.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      date: daysAgo(1),
      lines: [
        { itemId: farm.itemId, actualQty: 13.8 },
        { itemId: farm.barleyId, actualQty: 3 },
      ],
    });
    expect(onLimit.data.deviations).toEqual([]);
  });

  it('raises one alert at the herd level, on the same key the hourly rule uses', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 10);
    // 15 kg planned, 18 kg given: +20 % on the total. Attention, not urgent: under twice the 15 % limit.
    await shepherd.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      date: daysAgo(1),
      lines: [
        { itemId: farm.itemId, actualQty: 14.4 },
        { itemId: farm.barleyId, actualQty: 3.6 },
      ],
    });
    const alerts = await farm.f.run(() => tx().select().from(schema.alerts));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      ruleKey: 'ration_deviation',
      dedupKey: `ration_deviation:${farm.herdId}:${daysAgo(1)}`,
      severity: 'attention',
      entityId: farm.herdId,
    });
    expect(alerts[0].data).toMatchObject({ date: daysAgo(1), percent: 20, actual: 18, planned: 15 });

    const { evaluateRules } = await import('../src/modules/alerts/rules');
    await farm.f.run(() => evaluateRules());
    const after = await farm.f.run(() => tx().select().from(schema.alerts));
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('open');
  });

  it('twice the limit is urgent', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 10);
    await shepherd.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      lines: [
        { itemId: farm.itemId, actualQty: 20 },
        { itemId: farm.barleyId, actualQty: 5 },
      ],
    });
    const [alert] = await farm.f.run(() => tx().select().from(schema.alerts));
    expect(alert.severity).toBe('urgent');
  });

  it('one feed straying without moving the total is journaled, with no alert', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 10);
    const res = await shepherd.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      lines: [
        { itemId: farm.itemId, actualQty: 12 },
        { itemId: farm.barleyId, actualQty: 4.5 },
      ],
    });
    expect(res.data.deviations).toHaveLength(1);
    expect(res.data.deviations[0].percent).toBe(50);
    expect(await farm.f.run(() => tx().select().from(schema.alerts))).toEqual([]);
  });

  it('a condition of "deviation" alerts the people who can act on it', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 1);
    await shepherd.post('/livestock/daily-logs', { herdId: farm.herdId, condition: 'deviation', notes: "Yo'tal bor", lines: [] });
    const [alert] = await farm.f.run(() => tx().select().from(schema.alerts));
    expect(alert).toMatchObject({ ruleKey: 'herd_condition', body: "Yo'tal bor", severity: 'attention' });
    expect(renderAlert(alert, 'ru').title).toMatch(/^В отаре отмечено отклонение: ./); // the real payload names the herd
    expect(renderAlert(alert, 'ru').body).toBe("Yo'tal bor"); // the reporter's own words stay as written
    expect(alert.notifyRoles).toContain('veterinarian');
  });

  it('under-feeding is a deviation too, including a feed left out of the record', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    const owner = await farm.f.as('owner');
    await herdWith(farm, 10);
    const res = await shepherd.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      lines: [{ itemId: farm.itemId, actualQty: 12 }],
    });
    expect(res.data.deviations).toHaveLength(1);
    expect(res.data.deviations[0]).toMatchObject({ itemName: 'Arpa', actualQty: 0, percent: -100 });
    const barley = res.data.lines.find((l: any) => l.itemName === 'Arpa');
    expect(barley).toMatchObject({ plannedQty: 3, actualQty: 0 });

    const list = await owner.get('/livestock/daily-logs');
    expect(list.body.data[0]).toMatchObject({ plannedKg: 15, actualKg: 12, deviationPercent: -20 });
  });

  it('a log with no feed lines is an observation and raises nothing', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 2);
    const res = await shepherd.post('/livestock/daily-logs', { herdId: farm.herdId, waterL: 80, lines: [] });
    expect(res.data.deviations).toEqual([]);
    expect(res.data.lines).toEqual([]);
  });

  it('honours the tenant threshold', async () => {
    const farm = await makeFarm({ feed: { deviationPercent: 5 } });
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 10);
    const res = await shepherd.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      lines: [
        { itemId: farm.itemId, actualQty: 13.2 },
        { itemId: farm.barleyId, actualQty: 3 },
      ],
    });
    expect(res.data.deviations).toHaveLength(1);
  });

  it('converts a ration into tonnes when the stock is kept in tonnes', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 10);
    const tonneItem = await farm.f.run(async () => {
      const base = { tenantId: farm.f.tenantId, farmId: farm.f.farmId };
      const [item] = await tx()
        .insert(items)
        .values({ ...base, name: 'Somon', category: 'feed', unit: 't', defaultWarehouseId: farm.warehouseId })
        .returning();
      await receiveStock({ itemId: item.id, warehouseId: farm.warehouseId, qty: 2, unitCost: 500_000, date: daysAgo(10), source: 'opening' });
      await tx().insert(rationLines).values({ ...base, rationId: farm.rationId, itemId: item.id, kgPerHeadDay: 0.5 });
      return item;
    });
    const plan = await shepherd.get('/livestock/daily-logs/plan', { herdId: farm.herdId });
    expect(plan.data.lines.find((l: any) => l.itemId === tonneItem.id).plannedQty).toBe(0.005);
  });

  it('a shortage fails the whole log and leaves stock and records untouched', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 1);
    const res = await shepherd.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      lines: [
        { itemId: farm.itemId, actualQty: 5 },
        { itemId: farm.barleyId, actualQty: 99_999 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await feedStock(farm, farm.itemId)).toBe(10_000);
    expect((await shepherd.get('/livestock/daily-logs')).body.meta.total).toBe(0);
  });

  it('takes feed from wherever it is when the usual warehouse cannot cover it', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 1);
    const { other, item } = await farm.f.run(async () => {
      const base = { tenantId: farm.f.tenantId, farmId: farm.f.farmId };
      const [w] = await tx().insert(warehouses).values({ ...base, name: 'Zaxira', type: 'feed' }).returning();
      const [i] = await tx()
        .insert(items)
        .values({ ...base, name: 'Kepak', category: 'feed', unit: 'kg', defaultWarehouseId: farm.warehouseId })
        .returning();
      await receiveStock({ itemId: i.id, warehouseId: farm.warehouseId, qty: 1, unitCost: 100, date: daysAgo(5), source: 'opening' });
      await receiveStock({ itemId: i.id, warehouseId: w.id, qty: 50, unitCost: 100, date: daysAgo(5), source: 'opening' });
      return { other: w, item: i };
    });
    const res = await shepherd.post('/livestock/daily-logs', { herdId: farm.herdId, lines: [{ itemId: item.id, actualQty: 10 }] });
    expect(res.status).toBe(201);
    expect(res.data.lines.find((l: any) => l.itemId === item.id).warehouseId).toBe(other.id);
  });

  it('refuses the same feed twice in one record', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 1);
    const res = await shepherd.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      lines: [
        { itemId: farm.itemId, actualQty: 1 },
        { itemId: farm.itemId, actualQty: 2 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DUPLICATE_LINE');
  });

  it('editing returns the old feed to stock and issues the corrected quantity', async () => {
    const farm = await makeFarm();
    const zoo = await farm.f.as('zootechnician');
    await herdWith(farm, 10);
    const log = await zoo.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      lines: [
        { itemId: farm.itemId, actualQty: 12 },
        { itemId: farm.barleyId, actualQty: 3 },
      ],
    });
    expect(await feedStock(farm, farm.itemId)).toBe(9_988);

    const edited = await zoo.patch(`/livestock/daily-logs/${log.data.id}`, {
      condition: 'deviation',
      notes: "Ikki sovliq ozuqa yemadi",
      lines: [
        { itemId: farm.itemId, actualQty: 10 },
        { itemId: farm.barleyId, actualQty: 3 },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.data.condition).toBe('deviation');
    expect(edited.data.lines.find((l: any) => l.itemName === 'Beda').actualQty).toBe(10);
    expect(await feedStock(farm, farm.itemId)).toBe(9_990);

    const movements = await farm.f.run(() =>
      tx().select().from(schema.stockMovements).where(sql`ref_id = ${log.data.id}`),
    );
    expect(movements.reduce((sum, m) => sum + m.qty, 0)).toBe(13);
  });

  it('deleting returns the feed to stock', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    await herdWith(farm, 1);
    const log = await owner.post('/livestock/daily-logs', { herdId: farm.herdId, lines: [{ itemId: farm.itemId, actualQty: 7 }] });
    expect((await owner.delete(`/livestock/daily-logs/${log.data.id}`)).status).toBe(200);
    expect(await feedStock(farm, farm.itemId)).toBe(10_000);
    expect((await owner.get(`/livestock/daily-logs/${log.data.id}`)).status).toBe(404);
  });

  it('a shepherd may correct their own record today, nothing else', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    const zoo = await farm.f.as('zootechnician');
    await herdWith(farm, 1);

    const mine = await shepherd.post('/livestock/daily-logs', { herdId: farm.herdId, lines: [] });
    expect((await shepherd.patch(`/livestock/daily-logs/${mine.data.id}`, { waterL: 50 })).status).toBe(200);
    expect((await shepherd.delete(`/livestock/daily-logs/${mine.data.id}`)).status).toBe(403);

    const old = await shepherd.post('/livestock/daily-logs', { herdId: farm.herdId, date: daysAgo(2), lines: [] });
    const refused = await shepherd.patch(`/livestock/daily-logs/${old.data.id}`, { waterL: 50 });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('EDIT_WINDOW_CLOSED');

    const other = await zoo.post('/livestock/daily-logs', { herdId: farm.herdId, date: daysAgo(1), lines: [] });
    expect((await shepherd.patch(`/livestock/daily-logs/${other.data.id}`, { waterL: 50 })).status).toBe(403);
    expect((await zoo.patch(`/livestock/daily-logs/${old.data.id}`, { waterL: 50 })).status).toBe(200);
  });

  it('a stale offline edit is a conflict, not a silent overwrite', async () => {
    const farm = await makeFarm();
    const zoo = await farm.f.as('zootechnician');
    await herdWith(farm, 1);
    const log = await zoo.post('/livestock/daily-logs', { herdId: farm.herdId, lines: [] });
    const base = log.data.updatedAt;
    await zoo.patch(`/livestock/daily-logs/${log.data.id}`, { waterL: 10 });
    const stale = await zoo.patch(`/livestock/daily-logs/${log.data.id}`, { waterL: 99, baseUpdatedAt: base });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_UPDATE');
    expect((await zoo.get(`/livestock/daily-logs/${log.data.id}`)).data.waterL).toBe(10);
  });

  it('a condition of "deviation" is journaled through the daily log', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    await herdWith(farm, 1);
    const res = await shepherd.post('/livestock/daily-logs', { herdId: farm.herdId, condition: 'deviation', notes: "Yo'tal", lines: [] });
    expect(res.data.condition).toBe('deviation');
    const [event] = await farm.f.run(() =>
      tx().select().from(schema.events).where(sql`type = 'herd.daily_log' and entity_id = ${farm.herdId}`),
    );
    expect(event.data).toMatchObject({ logId: res.data.id, condition: 'deviation' });
  });

  it('the day overview shows which herds are done', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    const owner = await farm.f.as('owner');
    await herdWith(farm, 2);
    await owner.post('/livestock/herds', { name: 'Qolgan' });
    await shepherd.post('/livestock/daily-logs', { herdId: farm.herdId, lines: [] });
    const day = await shepherd.get('/livestock/daily-logs/day');
    expect(day.data.herds).toHaveLength(2);
    const done = day.data.herds.find((h: any) => h.id === farm.herdId);
    expect(done).toMatchObject({ logged: true, headCount: 2 });
    expect(day.data.herds.find((h: any) => h.id !== farm.herdId).logged).toBe(false);
  });

  it('refuses another tenant reaching into a herd', async () => {
    const farm = await makeFarm();
    const other = await makeFarm();
    const stranger = await other.f.as('shepherd');
    const res = await stranger.post('/livestock/daily-logs', { herdId: farm.herdId, lines: [] });
    expect(res.status).toBe(404);
  });
});

describe('exits (spec 8.5)', () => {
  async function saleRefs(farm: Farm) {
    return farm.f.run(async () => {
      const base = { tenantId: farm.f.tenantId, farmId: farm.f.farmId };
      const [buyer] = await tx().insert(counterparties).values({ ...base, name: 'Xaridor', type: 'buyer' }).returning();
      const [account] = await tx().insert(accounts).values({ ...base, name: 'Kassa', type: 'cash' }).returning();
      return { buyerId: buyer.id, accountId: account.id };
    });
  }

  it('sale: 40 kg × 50 000 = 2 000 000 becomes income on the herd, and the animal is archived', async () => {
    const farm = await makeFarm();
    const accountant = await farm.f.as('accountant');
    const owner = await farm.f.as('owner');
    const { buyerId, accountId } = await saleRefs(farm);
    const animal = await ewe(farm, { currentWeightKg: 40 });

    const res = await accountant.post('/livestock/exits', {
      animalId: animal.id,
      type: 'sale',
      pricePerKg: 50_000,
      counterpartyId: buyerId,
      paymentMethod: 'cash',
      accountId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.amount).toBe(2_000_000);
    expect(res.data.liveWeightKg).toBe(40);
    expect(res.data.transactionStatus).toBe('approved');

    const [transaction] = await farm.f.run(() =>
      tx().select().from(schema.transactions).where(eq(schema.transactions.id, res.data.transactionId)),
    );
    expect(transaction).toMatchObject({ type: 'income', amountBase: 2_000_000, sourceType: 'animal_exit', sourceId: res.data.id });
    const herd = await owner.get(`/livestock/herds/${farm.herdId}`);
    expect(transaction.costCenterId).toBe(herd.data.costCenterId);

    const card = await owner.get(`/livestock/animals/${animal.id}`);
    expect(card.data.status).toBe('sold');
    expect(card.data.exitDate).toBe(today);
    expect(card.data.exit.amount).toBe(2_000_000);
    expect((await owner.get('/livestock/animals')).body.data.map((a: any) => a.id)).not.toContain(animal.id);
    expect((await owner.get('/livestock/animals', { scope: 'archived' })).body.data.map((a: any) => a.id)).toContain(animal.id);
  });

  it('a large sale waits for approval, like any other money (spec 5.1)', async () => {
    const farm = await makeFarm();
    const accountant = await farm.f.as('accountant');
    const { buyerId } = await saleRefs(farm);
    const animal = await ewe(farm);
    const res = await accountant.post('/livestock/exits', {
      animalId: animal.id,
      type: 'sale',
      amount: 6_000_000,
      counterpartyId: buyerId,
      paymentMethod: 'debt',
    });
    expect(res.data.amount).toBe(6_000_000);
    expect(res.data.transactionStatus).toBe('pending');
  });

  it.each([
    ['COUNTERPARTY_REQUIRED', { pricePerKg: 1000 }],
    ['AMOUNT_REQUIRED', { useBuyer: true }],
  ])('a sale needs a buyer and a price: %s', async (code, over) => {
    const farm = await makeFarm();
    const accountant = await farm.f.as('accountant');
    const { buyerId } = await saleRefs(farm);
    const animal = await ewe(farm);
    const { useBuyer, ...rest } = over as { useBuyer?: boolean };
    const res = await accountant.post('/livestock/exits', {
      animalId: animal.id,
      type: 'sale',
      paymentMethod: 'debt',
      ...(useBuyer ? { counterpartyId: buyerId } : {}),
      ...rest,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect((await accountant.get(`/livestock/animals/${animal.id}`)).data.status).toBe('active');
  });

  it('withdrawal period blocks sale and slaughter until it ends (spec 8.3)', async () => {
    const farm = await makeFarm();
    const accountant = await farm.f.as('accountant');
    const zoo = await farm.f.as('zootechnician');
    const { buyerId } = await saleRefs(farm);
    const animal = await ewe(farm, { currentWeightKg: 50 });
    const until = addDays(today, 5);
    await farm.f.run(() =>
      tx().insert(schema.healthRecords).values({
        tenantId: farm.f.tenantId,
        farmId: farm.f.farmId,
        type: 'treatment',
        animalId: animal.id,
        date: today,
        withdrawalDays: 5,
        withdrawalUntil: until,
      }),
    );

    const sale = await accountant.post('/livestock/exits', {
      animalId: animal.id,
      type: 'sale',
      amount: 1_000_000,
      counterpartyId: buyerId,
      paymentMethod: 'debt',
    });
    expect(sale.status).toBe(409);
    expect(sale.body.error.code).toBe('WITHDRAWAL_PERIOD_ACTIVE');
    expect(sale.body.error.details.until).toBe(until);

    const slaughter = await zoo.post('/livestock/exits', { animalId: animal.id, type: 'slaughter', carcassWeightKg: 24, meatItemId: farm.itemId, warehouseId: farm.warehouseId });
    expect(slaughter.body.error.code).toBe('WITHDRAWAL_PERIOD_ACTIVE');

    const card = await zoo.get(`/livestock/animals/${animal.id}`);
    expect(card.data.withdrawalUntil).toBe(until);
  });

  it('a herd-wide treatment also blocks a sale of its animals', async () => {
    const farm = await makeFarm();
    const accountant = await farm.f.as('accountant');
    const { buyerId } = await saleRefs(farm);
    const animal = await ewe(farm);
    await farm.f.run(() =>
      tx().insert(schema.healthRecords).values({
        tenantId: farm.f.tenantId,
        farmId: farm.f.farmId,
        type: 'treatment',
        herdId: farm.herdId,
        date: today,
        withdrawalUntil: addDays(today, 3),
      }),
    );
    const res = await accountant.post('/livestock/exits', { animalId: animal.id, type: 'sale', amount: 1_000_000, counterpartyId: buyerId, paymentMethod: 'debt' });
    expect(res.body.error.code).toBe('WITHDRAWAL_PERIOD_ACTIVE');
  });

  it('a withdrawal that ended before the sale date does not block', async () => {
    const farm = await makeFarm();
    const accountant = await farm.f.as('accountant');
    const { buyerId } = await saleRefs(farm);
    const animal = await ewe(farm);
    await farm.f.run(() =>
      tx().insert(schema.healthRecords).values({
        tenantId: farm.f.tenantId,
        farmId: farm.f.farmId,
        type: 'treatment',
        animalId: animal.id,
        date: daysAgo(30),
        withdrawalUntil: daysAgo(1),
      }),
    );
    const res = await accountant.post('/livestock/exits', { animalId: animal.id, type: 'sale', amount: 1_000_000, counterpartyId: buyerId, paymentMethod: 'debt' });
    expect(res.status).toBe(201);
  });

  it('withdrawalUntil is the first allowed day: the day before is blocked, that day passes', async () => {
    const farm = await makeFarm();
    const accountant = await farm.f.as('accountant');
    const { buyerId } = await saleRefs(farm);
    const animal = await ewe(farm);
    await farm.f.run(() =>
      tx().insert(schema.healthRecords).values({
        tenantId: farm.f.tenantId,
        farmId: farm.f.farmId,
        type: 'treatment',
        animalId: animal.id,
        date: daysAgo(14),
        withdrawalDays: 14,
        withdrawalUntil: today,
      }),
    );
    const sale = { animalId: animal.id, type: 'sale', amount: 1_000_000, counterpartyId: buyerId, paymentMethod: 'debt' };

    const dayBefore = await accountant.post('/livestock/exits', { ...sale, date: daysAgo(1) });
    expect(dayBefore.status).toBe(409);
    expect(dayBefore.body.error.code).toBe('WITHDRAWAL_PERIOD_ACTIVE');
    expect(dayBefore.body.error.details.until).toBe(today);

    // The card agrees: nothing is blocked any more today.
    expect((await accountant.get(`/livestock/animals/${animal.id}`)).data.withdrawalUntil).toBeNull();

    const onTheDay = await accountant.post('/livestock/exits', { ...sale, date: today });
    expect(onTheDay.status).toBe(201);
  });

  it('an animal moved out of the herd after a herd treatment is still blocked', async () => {
    const farm = await makeFarm();
    const accountant = await farm.f.as('accountant');
    const zoo = await farm.f.as('zootechnician');
    const { buyerId } = await saleRefs(farm);
    const animal = await ewe(farm);
    const until = addDays(today, 3);
    await farm.f.run(() =>
      tx().insert(schema.healthRecords).values({
        tenantId: farm.f.tenantId,
        farmId: farm.f.farmId,
        type: 'treatment',
        herdId: farm.herdId,
        date: daysAgo(5),
        withdrawalUntil: until,
      }),
    );
    const other = await zoo.post('/livestock/herds', { name: 'Boshqa poda' });
    await zoo.post('/livestock/transfers', { animalIds: [animal.id], toHerdId: other.data.id, date: daysAgo(2) });

    const sale = await accountant.post('/livestock/exits', { animalId: animal.id, type: 'sale', amount: 1_000_000, counterpartyId: buyerId, paymentMethod: 'debt' });
    expect(sale.status).toBe(409);
    expect(sale.body.error.code).toBe('WITHDRAWAL_PERIOD_ACTIVE');
    expect(sale.body.error.details.until).toBe(until);

    const slaughter = await zoo.post('/livestock/exits', { animalId: animal.id, type: 'slaughter', carcassWeightKg: 24, liveWeightKg: 50, meatItemId: farm.itemId, warehouseId: farm.warehouseId });
    expect(slaughter.body.error.code).toBe('WITHDRAWAL_PERIOD_ACTIVE');
    expect((await zoo.get(`/livestock/animals/${animal.id}`)).data.withdrawalUntil).toBe(until);
  });

  it('an animal in quarantine cannot be sold', async () => {
    const farm = await makeFarm();
    const accountant = await farm.f.as('accountant');
    const { buyerId } = await saleRefs(farm);
    const animal = await ewe(farm, { status: 'quarantine' });
    const res = await accountant.post('/livestock/exits', { animalId: animal.id, type: 'sale', amount: 1_000_000, counterpartyId: buyerId, paymentMethod: 'debt' });
    expect(res.body.error.code).toBe('ANIMAL_IN_QUARANTINE');
  });

  it('slaughter: 24 kg from 50 kg live is 48 %, meat enters stock at book value', async () => {
    const farm = await makeFarm();
    const zoo = await farm.f.as('zootechnician');
    const owner = await farm.f.as('owner');
    const { meatId, productsId } = await farm.f.run(async () => {
      const base = { tenantId: farm.f.tenantId, farmId: farm.f.farmId };
      const [w] = await tx().insert(warehouses).values({ ...base, name: 'Tayyor', type: 'finished_goods' }).returning();
      const [i] = await tx().insert(items).values({ ...base, name: "Qo'y go'shti", category: 'product', unit: 'kg' }).returning();
      return { meatId: i.id, productsId: w.id };
    });
    const animal = await ewe(farm, { currentWeightKg: 50, purchasePrice: 2_400_000 });
    const res = await zoo.post('/livestock/exits', {
      animalId: animal.id,
      type: 'slaughter',
      carcassWeightKg: 24,
      meatItemId: meatId,
      warehouseId: productsId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.meatYieldPercent).toBe(48);
    expect(await farm.f.run(() => stockOnHand(meatId))).toBe(24);

    const [batch] = await farm.f.run(() =>
      tx().select().from(schema.stockBatches).where(eq(schema.stockBatches.id, res.data.batchId)),
    );
    expect(batch.unitCost).toBe(100_000);
    expect((await owner.get(`/livestock/animals/${animal.id}`)).data.status).toBe('slaughtered');
  });

  it('slaughter checks its inputs', async () => {
    const farm = await makeFarm();
    const zoo = await farm.f.as('zootechnician');
    const animal = await ewe(farm, { currentWeightKg: 50 });
    const noCarcass = await zoo.post('/livestock/exits', { animalId: animal.id, type: 'slaughter' });
    expect(noCarcass.body.error.code).toBe('WEIGHTS_REQUIRED');
    const tooHeavy = await zoo.post('/livestock/exits', { animalId: animal.id, type: 'slaughter', carcassWeightKg: 51 });
    expect(tooHeavy.body.error.code).toBe('INVALID_WEIGHTS');
    const noItem = await zoo.post('/livestock/exits', { animalId: animal.id, type: 'slaughter', carcassWeightKg: 24 });
    expect(noItem.body.error.code).toBe('MEAT_ITEM_REQUIRED');
  });

  it('death: the shepherd reports it, the loss is the book value, and only finance sees the amount', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    const owner = await farm.f.as('owner');
    const animal = await ewe(farm, { purchasePrice: 4_200_000 });
    const res = await shepherd.post('/livestock/exits', {
      animalId: animal.id,
      type: 'death',
      reason: 'Enterotoksemiya',
      vetConclusion: 'Tasdiqlandi',
    });
    expect(res.status).toBe(201);
    expect(res.data.lossAmount).toBeNull();

    const seen = await owner.get(`/livestock/exits/${res.data.id}`);
    expect(seen.data.lossAmount).toBe(4_200_000);
    expect(seen.data.reason).toBe('Enterotoksemiya');
    expect((await owner.get('/livestock/exits', { type: 'death' })).body.data[0].lossAmount).toBe(4_200_000);
    expect((await shepherd.get('/livestock/exits')).body.data[0].lossAmount).toBeNull();

    const events = await farm.f.run(() =>
      tx().select().from(schema.events).where(sql`type = 'animal.died' and entity_id = ${animal.id}`),
    );
    expect(events[0].severity).toBe('attention');
  });

  it('an unknown value stays unknown: a home-born lamb has no invented loss', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const lamb = await ewe(farm, { origin: 'born', birthDate: daysAgo(10), purchaseDate: null, purchasePrice: null, category: 'lamb_female' });
    const res = await owner.post('/livestock/exits', { animalId: lamb.id, type: 'death' });
    expect(res.status).toBe(201);
    expect(res.data.lossAmount).toBeNull();
  });

  it('a shepherd cannot record a sale or slaughter; a zootechnician cannot record a sale', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    const zoo = await farm.f.as('zootechnician');
    const animal = await ewe(farm);
    expect((await shepherd.post('/livestock/exits', { animalId: animal.id, type: 'sale' })).status).toBe(403);
    expect((await shepherd.post('/livestock/exits', { animalId: animal.id, type: 'slaughter' })).status).toBe(403);
    expect((await zoo.post('/livestock/exits', { animalId: animal.id, type: 'sale' })).status).toBe(403);
  });

  it('an accountant cannot report a death', async () => {
    const farm = await makeFarm();
    const accountant = await farm.f.as('accountant');
    const animal = await ewe(farm);
    expect((await accountant.post('/livestock/exits', { animalId: animal.id, type: 'death' })).status).toBe(403);
  });

  it('an animal cannot leave twice, and a retry with the same id is a success', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    const animal = await ewe(farm);
    const id = '0190a7e2-7b1c-7c3d-8e4f-bbbbbbbbbb01';
    const first = await shepherd.post('/livestock/exits', { id, animalId: animal.id, type: 'death' });
    expect(first.status).toBe(201);
    const retry = await shepherd.post('/livestock/exits', { id, animalId: animal.id, type: 'death' });
    expect(retry.status).toBe(201);
    expect(retry.data.id).toBe(id);
    const again = await shepherd.post('/livestock/exits', { animalId: animal.id, type: 'loss' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ANIMAL_NOT_ON_FARM');
  });

  it('a pregnant ewe that dies leaves the lambing calendar, and undo restores her', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const animal = await ewe(farm, { status: 'pregnant' });
    const expected = addDays(today, 30);
    await farm.f.run(() =>
      tx().insert(schema.breedingRecords).values({
        tenantId: farm.f.tenantId,
        farmId: farm.f.farmId,
        eweId: animal.id,
        matingDate: addDays(today, -120),
        expectedDate: expected,
        expectedEarliest: expected,
        expectedLatest: expected,
      }),
    );
    const inTenant = (fn: () => Promise<any>) => farm.f.run(fn);
    expect(await inTenant(() => lambingCalendar(60))).toEqual([{ date: expected, expected: 1 }]);

    const exit = await owner.post('/livestock/exits', { animalId: animal.id, type: 'death' });
    expect(await inTenant(() => lambingCalendar(60))).toEqual([]);

    expect((await owner.delete(`/livestock/exits/${exit.data.id}`)).status).toBe(200);
    expect(await inTenant(() => lambingCalendar(60))).toEqual([{ date: expected, expected: 1 }]);
    const card = await owner.get(`/livestock/animals/${animal.id}`);
    expect(card.data.status).toBe('pregnant');
    expect(card.data.exitDate).toBeNull();
    expect(card.data.pregnancy.expectedDate).toBe(expected);
  });

  it('undoing a slaughter takes the meat back out of stock', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const animal = await ewe(farm, { currentWeightKg: 50 });
    const exit = await owner.post('/livestock/exits', {
      animalId: animal.id,
      type: 'slaughter',
      carcassWeightKg: 24,
      meatItemId: farm.itemId,
      warehouseId: farm.warehouseId,
    });
    expect(await farm.f.run(() => stockOnHand(farm.itemId))).toBe(10_024);
    await owner.delete(`/livestock/exits/${exit.data.id}`);
    expect(await farm.f.run(() => stockOnHand(farm.itemId))).toBe(10_000);
    expect((await owner.get(`/livestock/animals/${animal.id}`)).data.status).toBe('active');
  });

  it('a sale with money attached cannot be undone from here', async () => {
    const farm = await makeFarm();
    const accountant = await farm.f.as('accountant');
    const owner = await farm.f.as('owner');
    const { buyerId } = await saleRefs(farm);
    const animal = await ewe(farm);
    const exit = await accountant.post('/livestock/exits', { animalId: animal.id, type: 'sale', amount: 1_000_000, counterpartyId: buyerId, paymentMethod: 'debt' });
    const res = await owner.delete(`/livestock/exits/${exit.data.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXIT_HAS_TRANSACTION');
  });
});

describe('shearing and pasture', () => {
  it('wool enters the products warehouse at the transfer price', async () => {
    const farm = await makeFarm();
    const zoo = await farm.f.as('zootechnician');
    const { woolId, productsId } = await farm.f.run(async () => {
      const base = { tenantId: farm.f.tenantId, farmId: farm.f.farmId };
      const [w] = await tx().insert(warehouses).values({ ...base, name: 'Tayyor', type: 'finished_goods' }).returning();
      const [i] = await tx().insert(items).values({ ...base, name: 'Jun', category: 'product', unit: 'kg', transferPrice: 15_000 }).returning();
      return { woolId: i.id, productsId: w.id };
    });
    const animal = await ewe(farm);
    const res = await zoo.post('/livestock/shearing', { animalId: animal.id, woolKg: 3.5, quality: '1-nav', itemId: woolId, warehouseId: productsId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.herdId).toBe(farm.herdId);

    const [batch] = await farm.f.run(() => tx().select().from(schema.stockBatches).where(eq(schema.stockBatches.id, res.data.batchId)));
    expect(batch).toMatchObject({ qtyRemaining: 3.5, unitCost: 15_000, source: 'own_harvest' });

    await zoo.post('/livestock/shearing', { herdId: farm.herdId, woolKg: 100, itemId: woolId, warehouseId: productsId });
    const list = await zoo.get('/livestock/shearing', { herdId: farm.herdId });
    expect(list.body.meta.total).toBe(2);
    expect(list.body.meta.totalWoolKg).toBe(103.5);

    expect((await zoo.delete(`/livestock/shearing/${res.data.id}`)).status).toBe(200);
    expect(await farm.f.run(() => stockOnHand(woolId))).toBe(100);
  });

  it('needs an animal or a herd', async () => {
    const farm = await makeFarm();
    const zoo = await farm.f.as('zootechnician');
    const res = await zoo.post('/livestock/shearing', { woolKg: 1, itemId: farm.itemId, warehouseId: farm.warehouseId });
    expect(res.body.error.code).toBe('TARGET_REQUIRED');
  });

  it('wool already sold cannot be taken back', async () => {
    const farm = await makeFarm();
    const zoo = await farm.f.as('zootechnician');
    const res = await zoo.post('/livestock/shearing', { herdId: farm.herdId, woolKg: 10, itemId: farm.barleyId, warehouseId: farm.warehouseId });
    await farm.f.run(async () => {
      const { issueStock } = await import('../src/core/inventory');
      await issueStock({ itemId: farm.barleyId, warehouseId: farm.warehouseId, qty: 5_005, date: today, reason: 'sale' });
    });
    const undo = await zoo.delete(`/livestock/shearing/${res.data.id}`);
    expect(undo.status).toBe(409);
    expect(undo.body.error.code).toBe('BATCH_ALREADY_USED');
  });

  it('computes stocking rate: 30 head on 10 ha is 3 head/ha', async () => {
    const farm = await makeFarm();
    const zoo = await farm.f.as('zootechnician');
    await herdWith(farm, 30);
    const field = await farm.f.run(async () => {
      const [row] = await tx()
        .insert(fields)
        .values({ tenantId: farm.f.tenantId, farmId: farm.f.farmId, number: 'Y-1', landUse: 'pasture', areaHa: 10 })
        .returning();
      return row;
    });
    const out = await zoo.post('/livestock/pasture-moves', { herdId: farm.herdId, fieldId: field.id, outDate: daysAgo(2) });
    expect(out.status).toBe(201);
    const list = await zoo.get('/livestock/pasture-moves', { open: 'true' });
    expect(list.body.data[0]).toMatchObject({ headCount: 30, stockingRate: 3, areaHa: 10, fieldNumber: 'Y-1' });

    const twice = await zoo.post('/livestock/pasture-moves', { herdId: farm.herdId, fieldId: field.id });
    expect(twice.body.error.code).toBe('PASTURE_MOVE_OPEN');

    const early = await zoo.post(`/livestock/pasture-moves/${out.data.id}/return`, { returnDate: daysAgo(3) });
    expect(early.body.error.code).toBe('INVALID_DATES');

    const back = await zoo.post(`/livestock/pasture-moves/${out.data.id}/return`, {});
    expect(back.data.returnDate).toBe(today);
    const closed = await zoo.post(`/livestock/pasture-moves/${out.data.id}/return`, {});
    expect(closed.body.error.code).toBe('PASTURE_MOVE_CLOSED');

    expect((await zoo.get(`/livestock/herds/${farm.herdId}`)).data.pasture).toHaveLength(1);
  });
});

describe('summary figures (hand-computed control numbers)', () => {
  /**
   * Opening 4 head bought 100 days ago.
   * In the period (last 30 days): 2 bought, 3 born, 1 sold, 1 slaughtered, 1 dead, 1 lost.
   * Closing = 4 + 3 + 2 − 1 − 1 − 1 − 1 = 5.
   * One animal both arrived and left before the period and must not appear at all.
   */
  it('herd movement', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const accountant = await farm.f.as('accountant');
    const buyer = await farm.f.run(async () => {
      const [row] = await tx()
        .insert(counterparties)
        .values({ tenantId: farm.f.tenantId, farmId: farm.f.farmId, name: 'X', type: 'buyer' })
        .returning();
      return row;
    });
    const old: { id: string }[] = [];
    for (let i = 0; i < 4; i++) old.push(await ewe(farm, { purchaseDate: daysAgo(100), currentWeightKg: 50 }));
    const before = await ewe(farm, { purchaseDate: daysAgo(90) });
    await owner.post('/livestock/exits', { animalId: before.id, type: 'death', date: daysAgo(80) });

    const bought = [await ewe(farm, { purchaseDate: daysAgo(10) }), await ewe(farm, { purchaseDate: daysAgo(10) })];
    const born: { id: string }[] = [];
    for (let i = 0; i < 3; i++) {
      born.push(await ewe(farm, { origin: 'born', birthDate: daysAgo(5), purchaseDate: null, purchasePrice: null, category: 'lamb_female' }));
    }

    await accountant.post('/livestock/exits', { animalId: old[0].id, type: 'sale', date: daysAgo(3), amount: 1_000_000, counterpartyId: buyer.id, paymentMethod: 'debt' });
    await owner.post('/livestock/exits', {
      animalId: old[1].id,
      type: 'slaughter',
      date: daysAgo(3),
      carcassWeightKg: 20,
      meatItemId: farm.itemId,
      warehouseId: farm.warehouseId,
    });
    await owner.post('/livestock/exits', { animalId: bought[0].id, type: 'death', date: daysAgo(2) });
    await owner.post('/livestock/exits', { animalId: born[0].id, type: 'loss', date: daysAgo(1) });

    const movement = await farm.f.run(() => herdMovement(daysAgo(29), today));
    expect(movement).toEqual({ opening: 4, born: 3, purchased: 2, sold: 1, slaughtered: 1, dead: 1, lost: 1, closing: 5 });
    expect(movement.closing).toBe(herdCount(movement));

    const summary = await farm.f.run(() => herdSummary());
    expect(summary.total).toBe(5);

    const dead = await farm.f.run(() => mortality(30));
    // 1 dead over an average of (4 + 5) / 2 = 4.5 head.
    expect(dead.dead).toBe(1);
    expect(dead.percent).toBeCloseTo((1 / 4.5) * 100, 5);

    const exposed = await owner.get('/livestock/movement', { from: daysAgo(29), to: today });
    expect(exposed.data.closing).toBe(5);
  });

  it('an exit dated before the period does not count; an exit on its first day does', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const a = await ewe(farm, { purchaseDate: daysAgo(100) });
    await owner.post('/livestock/exits', { animalId: a.id, type: 'death', date: daysAgo(10) });
    const onFirstDay = await farm.f.run(() => herdMovement(daysAgo(10), today));
    expect(onFirstDay).toMatchObject({ opening: 1, dead: 1, closing: 0 });
    const after = await farm.f.run(() => herdMovement(daysAgo(9), today));
    expect(after).toMatchObject({ opening: 0, dead: 0, closing: 0 });
  });

  it('herd summary by category and status', async () => {
    const farm = await makeFarm();
    await ewe(farm, { status: 'pregnant' });
    await ewe(farm, { status: 'pregnant' });
    await ewe(farm, { status: 'sick' });
    await ewe(farm, { status: 'quarantine' });
    await ewe(farm, { sex: 'male', category: 'ram' });
    const s = await farm.f.run(() => herdSummary());
    expect(s).toEqual({
      total: 5,
      byCategory: { ewe: 4, ram: 1 },
      byStatus: { pregnant: 2, sick: 1, quarantine: 1, active: 1 },
      pregnant: 2,
      sick: 1,
      quarantine: 1,
    });
  });

  it('with no data, rates are null rather than zero', async () => {
    const farm = await makeFarm();
    const kpis = await farm.f.run(() => reproductionKpis());
    expect(kpis.lambingPercent).toBeNull();
    expect(kpis.survivalPercent).toBeNull();
    expect((await farm.f.run(() => mortality(30))).percent).toBeNull();
    const growth = await farm.f.run(() => growthKpis(daysAgo(30), today));
    expect(growth).toMatchObject({ gainKg: null, adgG: null, feedConversion: null, dryMatterKg: null });
  });

  it('breeding figures are the Breeding page\'s own functions, so the two cannot disagree', () => {
    expect(summary.reproductionKpis).toBe(breeding.reproductionKpis);
    expect(summary.lambingCalendar).toBe(breeding.lambingCalendar);
  });

  it('growth: two animals gain 6 kg and 3 kg over 30 days; feed conversion from daily logs', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const a = await ewe(farm);
    const b = await ewe(farm);
    const c = await ewe(farm);
    await owner.post('/livestock/weights', { animalId: a.id, date: daysAgo(30), weightKg: 50 });
    await owner.post('/livestock/weights', { animalId: a.id, date: today, weightKg: 56 });
    await owner.post('/livestock/weights', { animalId: b.id, date: daysAgo(30), weightKg: 40 });
    await owner.post('/livestock/weights', { animalId: b.id, date: today, weightKg: 43 });
    // One weighing shows no gain and must not count.
    await owner.post('/livestock/weights', { animalId: c.id, date: today, weightKg: 70 });
    // 10 kg hay at 85 % + 10 kg barley at 88 % = 8.5 + 8.8 = 17.3 kg dry matter.
    await owner.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      date: daysAgo(10),
      lines: [
        { itemId: farm.itemId, actualQty: 10 },
        { itemId: farm.barleyId, actualQty: 10 },
      ],
    });

    const growth = await farm.f.run(() => growthKpis(daysAgo(30), today, farm.herdId));
    expect(growth.animals).toBe(2);
    expect(growth.gainKg).toBe(9);
    // (200 g + 100 g) / 2
    expect(growth.adgG).toBe(150);
    expect(growth.dryMatterKg).toBe(17.3);
    // Two of three animals is a fair sample: 9 kg scales to 13.5 kg for the herd the feed went to.
    expect(growth.herdGainKg).toBe(13.5);
    expect(growth.feedConversion).toBeCloseTo(17.3 / 13.5, 5);

    const exposed = await owner.get('/livestock/kpis', { from: daysAgo(30), to: today, herdId: farm.herdId });
    expect(exposed.data.growth.gainKg).toBe(9);
  });

  it('feed conversion is withheld when too few animals were weighed to stand for the herd', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const weighed = await ewe(farm);
    await ewe(farm);
    await ewe(farm);
    await owner.post('/livestock/weights', { animalId: weighed.id, date: daysAgo(30), weightKg: 50 });
    await owner.post('/livestock/weights', { animalId: weighed.id, date: today, weightKg: 56 });
    await owner.post('/livestock/daily-logs', {
      herdId: farm.herdId,
      date: daysAgo(10),
      lines: [{ itemId: farm.itemId, actualQty: 10 }],
    });
    const growth = await farm.f.run(() => growthKpis(daysAgo(30), today, farm.herdId));
    expect(growth.gainKg).toBe(6);
    expect(growth.herdGainKg).toBeNull();
    expect(growth.feedConversion).toBeNull();
  });

  it('feed without a dry-matter figure makes the total unknown instead of understated', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const item = await farm.f.run(async () => {
      const [row] = await tx()
        .insert(items)
        .values({ tenantId: farm.f.tenantId, farmId: farm.f.farmId, name: 'Noma\'lum', category: 'feed', unit: 'kg', defaultWarehouseId: farm.warehouseId })
        .returning();
      await receiveStock({ itemId: row.id, warehouseId: farm.warehouseId, qty: 100, unitCost: 1, date: daysAgo(20), source: 'opening' });
      return row;
    });
    await owner.post('/livestock/daily-logs', { herdId: farm.herdId, date: daysAgo(3), lines: [{ itemId: item.id, actualQty: 10 }] });
    const growth = await farm.f.run(() => growthKpis(daysAgo(30), today, farm.herdId));
    expect(growth.dryMatterKg).toBeNull();
  });

  it('weight trend has one row per month, null where nothing was weighed', async () => {
    const farm = await makeFarm();
    const owner = await farm.f.as('owner');
    const a = await ewe(farm);
    await owner.post('/livestock/weights', { animalId: a.id, date: today, weightKg: 60 });
    const trend = await farm.f.run(() => weightTrend(3));
    expect(trend).toHaveLength(3);
    expect(trend[2]).toEqual({ month: today.slice(0, 7), avgKg: 60 });
    expect(trend[0].avgKg).toBeNull();
  });
});
