/**
 * The AI cards on the pilot seed, as the agronomist and the zootechnician read them before the demo:
 * wheat valued as grain rather than straw, and the whole lactation's extra feed.
 */
import { and, eq } from 'drizzle-orm';
import { ROLE_KEYS, type RoleKey } from '@yap/shared';
import { describe, expect, it } from 'vitest';
import { tx } from '../src/core/context';
import { schema } from '../src/db/client';
import { runStatistics } from '../src/modules/ai/analysis';
import { groupDigits } from '../src/modules/ai/render';
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

function insightsOf(f: Fixture, type: string) {
  return f.run(() =>
    tx()
      .select()
      .from(schema.aiInsights)
      .where(and(eq(schema.aiInsights.farmId, f.farmId), eq(schema.aiInsights.type, type))),
  );
}

describe('AI cards on the pilot seed', () => {
  it('values wheat as grain and feeds the whole lactation', async () => {
    const f = await createFixture();
    const users = {} as Record<RoleKey, string>;
    for (const role of ROLE_KEYS) users[role] = (await f.as(role)).userId;
    const seed: SeedContext = { tenantId: f.tenantId, farmId: f.farmId, users, run: (fn, as = 'owner') => f.run(fn, { userId: users[as] }) };
    for (const step of [seedFinanceBase, seedLand, seedHr, seedAssets, seedInventory, seedLivestock, seedPayroll, seedVet, seedCrops, seedFinance, seedSales]) {
      await step(seed);
    }
    const report = await f.run(() => runStatistics());
    expect(report.failed).toEqual([]);

    const [season] = await insightsOf(f, 'season_profit');
    const [crop] = await insightsOf(f, 'crop_suggestion');
    const [lambing] = await insightsOf(f, 'lambing_workload');
    // Wheat is valued as its grain, "Bug'doy (yem)" at its latest sale price of 4 600 so'm/kg, not as its
    // straw at the 800 so'm/kg transfer price, which made the profit 683.3 mln and dropped wheat from the plan.
    const lines = (season.data as any).lines as any[];
    expect(lines.filter((l) => l.crop === "Bug'doy").map((l) => l.pricePerT)).toEqual([4_600_000, 4_600_000, 4_600_000]);
    // Wheat 37 ha × 5.5 t × 4.6 mln + barley 15 × 4.2 × 3.5 mln + alfalfa 28 × 10 × 2.1 mln = 1 744.6 mln.
    const forecast = season.data as any;
    expect(forecast.revenue).toBe(1_744_600_000);
    expect(forecast.profit).toBe(forecast.revenue - forecast.cost);
    expect(season.title).toContain(`${groupDigits(forecast.profit)} so'm`);

    // The crop plan weighs wheat at 5.5 t × 4.6 mln − 4.2 mln = 21.1 mln a hectare, its true margin.
    const options = ((crop.data as any).rows as any[]).flatMap((r) => r.options);
    const wheat = options.filter((o: any) => o.cropKey === 'wheat');
    expect(wheat.length).toBeGreaterThan(0);
    expect(wheat.every((o: any) => o.marginPerHa === 21_100_000)).toBe(true);

    // 700 ewes on the lactating ration for 8 weeks at 1.206 kg a day more: 47.3 t, not the 25.8 t of the
    // lambing weeks alone.
    const params = (lambing.data as any).i18n;
    expect(params).toMatchObject({ ewes: 700, lambs: 770, extraFeedT: 47 });
    expect(lambing.body).toContain("qo'shimcha 47 t ozuqa");
  });
});
