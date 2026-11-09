/**
 * The farm-wide crop plan and the ration saving, as an agronomist and a zootechnician would read them:
 * no farm put under one crop, no premix swapped for straw, and each reader's own language.
 */
import { and, eq } from 'drizzle-orm';
import { ROLE_KEYS, addDays, todayIso, type RoleKey } from '@yap/shared';
import { resources } from '@yap/shared/i18n';
import { describe, expect, it } from 'vitest';
import { tx } from '../src/core/context';
import { ensureCostCenter } from '../src/core/costCenters';
import { receiveStock } from '../src/core/inventory';
import { schema } from '../src/db/client';
import { runStatistics } from '../src/modules/ai/analysis';
import { aiText } from '../src/modules/ai/render';
import { seedAssets } from '../src/seed/assets';
import { seedCrops } from '../src/seed/crops';
import { seedFinance } from '../src/seed/finance';
import { seedFinanceBase } from '../src/seed/finance-base';
import { seedHr, seedPayroll } from '../src/seed/hr';
import { seedInventory } from '../src/seed/inventory';
import { seedLand } from '../src/seed/land';
import { seedLivestock } from '../src/seed/livestock';
import { seedSales } from '../src/seed/sales';
import type { SeedContext } from '../src/seed/types';
import { seedVet } from '../src/seed/vet';
import { createFixture, type Fixture } from './helpers';

const today = todayIso();
const base = (f: Fixture) => ({ tenantId: f.tenantId, farmId: f.farmId });

function insightsOf(f: Fixture, type: string) {
  return f.run(() =>
    tx()
      .select()
      .from(schema.aiInsights)
      .where(and(eq(schema.aiInsights.farmId, f.farmId), eq(schema.aiInsights.type, type))),
  );
}

async function makeHerd(f: Fixture, head: number) {
  return f.run(async () => {
    const [species] = await tx().select().from(schema.species).where(eq(schema.species.key, 'sheep'));
    const [herd] = await tx().insert(schema.herds).values({ ...base(f), name: `Poda ${head}`, state: 'pregnant' }).returning();
    const costCenterId = await ensureCostCenter('herd', herd.id, herd.name);
    await tx().update(schema.herds).set({ costCenterId }).where(eq(schema.herds.id, herd.id));
    await tx()
      .insert(schema.animals)
      .values(
        Array.from({ length: head }, (_, i) => ({
          ...base(f),
          tag: `D-${String(i + 1).padStart(4, '0')}`,
          speciesId: species.id,
          sex: 'female',
          category: 'ewe',
          origin: 'purchased',
          purchaseDate: addDays(today, -90),
          purchasePrice: 4_000_000,
          herdId: herd.id,
          status: 'active',
        })),
      );
    return herd.id;
  });
}

/** A ration of these feeds, kg a head a day, fed to the herd. Stock is received at `cost` when given. */
async function feedHerd(
  f: Fixture,
  herdId: string,
  feeds: { name: string; kg: number; dryMatterPct?: number; cost?: number; cropId?: string; transferPrice?: number }[],
) {
  await f.run(async () => {
    const [warehouse] = await tx().insert(schema.warehouses).values({ ...base(f), name: 'Ozuqa ombori', type: 'feed' }).returning();
    const [ration] = await tx().insert(schema.rations).values({ ...base(f), name: "Bo'g'oz sovliqlar ratsioni", state: 'pregnant' }).returning();
    for (const feed of feeds) {
      const [item] = await tx()
        .insert(schema.items)
        .values({
          ...base(f),
          name: feed.name,
          category: 'feed',
          unit: 'kg',
          dryMatterPct: feed.dryMatterPct,
          cropId: feed.cropId,
          transferPrice: feed.transferPrice,
        })
        .returning();
      await tx().insert(schema.rationLines).values({ ...base(f), rationId: ration.id, itemId: item.id, kgPerHeadDay: feed.kg });
      if (feed.cost !== undefined) {
        await receiveStock({ itemId: item.id, warehouseId: warehouse.id, qty: 50_000, unitCost: feed.cost, date: today, source: 'opening' });
      }
    }
    await tx().update(schema.herds).set({ rationId: ration.id }).where(eq(schema.herds.id, herdId));
  });
}

describe('crop suggestion for the whole farm', () => {
  /**
   * Five fields: wheat on 1 and 2 and barley on 3 this season, a perennial alfalfa stand on 4, and silage
   * corn already planned on 5 for a season still to start. Alfalfa pays most per hectare.
   */
  async function farm(f: Fixture) {
    return f.run(async () => {
      const cropRows = await tx().select().from(schema.crops).where(eq(schema.crops.tenantId, f.tenantId));
      const crop = (key: string) => cropRows.find((c) => c.key === key)!.id;
      const [current] = await tx()
        .insert(schema.seasons)
        .values({ ...base(f), name: 'Kuzgi', kind: 'autumn', startDate: addDays(today, -60), endDate: addDays(today, 240), isCurrent: true })
        .returning();
      const [next] = await tx()
        .insert(schema.seasons)
        .values({ ...base(f), name: 'Yozgi', kind: 'summer', startDate: addDays(today, 150), endDate: addDays(today, 330) })
        .returning();
      const plan = async (number: string, areaHa: number, seasonId: string, key: string, yieldTHa: number, cost: number) => {
        const [field] = await tx().insert(schema.fields).values({ ...base(f), number, areaHa }).returning();
        await tx()
          .insert(schema.cropPlans)
          .values({ ...base(f), seasonId, fieldId: field.id, cropId: crop(key), areaHa, expectedYieldTHa: yieldTHa, plannedCost: cost });
      };
      await plan('1', 10, current.id, 'wheat', 5, 30_000_000);
      await plan('2', 10, current.id, 'wheat', 5, 30_000_000);
      await plan('3', 10, current.id, 'barley', 4, 20_000_000);
      await plan('4', 20, current.id, 'alfalfa', 10, 40_000_000);
      await plan('5', 10, next.id, 'corn', 30, 40_000_000);
      return { crop };
    });
  }

  it('shares the land out, keeps the stand and the planned field, and grows the herd its feed (control numbers)', async () => {
    const f = await createFixture();
    const { crop } = await farm(f);
    const herdId = await makeHerd(f, 100);
    // Per hectare: alfalfa 10 t × 2 mln − 2 mln = 18 mln, corn 30 × 0.6 − 4 = 14, wheat 5 × 3 − 3 = 12, barley 4 × 2.5 − 2 = 8.
    await feedHerd(f, herdId, [
      { name: "Bug'doy", kg: 0.2, cropId: crop('wheat'), transferPrice: 3000 },
      { name: 'Arpa', kg: 0.5, cropId: crop('barley'), transferPrice: 2500 },
      { name: 'Beda pichani', kg: 1, cropId: crop('alfalfa'), transferPrice: 2000 },
      { name: 'Silos', kg: 1, cropId: crop('corn'), transferPrice: 600 },
    ]);

    await f.run(() => runStatistics());
    const [insight] = await insightsOf(f, 'crop_suggestion');
    const data = insight.data as any;
    expect(insight.containsMoney).toBe(true);
    expect(data.textKey).toBe('crop_plan');

    // 60 ha, so no crop may pass 24 ha. Alfalfa (20 ha kept) and corn (10 ha planned) count already.
    // The herd needs 6 t of barley over 120 days, 1.5 ha: it goes where it gives up least, field 1.
    // Wheat for its 2.4 t goes to field 3, where it follows barley. Field 2 takes corn, the best that still fits.
    expect(data.rows.map((r: any) => [r.field, r.cropKey])).toEqual([
      ['1', 'barley'],
      ['2', 'corn'],
      ['3', 'wheat'],
    ]);
    expect(data.areaHa).toEqual({ alfalfa: 20, corn: 20, barley: 10, wheat: 10 });
    expect(Math.max(...(Object.values(data.areaHa) as number[]))).toBeLessThanOrEqual(24);
    expect(data.feedShort).toEqual([]);
    // Alfalfa still ranks first per hectare on each field: it is left out for its share, not its margin.
    expect(data.rows.every((r: any) => r.options[0].cropKey === 'alfalfa')).toBe(true);

    // 10 × 8 + 10 × 14 + 10 × 12 = 340 mln.
    expect(insight.body).toContain("1-dala — Arpa, 2-dala — Makkajo'xori, 3-dala — Bug'doy");
    expect(insight.body).toContain("Beda 33%, Makkajo'xori 33%, Arpa 17%, Bug'doy 17%");
    expect(insight.body).toContain("340 000 000 so'm");
    expect(insight.body).not.toContain('{{');
    expect(insight.sources).toMatchObject({ fieldsSuggested: 3, fieldsKept: 2, maxCropSharePercent: 40, method: 'farm_allocation' });

    // The web app shows each reader the names in their language.
    expect(data.localized.plan).toEqual({
      uz: "1-dala — Arpa, 2-dala — Makkajo'xori, 3-dala — Bug'doy",
      ru: 'поле 1 — Ячмень, поле 2 — Кукуруза, поле 3 — Пшеница',
      en: 'field 1 — Barley, field 2 — Corn, field 3 — Wheat',
    });
    expect(data.localized.mix.ru).toBe('Люцерна 33%, Кукуруза 33%, Ячмень 17%, Пшеница 17%');
  });

  it('rotates two fields instead of sowing the better crop on both (control numbers)', async () => {
    const f = await createFixture();
    await f.run(async () => {
      const cropRows = await tx().select().from(schema.crops).where(eq(schema.crops.tenantId, f.tenantId));
      const crop = (key: string) => cropRows.find((c) => c.key === key)!.id;
      const [season] = await tx()
        .insert(schema.seasons)
        .values({ ...base(f), name: 'Kuzgi', kind: 'autumn', startDate: addDays(today, -30), endDate: addDays(today, 200), isCurrent: true })
        .returning();
      for (const [number, key, yieldTHa, cost] of [['1', 'wheat', 5, 30_000_000], ['2', 'barley', 4, 20_000_000]] as const) {
        const [field] = await tx().insert(schema.fields).values({ ...base(f), number, areaHa: 10 }).returning();
        await tx()
          .insert(schema.cropPlans)
          .values({ ...base(f), seasonId: season.id, fieldId: field.id, cropId: crop(key), areaHa: 10, expectedYieldTHa: yieldTHa, plannedCost: cost });
      }
      await tx()
        .insert(schema.items)
        .values([
          { ...base(f), name: "Bug'doy", category: 'feed', unit: 'kg', cropId: crop('wheat'), transferPrice: 3000 },
          { ...base(f), name: 'Arpa', category: 'feed', unit: 'kg', cropId: crop('barley'), transferPrice: 2500 },
        ]);
    });
    await f.run(() => runStatistics());
    const [insight] = await insightsOf(f, 'crop_suggestion');
    const rows = (insight.data as any).rows as any[];
    // Wheat 5 t × 3 mln − 3 mln/ha = 12 mln, barley 4 t × 2.5 mln − 2 mln/ha = 8 mln. Two crops may hold half
    // the land each: field 2 takes wheat, and field 1, where wheat grew, takes barley.
    expect(rows.find((r) => r.field === '1')).toMatchObject({ lastCrop: "Bug'doy", crop: 'Arpa', marginPerHa: 8_000_000 });
    expect(rows.find((r) => r.field === '2')).toMatchObject({ lastCrop: 'Arpa', crop: "Bug'doy", marginPerHa: 12_000_000 });
    expect((insight.data as any).textKey).toBe('crop_plan_no_feed');
  });

  it('suggests nothing when every field is under a perennial or planned already', async () => {
    const f = await createFixture();
    await f.run(async () => {
      const cropRows = await tx().select().from(schema.crops).where(eq(schema.crops.tenantId, f.tenantId));
      const crop = (key: string) => cropRows.find((c) => c.key === key)!.id;
      const [next] = await tx()
        .insert(schema.seasons)
        .values({ ...base(f), name: 'Yozgi', kind: 'summer', startDate: addDays(today, 150), endDate: addDays(today, 330) })
        .returning();
      for (const [number, key] of [['4', 'alfalfa'], ['5', 'corn']] as const) {
        const [field] = await tx().insert(schema.fields).values({ ...base(f), number, areaHa: 10 }).returning();
        await tx()
          .insert(schema.cropPlans)
          .values({ ...base(f), seasonId: next.id, fieldId: field.id, cropId: crop(key), areaHa: 10, expectedYieldTHa: 10, plannedCost: 20_000_000 });
      }
      await tx()
        .insert(schema.items)
        .values([
          { ...base(f), name: 'Beda pichani', category: 'feed', unit: 'kg', cropId: crop('alfalfa'), transferPrice: 2000 },
          { ...base(f), name: 'Silos', category: 'feed', unit: 'kg', cropId: crop('corn'), transferPrice: 600 },
        ]);
    });
    const report = await f.run(() => runStatistics());
    expect(report.coverage.find((c) => c.key === 'crop_suggestion')).toMatchObject({ enough: true });
    expect(await insightsOf(f, 'crop_suggestion')).toEqual([]);
  });
});

describe('cheaper ration', () => {
  /** The pilot farm's ration for pregnant ewes, with its stock costs. */
  const pregnant = [
    { name: 'Beda (pichan)', kg: 1.1, dryMatterPct: 86, cost: 2000 },
    { name: 'Silos', kg: 1, dryMatterPct: 30, cost: 650 },
    { name: 'Somon', kg: 0.4, dryMatterPct: 88, cost: 800 },
    { name: 'Arpa', kg: 0.3, dryMatterPct: 87, cost: 3500 },
    { name: 'Kepak', kg: 0.1, dryMatterPct: 88, cost: 2400 },
    { name: 'Kunjara', kg: 0.1, dryMatterPct: 90, cost: 3000 },
    { name: 'Tuz', kg: 0.012, dryMatterPct: 98, cost: 1500 },
    { name: "Mineral qo'shimcha", kg: 0.012, dryMatterPct: 95, cost: 18_000 },
  ];

  it('swaps hay for straw, never the premix, and says what it saves a head (control numbers)', async () => {
    const f = await createFixture();
    const herdId = await makeHerd(f, 100);
    await feedHerd(f, herdId, pregnant);

    await f.run(() => runStatistics());
    const [insight] = await insightsOf(f, 'feed_cost_saving');
    const data = insight.data as any;
    // 10% of the hay's 0.946 kg of dry matter: 0.0946 × (2325.58 − 909.09) = 134 so'm a head, 2.7% of 4994.
    expect(data).toMatchObject({ fromName: 'Beda (pichan)', toName: 'Somon', feedClass: 'roughage', savingPercent: 2.7 });
    expect(data.savingPerHeadDay).toBeCloseTo(134, 1);
    expect(insight.body).toContain("Beda (pichan) quruq moddasining 10 foizini Somon bilan almashtirish");
    expect(insight.body).toContain("13 400 so'm");
    expect(insight.body).toContain("har boshga 134 so'm");
    expect(insight.body).not.toContain('Mineral');
    expect(insight.sources).toMatchObject({ feedClass: 'roughage', savingPercent: 2.7, method: 'dry_matter_swap' });
  });

  it('compares two roughages at the old control numbers', async () => {
    const f = await createFixture();
    const herdId = await makeHerd(f, 100);
    await feedHerd(f, herdId, [
      { name: 'Beda pichani', kg: 1, dryMatterPct: 90, cost: 3000 },
      { name: 'Somon', kg: 1, dryMatterPct: 88, cost: 1000 },
    ]);
    await f.run(() => runStatistics());
    const [insight] = await insightsOf(f, 'feed_cost_saving');
    // 0.09 kg DM × (3333.33 − 1136.36) = 197.73 a head a day × 100 head.
    expect(insight.data).toMatchObject({ savingPerHeadDay: 197.73, savingPerDay: 19_772.73 });
    expect(insight.body).toContain("19 773 so'm");
  });

  it('offers nothing when only a supplement is dearer, and still counts the ration as judged', async () => {
    const f = await createFixture();
    const herdId = await makeHerd(f, 50);
    // The old rule moved the premix's dry matter to the hay.
    await feedHerd(f, herdId, [
      { name: 'Pichan', kg: 2, dryMatterPct: 86, cost: 1500 },
      { name: 'Tuz', kg: 0.02, dryMatterPct: 98, cost: 1500 },
      { name: "Mineral qo'shimcha", kg: 0.02, dryMatterPct: 95, cost: 18_000 },
    ]);
    const report = await f.run(() => runStatistics());
    expect(await insightsOf(f, 'feed_cost_saving')).toEqual([]);
    expect(report.coverage.find((c) => c.key === 'feed_cost_saving')).toMatchObject({ have: 1, enough: true });
  });
});

describe('on the pilot seed', () => {
  it('keeps alfalfa to its stand and swaps hay for straw, never the premix', async () => {
    const f = await createFixture();
    const users = {} as Record<RoleKey, string>;
    for (const role of ROLE_KEYS) users[role] = (await f.as(role)).userId;
    const seed: SeedContext = { tenantId: f.tenantId, farmId: f.farmId, users, run: (fn, as = 'owner') => f.run(fn, { userId: users[as] }) };
    for (const step of [seedFinanceBase, seedLand, seedHr, seedAssets, seedInventory, seedLivestock, seedPayroll, seedVet, seedCrops, seedFinance, seedSales]) {
      await step(seed);
    }
    await f.run(() => runStatistics());

    const [crop] = await insightsOf(f, 'crop_suggestion');
    const data = crop.data as any;
    const [feed] = await insightsOf(f, 'feed_cost_saving');

    // Field 4 is the second-year alfalfa stand and field 5 is planned for silage corn: neither is re-planned.
    expect(data.rows.map((r: any) => r.field).sort()).toEqual(['1', '2', '3', '6']);
    expect(data.rows.some((r: any) => r.cropKey === 'alfalfa')).toBe(false);
    expect(new Set(data.rows.map((r: any) => r.cropKey)).size).toBeGreaterThan(1);
    expect(Math.max(...(Object.values(data.areaHa) as number[]))).toBeLessThanOrEqual(0.4 * data.totalHa);
    expect(data.feedShort).toEqual([]);
    expect(crop.body).not.toContain('{{');

    expect((feed.data as any).feedClass).toBe('roughage');
    expect(feed.body).not.toMatch(/Mineral|Tuz/);
  });
});

describe('insight wording', () => {
  const plan = { plan: '1-dala — Arpa', mix: 'Arpa 100%', feedShort: 'Arpa', fields: 1, margin: '1 000', currency: 'UZS' };

  it('words the crop plan in every language', () => {
    for (const language of ['uz', 'uz-Cyrl', 'ru', 'en'] as const) {
      for (const key of ['crop_plan', 'crop_plan_feed_short', 'crop_plan_no_feed']) {
        for (const part of ['title', 'body']) {
          const text = aiText(language, `insight.${key}.${part}`, plan);
          expect(text, `${language} ${key}.${part}`).not.toMatch(/insight\.|\{\{/);
        }
      }
      expect(aiText(language, 'insight.crop_plan.item', { field: '1', crop: 'X' })).toMatch(/1.*X/);
    }
  });

  it('never leaves an Uzbek suffix standing apart from a number or a date', () => {
    const { insight } = resources.uz.ai as { insight: Record<string, Record<string, string>> };
    for (const [key, parts] of Object.entries(insight)) {
      for (const text of Object.values(parts)) {
        // "08.02.2027 dan", "8% dan", "{{covered}}% ini": write "kuni", "foizidan", "foizini" instead.
        expect(text, key).not.toMatch(/(\}\}|\d)%? (dan|da|gacha|ga|ni|ning|i|ini)\b/);
      }
    }
  });
});
