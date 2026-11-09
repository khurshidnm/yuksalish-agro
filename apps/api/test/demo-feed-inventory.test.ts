/**
 * Fixes before the expert demo: suckling lambs are not fed an adult ration, rations carry dry matter,
 * the farm-wide cost center is never printed as "General", and pasture replaces forage, not grain.
 */
import { addDays, todayIso } from '@yap/shared';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { generalCostCenterId } from '../src/core/costCenters';
import { tx } from '../src/core/context';
import { schema } from '../src/db/client';
import { documentLayout } from '../src/modules/inventory/documents.service';
import { createFixture, type Client, type Fixture } from './helpers';

const { animals, crops, herds, species } = schema;

const TODAY = todayIso();
const daysAgo = (n: number) => addDays(TODAY, -n);

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

async function ration(owner: Client, state: string, lines: { itemId: string; kgPerHeadDay: number }[], name = `R-${state}`) {
  const res = await owner.post('/feed/rations', { name, state, lines });
  expect(res.status).toBe(201);
  return res.data as { id: string; totalDryMatterKg: number | null; lines: { itemId: string; dryMatterKg: number | null }[] };
}

/** A herd with ewes and lambs on the farm. */
async function herdOf(f: Fixture, name: string, rationId: string, counts: { ewe?: number; lamb_male?: number; lamb_female?: number }) {
  return f.run(async () => {
    const [sheep] = await tx().select().from(species).where(sql`key = 'sheep' and tenant_id = ${f.tenantId}`);
    const [herd] = await tx().insert(herds).values({ tenantId: f.tenantId, farmId: f.farmId, name, rationId }).returning();
    const rows = Object.entries(counts).flatMap(([category, n]) =>
      Array.from({ length: n ?? 0 }, () => ({
        tenantId: f.tenantId,
        farmId: f.farmId,
        tag: `T-${Math.random().toString(36).slice(2, 10)}`,
        speciesId: sheep.id,
        sex: category === 'lamb_male' ? 'male' : 'female',
        category,
        origin: category === 'ewe' ? 'purchased' : 'born',
        herdId: herd.id,
      })),
    );
    if (rows.length > 0) await tx().insert(animals).values(rows);
    return herd.id;
  });
}

describe('suckling lambs and the feeding plan', () => {
  let f: Fixture;
  let owner: Client;
  let hay: string;

  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
    const w = await warehouse(owner, 'Ozuqa');
    hay = await item(owner, { name: 'Beda pichani', dryMatterPct: 86 });
    await owner.post('/inventory/receipts', { warehouseId: w, date: daysAgo(3), source: 'opening', lines: [{ itemId: hay, qty: 12_000, unitCost: 2000 }] });
    const ewes = await ration(owner, 'pregnant', [{ itemId: hay, kgPerHeadDay: 2 }]);
    const lambs = await ration(owner, 'lamb', [{ itemId: hay, kgPerHeadDay: 0.5 }]);
    // 10 ewes have lambed in their herd: 4 lambs at foot. A weaned group of 6 lambs eats its own ration.
    await herdOf(f, "Bo'g'oz sovliqlar", ewes.id, { ewe: 10, lamb_male: 2, lamb_female: 2 });
    await herdOf(f, "Qo'zilar", lambs.id, { lamb_male: 3, lamb_female: 3 });
  });

  it('feeds the adult ration to the ewes only, and names the lambs left out', async () => {
    const plan = (await owner.get('/feed/plan')).data;
    const byName = Object.fromEntries(plan.herds.map((h: any) => [h.herdName, h]));
    // 10 ewes × 2 kg = 20 kg, not 14 × 2 = 28 kg.
    expect(byName["Bo'g'oz sovliqlar"]).toMatchObject({ head: 10, lambs: 4, dailyKg: 20 });
    // A lamb ration counts every animal of its herd: 6 × 0.5 = 3 kg.
    expect(byName["Qo'zilar"]).toMatchObject({ head: 6, lambs: 0, dailyKg: 3 });
  });

  it('days of stock follow the same eaters: 12 000 kg / 23 kg a day', async () => {
    const row = (await owner.get('/feed/balance')).data.find((r: any) => r.itemId === hay);
    expect(row.plannedDaily).toBe(23);
    expect(row.daysByPlan).toBe(Math.round((12_000 / 23) * 10) / 10);
  });

  it('the winter plan counts 16 head eating, not 20', async () => {
    const plan = (await owner.get('/feed/winter-plan', { days: 100 })).data;
    expect(plan.head).toBe(16);
    expect(plan.rows[0]).toMatchObject({ dailyKg: 23, requiredKg: 2300 });
  });
});

describe('ration dry matter', () => {
  it('sums dry matter per head, and gives none when a feed lacks its percent', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const hay = await item(owner, { name: 'Beda pichani', dryMatterPct: 86 });
    const silage = await item(owner, { name: "Makkajo'xori silosi", dryMatterPct: 30 });
    const unknown = await item(owner, { name: 'Noma`lum yem' });

    // 1.1 kg hay at 86 % = 0.946 kg, 1 kg silage at 30 % = 0.3 kg: 1.246 kg of dry matter in 2.1 kg as fed.
    const known = await ration(owner, 'pregnant', [
      { itemId: hay, kgPerHeadDay: 1.1 },
      { itemId: silage, kgPerHeadDay: 1 },
    ]);
    expect(known.totalDryMatterKg).toBe(1.246);
    expect(known.lines.find((l) => l.itemId === hay)?.dryMatterKg).toBe(0.946);

    const partial = await ration(owner, 'lactating', [
      { itemId: hay, kgPerHeadDay: 1 },
      { itemId: unknown, kgPerHeadDay: 0.5 },
    ]);
    expect(partial.totalDryMatterKg).toBeNull();
    expect(partial.lines.find((l) => l.itemId === unknown)?.dryMatterKg).toBeNull();

    // The shepherd sees the ration's dry matter: it is not money.
    const seen = (await (await f.as('shepherd')).get(`/feed/rations/${known.id}`)).data;
    expect(seen.totalDryMatterKg).toBe(1.246);
  });
});

describe('the farm-wide cost center on movements and paper', () => {
  it('tells the screen its type, and prints it translated with the currency in words', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Ozuqa');
    const hay = await item(owner, { name: 'Beda pichani' });
    await owner.post('/inventory/receipts', { warehouseId: w, date: daysAgo(2), source: 'opening', lines: [{ itemId: hay, qty: 100, unitCost: 2000 }] });
    const general = await f.run(() => generalCostCenterId());
    const res = await owner.post('/inventory/issues', { warehouseId: w, date: TODAY, costCenterId: general, reason: 'ration', lines: [{ itemId: hay, qty: 10 }] });
    expect(res.status).toBe(201);

    const [move] = (await owner.get('/inventory/movements', { type: 'issue' })).data;
    expect(move).toMatchObject({ costCenterName: 'General', costCenterType: 'general', reason: 'ration' });

    const uz = await f.run(() => documentLayout(res.data.docNo, 'uz'));
    expect(Object.fromEntries(uz.details)).toMatchObject({ 'Xarajat markazi': 'Umumiy ferma', Maqsad: "Ratsion bo'yicha" });
    expect(uz.footer?.[0]).toMatch(/^Jami: 20.000 so'm$/);

    const ru = await f.run(() => documentLayout(res.data.docNo, 'ru'));
    expect(Object.fromEntries(ru.details)['Центр затрат']).toBe('Общефермские');
    expect(ru.footer?.[0]).toMatch(/сум$/);
    expect(JSON.stringify([uz, ru])).not.toContain('General');
  });
});

describe('pasture replaces forage, not grain', () => {
  it('halves straw in the grazing months but never the feed grain of the same crop', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const w = await warehouse(owner, 'Ozuqa');
    const wheat = await f.run(async () => {
      const [row] = await tx().select().from(crops).where(sql`key = 'wheat' and tenant_id = ${f.tenantId}`);
      return row.id;
    });
    const grain = await item(owner, { name: "Bug'doy (yem)", dryMatterPct: 87, cropId: wheat });
    const straw = await item(owner, { name: 'Somon', dryMatterPct: 88, cropId: wheat });
    await owner.post('/inventory/receipts', {
      warehouseId: w,
      date: daysAgo(2),
      source: 'opening',
      lines: [
        { itemId: grain, qty: 1000, unitCost: 3800 },
        { itemId: straw, qty: 1000, unitCost: 800 },
      ],
    });
    const r = await ration(owner, 'pregnant', [
      { itemId: grain, kgPerHeadDay: 1 },
      { itemId: straw, kgPerHeadDay: 1 },
    ]);
    await herdOf(f, 'Sovliqlar', r.id, { ewe: 10 });

    const { data } = await owner.get('/dashboard/outlook');
    const months: string[] = data.months;
    const days = (month: string) => {
      const [y, m] = month.split('-').map(Number);
      const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return month === months[0] ? inMonth - Number(TODAY.slice(8, 10)) + 1 : inMonth;
    };
    const grazing = (month: string) => ['04', '05', '06', '07', '08', '09', '10'].includes(month.slice(5));
    // 10 ewes × 1 kg a day, every day of the horizon; straw at half in April to October.
    const grainNeed = months.reduce((sum, month) => sum + 10 * days(month), 0);
    const strawNeed = months.reduce((sum, month) => sum + 10 * days(month) * (grazing(month) ? 0.5 : 1), 0);

    const byItem = Object.fromEntries(data.feed.map((row: any) => [row.itemId, row]));
    expect(byItem[grain].needKg).toBe(Math.round(grainNeed));
    expect(byItem[straw].needKg).toBe(Math.round(strawNeed));
  });
});
