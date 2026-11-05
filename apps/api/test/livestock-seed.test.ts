import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays, todayIso } from '@yap/shared';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { receiveStock } from '../src/core/inventory';
import { seedLivestock } from '../src/seed/livestock';
import { SEED } from '../src/seed/names';
import type { SeedContext } from '../src/seed/types';
import { herdSummary } from '../src/modules/livestock/summary';
import { createFixture } from './helpers';

const { counterparties, facilities, fields, items, rationLines, rations, warehouses } = schema;

/** Runs the real seed on a throwaway database, with just the records earlier seed steps provide. */
describe('pilot flock seed', () => {
  it('creates 700 ewes, two weighings and two weeks of logs, reconciled to the money', async () => {
    const f = await createFixture();
    const today = todayIso();
    const zoo = await f.as('zootechnician');
    const shepherd = await f.as('shepherd');
    const owner = await f.as('owner');

    await f.run(async () => {
      const base = { tenantId: f.tenantId, farmId: f.farmId };
      await tx().insert(facilities).values({ ...base, type: 'barn', name: SEED.facility.barn, capacity: 1000 });
      await tx().insert(counterparties).values({ ...base, name: SEED.counterparty.sheepSeller, type: 'supplier' });
      await tx().insert(fields).values({ ...base, number: SEED.field.pasture, landUse: 'pasture', areaHa: 100 });
      const [warehouse] = await tx().insert(warehouses).values({ ...base, name: SEED.warehouse.feed, type: 'feed' }).returning();
      const [ration] = await tx().insert(rations).values({ ...base, name: SEED.ration.pregnant, state: 'pregnant' }).returning();
      for (const [name, kg] of [[SEED.item.alfalfa, 1.2], [SEED.item.barley, 0.3], [SEED.item.salt, 0.012]] as const) {
        const [item] = await tx()
          .insert(items)
          .values({ ...base, name, category: 'feed', unit: 'kg', defaultWarehouseId: warehouse.id })
          .returning();
        await receiveStock({ itemId: item.id, warehouseId: warehouse.id, qty: 50_000, unitCost: 2_000, date: addDays(today, -40), source: 'opening' });
        await tx().insert(rationLines).values({ ...base, rationId: ration.id, itemId: item.id, kgPerHeadDay: kg });
      }
    });

    const seed: SeedContext = {
      tenantId: f.tenantId,
      farmId: f.farmId,
      users: { zootechnician: zoo.userId, shepherd: shepherd.userId, owner: owner.userId } as SeedContext['users'],
      run: (fn, as = 'owner') => f.run(fn, { userId: ({ zootechnician: zoo, shepherd, owner } as Record<string, typeof owner>)[as].userId }),
    };

    const started = Date.now();
    await seedLivestock(seed);
    const elapsed = Date.now() - started;

    const summary = await f.run(() => herdSummary());
    expect(summary).toMatchObject({ total: 700, sick: 3, byCategory: { ewe: 700 } });

    const [money] = await f.run(() =>
      tx().execute<{ total: string; min_price: string; max_price: string }>(sql`
        select sum(purchase_price) as total, min(purchase_price) as min_price, max(purchase_price) as max_price from animals`),
    ).then((r) => r.rows);
    expect(Number(money.total)).toBe(3_220_000_000);
    expect(Number(money.min_price)).toBeGreaterThanOrEqual(4_200_000);
    expect(Number(money.max_price)).toBeLessThanOrEqual(5_000_000);

    const [weights] = await f.run(() =>
      tx().execute<{ min_kg: string; max_kg: string; tags: string }>(sql`
        select min(w.weight_kg) as min_kg, max(w.weight_kg) as max_kg, count(distinct i.value) as tags
        from weight_records w join animal_identifiers i on i.animal_id = w.animal_id
        where w.date = '2026-10-20'`),
    ).then((r) => r.rows);
    expect(Number(weights.min_kg)).toBeGreaterThanOrEqual(62);
    expect(Number(weights.max_kg)).toBeLessThanOrEqual(80);
    expect(Number(weights.tags)).toBe(700);

    const campaigns = await zoo.get('/livestock/weighing-campaigns');
    const counts = Object.fromEntries(campaigns.body.data.map((c: any) => [c.name, c.weighed]));
    expect(counts).toEqual({ 'Kirish tortishi': 700, 'Nazorat tortishi': 175 });

    const logs = await zoo.get('/livestock/daily-logs', { pageSize: 100 });
    expect(logs.body.meta.total).toBe(14);
    const yesterday = logs.body.data.find((l: any) => l.date === addDays(today, -1));
    expect(Math.abs(yesterday.deviationPercent)).toBeLessThan(3);
    expect((await shepherd.get('/livestock/daily-logs/day')).data.herds[0].logged).toBe(false);

    const alerts = await f.run(() => tx().select().from(schema.alerts));
    expect(alerts).toEqual([]);

    const list = await zoo.get('/livestock/animals', { search: 'YA-0047' });
    expect(list.body.data[0].status).toBe('sick');

    const reseedTime = elapsed;
    expect(reseedTime).toBeLessThan(20_000);
  });
});
