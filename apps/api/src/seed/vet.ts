import { and, asc, eq, inArray } from 'drizzle-orm';
import { addDays, expectedLambingDate, lambingWindow, todayIso } from '@yap/shared';
import { schema } from '../db/client';
import { tx } from '../core/context';
import { recordEvent } from '../core/journal';
import { createPlan, createRecord, reportSick, startQuarantine, vaccinateHerd } from '../modules/livestock/health.service';
import { findEmployee, findHerd, findItem, findWarehouse } from './lookup';
import { SEED } from './names';
import type { SeedContext } from './types';

const { animals, breedingRecords, species } = schema;

/** The flock was bought in calf: matings fall between these dates, so lambing is Feb–Mar 2027. */
const FIRST_MATING = '2026-09-10';
const MATING_SPREAD_DAYS = 46;

export async function seedVet(s: SeedContext): Promise<void> {
  const ewes = await s.run(async () => {
    const herd = await findHerd(SEED.herd.pregnant);
    const rows = await tx()
      .select({ id: animals.id, tag: animals.tag, status: animals.status, speciesId: animals.speciesId })
      .from(animals)
      .where(and(eq(animals.herdId, herd.id), eq(animals.sex, 'female')))
      .orderBy(asc(animals.tag));
    if (rows.length === 0) throw new Error('seedVet needs the ewes from seedLivestock');

    const [sheep] = await tx().select().from(species).where(eq(species.id, rows[0].speciesId));
    await tx()
      .insert(breedingRecords)
      .values(
        rows.map((ewe, i) => {
          // Stepping by 7 spreads neighbouring tags across the whole period.
          const matingDate = addDays(FIRST_MATING, (i * 7) % MATING_SPREAD_DAYS);
          const window = lambingWindow(matingDate, sheep.gestationMinDays, sheep.gestationMaxDays);
          return {
            tenantId: s.tenantId,
            farmId: s.farmId,
            createdBy: s.users.zootechnician,
            eweId: ewe.id,
            source: 'purchase',
            matingDate,
            expectedDate: expectedLambingDate(matingDate, sheep.gestationDays),
            expectedEarliest: window.earliest,
            expectedLatest: window.latest,
          };
        }),
      );
    await tx()
      .update(animals)
      .set({ status: 'pregnant' })
      .where(inArray(animals.id, rows.filter((ewe) => ewe.status === 'active').map((ewe) => ewe.id)));
    await recordEvent({
      type: 'animal.pregnancies_recorded',
      entityType: 'herd',
      entityId: herd.id,
      occurredAt: FIRST_MATING,
      data: { count: rows.length, source: 'purchase' },
    });
    return rows;
  }, 'zootechnician');

  const today = todayIso();
  const pick = (index: number) => ewes[index % ewes.length];

  await s.run(async () => {
    const herd = await findHerd(SEED.herd.pregnant);
    const vaccineStore = await findWarehouse(SEED.warehouse.vet);
    const vet = await findEmployee(SEED.position.veterinarian);
    const [sheep] = await tx().select({ id: species.id }).from(species).where(and(eq(species.tenantId, s.tenantId), eq(species.key, 'sheep')));

    // Mandatory calendar (spec 8.3). Brucellosis is a laboratory check here, so it uses no stock.
    await createPlan({ name: 'Brutsellyoz tekshiruvi', speciesId: sheep.id, ageDays: 120, intervalDays: 365, mandatory: true });
    const pox = await findItem(SEED.item.poxVaccine);
    await createPlan({ name: 'Chechakka qarshi emlash', itemId: pox.id, speciesId: sheep.id, ageDays: 90, intervalDays: 365, mandatory: true });
    const fmd = await findItem(SEED.item.fmdVaccine);
    await createPlan({ name: 'Oqsilga qarshi emlash', itemId: fmd.id, speciesId: sheep.id, ageDays: 60, intervalDays: 180, mandatory: true });
    const enterotoxemia = await findItem(SEED.item.enterotoxemiaVaccine);
    const enterotoxemiaPlan = await createPlan({
      name: 'Enterotoksemiyaga qarshi emlash',
      itemId: enterotoxemia.id,
      speciesId: sheep.id,
      ageDays: 30,
      intervalDays: 180,
      mandatory: true,
    });
    const dewormer = await findItem(SEED.item.dewormer);
    await createPlan({ name: 'Gijjaga qarshi ishlov', itemId: dewormer.id, speciesId: sheep.id, ageDays: 60, intervalDays: 120, mandatory: false });

    // The whole flock against enterotoxemia: one dose a head, taken from the vet store.
    await vaccinateHerd({
      herdId: herd.id,
      planId: enterotoxemiaPlan.id,
      date: addDays(today, -3),
      warehouseId: vaccineStore.id,
      dosePerHead: 1,
      vetEmployeeId: vet.id,
      notes: 'Kelgandan keyingi birinchi emlash',
    });

    const antibiotic = await findItem(SEED.item.antibiotic);
    await createRecord({
      type: 'treatment',
      animalId: pick(16).id,
      date: addDays(today, -1),
      diagnosis: 'Pnevmoniya',
      itemId: antibiotic.id,
      warehouseId: vaccineStore.id,
      dose: 1,
      courseDays: 3,
      qtyUsed: 3,
      vetEmployeeId: vet.id,
    });
    const vitamin = await findItem(SEED.item.vitamin);
    await createRecord({
      type: 'treatment',
      animalId: pick(41).id,
      date: addDays(today, -6),
      diagnosis: 'Vitamin yetishmasligi',
      itemId: vitamin.id,
      warehouseId: vaccineStore.id,
      qtyUsed: 1,
      vetEmployeeId: vet.id,
      result: 'Holati yaxshilandi',
    });

    await startQuarantine({
      animalIds: [pick(70).id],
      startDate: addDays(today, -4),
      reason: 'Oqsoqlanish: kasallik yuqmasligi uchun alohida saqlanmoqda',
    });
  }, 'veterinarian');

  // A live report, so the vet's "today" panel and the urgent alert have something real to show.
  await s.run(
    () => reportSick({ animalId: pick(103).id, note: "Ikki kundan beri yem yemayapti, boshini quyi solgan", date: today }),
    'shepherd',
  );
}
