/**
 * Who an animal is held for. The sales order, the livestock exit and the sale-readiness list all ask
 * here, so "reserved" means the same thing everywhere. This file imports no other service: it is a
 * leaf, which keeps sales and livestock from importing each other in a circle.
 *
 * The rule: while a reservation is open, the animal can be sold only to the buyer it is held for.
 * A reservation made for a name and phone alone has no buyer in the books yet, so it blocks every
 * sale until it is turned into one (which asks for the buyer) or cancelled.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { conflict } from '../../core/errors';
import { recordEvent } from '../../core/journal';

const { animalReservations: r, animals, counterparties } = schema;

export interface OpenReservation {
  id: string;
  animalId: string;
  tag: string;
  counterpartyId: string | null;
  counterpartyName: string | null;
  /** Personal data. The caller decides who may see it. */
  customerName: string | null;
  customerPhone: string | null;
  /** Money. The caller decides who may see it. */
  agreedPrice: number | null;
  reservedUntil: string;
}

/** The open reservation of each given animal that has one. Raw: callers strip money and personal data. */
export async function openReservations(animalIds: string[]): Promise<Map<string, OpenReservation>> {
  const rows = animalIds.length
    ? await tx()
        .select({
          id: r.id,
          animalId: r.animalId,
          tag: animals.tag,
          counterpartyId: r.counterpartyId,
          counterpartyName: counterparties.name,
          customerName: r.customerName,
          customerPhone: r.customerPhone,
          agreedPrice: r.agreedPrice,
          reservedUntil: r.reservedUntil,
        })
        .from(r)
        .innerJoin(animals, eq(animals.id, r.animalId))
        .leftJoin(counterparties, eq(counterparties.id, r.counterpartyId))
        .where(and(eq(r.farmId, ctx().farmId), eq(r.status, 'open'), inArray(r.animalId, animalIds)))
    : [];
  return new Map(rows.map((row) => [row.animalId, row]));
}

/**
 * Refuse a sale of an animal that is held for somebody else. The answer names the animal and the
 * date, never the other buyer: whoever is selling may not hold the right to see who that is.
 */
export async function assertNotReservedForOthers(animalIds: string[], buyerId: string | null | undefined): Promise<void> {
  const held = [...(await openReservations(animalIds)).values()].filter((row) => !row.counterpartyId || row.counterpartyId !== buyerId);
  if (held.length === 0) return;
  throw conflict('ANIMAL_RESERVED_FOR_OTHER', `${held.length} animal(s) are reserved for another buyer`, {
    animals: held.map((row) => ({ animalId: row.animalId, tag: row.tag, reservationId: row.id, reservedUntil: row.reservedUntil })),
  });
}

/**
 * A sale to the buyer an animal was held for has gone through: the reservation has done its work.
 * `saleId` is null when the animal left through a livestock exit, which has no sale document.
 */
export async function settleReservations(animalIds: string[], buyerId: string, saleId: string | null): Promise<void> {
  const mine = [...(await openReservations(animalIds)).values()].filter((row) => row.counterpartyId === buyerId);
  for (const row of mine) {
    await tx()
      .update(r)
      .set({ status: 'converted', saleId, closedBy: ctx().userId, closedAt: new Date() })
      .where(and(eq(r.id, row.id), eq(r.status, 'open')));
    await recordEvent({
      type: 'reservation.converted',
      entityType: 'animal_reservation',
      entityId: row.id,
      data: { animalId: row.animalId, tag: row.tag, saleId, bySale: true },
    });
  }
}
