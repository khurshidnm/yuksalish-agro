/**
 * Ready-for-sale list: which animals are at the weight the farm sells at, which get there soon, and
 * which may not be sold yet whatever they weigh. Read-only: nothing here writes.
 *
 * The forecast is `saleForecast` from shared, over the animal's own weighings. Two things take an
 * animal off the "free to sell" list regardless of weight: a withdrawal period that has not ended
 * (the same check the sale itself makes) and an open reservation.
 */
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { addDays, ANIMAL_CATEGORIES, SALE_READINESS_STATUSES, SEXES } from '@yap/shared';
import {
  estimatedSaleValue,
  ownPricePerKg,
  SALE_READINESS,
  saleForecast,
  type DatedWeight,
  type SaleReadinessStatus,
} from '@yap/shared/formulas/sale-readiness';
import { schema } from '../../db/client';
import { canSeeMoney, ctx, hasPermission, today, tx } from '../../core/context';
import { listQuery, searchAny, type Page } from '../../core/query';
import { openReservations } from '../sales/reserved.service';
import { openCullMarks } from './cull-marks.service';
import { animalsUnderWithdrawal } from './health.service';
import { assertInFarm, onFarm } from './refs';

const { animals, herds, weightRecords: w, animalExits } = schema;

/**
 * How far back the farm's own live-weight sales count towards the price per kg behind the value
 * estimate. A starting value, not a figure from a book.
 */
export const SALE_PRICE_WINDOW_DAYS = SALE_READINESS.priceWindowDays;

export const saleReadinessQuery = listQuery.extend({
  herdId: z.uuid().optional(),
  sex: z.enum(SEXES).optional(),
  /** Growing lambs and breeding ewes are sold for different reasons: the list can show one kind. */
  category: z.enum(ANIMAL_CATEGORIES).optional(),
  status: z.enum(SALE_READINESS_STATUSES).optional(),
  /** Target sale weight for this request only. Without it the farm's setting is used. */
  targetKg: z.coerce.number().positive().max(2000).optional(),
});
export type SaleReadinessQuery = z.infer<typeof saleReadinessQuery>;

const STATUS_ORDER: Record<SaleReadinessStatus, number> = { ready: 0, soon: 1, later: 2, unknown: 3 };

/** The farm's own price per kg of live weight over its recent sales. Money: call only for those who may see it. */
async function recentPricePerKg(): Promise<number | null> {
  const sales = await tx()
    .select({ amount: animalExits.amount, liveWeightKg: animalExits.liveWeightKg })
    .from(animalExits)
    .where(
      and(
        eq(animalExits.farmId, ctx().farmId),
        eq(animalExits.type, 'sale'),
        gte(animalExits.date, addDays(today(), -SALE_PRICE_WINDOW_DAYS)),
      ),
    );
  return ownPricePerKg(sales);
}

/**
 * The weighings the forecast needs, per animal: everything inside the recent window of that
 * animal's newest weighing, and always its two newest weighing days.
 */
async function recentWeights(where: ReturnType<typeof and>): Promise<Map<string, DatedWeight[]>> {
  const ranked = tx().$with('ranked').as(
    tx()
      .select({
        animalId: w.animalId,
        date: w.date,
        weightKg: w.weightKg,
        createdAt: w.createdAt,
        newest: sql<string>`max(${w.date}) over (partition by ${w.animalId})`.as('newest'),
        nth: sql<number>`dense_rank() over (partition by ${w.animalId} order by ${w.date} desc)`.as('nth'),
      })
      .from(w)
      .innerJoin(animals, eq(animals.id, w.animalId))
      .where(and(eq(w.farmId, ctx().farmId), where)),
  );
  const rows = await tx()
    .with(ranked)
    .select({ animalId: ranked.animalId, date: ranked.date, weightKg: ranked.weightKg })
    .from(ranked)
    .where(sql`${ranked.nth} <= 2 or ${ranked.date} >= ${ranked.newest} - ${SALE_READINESS.recentWindowDays}::int`)
    // Oldest entry first, so that of two weights on one day the later entry stands.
    .orderBy(asc(ranked.date), asc(ranked.createdAt));

  const byAnimal = new Map<string, DatedWeight[]>();
  for (const row of rows) {
    const list = byAnimal.get(row.animalId) ?? [];
    list.push({ date: row.date, weightKg: Number(row.weightKg) });
    byAnimal.set(row.animalId, list);
  }
  return byAnimal;
}

export async function listSaleReadiness(q: SaleReadinessQuery) {
  await assertInFarm(herds, q.herdId, 'Herd');
  const targetKg = q.targetKg ?? ctx().settings.livestock.saleTargetWeightKg ?? null;
  const now = today();

  const where = and(
    eq(animals.farmId, ctx().farmId),
    onFarm(),
    q.herdId ? eq(animals.herdId, q.herdId) : undefined,
    q.sex ? eq(animals.sex, q.sex) : undefined,
    q.category ? eq(animals.category, q.category) : undefined,
    searchAny(q.search, [animals.tag]),
  );

  const herd = await tx()
    .select({
      id: animals.id,
      tag: animals.tag,
      sex: animals.sex,
      category: animals.category,
      animalStatus: animals.status,
      birthDate: animals.birthDate,
      herdId: animals.herdId,
      herdName: herds.name,
      currentWeightKg: animals.currentWeightKg,
      lastWeighedOn: animals.lastWeighedOn,
    })
    .from(animals)
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .where(where);
  const weights = await recentWeights(where);

  const forecast = herd
    .map((a) => {
      const own = weights.get(a.id) ?? [];
      // An import or an opening balance can put a weight on the animal with no weighing behind it.
      // It is still a measured weight, so it counts as one point, unless a weighing is as new.
      const newest = own.at(-1)?.date;
      if (a.currentWeightKg != null && a.lastWeighedOn && (!newest || newest < a.lastWeighedOn)) {
        own.push({ date: a.lastWeighedOn, weightKg: Number(a.currentWeightKg) });
      }
      return { animal: a, f: saleForecast(own, targetKg, now) };
    })
    .filter((row) => !q.status || row.f.status === q.status)
    .sort(
      (a, b) =>
        STATUS_ORDER[a.f.status] - STATUS_ORDER[b.f.status] ||
        (a.f.daysToTarget ?? Infinity) - (b.f.daysToTarget ?? Infinity) ||
        a.animal.tag.localeCompare(b.animal.tag),
    );

  const pageRows = forecast.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
  const ids = pageRows.map((row) => row.animal.id);
  const [withdrawals, reservations, culls] = await Promise.all([animalsUnderWithdrawal(ids), openReservations(ids), openCullMarks(ids)]);
  const withdrawalOf = new Map(withdrawals.map((row) => [row.animalId, row.withdrawalUntil]));

  // Rule 7: a price and a value are money. Without the right they are not even worked out.
  const money = canSeeMoney();
  const pricePerKg = money ? await recentPricePerKg() : null;
  // Who an animal is held for belongs to sales; a name typed by hand is personal data on top of that.
  const seesBuyer = hasPermission('sales.view');
  const seesPerson = hasPermission('pii.view');

  const data = pageRows.map(({ animal: a, f }) => {
    const held = reservations.get(a.id);
    const cull = culls.get(a.id);
    const withdrawalUntil = withdrawalOf.get(a.id) ?? null;
    return {
      id: a.id,
      tag: a.tag,
      sex: a.sex,
      category: a.category,
      animalStatus: a.animalStatus,
      birthDate: a.birthDate,
      herdId: a.herdId,
      herdName: a.herdName,
      targetKg,
      status: f.status,
      currentWeightKg: f.lastWeight?.weightKg ?? null,
      lastWeighedOn: f.lastWeight?.date ?? null,
      dailyGainKg: f.dailyGainKg,
      gainFrom: f.gainFrom,
      projectedWeightKg: f.projectedWeightKg,
      targetDate: f.targetDate,
      daysToTarget: f.daysToTarget,
      notGaining: f.notGaining,
      /** First day the animal may be sold again after a treatment. Null: no withdrawal in force. */
      withdrawalUntil,
      reservation: held
        ? {
            id: held.id,
            reservedUntil: held.reservedUntil,
            counterpartyId: seesBuyer ? held.counterpartyId : null,
            customer: seesBuyer ? (held.counterpartyName ?? (seesPerson ? held.customerName : null)) : null,
            agreedPrice: money ? held.agreedPrice : null,
          }
        : null,
      /** A person marked this animal to leave the flock: a reason to sell, not a block. */
      cullMark: cull ? { id: cull.id, reason: cull.reason, markedOn: cull.markedOn } : null,
      freeToSell: !withdrawalUntil && !held,
      pricePerKg,
      estimatedValue: money ? estimatedSaleValue(f.lastWeight?.weightKg ?? null, pricePerKg) : null,
    };
  });

  const page: Page<(typeof data)[number]> = { data, meta: { page: q.page, pageSize: q.pageSize, total: forecast.length } };
  return page;
}
