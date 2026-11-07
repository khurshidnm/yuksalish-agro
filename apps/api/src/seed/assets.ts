import { monthOf, todayIso } from '@yap/shared';
import { create } from '../modules/assets/assets.service';
import { monthsFrom, postMonths, previousMonth } from '../modules/assets/depreciation.service';
import { create as createCounterparty } from '../modules/finance/counterparties.service';
import { SEED } from './names';
import type { SeedContext } from './types';

const a = SEED.asset;

/** Spec 12.6: the combine is hired for harvest, not owned. */
export const RENTED_COMBINE = 'Kombayn Acros 595 (ijara)';

/**
 * The demo's books start in September 2026, so what wore off before then is each machine's opening
 * figure: the months from the one after purchase to August 2026, times the monthly amount. Later
 * months are posted by the real run.
 */
const FIRST_POSTED_MONTH = '2026-09';
const opening = (openingDepreciation: number) => ({ openingDepreciation, openingDepreciationDate: '2026-08-31' });

const MACHINES = [
  {
    name: a.tractor1,
    type: 'tractor',
    inventoryNo: 'T-001',
    purchaseDate: '2024-03-15',
    purchasePrice: 285_000_000,
    salvageValue: 30_000_000,
    usefulLifeMonths: 120,
    ...opening(61_625_000), // 29 months × 2 125 000
    motoHours: 3120,
    fuelNormLPerHour: 9,
    fuelNormLPerHa: 8,
  },
  {
    name: a.tractor2,
    type: 'tractor',
    inventoryNo: 'T-002',
    purchaseDate: '2023-09-10',
    purchasePrice: 210_000_000,
    salvageValue: 20_000_000,
    usefulLifeMonths: 120,
    ...opening(55_416_666.67), // 35 months × 190 000 000 / 120
    motoHours: 4280,
    fuelNormLPerHour: 8,
    fuelNormLPerHa: 7,
  },
  // 24 months × 62 000 000 / 96
  { name: a.seeder, type: 'seeder', inventoryNo: 'S-001', purchaseDate: '2024-08-20', purchasePrice: 62_000_000, usefulLifeMonths: 96, ...opening(15_500_000) },
  // 29 months × 28 000 000 / 84
  { name: a.plough, type: 'plough', inventoryNo: 'P-001', purchaseDate: '2024-03-20', purchasePrice: 28_000_000, usefulLifeMonths: 84, ...opening(9_666_666.67) },
  // 16 months × 250 000
  { name: a.pump, type: 'pump', inventoryNo: 'N-001', purchaseDate: '2025-04-05', purchasePrice: 18_000_000, usefulLifeMonths: 72, ...opening(4_000_000) },
  // 18 months × 375 000
  { name: a.generator, type: 'generator', inventoryNo: 'G-001', purchaseDate: '2025-02-12', purchasePrice: 45_000_000, usefulLifeMonths: 120, status: 'idle', ...opening(6_750_000) },
  // Bought after the opening date, so all of its months are posted.
  { name: a.scale, type: 'scale', inventoryNo: 'V-001', purchaseDate: '2026-09-01', purchasePrice: 12_000_000, usefulLifeMonths: 84 },
] as const;

/** Runs before inventory, so there is no fuel yet: shifts and repairs are in seed/crops.ts. */
export async function seedAssets(s: SeedContext): Promise<void> {
  await s.run(async () => {
    for (const machine of MACHINES) await create({ ...machine });

    const contractor = await createCounterparty({
      name: 'Agroservis Buxoro MChJ',
      type: 'service',
      phone: '+998652230145',
      address: 'Buxoro shahri',
      notes: 'Kombayn va qishloq xo\'jaligi texnikasi ijarasi',
    });
    await create({
      name: RENTED_COMBINE,
      type: 'combine',
      inventoryNo: 'IJ-001',
      rented: true,
      rentalCounterpartyId: contractor.id,
      rentalPrice: 450_000,
      rentalUnit: 'ha',
      notes: "Hosil yig'ish mavsumiga ijaraga olinadi: gektariga 450 000 so'm, hisob-kitob akt bo'yicha.",
    });
  });
}

/** Goes through the same run as a real farm, so the ledger and the machine cards agree. */
export async function seedDepreciation(s: SeedContext): Promise<void> {
  await s.run(async () => void (await postMonths(monthsFrom(FIRST_POSTED_MONTH, previousMonth(monthOf(todayIso()))))), 'accountant');
}
