/**
 * Reservations: an animal held for a buyer until a date. A reservation moves no money and no animal.
 * It becomes a sale through the sales order (orders.service), which is the only place a sale is made.
 */
import { and, count, desc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ANIMAL_ON_FARM_STATUSES, RESERVATION_STATUSES, addDays } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { hideMoney, hidePii } from '../../core/privacy';
import { clientId, isoDate, listQuery, searchAny, sortBy } from '../../core/query';
import { normalizePhone } from '../auth/auth.service';
import { animalsUnderWithdrawal } from '../livestock/health.service';
import { MAX_MONEY, SALE_PAYMENT_METHODS } from './constants';
import * as orders from './orders.service';
import { assertCounterparty } from './refs';

const { animalReservations: r, animals, counterparties, herds, sales, saleLines } = schema;

type Reservation = typeof r.$inferSelect;

/** Starting value: a hold longer than this is a mistake in the date more often than a plan. */
export const RESERVATION_MAX_DAYS = 365;

const customerFields = {
  counterpartyId: z.uuid().nullish(),
  customerName: z.string().trim().min(2).max(120).nullish(),
  customerPhone: z.string().trim().min(9).max(24).nullish(),
};

export const reservationInput = z.object({
  id: clientId,
  animalId: z.uuid(),
  ...customerFields,
  /** For the whole animal, in the base currency. */
  agreedPrice: z.number().positive().max(MAX_MONEY).nullish(),
  reservedUntil: isoDate,
  note: z.string().trim().max(500).nullish(),
});
export type ReservationInput = z.infer<typeof reservationInput>;

export const reservationListQuery = listQuery.extend({
  status: z.enum(RESERVATION_STATUSES).optional(),
  animalId: z.uuid().optional(),
  counterpartyId: z.uuid().optional(),
});

export const reservationCancelInput = z.object({ reason: z.string().trim().max(500).nullish() });

export const reservationConvertInput = z.object({
  /** Needed when the reservation names a person who is not a counterparty yet. */
  counterpartyId: z.uuid().nullish(),
  /** For the whole animal. Defaults to the agreed price. */
  price: z.number().positive().max(MAX_MONEY).nullish(),
  date: isoDate.optional(),
  paymentMethod: z.enum(SALE_PAYMENT_METHODS).optional(),
  accountId: z.uuid().nullish(),
});

const MONEY_FIELDS = ['agreedPrice'] as const;
const PII_FIELDS = ['customerName', 'customerPhone'] as const;

const strip = <T extends { agreedPrice: number | null; customerName: string | null; customerPhone: string | null }>(rows: T[]): T[] =>
  hidePii(hideMoney(rows, [...MONEY_FIELDS]), [...PII_FIELDS]);

function cleanPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const normal = normalizePhone(phone);
  if (!/^\+\d{9,15}$/.test(normal)) throw badRequest('INVALID_PHONE', 'This phone number is not valid');
  return normal;
}

function assertHoldDate(reservedUntil: string): void {
  const now = today();
  if (reservedUntil < now || reservedUntil > addDays(now, RESERVATION_MAX_DAYS)) {
    throw badRequest('RESERVATION_DATE_INVALID', 'The reservation must end today or later, and within a year', {
      from: now,
      to: addDays(now, RESERVATION_MAX_DAYS),
    });
  }
}

const selection = {
  id: r.id,
  animalId: r.animalId,
  animalTag: animals.tag,
  animalCategory: animals.category,
  animalStatus: animals.status,
  herdName: herds.name,
  currentWeightKg: animals.currentWeightKg,
  counterpartyId: r.counterpartyId,
  counterpartyName: counterparties.name,
  customerName: r.customerName,
  customerPhone: r.customerPhone,
  agreedPrice: r.agreedPrice,
  reservedUntil: r.reservedUntil,
  status: r.status,
  note: r.note,
  saleId: r.saleId,
  saleNumber: sales.number,
  requestId: r.requestId,
  closedAt: r.closedAt,
  closeReason: r.closeReason,
  createdAt: r.createdAt,
};

const from = () =>
  tx()
    .select(selection)
    .from(r)
    .innerJoin(animals, eq(animals.id, r.animalId))
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .leftJoin(counterparties, eq(counterparties.id, r.counterpartyId))
    .leftJoin(sales, eq(sales.id, r.saleId));

/** Adds the withdrawal date to open reservations: the animal may be held, but it cannot leave before that day. */
async function withWithdrawal<T extends { animalId: string; status: string }>(rows: T[]) {
  const open = rows.filter((row) => row.status === 'open').map((row) => row.animalId);
  const until = new Map((await animalsUnderWithdrawal(open)).map((w) => [w.animalId, w.withdrawalUntil]));
  return rows.map((row) => ({ ...row, withdrawalUntil: row.status === 'open' ? (until.get(row.animalId) ?? null) : null }));
}

export async function list(q: z.infer<typeof reservationListQuery>) {
  const where = and(
    eq(r.farmId, ctx().farmId),
    q.status ? eq(r.status, q.status) : undefined,
    q.animalId ? eq(r.animalId, q.animalId) : undefined,
    q.counterpartyId ? eq(r.counterpartyId, q.counterpartyId) : undefined,
    // Searching a hidden name would tell whoever cannot see it that it is there.
    searchAny(q.search, hasPermission('pii.view') ? [animals.tag, counterparties.name, r.customerName] : [animals.tag, counterparties.name]),
  );
  const rows = await from()
    .where(where)
    .orderBy(
      ...sortBy(
        q.sort,
        { reservedUntil: r.reservedUntil, createdAt: r.createdAt, tag: animals.tag, status: r.status },
        [sql`case ${r.status} when 'open' then 0 else 1 end`, desc(r.reservedUntil)],
        r.id,
      ),
    )
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [{ total }] = await tx()
    .select({ total: count() })
    .from(r)
    .innerJoin(animals, eq(animals.id, r.animalId))
    .leftJoin(counterparties, eq(counterparties.id, r.counterpartyId))
    .where(where);
  return { data: strip(await withWithdrawal(rows)), meta: { page: q.page, pageSize: q.pageSize, total } };
}

export async function get(id: string) {
  const [row] = await from().where(and(eq(r.id, id), eq(r.farmId, ctx().farmId)));
  if (!row) throw notFound('Reservation');
  return strip(await withWithdrawal([row]))[0];
}

async function lockReservation(id: string): Promise<Reservation> {
  const [row] = await tx()
    .select()
    .from(r)
    .where(and(eq(r.id, id), eq(r.farmId, ctx().farmId)))
    .for('update');
  if (!row) throw notFound('Reservation');
  return row;
}

function assertOpen(row: Reservation): void {
  if (row.status !== 'open') throw conflict('RESERVATION_NOT_OPEN', 'This reservation is no longer open', { status: row.status });
}

async function lockAnimalOnFarm(animalId: string) {
  const [animal] = await tx()
    .select({ id: animals.id, tag: animals.tag, status: animals.status })
    .from(animals)
    .where(and(eq(animals.id, animalId), eq(animals.farmId, ctx().farmId)))
    .for('update');
  if (!animal) throw notFound('Animal');
  if (!(ANIMAL_ON_FARM_STATUSES as readonly string[]).includes(animal.status)) {
    throw conflict('ANIMAL_NOT_ON_FARM', `Animal ${animal.tag} is no longer on the farm`, { animalId: animal.id, tag: animal.tag, status: animal.status });
  }
  return animal;
}

/**
 * Hold an animal for a buyer. An animal under a withdrawal period can be held, since the buyer may
 * be willing to wait: the answer carries the date, and the sale itself is still refused before it.
 */
export async function create(input: ReservationInput, link: { requestId?: string } = {}) {
  assertHoldDate(input.reservedUntil);
  const customerPhone = cleanPhone(input.customerPhone);
  if (!input.counterpartyId && !input.customerName) {
    throw badRequest('RESERVATION_CUSTOMER_REQUIRED', 'Choose the buyer, or enter their name');
  }
  await assertCounterparty(input.counterpartyId);
  // Two people reserving the same animal take turns here, and the second one finds it taken.
  const animal = await lockAnimalOnFarm(input.animalId);

  const c = ctx();
  // The unique index is what decides. Asking it not to raise keeps this transaction usable for the answer.
  const [row] = await tx()
    .insert(r)
    .values({
      id: input.id,
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      animalId: animal.id,
      counterpartyId: input.counterpartyId ?? null,
      customerName: input.customerName ?? null,
      customerPhone,
      agreedPrice: input.agreedPrice ?? null,
      reservedUntil: input.reservedUntil,
      note: input.note ?? null,
      requestId: link.requestId ?? null,
    })
    .onConflictDoNothing({ target: r.animalId, where: sql`status = 'open'` })
    .returning({ id: r.id });
  if (!row) {
    const [held] = await tx()
      .select({ id: r.id, reservedUntil: r.reservedUntil })
      .from(r)
      .where(and(eq(r.animalId, animal.id), eq(r.status, 'open')));
    // The date, not the buyer: who holds it is not for everyone who may reserve.
    throw conflict('ANIMAL_RESERVED', `Animal ${animal.tag} is already reserved`, {
      animalId: animal.id,
      tag: animal.tag,
      reservationId: held?.id ?? null,
      reservedUntil: held?.reservedUntil ?? null,
    });
  }
  await recordEvent({
    type: 'reservation.created',
    entityType: 'animal_reservation',
    entityId: row.id,
    data: { animalId: animal.id, tag: animal.tag, reservedUntil: input.reservedUntil, counterpartyId: input.counterpartyId ?? null },
  });
  return get(row.id);
}

export async function cancel(id: string, reason?: string | null) {
  const row = await lockReservation(id);
  assertOpen(row);
  await tx()
    .update(r)
    .set({ status: 'cancelled', closedBy: ctx().userId, closedAt: new Date(), closeReason: reason ?? null })
    .where(eq(r.id, id));
  await recordEvent({
    type: 'reservation.cancelled',
    entityType: 'animal_reservation',
    entityId: id,
    data: { animalId: row.animalId, reason: reason ?? null },
  });
  return get(id);
}

/**
 * Make the draft sale of a reservation: one animal, sold by the head. The draft moves nothing:
 * confirming it in the sales order is what posts income and takes the animal off the farm, with the
 * withdrawal check and the two-person rule that every sale has. A deposit, if one was taken, is
 * recorded in finance like any other money: this function creates none.
 *
 * The reservation stays open, and so keeps holding the animal, while the draft waits to be
 * confirmed: a draft can wait for a second person, be sent back or be deleted, and none of that may
 * let the animal go to another buyer. It closes as `converted` when the sale is confirmed
 * (`settleReservations`). A deleted draft leaves the reservation as it was before.
 */
export async function convert(id: string, input: z.infer<typeof reservationConvertInput>) {
  const row = await lockReservation(id);
  assertOpen(row);
  if (row.saleId) {
    const [waiting] = await tx()
      .select({ id: sales.id, number: sales.number, status: sales.status })
      .from(sales)
      .where(and(eq(sales.id, row.saleId), eq(sales.farmId, ctx().farmId)));
    const [line] = await tx()
      .select({ id: saleLines.id })
      .from(saleLines)
      .where(and(eq(saleLines.saleId, row.saleId), eq(saleLines.animalId, row.animalId)))
      .limit(1);
    // A cancelled sale is over, and so is one the animal was taken off: the reservation may get a new one.
    if (waiting && line && waiting.status !== 'cancelled') {
      throw conflict('RESERVATION_SALE_EXISTS', `Sale ${waiting.number} was already made for this reservation`, {
        saleId: waiting.id,
        number: waiting.number,
      });
    }
  }
  const counterpartyId = row.counterpartyId ?? input.counterpartyId ?? null;
  if (!counterpartyId) {
    throw badRequest('RESERVATION_NEEDS_COUNTERPARTY', 'Choose the buyer in the books before turning this reservation into a sale');
  }
  const price = input.price ?? row.agreedPrice;
  if (price == null) throw badRequest('RESERVATION_PRICE_REQUIRED', 'Enter the price: none was agreed when the animal was reserved');
  await assertCounterparty(counterpartyId);
  await lockAnimalOnFarm(row.animalId);

  // The buyer first: the sales order lets an animal go only to the buyer it is held for.
  await tx().update(r).set({ counterpartyId }).where(eq(r.id, id));
  const sale = await orders.create({
    date: input.date ?? today(),
    counterpartyId,
    paymentMethod: input.paymentMethod ?? 'debt',
    accountId: input.accountId ?? null,
    lines: [{ animalId: row.animalId, qty: 1, unit: 'head', price }],
  });
  await tx().update(r).set({ saleId: sale.id }).where(eq(r.id, id));
  await recordEvent({
    type: 'reservation.sale_drafted',
    entityType: 'animal_reservation',
    entityId: id,
    data: { animalId: row.animalId, saleId: sale.id, saleNumber: sale.number },
  });
  return get(id);
}

/**
 * Daily: a reservation whose date has passed stops holding the animal, and one whose animal has
 * left the farm some other way (died, lost, slaughtered) is closed. The last day of a reservation
 * still holds, so this takes only dates before today.
 */
export async function expireReservations(): Promise<{ expired: number; closed: number }> {
  const farmId = ctx().farmId;
  const now = today();
  const gone = await tx()
    .select({ id: r.id, animalId: r.animalId })
    .from(r)
    .innerJoin(animals, eq(animals.id, r.animalId))
    .where(and(eq(r.farmId, farmId), eq(r.status, 'open'), notInArray(animals.status, [...ANIMAL_ON_FARM_STATUSES])))
    .for('update', { of: r });
  for (const row of gone) {
    await tx().update(r).set({ status: 'cancelled', closedAt: new Date(), closeReason: 'animal_left' }).where(eq(r.id, row.id));
    await recordEvent({
      type: 'reservation.cancelled',
      entityType: 'animal_reservation',
      entityId: row.id,
      data: { animalId: row.animalId, reason: 'animal_left' },
    });
  }

  const due = await tx()
    .select({ id: r.id, animalId: r.animalId, reservedUntil: r.reservedUntil })
    .from(r)
    .where(
      and(
        eq(r.farmId, farmId),
        eq(r.status, 'open'),
        lt(r.reservedUntil, now),
        gone.length ? notInArray(r.id, gone.map((row) => row.id)) : undefined,
      ),
    )
    .for('update');
  for (const row of due) {
    await tx().update(r).set({ status: 'expired', closedAt: new Date() }).where(eq(r.id, row.id));
    await recordEvent({
      type: 'reservation.expired',
      entityType: 'animal_reservation',
      entityId: row.id,
      severity: 'attention',
      data: { animalId: row.animalId, reservedUntil: row.reservedUntil },
    });
  }
  return { expired: due.length, closed: gone.length };
}
