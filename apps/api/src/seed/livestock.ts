/**
 * The pilot flock (spec 2): 500 pregnant Hisori ewes bought in late October 2026, weighed on arrival,
 * with two weeks of daily records. Pregnancies are added by seed/vet.ts.
 * Random values use a fixed seed, so every `db:reset` gives the same farm.
 */
import { addDays, diffDays, round, todayIso } from '@yap/shared';
import { and, eq } from 'drizzle-orm';
import { schema } from '../db/client';
import { ctx, tx } from '../core/context';
import { newId } from '../db/schema';
import { createDailyLog, getPlan } from '../modules/livestock/daily-logs.service';
import { createHerd } from '../modules/livestock/herds.service';
import { findCounterparty, findFacility, findField, findHerd, findRation } from './lookup';
import { SEED } from './names';
import type { SeedContext } from './types';

const { animalIdentifiers, animals, breeds, pastureMoves, species, weighingCampaigns, weightRecords } = schema;

const EWES = 500;
const PURCHASE_DATE = '2026-10-20';
/** Prices vary in pairs around this, so the flock totals exactly 2.1 billion so'm for the finance seed. */
const AVERAGE_PRICE = 4_200_000;
const SICK_TAGS = new Set(['YA-0047', 'YA-0213', 'YA-0389']);
/** Every nth ewe was weighed again at the check weighing. */
const CONTROL_EVERY = 4;

/** mulberry32: small, seedable, good enough for demo data. */
function randomSource(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function seedFlock(): Promise<void> {
  const c = ctx();
  const columns = { tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId };
  const random = randomSource(20261020);
  const today = todayIso(c.timezone);

  const barn = await findFacility(SEED.facility.barn);
  const ration = await findRation(SEED.ration.pregnant);
  const seller = await findCounterparty(SEED.counterparty.sheepSeller);
  const herd = await createHerd({ name: SEED.herd.pregnant, state: 'pregnant', facilityId: barn.id, rationId: ration.id });

  const [sheep] = await tx()
    .select({ id: species.id })
    .from(species)
    .where(and(eq(species.tenantId, c.tenantId), eq(species.key, 'sheep')));
  const [hisori] = await tx()
    .select({ id: breeds.id })
    .from(breeds)
    .where(and(eq(breeds.tenantId, c.tenantId), eq(breeds.key, 'hisori')));

  const controlDate = addDays(today, -3);
  const daysSinceArrival = diffDays(PURCHASE_DATE, controlDate);
  const arrivalCampaign = newId();
  const controlCampaign = newId();
  await tx()
    .insert(weighingCampaigns)
    .values([
      { ...columns, id: arrivalCampaign, herdId: herd.id, date: PURCHASE_DATE, name: 'Kirish tortishi', status: 'closed' },
      { ...columns, id: controlCampaign, herdId: herd.id, date: controlDate, name: 'Nazorat tortishi', status: 'open' },
    ]);

  const animalRows: (typeof animals.$inferInsert)[] = [];
  const identifierRows: (typeof animalIdentifiers.$inferInsert)[] = [];
  const weightRows: (typeof weightRecords.$inferInsert)[] = [];

  let spread = 0;
  for (let i = 0; i < EWES; i++) {
    const id = newId();
    const tag = `YA-${String(i + 1).padStart(4, '0')}`;
    // Odd-indexed ewes mirror the one before, so each pair averages exactly AVERAGE_PRICE.
    spread = i % 2 === 0 ? Math.round(random() * 8) * 50_000 : -spread;

    const ageDays = Math.round((2 + random() * 3) * 365);
    // Three draws lean the weights toward the middle of the 55-70 kg range, as a real flock does.
    const arrivalKg = round(55 + (15 * (random() + random() + random())) / 3, 1);
    const reweighed = i % CONTROL_EVERY === 0;
    const controlKg = round(arrivalKg + (0.09 + random() * 0.09) * daysSinceArrival, 1);

    animalRows.push({
      ...columns,
      id,
      tag,
      speciesId: sheep.id,
      breedId: hisori.id,
      sex: 'female',
      category: 'ewe',
      birthDate: addDays(PURCHASE_DATE, -ageDays),
      birthDateEstimated: true,
      origin: 'purchased',
      purchaseDate: PURCHASE_DATE,
      purchasePrice: AVERAGE_PRICE + spread,
      sellerId: seller.id,
      herdId: herd.id,
      facilityId: barn.id,
      status: SICK_TAGS.has(tag) ? 'sick' : 'active',
      currentWeightKg: reweighed ? controlKg : arrivalKg,
      lastWeighedOn: reweighed ? controlDate : PURCHASE_DATE,
    });
    identifierRows.push({ ...columns, animalId: id, type: 'ear_tag', value: tag });
    weightRows.push({ ...columns, animalId: id, date: PURCHASE_DATE, weightKg: arrivalKg, method: 'scale', campaignId: arrivalCampaign });
    if (reweighed) {
      weightRows.push({ ...columns, animalId: id, date: controlDate, weightKg: controlKg, method: 'scale', campaignId: controlCampaign });
    }
  }

  for (const part of chunks(animalRows, 200)) await tx().insert(animals).values(part);
  for (const part of chunks(identifierRows, 500)) await tx().insert(animalIdentifiers).values(part);
  for (const part of chunks(weightRows, 500)) await tx().insert(weightRecords).values(part);

  const pasture = await findField(SEED.field.pasture);
  await tx()
    .insert(pastureMoves)
    .values({
      ...columns,
      herdId: herd.id,
      fieldId: pasture.id,
      outDate: addDays(PURCHASE_DATE, 2),
      returnDate: addDays(PURCHASE_DATE, 8),
      notes: "Qishlovdan oldingi yaylov",
    });
}

/** Two weeks up to yesterday. Today is left open, so the shepherd's screen has work on it. */
async function seedDailyLogs(): Promise<void> {
  const random = randomSource(14);
  const today = todayIso(ctx().timezone);
  const herd = await findHerd(SEED.herd.pregnant);

  for (let daysAgo = 14; daysAgo >= 1; daysAgo--) {
    const date = addDays(today, -daysAgo);
    const plan = await getPlan(herd.id, date);
    // Yesterday ran about 20 % over ration, which is what the morning alert is for (spec 15.3).
    const overfed = daysAgo === 1;
    const lines = plan.lines.map((line) => {
      const factor = overfed ? 1.2 : 0.98 + random() * 0.04;
      const qty = line.plannedQty * factor;
      return { itemId: line.itemId, actualQty: round(qty, qty >= 50 ? 0 : 1) };
    });
    await createDailyLog({
      herdId: herd.id,
      date,
      waterL: Math.round(2400 + random() * 500),
      condition: 'normal',
      lines,
    });
  }
}

export async function seedLivestock(s: SeedContext): Promise<void> {
  await s.run(seedFlock, 'zootechnician');
  await s.run(seedDailyLogs, 'shepherd');
}
