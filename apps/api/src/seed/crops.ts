import { eq } from 'drizzle-orm';
import { schema } from '../db/client';
import { ctx, tx } from '../core/context';
import { createMaintenance } from '../modules/assets/maintenance.service';
import { logUsage } from '../modules/assets/usage.service';
import { createHarvest } from '../modules/crops/harvests.service';
import { createOperation } from '../modules/crops/operations.service';
import { create as createPlan } from '../modules/crops/plans.service';
import { create as createSeason } from '../modules/crops/seasons.service';
import { create as createTechCard } from '../modules/crops/tech-cards.service';
import { findAccount, findAsset, findCrop, findEmployee, findField, findItem, findWarehouse } from './lookup';
import { SEED } from './names';
import type { SeedContext } from './types';

const { field: F, asset: A, item: I, warehouse: W } = SEED;

type OperationType = 'tillage' | 'sowing' | 'irrigation' | 'fertilizing' | 'protection' | 'observation' | 'harvest';

interface Material {
  item: string;
  warehouse: string;
  qty: number;
  normPerHa?: number;
}

interface Work {
  date: string;
  field: string;
  type: OperationType;
  status?: 'done' | 'planned';
  machine?: string;
  area?: number;
  hours?: number;
  fuel?: number;
  water?: number;
  materials?: Material[];
  details?: Record<string, unknown>;
  notes?: string;
}

const seed = (item: string, qty: number, normPerHa: number): Material => ({ item, warehouse: W.seed, qty, normPerHa });

const tillage = (date: string, field: string, area: number, machine: string): Work => ({
  date, field, type: 'tillage', machine, area, hours: Math.round(area * 0.8), fuel: Math.round(area * 6.5),
  details: { method: 'plowing' },
});
const ammophos = (date: string, field: string, area: number): Work => ({
  date, field, type: 'fertilizing', machine: A.tractor1, area, hours: Math.round(area * 0.25), fuel: Math.round(area * 1.8),
  materials: [seed(I.ammophos, area * 150, 150)],
});
const sowing = (date: string, field: string, area: number, item: string, rate: number, variety: string): Work => ({
  date, field, type: 'sowing', machine: A.tractor1, area, hours: Math.round(area * 0.55), fuel: Math.round(area * 4.8),
  materials: [seed(item, area * rate, rate)],
  details: { variety, seedRateKgHa: rate },
});
const watering = (date: string, field: string, area: number, source: string): Work => ({
  date, field, type: 'irrigation', water: area * 900, hours: Math.round(area * 1.1), details: { waterSource: source },
});

/**
 * Autumn 2026 in the order it happened. Every field is prepared and sown, and the alfalfa, in its
 * second year, is fed and watered. Corn stubble is ploughed for next spring.
 */
const AUTUMN_WORK: Work[] = [
  { date: '2026-10-03', field: F.alfalfa, type: 'fertilizing', machine: A.tractor1, area: 28, hours: 7, fuel: 50, materials: [seed(I.ammophos, 2800, 100)] },
  watering('2026-10-08', F.alfalfa, 28, 'Magistral kanal'),

  tillage('2026-10-05', F.wheat1, 10, A.tractor2),
  ammophos('2026-10-12', F.wheat1, 10),
  sowing('2026-10-15', F.wheat1, 10, I.wheatSeed, 220, 'Grom'),
  watering('2026-10-19', F.wheat1, 10, 'Magistral kanal'),

  tillage('2026-10-08', F.wheat2, 9, A.tractor1),
  ammophos('2026-10-14', F.wheat2, 9),
  sowing('2026-10-17', F.wheat2, 9, I.wheatSeed, 220, 'Krasnodar-99'),
  watering('2026-10-21', F.wheat2, 9, 'Magistral kanal'),

  tillage('2026-10-10', F.wheat3, 18, A.tractor2),
  ammophos('2026-10-18', F.wheat3, 18),
  sowing('2026-10-22', F.wheat3, 18, I.wheatSeed, 220, 'Grom'),
  watering('2026-10-26', F.wheat3, 18, 'Ariq №1'),

  tillage('2026-10-20', F.barley, 15, A.tractor2),
  {
    date: '2026-10-27',
    field: F.barley,
    type: 'sowing',
    machine: A.tractor1,
    area: 15,
    hours: 8,
    fuel: 72,
    materials: [seed(I.barleySeed, 3000, 200), seed(I.ammophos, 1800, 120)],
    details: { variety: 'Bolgar-1', seedRateKgHa: 200 },
  },
  watering('2026-10-30', F.barley, 15, 'Ariq №1'),

  {
    date: '2026-11-02',
    field: F.wheat1,
    type: 'observation',
    details: { condition: 'good', pests: "Yo'q" },
    notes: "Bug'doy maysalari tekis unib chiqdi, begona o't kam.",
  },

  { date: '2026-11-08', field: F.wheat3, type: 'irrigation', status: 'planned', water: 14_400, notes: 'Maysa suvi' },
  { date: '2026-11-12', field: F.corn, type: 'tillage', status: 'planned', area: 10 },
  { date: '2026-11-15', field: F.wheat1, type: 'fertilizing', status: 'planned', area: 10, materials: [seed(I.urea, 1000, 100)] },
];

/** Stored per work day, so seeding needs no network and always gives the same result. */
const WEATHER: [date: string, tempMin: number, tempMax: number, rainMm: number][] = [
  ['2026-10-03', 10, 26, 0],
  ['2026-10-05', 9, 25, 0],
  ['2026-10-08', 9, 24, 0],
  ['2026-10-10', 8, 23, 0],
  ['2026-10-12', 8, 23, 0],
  ['2026-10-14', 7, 22, 0],
  ['2026-10-15', 7, 22, 0],
  ['2026-10-17', 6, 21, 0],
  ['2026-10-18', 6, 21, 0],
  ['2026-10-19', 6, 20, 0],
  ['2026-10-20', 6, 20, 1.2],
  ['2026-10-21', 5, 20, 0],
  ['2026-10-22', 5, 19, 0],
  ['2026-10-26', 4, 18, 0],
  ['2026-10-27', 4, 18, 0],
  ['2026-10-30', 3, 16, 2.4],
  ['2026-11-02', 2, 14, 0],
];

const TECH_CARDS = [
  {
    crop: 'wheat',
    name: "Kuzgi bug'doy, sug'oriladigan",
    expectedYieldTHa: 5.5,
    lines: [
      { type: 'tillage', name: 'Yer haydash', offsetDays: -14, costPerHa: 450_000 },
      { type: 'tillage', name: 'Tekislash va mola', offsetDays: -7, costPerHa: 180_000 },
      { type: 'fertilizing', name: 'Ammofos, ekish oldidan', offsetDays: -3, fertilizerKgHa: 150, costPerHa: 1_425_000 },
      { type: 'sowing', name: 'Ekish', offsetDays: 0, seedKgHa: 220, laborDaysHa: 0.3, costPerHa: 1_550_000 },
      { type: 'irrigation', name: 'Ekish suvi', offsetDays: 4, waterM3Ha: 900, costPerHa: 120_000 },
      { type: 'fertilizing', name: 'Karbamid bilan oziqlantirish', offsetDays: 125, fertilizerKgHa: 200, costPerHa: 1_240_000 },
      { type: 'irrigation', name: "Bahorgi sug'orish", offsetDays: 150, waterM3Ha: 1000, costPerHa: 130_000 },
      { type: 'protection', name: "Begona o'tlarga qarshi ishlov", offsetDays: 155, costPerHa: 220_000 },
      { type: 'harvest', name: "Hosil yig'ish", offsetDays: 235, costPerHa: 650_000 },
    ],
  },
  {
    crop: 'alfalfa',
    name: 'Beda, kuzgi ekish',
    expectedYieldTHa: 9,
    lines: [
      { type: 'tillage', name: 'Yer haydash', offsetDays: -14, costPerHa: 450_000 },
      { type: 'fertilizing', name: 'Ammofos, ekish oldidan', offsetDays: -3, fertilizerKgHa: 150, costPerHa: 1_425_000 },
      { type: 'sowing', name: 'Ekish', offsetDays: 0, seedKgHa: 18, laborDaysHa: 0.3, costPerHa: 1_250_000 },
      { type: 'irrigation', name: 'Ekish suvi', offsetDays: 3, waterM3Ha: 800, costPerHa: 110_000 },
      { type: 'irrigation', name: "Bahorgi sug'orish", offsetDays: 170, waterM3Ha: 1000, costPerHa: 130_000 },
      { type: 'harvest', name: "Birinchi o'rim", offsetDays: 215, costPerHa: 350_000 },
    ],
  },
] as const;

const PLANS = [
  { season: 'autumn', field: F.wheat1, crop: 'wheat', variety: 'Grom', sowing: '2026-10-15', expectedYieldTHa: 5.5, plannedCost: 42_000_000, ownUsePct: 10 },
  { season: 'autumn', field: F.wheat2, crop: 'wheat', variety: 'Krasnodar-99', sowing: '2026-10-17', expectedYieldTHa: 5.5, plannedCost: 38_000_000, ownUsePct: 10 },
  { season: 'autumn', field: F.wheat3, crop: 'wheat', variety: 'Grom', sowing: '2026-10-22', expectedYieldTHa: 5.5, plannedCost: 76_000_000, ownUsePct: 10 },
  {
    season: 'autumn',
    field: F.barley,
    crop: 'barley',
    variety: 'Bolgar-1',
    sowing: '2026-10-27',
    expectedYieldTHa: 4.2,
    plannedCost: 62_000_000,
    ownUsePct: 100,
    notes: "To'liq o'z chorvasi uchun",
  },
  {
    season: 'autumn',
    field: F.alfalfa,
    crop: 'alfalfa',
    variety: 'Toshkent-1',
    expectedYieldTHa: 10,
    plannedCost: 70_000_000,
    ownUsePct: 95,
    notes: "Ikkinchi yil beda, to'rt o'rim",
  },
  {
    season: 'summer',
    field: F.corn,
    crop: 'corn',
    variety: "Silosbop duragay",
    sowing: '2027-05-15',
    expectedYieldTHa: 35,
    plannedCost: 54_000_000,
    ownUsePct: 100,
    notes: 'Silos uchun',
  },
] as const;

/** The 2026 crops, so the farm has a record to compare against. Their stock is the opening feed. */
const LAST_YEAR: {
  season: 'autumn' | 'summer';
  field: string;
  crop: string;
  variety: string;
  sown: string;
  yieldTHa: number;
  ownUsePct: number;
  cuts: [date: string, tons: number][];
}[] = [
  { season: 'autumn', field: F.wheat1, crop: 'wheat', variety: 'Grom', sown: '2025-10-16', yieldTHa: 5.5, ownUsePct: 15, cuts: [['2026-06-18', 57]] },
  { season: 'autumn', field: F.wheat2, crop: 'wheat', variety: 'Krasnodar-99', sown: '2025-10-18', yieldTHa: 5.5, ownUsePct: 15, cuts: [['2026-06-20', 49.5]] },
  { season: 'autumn', field: F.wheat3, crop: 'wheat', variety: 'Grom', sown: '2025-10-23', yieldTHa: 5.5, ownUsePct: 15, cuts: [['2026-06-24', 95.4]] },
  { season: 'autumn', field: F.barley, crop: 'barley', variety: 'Bolgar-1', sown: '2025-10-28', yieldTHa: 4.2, ownUsePct: 100, cuts: [['2026-06-08', 64.5]] },
  {
    season: 'summer',
    field: F.alfalfa,
    crop: 'alfalfa',
    variety: 'Toshkent-1',
    sown: '2025-10-05',
    yieldTHa: 10,
    ownUsePct: 85,
    cuts: [['2026-05-10', 90], ['2026-06-22', 81], ['2026-08-05', 73], ['2026-09-18', 56]],
  },
  { season: 'summer', field: F.corn, crop: 'corn', variety: 'Silosbop duragay', sown: '2026-05-14', yieldTHa: 35, ownUsePct: 100, cuts: [['2026-09-12', 365]] },
];

export async function seedCrops(s: SeedContext): Promise<void> {
  await s.run(async () => {
    const c = ctx();
    const past = {
      autumn: await createSeason({ name: 'Kuzgi 2025/26', kind: 'autumn', startDate: '2025-09-01', endDate: '2026-07-15' }),
      summer: await createSeason({ name: 'Yozgi 2026', kind: 'summer', startDate: '2026-04-15', endDate: '2026-10-31' }),
    };
    const seasons = {
      autumn: await createSeason({
        name: SEED.season.autumn,
        kind: 'autumn',
        startDate: '2026-09-01',
        endDate: '2027-07-15',
        isCurrent: true,
      }),
      summer: await createSeason({ name: SEED.season.summer, kind: 'summer', startDate: '2027-04-15', endDate: '2027-10-31' }),
    };

    for (const card of TECH_CARDS) {
      const crop = await findCrop(card.crop);
      await createTechCard({
        cropId: crop.id,
        name: card.name,
        expectedYieldTHa: card.expectedYieldTHa,
        lines: card.lines.map((line) => ({ ...line })),
      });
    }

    for (const crop of LAST_YEAR) {
      const field = await findField(crop.field);
      await createPlan({
        seasonId: past[crop.season].id,
        fieldId: field.id,
        cropId: (await findCrop(crop.crop)).id,
        variety: crop.variety,
        sowingDatePlan: crop.sown,
        sowingDateFact: crop.sown,
        expectedYieldTHa: crop.yieldTHa,
        ownUsePct: crop.ownUsePct,
      });
      for (const [date, grossT] of crop.cuts) {
        await createHarvest({ fieldId: field.id, date, grossT, areaDoneHa: field.areaHa, moisturePct: 14, quality: 'Yaxshi' });
      }
    }

    for (const plan of PLANS) {
      await createPlan({
        seasonId: seasons[plan.season].id,
        fieldId: (await findField(plan.field)).id,
        cropId: (await findCrop(plan.crop)).id,
        variety: plan.variety,
        sowingDatePlan: 'sowing' in plan ? plan.sowing : null,
        // A second-year stand was sown long ago, and nothing in this season's journal says so.
        ...(plan.field === F.alfalfa ? { sowingDateFact: '2025-10-05', status: 'growing' as const } : {}),
        ownUsePct: plan.ownUsePct,
        ...('expectedYieldTHa' in plan ? { expectedYieldTHa: plan.expectedYieldTHa, plannedCost: plan.plannedCost } : {}),
        ...('notes' in plan ? { notes: plan.notes } : {}),
      });
    }

    await tx()
      .insert(schema.weatherDaily)
      .values(
        WEATHER.map(([date, tempMin, tempMax, precipitationMm]) => ({
          tenantId: c.tenantId,
          farmId: c.farmId,
          date,
          tempMin,
          tempMax,
          precipitationMm,
          source: 'seed',
        })),
      )
      .onConflictDoNothing();

    const mechanic = await findEmployee(SEED.position.mechanic);
    const agronomist = await findEmployee(SEED.position.agronomist);

    for (const work of AUTUMN_WORK) {
      const materials = [];
      for (const m of work.materials ?? []) {
        materials.push({
          itemId: (await findItem(m.item)).id,
          warehouseId: (await findWarehouse(m.warehouse)).id,
          qty: m.qty,
          normPerHa: m.normPerHa,
        });
      }
      await createOperation({
        type: work.type,
        status: work.status ?? 'done',
        date: work.date,
        fieldId: (await findField(work.field)).id,
        assetId: work.machine ? (await findAsset(work.machine)).id : null,
        employeeId: work.machine ? mechanic.id : agronomist.id,
        areaDoneHa: work.area,
        durationH: work.hours,
        fuelL: work.fuel,
        waterM3: work.water,
        details: work.details,
        notes: work.notes,
        materials,
      });
    }

    // Work that belongs to no field: a run to the Qorovulbozor depot for fuel.
    const tractor2 = await findAsset(A.tractor2);
    await logUsage({
      assetId: tractor2.id,
      date: '2026-10-28',
      operatorEmployeeId: mechanic.id,
      workType: 'Transport',
      motoHours: 3,
      fuelL: 24,
      notes: "Neft bazasidan yoqilg'i olib kelindi",
    });

    const cash = await findAccount(SEED.account.cash);
    const tractor1 = await findAsset(A.tractor1);
    await createMaintenance(tractor1.id, {
      date: '2026-09-25',
      type: 'planned',
      description: 'TO-2: moy va filtrlar almashtirildi',
      cost: 1_850_000,
      nextDueMotoHours: 3400,
      downtimeHours: 6,
      payment: { paymentMethod: 'cash', accountId: cash.id },
    });

    await createMaintenance(tractor2.id, {
      date: '2026-05-12',
      type: 'planned',
      description: 'TO-1',
      nextDueDate: '2026-12-15',
      nextDueMotoHours: 4500,
    });

    const pump = await findAsset(A.pump);
    await tx()
      .update(schema.assets)
      .set({ status: 'repair', notes: "Podshipnik almashtirilmoqda, yetkazib berish kutilmoqda" })
      .where(eq(schema.assets.id, pump.id));
  }, 'agronomist');
}
