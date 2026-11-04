import { eq } from 'drizzle-orm';
import { schema } from '../db/client';
import { ctx, tx } from '../core/context';
import { createMaintenance } from '../modules/assets/maintenance.service';
import { logUsage } from '../modules/assets/usage.service';
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

/**
 * Autumn 2026 in the order it happened (spec 2.1). Each field is tilled, fertilised, sown and
 * irrigated. One TTZ-80 shift burns well over its norm, so the fuel alert has something to show.
 */
const AUTUMN_WORK: Work[] = [
  // Field 4, alfalfa, 12 ha
  { date: '2026-10-01', field: F.alfalfa, type: 'tillage', machine: A.tractor1, area: 12, hours: 9, fuel: 95, details: { method: 'plowing' } },
  { date: '2026-10-03', field: F.alfalfa, type: 'fertilizing', machine: A.tractor1, area: 12, hours: 3, fuel: 22, materials: [seed(I.ammophos, 1800, 150)] },
  {
    date: '2026-10-05',
    field: F.alfalfa,
    type: 'sowing',
    machine: A.tractor1,
    area: 12,
    hours: 7,
    fuel: 60,
    materials: [seed(I.alfalfaSeed, 216, 18)],
    details: { variety: 'Toshkent-1', seedRateKgHa: 18 },
  },
  { date: '2026-10-08', field: F.alfalfa, type: 'irrigation', water: 9600, hours: 14, details: { waterSource: 'Quduq №1' } },

  // Field 1, wheat, 20 ha
  { date: '2026-10-10', field: F.wheat1, type: 'tillage', machine: A.tractor2, area: 20, hours: 16, fuel: 170, details: { method: 'plowing' }, notes: "Yer qattiq, plug chuqurligi oshirildi" },
  { date: '2026-10-17', field: F.wheat1, type: 'fertilizing', machine: A.tractor1, area: 20, hours: 5, fuel: 36, materials: [seed(I.ammophos, 3000, 150)] },
  {
    date: '2026-10-20',
    field: F.wheat1,
    type: 'sowing',
    machine: A.tractor1,
    area: 20,
    hours: 11,
    fuel: 98,
    materials: [seed(I.wheatSeed, 4400, 220)],
    details: { variety: 'Grom', seedRateKgHa: 220 },
  },
  { date: '2026-10-24', field: F.wheat1, type: 'irrigation', water: 18_000, hours: 22, details: { waterSource: "Amu-Buxoro kanali" } },

  // Field 2, wheat, 15 ha
  { date: '2026-10-14', field: F.wheat2, type: 'tillage', machine: A.tractor1, area: 15, hours: 11, fuel: 118, details: { method: 'plowing' } },
  { date: '2026-10-23', field: F.wheat2, type: 'fertilizing', machine: A.tractor1, area: 15, hours: 4, fuel: 27, materials: [seed(I.ammophos, 2250, 150)] },
  {
    date: '2026-10-25',
    field: F.wheat2,
    type: 'sowing',
    machine: A.tractor1,
    area: 15,
    hours: 8,
    fuel: 72,
    materials: [seed(I.wheatSeed, 3300, 220)],
    details: { variety: 'Krasnodar-99', seedRateKgHa: 220 },
  },

  // Field 3, barley, 15 ha
  { date: '2026-10-22', field: F.barley, type: 'tillage', machine: A.tractor2, area: 15, hours: 10, fuel: 104, details: { method: 'plowing' } },
  {
    date: '2026-10-29',
    field: F.barley,
    type: 'sowing',
    machine: A.tractor1,
    area: 15,
    hours: 8,
    fuel: 70,
    materials: [seed(I.barleySeed, 3000, 200), seed(I.ammophos, 1800, 120)],
    details: { variety: 'Bolgar-1', seedRateKgHa: 200 },
  },
  {
    date: '2026-11-02',
    field: F.alfalfa,
    type: 'observation',
    details: { condition: 'good', pests: "Yo'q" },
    notes: "Beda maysalari tekis unib chiqdi, begona o't kam.",
  },

  // Still to do. The first is past its date, so the overdue list has something to show.
  { date: '2026-11-01', field: F.wheat2, type: 'irrigation', status: 'planned', water: 13_500, notes: 'Ekish suvi' },
  { date: '2026-11-10', field: F.barley, type: 'irrigation', status: 'planned', water: 12_000 },
  { date: '2026-11-15', field: F.wheat1, type: 'fertilizing', status: 'planned', area: 20, materials: [seed(I.urea, 2000, 100)] },
];

/** Stored per work day, so seeding needs no network and always gives the same result. */
const WEATHER: [date: string, tempMin: number, tempMax: number, rainMm: number][] = [
  ['2026-10-01', 11, 27, 0],
  ['2026-10-03', 10, 26, 0],
  ['2026-10-05', 9, 25, 0],
  ['2026-10-08', 9, 24, 0],
  ['2026-10-10', 8, 23, 0],
  ['2026-10-14', 7, 22, 0],
  ['2026-10-17', 6, 21, 0],
  ['2026-10-20', 6, 20, 1.2],
  ['2026-10-22', 5, 19, 0],
  ['2026-10-23', 5, 19, 0],
  ['2026-10-24', 4, 18, 0],
  ['2026-10-25', 4, 18, 0],
  ['2026-10-29', 3, 16, 2.4],
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
  { season: 'autumn', field: F.wheat1, crop: 'wheat', variety: 'Grom', sowing: '2026-10-20', ownUsePct: 10 },
  { season: 'autumn', field: F.wheat2, crop: 'wheat', variety: 'Krasnodar-99', sowing: '2026-10-25', ownUsePct: 10 },
  {
    season: 'autumn',
    field: F.barley,
    crop: 'barley',
    variety: 'Bolgar-1',
    sowing: '2026-10-28',
    expectedYieldTHa: 4.2,
    plannedCost: 62_000_000,
    ownUsePct: 100,
    notes: "To'liq o'z chorvasi uchun",
  },
  { season: 'autumn', field: F.alfalfa, crop: 'alfalfa', variety: 'Toshkent-1', sowing: '2026-10-05', ownUsePct: 85 },
  {
    season: 'summer',
    field: F.rice,
    crop: 'rice',
    variety: 'Iskandar',
    sowing: '2027-05-15',
    expectedYieldTHa: 6,
    plannedCost: 54_000_000,
    ownUsePct: 0,
  },
] as const;

export async function seedCrops(s: SeedContext): Promise<void> {
  await s.run(async () => {
    const c = ctx();
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

    for (const plan of PLANS) {
      await createPlan({
        seasonId: seasons[plan.season].id,
        fieldId: (await findField(plan.field)).id,
        cropId: (await findCrop(plan.crop)).id,
        variety: plan.variety,
        sowingDatePlan: plan.sowing,
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

    // Past its date, so "service due" has something to show.
    await createMaintenance(tractor2.id, {
      date: '2026-05-12',
      type: 'planned',
      description: 'TO-1',
      nextDueDate: '2026-10-30',
      nextDueMotoHours: 4500,
    });

    const pump = await findAsset(A.pump);
    await tx()
      .update(schema.assets)
      .set({ status: 'repair', notes: "Podshipnik almashtirilmoqda, yetkazib berish kutilmoqda" })
      .where(eq(schema.assets.id, pump.id));
  }, 'agronomist');
}
