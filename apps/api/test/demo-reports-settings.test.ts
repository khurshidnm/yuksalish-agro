/**
 * Demo fixes in reports and settings: a season filter that names the season it reads, soil units,
 * field names in crop reports, KPI head and mortality for the chosen period, and labels for every
 * table the data export and the audit log can show.
 */
import { and, eq, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { addDays, todayIso } from '@yap/shared';
import { resources } from '@yap/shared/i18n';
import { beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import * as tables from '../src/db/schema';
import { ctx, tx } from '../src/core/context';
import { formatNumber } from '../src/modules/reports/i18n';
import { createFixture, type Client, type Fixture } from './helpers';

const LANGS = ['uz', 'ru', 'en'] as const;

interface World {
  f: Fixture;
  owner: Client;
  pastSeasonId: string;
  currentSeasonId: string;
}

/**
 *   Season "Kuzgi 2025/26": field №7 "G'arbiy massiv", 10 ha of wheat, 40 t harvested on 2026-06-20.
 *   Season "Kuzgi 2026/27": the current one, the same field sown again, nothing harvested yet.
 *   Herd: 10 ewes from 2026-01-10; one dies 10 days ago, one 400 days ago would be before the herd.
 */
async function buildWorld(): Promise<World> {
  const f = await createFixture();
  const ids = await f.run(async () => {
    const c = ctx();
    const base = { tenantId: c.tenantId, farmId: c.farmId };
    const [field] = await tx().insert(schema.fields).values({ ...base, number: '7', name: "G'arbiy massiv", areaHa: 10 }).returning();
    const [crop] = await tx().select().from(schema.crops).where(and(eq(schema.crops.tenantId, c.tenantId), eq(schema.crops.key, 'wheat')));
    const [past] = await tx()
      .insert(schema.seasons)
      .values({ ...base, name: 'Kuzgi 2025/26', kind: 'autumn', startDate: '2025-09-01', endDate: '2026-08-31' })
      .returning();
    const [current] = await tx()
      .insert(schema.seasons)
      .values({ ...base, name: 'Kuzgi 2026/27', kind: 'autumn', startDate: '2026-09-01', endDate: '2027-08-31', isCurrent: true })
      .returning();
    const [pastPlan] = await tx()
      .insert(schema.cropPlans)
      .values({ ...base, seasonId: past.id, fieldId: field.id, cropId: crop.id, areaHa: 10, expectedYieldTHa: 5, status: 'harvested' })
      .returning();
    await tx()
      .insert(schema.cropPlans)
      .values({ ...base, seasonId: current.id, fieldId: field.id, cropId: crop.id, areaHa: 10, expectedYieldTHa: 5, status: 'sown' });
    await tx().insert(schema.harvests).values({ ...base, fieldId: field.id, cropPlanId: pastPlan.id, date: '2026-06-20', grossT: 40 });
    await tx().insert(schema.soilAnalyses).values({ ...base, fieldId: field.id, date: '2026-04-01', n: 12, p: 25, k: 210, ph: 7.9, humus: 0.9, salinity: 0.3 });

    const [sheep] = await tx().select().from(schema.species).where(and(eq(schema.species.tenantId, c.tenantId), eq(schema.species.key, 'sheep')));
    const [herd] = await tx().insert(schema.herds).values({ ...base, name: 'Sovliqlar' }).returning();
    const animals = await tx()
      .insert(schema.animals)
      .values(
        Array.from({ length: 10 }, (_, i) => ({
          ...base,
          tag: `K-${i + 1}`,
          speciesId: sheep.id,
          sex: 'female',
          category: 'ewe',
          origin: 'purchased',
          purchaseDate: '2026-01-10',
          herdId: herd.id,
          status: 'active',
        })),
      )
      .returning();
    const died = addDays(todayIso(), -10);
    await tx().update(schema.animals).set({ status: 'dead', exitDate: died }).where(eq(schema.animals.id, animals[9].id));
    await tx().insert(schema.animalExits).values({ ...base, animalId: animals[9].id, type: 'death', date: died, reason: 'Pnevmoniya' });
    return { pastSeasonId: past.id, currentSeasonId: current.id };
  });
  return { f, owner: await f.as('owner'), ...ids };
}

describe('season reports name the season they read', () => {
  let w: World;
  beforeAll(async () => {
    w = await buildWorld();
  });

  it('a yield report left empty reads the newest season with a harvest, and says which', async () => {
    const res = await w.owner.get('/reports/crops.yield', { lang: 'uz' });
    expect(res.status).toBe(200);
    expect(res.data.defaults).toEqual({ seasonId: { value: w.pastSeasonId, label: 'Kuzgi 2025/26' } });
    expect(res.data.filterSummary).toContainEqual({ label: 'Mavsum', value: 'Kuzgi 2025/26' });
    expect(res.data.rows).toHaveLength(1);
    // 40 t from 10 ha against 5 t/ha planned: 4 t/ha, -20 %.
    expect(res.data.rows[0]).toMatchObject({ field: "№7 G'arbiy massiv", harvestedT: 40, actualYieldTHa: 4, yieldDeviationPercent: -20 });
  });

  it('a cost report left empty reads the current season, named', async () => {
    const res = await w.owner.get('/reports/crops.field_costs', { lang: 'uz' });
    expect(res.status).toBe(200);
    expect(res.data.defaults).toEqual({ seasonId: { value: w.currentSeasonId, label: 'Kuzgi 2026/27' } });
    expect(res.data.filterSummary).toContainEqual({ label: 'Mavsum', value: 'Kuzgi 2026/27' });
    expect(res.data.rows.map((r: any) => r.field)).toEqual(["№7 G'arbiy massiv"]);
  });

  it('a chosen season is not a default, and its name comes from the database', async () => {
    const res = await w.owner.get('/reports/crops.yield', { seasonId: w.currentSeasonId, seasonIdLabel: 'anything', lang: 'uz' });
    expect(res.data.defaults).toEqual({});
    expect(res.data.filterSummary).toContainEqual({ label: 'Mavsum', value: 'Kuzgi 2026/27' });
    expect(res.data.rows[0]).toMatchObject({ harvestedT: 0, actualYieldTHa: null });
  });

  it('the catalog says what an empty season reads instead of "all"', async () => {
    const res = await w.owner.get('/reports', { lang: 'ru' });
    const season = (key: string) => res.data.reports.find((r: any) => r.key === key).filters.find((x: any) => x.key === 'seasonId');
    expect(season('crops.yield').emptyLabel).toBe('Последний сезон с урожаем');
    expect(season('crops.field_costs').emptyLabel).toBe('Текущий сезон');
    const fieldFilter = res.data.reports.find((r: any) => r.key === 'crops.soil').filters.find((x: any) => x.key === 'fieldId');
    expect(fieldFilter.emptyLabel).toBeUndefined();
  });

  it('the crop KPI shows no cost per ton for a harvest with no cost on record', async () => {
    const res = await w.owner.get('/reports/crops.kpi', { lang: 'en' });
    expect(res.data.defaults.seasonId.value).toBe(w.pastSeasonId);
    const rows = Object.fromEntries(res.data.rows.map((r: any) => [r.indicator, r.value]));
    expect(rows['Yield']).toBe(4);
    expect(rows['Cost per ton']).toBeNull();
  });
});

describe('soil report units, as on the field card', () => {
  let w: World;
  beforeAll(async () => {
    w = await buildWorld();
  });

  it('names nutrients with their formula and unit in every script', async () => {
    const label = async (lang: string) => {
      const res = await w.owner.get('/reports/crops.soil', { lang });
      return Object.fromEntries(res.data.columns.map((c: any) => [c.key, c.label]));
    };
    expect(await label('uz')).toMatchObject({ n: 'Azot (N-NO₃), mg/kg', p: 'Fosfor (P₂O₅), mg/kg', k: 'Kaliy (K₂O), mg/kg', humus: 'Gumus, %', salinity: 'Quruq qoldiq, %', ph: 'pH' });
    expect(await label('ru')).toMatchObject({ n: 'Азот (N-NO₃), мг/кг', salinity: 'Плотный остаток, %' });
    expect(await label('en')).toMatchObject({ p: 'Phosphorus (P₂O₅), mg/kg', salinity: 'Dry residue, %' });
    // The formula is chemistry, not Uzbek: it stays Latin in Cyrillic script.
    const cyrillic = await label('uz-Cyrl');
    expect(cyrillic.n).toContain('(N-NO₃)');
    expect(cyrillic.p).toContain('(P₂O₅)');
    const res = await w.owner.get('/reports/crops.soil', { lang: 'uz' });
    expect(res.data.rows[0]).toMatchObject({ field: "№7 G'arbiy massiv", n: 12, p: 25, k: 210 });
  });
});

describe('livestock KPI for the chosen period', () => {
  let w: World;
  beforeAll(async () => {
    w = await buildWorld();
  });

  it('counts head at the period end and mortality within the period', async () => {
    const today = todayIso();
    const before = addDays(today, -20);
    const early = await w.owner.get('/reports/livestock.kpi', { from: '2026-01-01', to: before, lang: 'en' });
    const rows = (res: any) => Object.fromEntries(res.data.rows.map((r: any) => [r.indicator, r.value]));
    // Before the death: 10 head, nobody died.
    expect(rows(early)['Total head']).toBe(10);
    expect(rows(early)['Mortality']).toBe(0);
    const now = await w.owner.get('/reports/livestock.kpi', { from: addDays(today, -15), to: today, lang: 'en' });
    expect(rows(now)['Total head']).toBe(9);
    expect(rows(now)['Mortality']).toBeGreaterThan(0);
  });
});

describe('data export and audit labels', () => {
  it('every tenant table has a name in every language', async () => {
    const tenantTables = Object.values(tables)
      .filter((value) => is(value, PgTable))
      .map((value) => getTableConfig(value as PgTable))
      .filter((config) => config.columns.some((column) => column.name === 'tenantId' || column.name === 'tenant_id'))
      .map((config) => config.name);
    expect(tenantTables.length).toBeGreaterThan(50);
    for (const lang of LANGS) {
      const entities = (resources[lang].settings as unknown as { entities: Record<string, string> }).entities;
      expect(tenantTables.filter((name) => !entities[name]), lang).toEqual([]);
    }
  });

  it('every table in the export overview has a name, so no raw table name reaches the screen', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const res = await owner.get('/settings/export/overview');
    expect(res.status).toBe(200);
    const names: string[] = res.data.map((row: { name: string }) => row.name);
    expect(names).toContain('cash_holders');
    for (const lang of LANGS) {
      const entities = (resources[lang].settings as unknown as { entities: Record<string, string> }).entities;
      expect(names.filter((name) => !entities[name]), lang).toEqual([]);
    }
  });
});

describe('numbers in exports', () => {
  it('never prints a negative zero', () => {
    expect(formatNumber(-0, 0, 'ru')).toBe('0');
    expect(formatNumber(-0.0001, 2, 'ru')).toBe('0');
    expect(formatNumber(-0.4, 0, 'en')).toBe('0');
    expect(formatNumber(-0.6, 0, 'en')).toBe('-1');
    expect(formatNumber(-1234.5, 1, 'en')).toBe('-1,234.5');
  });
});
