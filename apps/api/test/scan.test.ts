import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIso } from '@yap/shared';
import { animalLabelCode, itemLabelCode, normalizeScan } from '@yap/shared/formulas/scan-code';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { createFixture, type Client, type Fixture } from './helpers';

const { animalIdentifiers, animals, farms, items, species } = schema;

const today = todayIso();

interface World {
  f: Fixture;
  owner: Client;
  speciesId: string;
  herdId: string;
}

async function makeWorld(): Promise<World> {
  const f = await createFixture();
  const owner = await f.as('owner');
  const [sheep] = await f.run(() => tx().select().from(species).where(eq(species.key, 'sheep')));
  const herd = await owner.post('/livestock/herds', { name: 'Sovliqlar', state: 'maintenance' });
  expect(herd.status, JSON.stringify(herd.body)).toBe(201);
  return { f, owner, speciesId: sheep.id, herdId: herd.data.id };
}

async function animal(w: World, tag: string, over: Record<string, unknown> = {}) {
  const res = await w.owner.post('/livestock/animals', {
    tag,
    speciesId: w.speciesId,
    sex: 'female',
    category: 'ewe',
    origin: 'purchased',
    purchaseDate: addDays(today, -60),
    purchasePrice: 4_000_000,
    herdId: w.herdId,
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data as { id: string; tag: string };
}

const tags = (res: { data: { tag: string }[] }) => res.data.map((a) => a.tag);

describe('animals by scanned code', () => {
  let w: World;
  let a: { id: string; tag: string };
  beforeAll(async () => {
    w = await makeWorld();
    a = await animal(w, 'YA-0123', {
      identifiers: [
        { type: 'rfid', value: '982 000123456789' },
        { type: 'qr', value: 'QR-A1' },
      ],
    });
    await animal(w, 'YA-0007');
    await animal(w, 'QB-0007');
  });

  it('finds the animal by its tag, its chip and its QR code, whatever the case and spacing', async () => {
    const byCode = (code: string) => w.owner.get('/livestock/animals/by-code', { code });
    expect((await byCode('YA-0123')).data).toMatchObject([{ id: a.id, tag: 'YA-0123', matchedBy: 'tag', exact: true, onFarm: true, herdName: 'Sovliqlar', speciesKey: 'sheep' }]);
    expect((await byCode('ya-0123')).data).toMatchObject([{ id: a.id, matchedBy: 'tag', exact: false }]);
    expect((await byCode('982000123456789')).data).toMatchObject([{ id: a.id, matchedBy: 'rfid' }]);
    expect((await byCode('982 000123456789')).data).toMatchObject([{ id: a.id, matchedBy: 'rfid', exact: true }]);
    expect((await byCode('qr-a1')).data).toMatchObject([{ id: a.id, matchedBy: 'qr' }]);
  });

  it('takes the code out of a web address on a bought tag', async () => {
    const res = await w.owner.get('/livestock/animals/by-code', { code: 'https://tags.example/t/YA-0123' });
    expect(tags(res)).toEqual(['YA-0123']);
  });

  it('answers an unknown code with an empty list, and never with a near match', async () => {
    const byCode = async (code: string) => (await w.owner.get('/livestock/animals/by-code', { code })).data;
    expect(await byCode('NOPE')).toEqual([]);
    // The typing lookup takes "123" for YA-0123. A scan must not.
    expect((await w.owner.get('/livestock/animals/scan', { code: '123' })).data.tag).toBe('YA-0123');
    expect(await byCode('123')).toEqual([]);
    expect(await byCode('YA-012')).toEqual([]);
    expect(await byCode('YA0123')).toEqual([]);
    expect(await byCode('7')).toEqual([]);
  });

  it('refuses a scan that holds no code', async () => {
    const res = await w.owner.get('/livestock/animals/by-code', { code: 'https://tags.example/' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SCAN_UNREADABLE');
  });

  it('returns both animals when one code names two, for the person to choose', async () => {
    const tagged = await animal(w, '555001');
    const chipped = await animal(w, 'CH-1', { identifiers: [{ type: 'rfid', value: '555001' }] });
    const res = await w.owner.get('/livestock/animals/by-code', { code: '555001' });
    expect(res.data.map((m: any) => [m.id, m.matchedBy]).sort()).toEqual(
      [
        [tagged.id, 'tag'],
        [chipped.id, 'rfid'],
      ].sort(),
    );

    // Tags that differ only in case: the exact one wins, and a third spelling offers both.
    await animal(w, 'mx-1');
    await animal(w, 'MX-1');
    expect(tags(await w.owner.get('/livestock/animals/by-code', { code: 'MX-1' }))).toEqual(['MX-1']);
    expect(tags(await w.owner.get('/livestock/animals/by-code', { code: 'Mx-1' })).sort()).toEqual(['MX-1', 'mx-1']);
  });

  it('an identifier taken out of use no longer names its animal', async () => {
    const old = await animal(w, 'OLD-1', { identifiers: [{ type: 'qr', value: 'QR-OLD' }] });
    expect(tags(await w.owner.get('/livestock/animals/by-code', { code: 'QR-OLD' }))).toEqual(['OLD-1']);
    await w.f.run(() => tx().update(animalIdentifiers).set({ active: false }).where(eq(animalIdentifiers.value, 'QR-OLD')));
    expect((await w.owner.get('/livestock/animals/by-code', { code: 'QR-OLD' })).data).toEqual([]);
    expect(old.tag).toBe('OLD-1');
  });

  it('says when the animal has left the farm instead of hiding it', async () => {
    const gone = await animal(w, 'GONE-1');
    await w.owner.post('/livestock/exits', { animalId: gone.id, type: 'death' });
    const res = await w.owner.get('/livestock/animals/by-code', { code: 'GONE-1' });
    expect(res.data).toMatchObject([{ id: gone.id, onFarm: false }]);
  });

  it('carries no price and no seller', async () => {
    const res = await w.owner.get('/livestock/animals/by-code', { code: 'YA-0123' });
    expect(Object.keys(res.data[0]).sort()).toEqual(
      ['birthDate', 'category', 'exact', 'herdId', 'herdName', 'id', 'matchedBy', 'onFarm', 'sex', 'speciesKey', 'status', 'tag'].sort(),
    );
  });

  it('needs the right to see livestock', async () => {
    const shepherd = await w.f.as('shepherd');
    expect((await shepherd.get('/livestock/animals/by-code', { code: 'YA-0123' })).status).toBe(200);
    const storekeeper = await w.f.as('storekeeper');
    expect((await storekeeper.get('/livestock/animals/by-code', { code: 'YA-0123' })).status).toBe(403);
    expect((await storekeeper.post('/livestock/animals/match-codes', { codes: ['YA-0123'] })).status).toBe(403);
    expect((await storekeeper.post('/livestock/animals/tag-labels', { ids: [a.id] })).status).toBe(403);
  });

  it('does not see another tenant, nor another farm of the same tenant', async () => {
    const other = await makeWorld();
    await animal(other, 'YA-0123');
    await animal(other, 'ONLY-THERE');
    expect((await w.owner.get('/livestock/animals/by-code', { code: 'ONLY-THERE' })).data).toEqual([]);
    expect((await w.owner.get('/livestock/animals/by-code', { code: 'YA-0123' })).data).toMatchObject([{ id: a.id }]);

    const [second] = await w.f.run(() => tx().insert(farms).values({ tenantId: w.f.tenantId, name: 'Ikkinchi' } as never).returning());
    await w.f.run(() =>
      tx().insert(animals).values({ tenantId: w.f.tenantId, farmId: second.id, tag: 'FARM2-1', speciesId: w.speciesId, sex: 'female', category: 'ewe', origin: 'purchased' }),
    );
    expect((await w.owner.get('/livestock/animals/by-code', { code: 'FARM2-1' })).data).toEqual([]);
    const labels = await w.owner.post('/livestock/animals/match-codes', { codes: ['FARM2-1'] });
    expect(labels.data).toEqual([{ code: 'FARM2-1', matches: [] }]);
  });

  it('matches a whole file of codes at once, each to its own animals', async () => {
    const res = await w.owner.post('/livestock/animals/match-codes', { codes: ['ya-0007', '982000123456789', 'NOPE', 'ya-0007', '7'] });
    expect(res.status).toBe(200);
    expect(res.data.map((r: any) => [r.code, r.matches.map((m: any) => `${m.tag}:${m.matchedBy}`)])).toEqual([
      ['ya-0007', ['YA-0007:tag']],
      ['982000123456789', ['YA-0123:rfid']],
      ['NOPE', []],
      ['7', []],
    ]);
  });
});

describe('printed tags', () => {
  it('a tag carries the animal QR identifier when it has one, else its ear tag, and reads back to that animal', async () => {
    const w = await makeWorld();
    const plain = await animal(w, 'TG-0001');
    const coded = await animal(w, 'TG-0002', { identifiers: [{ type: 'qr', value: 'QR-TG2' }, { type: 'rfid', value: '982000000000002' }] });
    const res = await w.owner.post('/livestock/animals/tag-labels', { ids: [coded.id, plain.id] });
    expect(res.status).toBe(200);
    expect(res.data).toEqual([
      { id: plain.id, tag: 'TG-0001', herdName: 'Sovliqlar', code: 'TG-0001' },
      { id: coded.id, tag: 'TG-0002', herdName: 'Sovliqlar', code: 'QR-TG2' },
    ]);
    expect(res.data[1].code).toBe(animalLabelCode({ tag: 'TG-0002', qr: 'QR-TG2' }));

    // The round trip: what is printed is what the scan dialog reads, and it finds the same animal.
    for (const label of res.data) {
      const read = normalizeScan(label.code);
      expect(read).toBe(label.code);
      const found = await w.owner.get('/livestock/animals/by-code', { code: read! });
      expect(found.data.map((m: any) => m.id)).toEqual([label.id]);
    }
  });

  it('prints a whole herd, without the animals that have left it', async () => {
    const w = await makeWorld();
    await animal(w, 'HD-2');
    await animal(w, 'HD-1');
    const gone = await animal(w, 'HD-3');
    await w.owner.post('/livestock/exits', { animalId: gone.id, type: 'death' });
    await animal(w, 'HD-9', { herdId: null });
    const res = await w.owner.post('/livestock/animals/tag-labels', { herdId: w.herdId });
    expect(res.data.map((l: any) => l.code)).toEqual(['HD-1', 'HD-2']);
  });

  it('asks for the animals or a herd, not both and not neither, and keeps to its own farm', async () => {
    const w = await makeWorld();
    const one = await animal(w, 'ONE-1');
    expect((await w.owner.post('/livestock/animals/tag-labels', {})).status).toBe(400);
    expect((await w.owner.post('/livestock/animals/tag-labels', { ids: [one.id], herdId: w.herdId })).status).toBe(400);

    const other = await makeWorld();
    const theirs = await animal(other, 'THEIRS-1');
    expect((await w.owner.post('/livestock/animals/tag-labels', { ids: [theirs.id] })).data).toEqual([]);
    expect((await w.owner.post('/livestock/animals/tag-labels', { herdId: other.herdId })).status).toBe(400);
  });
});

describe('items by scanned code', () => {
  let w: World;
  let ids: { hay: string; diesel: string; bare: string; twinA: string; twinB: string; retired: string };
  beforeAll(async () => {
    w = await makeWorld();
    ids = await w.f.run(async () => {
      const base = { tenantId: w.f.tenantId, farmId: w.f.farmId, unit: 'kg' };
      const add = async (values: Record<string, unknown>) => (await tx().insert(items).values({ ...base, ...values } as never).returning())[0].id;
      return {
        hay: await add({ name: 'Beda', category: 'feed', barcode: '0036000291452', sku: 'HAY-1' }),
        diesel: await add({ name: 'Dizel', category: 'fuel', unit: 'l', sku: 'DT 92', transferPrice: 11_500 }),
        bare: await add({ name: 'Tuz', category: 'feed' }),
        twinA: await add({ name: 'Arpa 1', category: 'feed', barcode: '4780000000017' }),
        twinB: await add({ name: 'Arpa 2', category: 'feed', barcode: '4780000000017' }),
        retired: await add({ name: 'Eski', category: 'feed', sku: 'OLD-9', active: false }),
      };
    });
  });

  const byCode = (code: string, client?: Client) => (client ?? w.owner).get('/inventory/items/by-code', { code });

  it('finds an item by barcode, by its own code and by the id on a label printed here', async () => {
    expect((await byCode('0036000291452')).data).toMatchObject([{ id: ids.hay, name: 'Beda', matchedBy: 'barcode', unit: 'kg', category: 'feed' }]);
    // A scanner that reports the same number as a 12-digit UPC-A.
    expect((await byCode('036000291452')).data).toMatchObject([{ id: ids.hay, matchedBy: 'barcode' }]);
    expect((await byCode('hay-1')).data).toMatchObject([{ id: ids.hay, matchedBy: 'sku' }]);
    expect((await byCode('dt92')).data).toMatchObject([{ id: ids.diesel, matchedBy: 'sku' }]);
    expect((await byCode(ids.bare)).data).toMatchObject([{ id: ids.bare, matchedBy: 'id' }]);
    expect((await byCode(ids.bare.toUpperCase())).data).toMatchObject([{ id: ids.bare, matchedBy: 'id' }]);
  });

  it('every item label reads back to its item', async () => {
    const rows = await w.f.run(() => tx().select().from(items).where(eq(items.farmId, w.f.farmId)));
    for (const row of rows.filter((r) => r.id !== ids.twinA && r.id !== ids.twinB)) {
      const code = itemLabelCode(row);
      expect(normalizeScan(code)).toBe(code);
      expect((await byCode(code)).data.map((i: any) => i.id)).toEqual([row.id]);
    }
  });

  it('answers an unknown code with an empty list, never with a similar name or number', async () => {
    expect((await byCode('Beda')).data).toEqual([]);
    expect((await byCode('HAY')).data).toEqual([]);
    expect((await byCode('003600029145')).data).toEqual([]);
  });

  it('returns both items when two carry one barcode, and says when an item is switched off', async () => {
    expect((await byCode('4780000000017')).data.map((i: any) => i.id).sort()).toEqual([ids.twinA, ids.twinB].sort());
    expect((await byCode('OLD-9')).data).toMatchObject([{ id: ids.retired, active: false }]);
  });

  it('carries no price', async () => {
    const [row] = (await byCode('DT 92')).data;
    expect(Object.keys(row).sort()).toEqual(['active', 'barcode', 'category', 'defaultWarehouseId', 'exact', 'id', 'matchedBy', 'name', 'sku', 'unit'].sort());
  });

  it('needs the right to see the warehouse, and stays inside the tenant', async () => {
    expect((await byCode('HAY-1', await w.f.as('storekeeper'))).status).toBe(200);
    expect((await byCode('HAY-1', await w.f.as('shepherd'))).status).toBe(403);
    const other = await makeWorld();
    expect((await other.owner.get('/inventory/items/by-code', { code: 'HAY-1' })).data).toEqual([]);
    expect((await other.owner.get('/inventory/items/by-code', { code: ids.bare })).data).toEqual([]);
  });
});

describe('weighing entries that name the animal', () => {
  it('a scan weighs exactly the animal the person was shown, whatever the code would resolve to', async () => {
    const w = await makeWorld();
    // "123" typed resolves to YA-0123 by its number; the scan showed TG-123 and the person chose it.
    await animal(w, 'YA-0123');
    const chosen = await animal(w, 'TG-9', { identifiers: [{ type: 'rfid', value: '123' }] });
    const campaign = await w.owner.post('/livestock/weighing-campaigns', { herdId: w.herdId, name: 'Kuz' });
    const url = `/livestock/weighing-campaigns/${campaign.data.id}/entries`;

    const res = await w.owner.post(url, { code: '123', animalId: chosen.id, weightKg: 61.5, method: 'rfid' });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ animalId: chosen.id, tag: 'TG-9', weightKg: 61.5 });
    const detail = await w.owner.get(`/livestock/weighing-campaigns/${campaign.data.id}`);
    expect(detail.data.entries).toMatchObject([{ tag: 'TG-9', weightKg: 61.5, method: 'rfid' }]);
  });

  it('an id from another tenant weighs nothing', async () => {
    const w = await makeWorld();
    const other = await makeWorld();
    const theirs = await animal(other, 'THEIRS-1');
    await animal(w, 'MINE-1');
    const campaign = await w.owner.post('/livestock/weighing-campaigns', { herdId: w.herdId, name: 'Kuz' });
    const url = `/livestock/weighing-campaigns/${campaign.data.id}/entries`;
    // The code alone would find MINE-1: the id decides, and it is not on this farm.
    const res = await w.owner.post(url, { code: 'MINE-1', animalId: theirs.id, weightKg: 50 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ANIMAL_NOT_FOUND');
    const bulk = await w.owner.post(`${url}/bulk`, { entries: [{ code: 'MINE-1', animalId: theirs.id, weightKg: 50 }] });
    expect(bulk.data).toMatchObject({ applied: 0, failed: [{ code: 'MINE-1', error: 'ANIMAL_NOT_FOUND' }] });
  });

  it('a scale file is applied row by row: the rows that cannot stand are reported and the rest are kept', async () => {
    const w = await makeWorld();
    const a = await animal(w, 'SF-1', { identifiers: [{ type: 'rfid', value: '982000000000001' }] });
    const b = await animal(w, 'SF-2');
    const heavy = await animal(w, 'SF-3');
    const young = await animal(w, 'SF-4', { origin: 'born', birthDate: today, purchaseDate: undefined, purchasePrice: undefined, category: 'lamb_female' });
    const gone = await animal(w, 'SF-5');
    await w.owner.post('/livestock/exits', { animalId: gone.id, type: 'death' });
    const campaign = await w.owner.post('/livestock/weighing-campaigns', { herdId: w.herdId, name: 'Kuz', date: addDays(today, -1) });
    const url = `/livestock/weighing-campaigns/${campaign.data.id}`;

    const bulk = await w.owner.post(`${url}/entries/bulk`, {
      entries: [
        { code: '982000000000001', animalId: a.id, weightKg: 52.4, method: 'rfid' },
        { code: 'SF-2', animalId: b.id, weightKg: 48, method: 'scale' },
        { code: 'SF-3', animalId: heavy.id, weightKg: 300, method: 'scale' },
        { code: 'SF-4', animalId: young.id, weightKg: 4, method: 'scale' },
        { code: 'SF-5', animalId: gone.id, weightKg: 50, method: 'scale' },
      ],
    });
    expect(bulk.status).toBe(200);
    expect(bulk.data.applied).toBe(2);
    expect(bulk.data.failed).toEqual([
      { code: 'SF-3', error: 'WEIGHT_NOT_PLAUSIBLE' },
      { code: 'SF-4', error: 'WEIGHT_BEFORE_BIRTH' },
      { code: 'SF-5', error: 'ANIMAL_NOT_ON_FARM' },
    ]);
    expect(bulk.data.progress).toMatchObject({ weighed: 2, averageKg: 50.2 });

    const detail = await w.owner.get(url);
    expect(detail.data.entries.map((e: any) => [e.tag, e.weightKg, e.method]).sort()).toEqual([
      ['SF-1', 52.4, 'rfid'],
      ['SF-2', 48, 'scale'],
    ]);
    const card = await w.owner.get(`/livestock/animals/${heavy.id}`);
    expect(card.data.weights).toHaveLength(0);
  });

  it('a shepherd, who may not change the registry, cannot import weights', async () => {
    const w = await makeWorld();
    const a = await animal(w, 'SH-1');
    const campaign = await w.owner.post('/livestock/weighing-campaigns', { herdId: w.herdId, name: 'Kuz' });
    const shepherd = await w.f.as('shepherd');
    const res = await shepherd.post(`/livestock/weighing-campaigns/${campaign.data.id}/entries/bulk`, { entries: [{ code: 'SH-1', animalId: a.id, weightKg: 50 }] });
    expect(res.status).toBe(403);
  });
});
