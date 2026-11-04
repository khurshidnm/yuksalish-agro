import { addDays, todayIso } from '@yap/shared';
import { schema } from '../db/client';
import { ctx, tx } from '../core/context';
import { receiveStock } from '../core/inventory';
import { findCrop, findFacility, findItem, findWarehouse } from './lookup';
import { SEED } from './names';
import type { SeedContext } from './types';

const { items, rationLines, rations, warehouses } = schema;

type Category = (typeof items.$inferInsert)['category'];

interface ItemSeed {
  name: string;
  category: Category;
  unit: string;
  warehouse: string;
  /** Quantity in the item's unit. Omitted: the item exists with no stock. */
  qty?: number;
  cost?: number;
  dryMatterPct?: number;
  minQty?: number;
  minDays?: number;
  transferPrice?: number;
  withdrawalDays?: number;
  crop?: string;
  /** Days from today. */
  expiresInDays?: number;
}

const w = SEED.warehouse;
const i = SEED.item;

/**
 * Enough stock for the seeds that consume it: 14 days of daily logs, vaccinating 500 ewes and
 * sowing 70 ha. Bran is deliberately short for the winter (6 t needed), and premix ends up below
 * its two-week minimum once the logs have run, so the demo shows both warnings.
 */
const ITEMS: ItemSeed[] = [
  { name: i.alfalfa, category: 'feed', unit: 'kg', warehouse: w.feed, qty: 120_000, cost: 2_200, dryMatterPct: 86, transferPrice: 2_000, crop: 'alfalfa', minDays: 30 },
  { name: i.straw, category: 'feed', unit: 'kg', warehouse: w.feed, qty: 80_000, cost: 900, dryMatterPct: 88, transferPrice: 800, crop: 'wheat' },
  { name: i.barley, category: 'feed', unit: 'kg', warehouse: w.feed, qty: 40_000, cost: 3_800, dryMatterPct: 87, transferPrice: 3_500, crop: 'barley', minDays: 30 },
  { name: i.wheatGrain, category: 'feed', unit: 'kg', warehouse: w.feed, qty: 5_000, cost: 4_000, dryMatterPct: 87, transferPrice: 3_800, crop: 'wheat' },
  { name: i.bran, category: 'feed', unit: 'kg', warehouse: w.feed, qty: 3_000, cost: 2_400, dryMatterPct: 88 },
  { name: i.cake, category: 'feed', unit: 'kg', warehouse: w.feed, qty: 10_000, cost: 3_000, dryMatterPct: 90 },
  { name: i.silage, category: 'feed', unit: 'kg', warehouse: w.feed, dryMatterPct: 30 },
  { name: i.salt, category: 'feed', unit: 'kg', warehouse: w.feed, qty: 1_000, cost: 1_500, dryMatterPct: 98 },
  { name: i.premix, category: 'feed', unit: 'kg', warehouse: w.feed, qty: 120, cost: 18_000, dryMatterPct: 95 },
  { name: i.wheatSeed, category: 'seed', unit: 'kg', warehouse: w.seed, qty: 8_000, cost: 6_500, expiresInDays: 365 },
  { name: i.barleySeed, category: 'seed', unit: 'kg', warehouse: w.seed, qty: 3_500, cost: 5_500, expiresInDays: 365 },
  { name: i.alfalfaSeed, category: 'seed', unit: 'kg', warehouse: w.seed, qty: 400, cost: 65_000, expiresInDays: 540 },
  { name: i.riceSeed, category: 'seed', unit: 'kg', warehouse: w.seed, qty: 2_000, cost: 9_000, expiresInDays: 300 },
  { name: i.ammophos, category: 'fertilizer', unit: 'kg', warehouse: w.seed, qty: 12_000, cost: 9_500 },
  { name: i.urea, category: 'fertilizer', unit: 'kg', warehouse: w.seed, qty: 15_000, cost: 6_200 },
  { name: i.diesel, category: 'fuel', unit: 'l', warehouse: w.fuel, qty: 10_000, cost: 12_500, minQty: 1_500 },
  { name: i.enterotoxemiaVaccine, category: 'vaccine', unit: 'dose', warehouse: w.vet, qty: 1_000, cost: 1_800, expiresInDays: 300 },
  { name: i.poxVaccine, category: 'vaccine', unit: 'dose', warehouse: w.vet, qty: 600, cost: 1_200, expiresInDays: 20 },
  { name: i.fmdVaccine, category: 'vaccine', unit: 'dose', warehouse: w.vet, qty: 1_000, cost: 2_500, expiresInDays: 240 },
  { name: i.antibiotic, category: 'vet_drug', unit: 'vial', warehouse: w.vet, qty: 100, cost: 28_000, withdrawalDays: 21, expiresInDays: 420 },
  { name: i.dewormer, category: 'vet_drug', unit: 'dose', warehouse: w.vet, qty: 1_000, cost: 1_400, withdrawalDays: 14, expiresInDays: 360 },
  { name: i.vitamin, category: 'vet_drug', unit: 'vial', warehouse: w.vet, qty: 100, cost: 35_000, expiresInDays: 480 },
  { name: i.wool, category: 'product', unit: 'kg', warehouse: w.products, transferPrice: 12_000 },
  { name: i.meat, category: 'product', unit: 'kg', warehouse: w.products, transferPrice: 95_000 },
];

const RATIONS: { name: string; state: string; lines: [string, number][] }[] = [
  {
    name: SEED.ration.pregnant,
    state: 'pregnant',
    lines: [[i.alfalfa, 1.2], [i.straw, 0.5], [i.barley, 0.3], [i.bran, 0.1], [i.cake, 0.1], [i.salt, 0.012], [i.premix, 0.01]],
  },
  {
    name: SEED.ration.lactating,
    state: 'lactating',
    lines: [[i.alfalfa, 1.6], [i.straw, 0.3], [i.barley, 0.5], [i.bran, 0.2], [i.cake, 0.2], [i.salt, 0.015], [i.premix, 0.012]],
  },
  {
    name: SEED.ration.lamb,
    state: 'lamb',
    lines: [[i.alfalfa, 0.4], [i.barley, 0.2], [i.bran, 0.1], [i.cake, 0.05], [i.salt, 0.005], [i.premix, 0.005]],
  },
];

export async function seedInventory(s: SeedContext): Promise<void> {
  await s.run(async () => {
    const c = ctx();
    const columns = { tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId };
    const today = todayIso(c.timezone);
    const openingDate = addDays(today, -40);

    const feedStore = await findFacility(SEED.facility.feedStore);
    const mainStore = await findFacility(SEED.facility.mainStore);
    await tx()
      .insert(warehouses)
      .values([
        { ...columns, name: w.feed, type: 'feed', facilityId: feedStore.id },
        { ...columns, name: w.seed, type: 'seed_fertilizer', facilityId: mainStore.id },
        { ...columns, name: w.vet, type: 'vet', facilityId: mainStore.id },
        { ...columns, name: w.fuel, type: 'fuel', facilityId: mainStore.id },
        { ...columns, name: w.parts, type: 'spare_parts', facilityId: mainStore.id },
        { ...columns, name: w.products, type: 'finished_goods', facilityId: mainStore.id },
      ]);

    for (const seed of ITEMS) {
      const warehouse = await findWarehouse(seed.warehouse);
      const crop = seed.crop ? await findCrop(seed.crop) : null;
      const [item] = await tx()
        .insert(items)
        .values({
          ...columns,
          name: seed.name,
          category: seed.category,
          unit: seed.unit,
          dryMatterPct: seed.dryMatterPct,
          minQty: seed.minQty,
          minDays: seed.minDays,
          defaultWarehouseId: warehouse.id,
          withdrawalDays: seed.withdrawalDays,
          transferPrice: seed.transferPrice,
          cropId: crop?.id,
        })
        .returning({ id: items.id });
      if (seed.qty) {
        await receiveStock({
          itemId: item.id,
          warehouseId: warehouse.id,
          qty: seed.qty,
          unitCost: seed.cost ?? 0,
          date: openingDate,
          source: 'opening',
          batchNo: `BOSH-${seed.name.slice(0, 3).toUpperCase()}`,
          expiryDate: seed.expiresInDays ? addDays(today, seed.expiresInDays) : null,
          notes: "Boshlang'ich qoldiq",
        });
      }
    }

    for (const ration of RATIONS) {
      const [row] = await tx()
        .insert(rations)
        .values({ ...columns, name: ration.name, state: ration.state })
        .returning({ id: rations.id });
      const lines = [];
      for (const [name, kgPerHeadDay] of ration.lines) {
        const item = await findItem(name);
        lines.push({ ...columns, rationId: row.id, itemId: item.id, kgPerHeadDay });
      }
      await tx().insert(rationLines).values(lines);
    }
  }, 'storekeeper');
}
