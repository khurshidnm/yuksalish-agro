/**
 * Ration balancing by nutrients and the least-cost mix.
 *
 * Feed composition is the typical values of `TYPICAL_FEEDS` (Feedipedia); requirements are NRC 1985,
 * Table 1. Every control number below is worked by hand from those two.
 */
import { addDays, todayIso } from '@yap/shared';
import { TYPICAL_FEEDS } from '@yap/shared/formulas/nutrition';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { tx } from '../src/core/context';
import { schema } from '../src/db/client';
import { createFixture, type Client, type Fixture } from './helpers';

const { animals, herds, species } = schema;

const DATE = addDays(todayIso(), -3);

async function warehouse(owner: Client, name: string) {
  const res = await owner.post('/inventory/warehouses', { name, type: 'feed' });
  expect(res.status).toBe(201);
  return res.data.id as string;
}

async function item(owner: Client, body: Record<string, unknown>) {
  const res = await owner.post('/inventory/items', { category: 'feed', unit: 'kg', ...body });
  expect(res.status).toBe(201);
  return res.data.id as string;
}

async function receive(owner: Client, warehouseId: string, lines: { itemId: string; qty: number; unitCost: number }[]) {
  const res = await owner.post('/inventory/receipts', { warehouseId, date: DATE, source: 'opening', lines });
  expect(res.status).toBe(201);
}

async function ration(owner: Client, state: string, lines: { itemId: string; kgPerHeadDay: number }[], name: string) {
  const res = await owner.post('/feed/rations', { name, state, lines });
  expect(res.status).toBe(201);
  return res.data.id as string;
}

interface Group {
  species?: string;
  category: string;
  count: number;
  weightKg?: number;
}

/** A herd on a ration, with animals of the given weights. */
async function herdOf(f: Fixture, name: string, rationId: string | null, groups: Group[]) {
  return f.run(async () => {
    const kinds = await tx().select().from(species).where(sql`tenant_id = ${f.tenantId}`);
    const [herd] = await tx().insert(herds).values({ tenantId: f.tenantId, farmId: f.farmId, name, rationId }).returning();
    const rows = groups.flatMap((g) =>
      Array.from({ length: g.count }, () => ({
        tenantId: f.tenantId,
        farmId: f.farmId,
        tag: `T-${Math.random().toString(36).slice(2, 10)}`,
        speciesId: kinds.find((k) => k.key === (g.species ?? 'sheep'))!.id,
        sex: g.category === 'lamb_male' ? 'male' : 'female',
        category: g.category,
        origin: 'purchased',
        herdId: herd.id,
        currentWeightKg: g.weightKg ?? null,
      })),
    );
    if (rows.length > 0) await tx().insert(animals).values(rows);
    return herd.id;
  });
}

const line = (data: any, herdId: string, nutrient: string) =>
  data.herds.find((h: any) => h.herdId === herdId).lines.find((l: any) => l.nutrient === nutrient);

describe('nutrient content on feed items', () => {
  it('stores the figures, returns them, and clears one back to unknown', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const id = await item(owner, { name: 'Beda pichani', ...TYPICAL_FEEDS.lucerne_hay });

    const listed = (await owner.get('/inventory/items', { search: 'Beda' })).data.find((r: any) => r.id === id);
    expect(listed).toMatchObject({ dryMatterPct: 89.4, meMjPerKgDm: 8.4, crudeProteinPctDm: 18.2, calciumGPerKgDm: 16.8, phosphorusGPerKgDm: 2.6, isRoughage: true });

    const patched = await owner.patch(`/inventory/items/${id}`, { meMjPerKgDm: 9.1, phosphorusGPerKgDm: null });
    expect(patched.status).toBe(200);
    const one = (await owner.get(`/inventory/items/${id}`)).data;
    expect(one.meMjPerKgDm).toBe(9.1);
    expect(one.phosphorusGPerKgDm).toBeNull();
    expect(one.crudeProteinPctDm).toBe(18.2);

    // Unknown stays null, never 0.
    const bare = await item(owner, { name: "Noma'lum yem" });
    const bareRow = (await owner.get(`/inventory/items/${bare}`)).data;
    expect([bareRow.meMjPerKgDm, bareRow.crudeProteinPctDm, bareRow.calciumGPerKgDm, bareRow.phosphorusGPerKgDm, bareRow.isRoughage]).toEqual([null, null, null, null, null]);

    const wrong = await owner.post('/inventory/items', { category: 'feed', unit: 'kg', name: 'Xato', crudeProteinPctDm: 140 });
    expect(wrong.status).toBe(400);
  });
});

describe('ration balance by nutrients', () => {
  let f: Fixture;
  let owner: Client;
  let hay: string;
  let barley: string;
  let unknown: string;
  let pregnant: string;
  let ewes: string;

  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
    hay = await item(owner, { name: 'Beda pichani', ...TYPICAL_FEEDS.lucerne_hay });
    barley = await item(owner, { name: 'Arpa', ...TYPICAL_FEEDS.barley_grain });
    unknown = await item(owner, { name: "Noma'lum yem", dryMatterPct: 88 });
    pregnant = await ration(owner, 'pregnant', [
      { itemId: hay, kgPerHeadDay: 1.5 },
      { itemId: barley, kgPerHeadDay: 0.4 },
    ], "Bo'g'oz sovliqlar ratsioni");
    // 6 ewes of 68 kg and 4 of 73 kg: 700 kg over 10 weighed head = 70.0 kg. Two more were never
    // weighed. The three lambs at foot do not eat the ewes' ration and do not pull the average down.
    ewes = await herdOf(f, "Bo'g'oz sovliqlar", pregnant, [
      { category: 'ewe', count: 6, weightKg: 68 },
      { category: 'ewe', count: 4, weightKg: 73 },
      { category: 'ewe', count: 2 },
      { category: 'lamb_female', count: 3, weightKg: 12 },
    ]);
  });

  it('gives supply against requirement for a seeded ration', async () => {
    const res = await owner.get(`/feed/rations/${pregnant}/nutrients`);
    expect(res.status).toBe(200);
    const data = res.data;

    // Hay 1.5 kg × 89.4 % = 1.341 kg DM; barley 0.4 kg × 87.1 % = 0.3484 kg DM; 1.6894 kg together.
    // ME 1.341 × 8.4 + 0.3484 × 12.4 = 11.2644 + 4.32016 = 15.58456 MJ.
    // Protein 1.341 × 182 + 0.3484 × 118 = 244.062 + 41.1112 = 285.1732 g.
    // Ca 1.341 × 16.8 + 0.3484 × 0.8 = 22.80752 g. P 1.341 × 2.6 + 0.3484 × 3.9 = 4.84536 g.
    expect(data.supply).toEqual({ dryMatter: 1.689, energy: 15.58, protein: 285.2, calcium: 22.81, phosphorus: 4.85 });
    // Roughage 1.341 of 1.6894 kg DM.
    expect(data.roughageSharePct).toBe(79.4);
    expect(data.missing).toEqual([]);
    expect(data).toMatchObject({ state: 'pregnant', stage: 'late', litter: 1 });

    expect(data.herds).toHaveLength(1);
    const herd = data.herds[0];
    expect(herd).toMatchObject({ herdId: ewes, species: 'sheep', head: 12, weighedHead: 10, avgWeightKg: 70, reason: null });
    // NRC 1985 Table 1, last 4 weeks of gestation, 130-150 % lambing rate, 70 kg:
    // 1.8 kg DM, 3.8 Mcal ME (× 4.184 = 15.8992 MJ), 193 g protein, 6.2 g Ca, 5.6 g P.
    expect(herd.requirement).toMatchObject({ dryMatterKg: 1.8, meMj: 15.9, crudeProteinG: 193, calciumG: 6.2, phosphorusG: 5.6, weightUsedKg: 70, weightClamped: false, rows: ['late_pregnancy_1'] });

    // 1.6894 / 1.8 = 93.9 %; 15.58456 / 15.8992 = 98.0 %; 285.1732 / 193 = 147.8 %;
    // 22.80752 / 6.2 = 367.9 %; 4.84536 / 5.6 = 86.5 %.
    expect(herd.lines).toEqual([
      { nutrient: 'dryMatter', supply: 1.689, requirement: 1.8, coveredPct: 93.9, flag: 'enough' },
      { nutrient: 'energy', supply: 15.58, requirement: 15.9, coveredPct: 98, flag: 'enough' },
      { nutrient: 'protein', supply: 285.2, requirement: 193, coveredPct: 147.8, flag: 'over' },
      { nutrient: 'calcium', supply: 22.81, requirement: 6.2, coveredPct: 367.9, flag: 'over' },
      { nutrient: 'phosphorus', supply: 4.85, requirement: 5.6, coveredPct: 86.5, flag: 'short' },
    ]);
  });

  it('reads other rows of the table when the stage or the litter is said', async () => {
    // First 15 weeks of gestation, 70 kg: 1.4 kg DM, 2.8 Mcal = 11.7152 MJ, 130 g, 3.5 g, 2.9 g.
    const early = (await owner.get(`/feed/rations/${pregnant}/nutrients`, { stage: 'early' })).data;
    expect(early).toMatchObject({ stage: 'early', litter: null });
    expect(early.herds[0].requirement).toMatchObject({ dryMatterKg: 1.4, meMj: 11.72, crudeProteinG: 130, calciumG: 3.5, phosphorusG: 2.9 });
    // 15.58456 / 11.7152 = 133.0 %: over. Dry matter 1.6894 / 1.4 = 120.7 %: more than she will eat.
    expect(line(early, ewes, 'energy')).toMatchObject({ coveredPct: 133, flag: 'over' });
    expect(line(early, ewes, 'dryMatter')).toMatchObject({ coveredPct: 120.7, flag: 'over' });

    // Last 4 weeks, 180-225 % lambing rate, 70 kg: 1.9 kg DM, 4.4 Mcal = 18.4096 MJ, 214 g, 7.6 g, 4.5 g.
    const twins = (await owner.get(`/feed/rations/${pregnant}/nutrients`, { litter: 2 })).data;
    expect(twins.herds[0].requirement).toMatchObject({ dryMatterKg: 1.9, meMj: 18.41, crudeProteinG: 214, calciumG: 7.6, phosphorusG: 4.5, rows: ['late_pregnancy_2'] });
    // 15.58456 / 18.4096 = 84.7 %: short.
    expect(line(twins, ewes, 'energy')).toMatchObject({ coveredPct: 84.7, flag: 'short' });

    expect((await owner.get(`/feed/rations/${pregnant}/nutrients`, { litter: 3 })).status).toBe(400);
  });

  it('previews lines that are not saved yet against the herds of the ration being edited', async () => {
    // Hay alone, 2 kg: 1.788 kg DM, 15.0192 MJ, 325.416 g protein, 30.0384 g Ca, 4.6488 g P.
    const res = await owner.post('/feed/nutrient-balance', { rationId: pregnant, state: 'pregnant', lines: [{ itemId: hay, kgPerHeadDay: 2 }] });
    expect(res.status).toBe(200);
    expect(res.data.supply).toEqual({ dryMatter: 1.788, energy: 15.02, protein: 325.4, calcium: 30.04, phosphorus: 4.65 });
    expect(res.data.roughageSharePct).toBe(100);
    // 15.0192 / 15.8992 = 94.5 %: just short.
    expect(line(res.data, ewes, 'energy')).toMatchObject({ coveredPct: 94.5, flag: 'short' });

    // A new ration feeds no herd yet: the supply is shown, with no herd to set a requirement by.
    const fresh = (await owner.post('/feed/nutrient-balance', { state: 'lactating', lines: [{ itemId: hay, kgPerHeadDay: 2 }] })).data;
    expect(fresh.herds).toEqual([]);
    expect(fresh.supply.energy).toBe(15.02);
    expect(fresh).toMatchObject({ state: 'lactating', stage: null, litter: 1 });

    // Nothing was saved.
    const saved = (await owner.get(`/feed/rations/${pregnant}`)).data;
    expect(saved.lines).toHaveLength(2);
  });

  it('leaves a nutrient null when a feed has no figure for it, and names the feed and the figure', async () => {
    const partial = await ration(owner, 'maintenance', [
      { itemId: hay, kgPerHeadDay: 1 },
      { itemId: unknown, kgPerHeadDay: 0.5 },
    ], 'Chala ratsion');
    const herd = await herdOf(f, 'Qisir sovliqlar', partial, [{ category: 'ewe', count: 5, weightKg: 60 }]);
    const data = (await owner.get(`/feed/rations/${partial}/nutrients`)).data;

    // Dry matter is known for both: 0.894 + 0.44 = 1.334 kg. Nothing else can be summed.
    expect(data.supply).toEqual({ dryMatter: 1.334, energy: null, protein: null, calcium: null, phosphorus: null });
    expect(data.roughageSharePct).toBeNull();
    expect(data.missing).toEqual([
      { itemId: unknown, itemName: "Noma'lum yem", fields: ['meMjPerKgDm', 'crudeProteinPctDm', 'calciumGPerKgDm', 'phosphorusGPerKgDm'] },
    ]);
    // Maintenance, 60 kg: 1.1 kg DM, 2.2 Mcal = 9.2048 MJ, 104 g, 2.3 g, 2.1 g. The requirement is
    // known; what cannot be compared carries no percent and no flag.
    expect(line(data, herd, 'dryMatter')).toEqual({ nutrient: 'dryMatter', supply: 1.334, requirement: 1.1, coveredPct: 121.3, flag: 'over' });
    expect(line(data, herd, 'energy')).toEqual({ nutrient: 'energy', supply: null, requirement: 9.2, coveredPct: null, flag: null });
    expect(line(data, herd, 'phosphorus')).toEqual({ nutrient: 'phosphorus', supply: null, requirement: 2.1, coveredPct: null, flag: null });
  });

  it('gives no requirement without a weight, for an empty herd, for goats and for a mixed herd, and says why', async () => {
    const lactating = await ration(owner, 'lactating', [{ itemId: hay, kgPerHeadDay: 2 }], "Sog'in sovliqlar ratsioni");
    const unweighed = await herdOf(f, 'Tortilmagan', lactating, [{ category: 'ewe', count: 4 }]);
    const empty = await herdOf(f, "Bo'sh", lactating, []);
    const goats = await herdOf(f, 'Echkilar', lactating, [{ species: 'goat', category: 'ewe', count: 3, weightKg: 45 }]);
    const mixed = await herdOf(f, 'Aralash', lactating, [
      { category: 'ewe', count: 2, weightKg: 60 },
      { species: 'goat', category: 'ewe', count: 1, weightKg: 45 },
    ]);
    // Light ewes: 45 kg is below the table's first row, so the 50 kg row is read and the answer says so.
    const light = await herdOf(f, 'Yengil', lactating, [{ category: 'ewe', count: 2, weightKg: 45 }]);

    const data = (await owner.get(`/feed/rations/${lactating}/nutrients`)).data;
    const of = (id: string) => data.herds.find((h: any) => h.herdId === id);

    expect(of(unweighed)).toMatchObject({ head: 4, weighedHead: 0, avgWeightKg: null, reason: 'no_weight', requirement: null });
    expect(of(empty)).toMatchObject({ head: 0, avgWeightKg: null, reason: 'no_animals', requirement: null });
    expect(of(goats)).toMatchObject({ species: 'goat', avgWeightKg: 45, reason: 'species_not_covered', requirement: null });
    expect(of(mixed)).toMatchObject({ species: null, head: 3, reason: 'mixed_species', requirement: null });
    for (const id of [unweighed, empty, goats, mixed]) {
      // The supply is still there; the comparison is not, and it is not a zero.
      expect(line(data, id, 'energy')).toEqual({ nutrient: 'energy', supply: 15.02, requirement: null, coveredPct: null, flag: null });
    }

    // First 6-8 weeks of lactation, singles, 50 kg: 2.1 kg DM, 4.9 Mcal = 20.5016 MJ, 304 g, 8.9 g, 6.1 g.
    expect(of(light)).toMatchObject({ avgWeightKg: 45, reason: null });
    expect(of(light).requirement).toMatchObject({ weightUsedKg: 50, weightClamped: true, dryMatterKg: 2.1, meMj: 20.5, crudeProteinG: 304, calciumG: 8.9, phosphorusG: 6.1 });
  });

  it('is readable with feed.view and carries no money', async () => {
    const shepherd = await f.as('shepherd');
    const res = await shepherd.get(`/feed/rations/${pregnant}/nutrients`);
    expect(res.status).toBe(200);
    expect(res.data.herds[0].lines).toHaveLength(5);
    expect(JSON.stringify(res.data)).not.toMatch(/cost|price/i);

    const preview = await shepherd.post('/feed/nutrient-balance', { state: 'pregnant', lines: [{ itemId: hay, kgPerHeadDay: 2 }] });
    expect(preview.status).toBe(200);

    // The mechanic has no feed.view.
    const mechanic = await f.as('mechanic');
    expect((await mechanic.get(`/feed/rations/${pregnant}/nutrients`)).status).toBe(403);
  });

  it('does not show another tenant its rations or count its feeds', async () => {
    const other = await createFixture();
    const stranger = await other.as('owner');
    expect((await stranger.get(`/feed/rations/${pregnant}/nutrients`)).status).toBe(404);
    expect((await stranger.post('/feed/nutrient-balance', { state: 'pregnant', lines: [{ itemId: hay, kgPerHeadDay: 2 }] })).status).toBe(404);

    // Their own feed, with our ration id: the id is not theirs, so no herd of ours comes back.
    const theirs = await item(stranger, { name: 'Somon', ...TYPICAL_FEEDS.cereal_straw });
    const res = await stranger.post('/feed/nutrient-balance', { rationId: pregnant, state: 'pregnant', lines: [{ itemId: theirs, kgPerHeadDay: 1 }] });
    expect(res.status).toBe(200);
    expect(res.data.herds).toEqual([]);
  });
});

describe('least-cost mix', () => {
  let f: Fixture;
  let owner: Client;
  let hay: string;
  let straw: string;
  let barley: string;
  let bare: string;
  let herd: string;

  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
    const w = await warehouse(owner, 'Ozuqa');
    hay = await item(owner, { name: 'Beda pichani', ...TYPICAL_FEEDS.lucerne_hay });
    straw = await item(owner, { name: 'Somon', ...TYPICAL_FEEDS.cereal_straw });
    barley = await item(owner, { name: 'Arpa', ...TYPICAL_FEEDS.barley_grain });
    bare = await item(owner, { name: "Noma'lum yem", dryMatterPct: 88 });
    await receive(owner, w, [
      { itemId: hay, qty: 50_000, unitCost: 1500 },
      { itemId: straw, qty: 20_000, unitCost: 300 },
      { itemId: barley, qty: 10_000, unitCost: 2800 },
    ]);
    const current = await ration(owner, 'pregnant', [{ itemId: hay, kgPerHeadDay: 2 }], 'Hozirgi');
    herd = await herdOf(f, "Bo'g'oz sovliqlar", current, [{ category: 'ewe', count: 20, weightKg: 70 }]);
  });

  it('finds the cheapest mix of lucerne hay and barley for a 70 kg ewe in late pregnancy', async () => {
    const res = await owner.post('/feed/least-cost-mix', { state: 'pregnant', weightKg: 70, feeds: [{ itemId: hay }, { itemId: barley }] });
    expect(res.status).toBe(200);
    const data = res.data;
    expect(data.status).toBe('optimal');
    expect(data).toMatchObject({ herd: null, state: 'pregnant', stage: 'late', litter: 1, weightKg: 70, minRoughageSharePct: 50, missing: [], shortfalls: [] });

    // Need: at most 1.8 kg DM; at least 15.8992 MJ, 193 g protein, 6.2 g Ca, 5.6 g P; half the DM roughage.
    // In kg of dry matter, H of hay and B of barley. Phosphorus is the tight one: 2.6 H + 3.9 B ≥ 5.6.
    // Hay gives phosphorus cheaper (2.6 g for 1500 / 0.894 = 1678 a kg DM, against 3.9 g for
    // 2800 / 0.871 = 3215), but hay alone would need 5.6 / 2.6 = 2.154 kg DM, over the 1.8 she eats.
    // So the intake limit and phosphorus both hold: H + B = 1.8 and 2.6 H + 3.9 B = 5.6
    //   → B = (5.6 − 4.68) / 1.3 = 0.70769, H = 1.09231.
    // Energy there 8.4 × 1.09231 + 12.4 × 0.70769 = 17.95 MJ and protein 198.8 + 83.5 = 282.3 g: both met.
    // As fed: hay 1.09231 / 0.894 = 1.2218 kg, barley 0.70769 / 0.871 = 0.8125 kg.
    // Cost 1.2218 × 1500 + 0.8125 × 2800 = 1832.7 + 2275.0 = 4107.7 a head a day.
    const byItem = Object.fromEntries(data.lines.map((l: any) => [l.itemId, l]));
    expect(Math.abs(byItem[hay].kgPerHeadDay - 1.2218)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(byItem[barley].kgPerHeadDay - 0.8125)).toBeLessThanOrEqual(0.001);
    expect(byItem[hay]).toMatchObject({ itemName: 'Beda pichani', isRoughage: true, unitCostPerKg: 1500 });
    expect(byItem[barley]).toMatchObject({ isRoughage: false, unitCostPerKg: 2800 });
    expect(Math.abs(data.costPerHeadDay - 4107.7)).toBeLessThanOrEqual(3);
    // The season is the tenant's winter length, 120 days by default.
    expect(data.seasonDays).toBe(120);
    expect(data.costPerSeason).toBeCloseTo(data.costPerHeadDay * 120, 1);
    // Roughage 1.09231 of 1.8 kg DM = 60.7 %.
    expect(data.roughageSharePct).toBeCloseTo(60.7, 0);

    const balance = Object.fromEntries(data.balance.map((l: any) => [l.nutrient, l]));
    expect(balance.dryMatter.coveredPct).toBeCloseTo(100, 0);
    expect(balance.phosphorus.coveredPct).toBeCloseTo(100, 0);
    expect(balance.energy.coveredPct).toBeCloseTo(112.9, 0);
    expect(balance.protein.coveredPct).toBeCloseTo(146.3, 0);
    for (const l of data.balance) expect(l.flag).not.toBe('short');
  });

  it('takes the weight and the state from a herd, and the mix saves as a ration that balances', async () => {
    const res = await owner.post('/feed/least-cost-mix', { herdId: herd, feeds: [{ itemId: hay }, { itemId: barley }, { itemId: straw }] });
    expect(res.status).toBe(200);
    const data = res.data;
    expect(data.status).toBe('optimal');
    expect(data.herd).toMatchObject({ herdId: herd, species: 'sheep', head: 20, weighedHead: 20, avgWeightKg: 70 });
    expect(data).toMatchObject({ state: 'pregnant', weightKg: 70 });
    // With straw on offer too the mix can only get cheaper or stay, never dearer, than hay and barley.
    expect(data.costPerHeadDay).toBeLessThanOrEqual(4107.7 + 3);

    // Saving goes through the ration service, as the button does.
    const saved = await owner.post('/feed/rations', {
      name: 'Eng arzon aralashma',
      state: data.state,
      lines: data.lines.map((l: any) => ({ itemId: l.itemId, kgPerHeadDay: l.kgPerHeadDay })),
    });
    expect(saved.status).toBe(201);
    await f.run(async () => {
      await tx().update(herds).set({ rationId: saved.data.id }).where(sql`id = ${herd}`);
    });
    const balance = (await owner.get(`/feed/rations/${saved.data.id}/nutrients`)).data;
    expect(balance.herds).toHaveLength(1);
    for (const l of balance.herds[0].lines) {
      expect(l.flag).not.toBe('short');
      if (l.nutrient !== 'dryMatter') expect(l.coveredPct).toBeGreaterThanOrEqual(99.9);
    }
    expect(line(balance, herd, 'dryMatter').coveredPct).toBeLessThanOrEqual(100.1);
  });

  it('respects a maximum on one feed', async () => {
    // Barley held to 0.5 kg (0.4355 kg DM): phosphorus then needs (5.6 − 3.9 × 0.4355) / 2.6 = 1.5006 kg
    // DM of hay, 1.9361 kg DM in all, over the 1.8 she eats. No mix.
    const res = await owner.post('/feed/least-cost-mix', {
      state: 'pregnant',
      weightKg: 70,
      feeds: [{ itemId: hay }, { itemId: barley, maxKgPerHeadDay: 0.5 }],
    });
    expect(res.data.status).toBe('infeasible');
    // Most phosphorus within the limits: 0.4355 × 3.9 + (1.8 − 0.4355) × 2.6 = 1.69845 + 3.5477 = 5.25 g.
    expect(res.data.shortfalls).toEqual([{ nutrient: 'phosphorus', required: 5.6, best: 5.25, alone: true }]);
  });

  it('says plainly when no mix can meet the requirement, and which requirement fails', async () => {
    const res = await owner.post('/feed/least-cost-mix', { state: 'pregnant', weightKg: 70, feeds: [{ itemId: straw }, { itemId: barley }] });
    expect(res.status).toBe(200);
    const data = res.data;
    expect(data.status).toBe('infeasible');
    expect(data.lines).toEqual([]);
    expect(data.costPerHeadDay).toBeNull();
    expect(data.costPerSeason).toBeNull();
    // Half the 1.8 kg of dry matter must be straw. The most protein is then 0.9 × 42 + 0.9 × 118 = 144 g
    // of 193, and the most phosphorus 0.9 × 0.7 + 0.9 × 3.9 = 4.14 g of 5.6. Energy can be met:
    // 0.9 × 6.8 + 0.9 × 12.4 = 17.28 MJ of 15.9. Calcium too: all straw gives 1.8 × 4.8 = 8.64 g of 6.2.
    expect(data.shortfalls).toEqual([
      { nutrient: 'protein', required: 193, best: 144, alone: true },
      { nutrient: 'phosphorus', required: 5.6, best: 4.14, alone: true },
    ]);
  });

  it('does not guess when a candidate lacks its composition or a price', async () => {
    const res = await owner.post('/feed/least-cost-mix', { state: 'pregnant', weightKg: 70, feeds: [{ itemId: hay }, { itemId: bare }] });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('missing_data');
    expect(res.data.lines).toEqual([]);
    expect(res.data.costPerHeadDay).toBeNull();
    expect(res.data.missing).toEqual([
      { itemId: bare, itemName: "Noma'lum yem", fields: ['meMjPerKgDm', 'crudeProteinPctDm', 'calciumGPerKgDm', 'phosphorusGPerKgDm', 'isRoughage', 'price'] },
    ]);
  });

  it('has no requirement to mix for when the herd has no weights', async () => {
    const unweighed = await herdOf(f, 'Tortilmagan', null, [{ category: 'ewe', count: 3 }]);
    const res = await owner.post('/feed/least-cost-mix', { herdId: unweighed, state: 'pregnant', feeds: [{ itemId: hay }, { itemId: barley }] });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ status: 'no_requirement', reason: 'no_weight', requirement: null, weightKg: null, lines: [] });

    // A weight typed in stands in for the missing ones.
    const typed = await owner.post('/feed/least-cost-mix', { herdId: unweighed, state: 'pregnant', weightKg: 70, feeds: [{ itemId: hay }, { itemId: barley }] });
    expect(typed.data.status).toBe('optimal');
  });

  it('refuses a request that names neither a herd nor a state and a weight', async () => {
    expect((await owner.post('/feed/least-cost-mix', { feeds: [{ itemId: hay }] })).status).toBe(400);
    expect((await owner.post('/feed/least-cost-mix', { state: 'pregnant', feeds: [{ itemId: hay }] })).status).toBe(400);
    const twice = await owner.post('/feed/least-cost-mix', { state: 'pregnant', weightKg: 70, feeds: [{ itemId: hay }, { itemId: hay }] });
    expect(twice.status).toBe(400);
    expect(twice.body.error.code).toBe('DUPLICATE_RATION_ITEM');
  });

  it('is only for people who may see feed cost', async () => {
    const body = { state: 'pregnant', weightKg: 70, feeds: [{ itemId: hay }, { itemId: barley }] };
    // feed.view without feed.approve and without finance.view.
    for (const role of ['shepherd', 'storekeeper', 'veterinarian', 'agronomist'] as const) {
      const res = await (await f.as(role)).post('/feed/least-cost-mix', body);
      expect(res.status, role).toBe(403);
      expect(JSON.stringify(res.body), role).not.toMatch(/1500|2800|costPer/);
    }
    // The zootechnician runs the feed module; the accountant sees all money.
    for (const role of ['zootechnician', 'accountant'] as const) {
      const res = await (await f.as(role)).post('/feed/least-cost-mix', body);
      expect(res.status, role).toBe(200);
      expect(res.data.status, role).toBe('optimal');
    }
  });

  it("does not mix another tenant's feeds or read its herds", async () => {
    const other = await createFixture();
    const stranger = await other.as('owner');
    const mine = await item(stranger, { name: 'Somon', ...TYPICAL_FEEDS.cereal_straw });
    expect((await stranger.post('/feed/least-cost-mix', { state: 'pregnant', weightKg: 70, feeds: [{ itemId: hay }] })).status).toBe(404);
    expect((await stranger.post('/feed/least-cost-mix', { herdId: herd, feeds: [{ itemId: mine }] })).status).toBe(404);
  });
});
