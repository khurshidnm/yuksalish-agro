/**
 * Cull marks: a person's own decision that an animal is to leave the flock. Kept apart from the
 * suggestions (culling.service.ts), which are worked out from records and never stored.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { CULL_REASONS } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate } from '../../core/query';
import { assertNotFuture, assertOnFarm, getAnimalOrThrow } from './refs';

const { cullMarks: m } = schema;

const note = z.string().trim().max(500).nullish();

export const cullMarkInput = z.object({
  id: clientId,
  animalId: z.uuid(),
  reason: z.enum(CULL_REASONS),
  note,
  date: isoDate.optional(),
});

export const cullClearInput = z.object({ date: isoDate.optional(), note });

export interface OpenCullMark {
  id: string;
  animalId: string;
  reason: string;
  note: string | null;
  markedOn: string;
}

/** The open cull mark of each given animal that has one. Sale readiness reads this. */
export async function openCullMarks(animalIds: string[]): Promise<Map<string, OpenCullMark>> {
  const rows = animalIds.length
    ? await tx()
        .select({ id: m.id, animalId: m.animalId, reason: m.reason, note: m.note, markedOn: m.markedOn })
        .from(m)
        .where(and(eq(m.farmId, ctx().farmId), isNull(m.clearedOn), inArray(m.animalId, animalIds)))
    : [];
  return new Map(rows.map((row) => [row.animalId, row]));
}

/** Mark an animal for culling. One open mark at a time: a second one is refused, not merged. */
export async function markForCulling(i: z.infer<typeof cullMarkInput>) {
  const date = i.date ?? today();
  assertNotFuture(date);
  // The lock makes two people marking the same animal at once take turns, so the check below holds.
  const animal = await getAnimalOrThrow(i.animalId, { lock: true });
  assertOnFarm(animal);
  const existing = (await openCullMarks([animal.id])).get(animal.id);
  if (existing) throw conflict('CULL_MARK_EXISTS', `Animal ${animal.tag} is already marked for culling`, { markId: existing.id, tag: animal.tag });

  const c = ctx();
  const [row] = await tx()
    .insert(m)
    .values({
      ...(i.id ? { id: i.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      animalId: animal.id,
      reason: i.reason,
      note: i.note || null,
      markedOn: date,
    })
    .returning();
  await recordEvent({
    type: 'animal.cull_marked',
    entityType: 'animal',
    entityId: animal.id,
    occurredAt: date,
    severity: 'attention',
    data: { markId: row.id, reason: row.reason },
  });
  return row;
}

/** Take the mark off: she stays in the flock after all. The mark is kept as history. */
export async function clearCullMark(id: string, i: z.infer<typeof cullClearInput>) {
  const date = i.date ?? today();
  assertNotFuture(date);
  const [mark] = await tx()
    .select()
    .from(m)
    .where(and(eq(m.id, id), eq(m.farmId, ctx().farmId)))
    .for('update');
  if (!mark) throw notFound('Cull mark');
  if (mark.clearedOn) throw conflict('CULL_MARK_NOT_OPEN', 'This cull mark has already been cleared');
  if (date < mark.markedOn) throw badRequest('CLEARED_BEFORE_MARKED', 'A mark cannot be cleared before the day it was made', { markedOn: mark.markedOn });
  const [row] = await tx()
    .update(m)
    .set({ clearedOn: date, note: i.note ? [mark.note, i.note].filter(Boolean).join(' | ') : mark.note })
    .where(eq(m.id, id))
    .returning();
  await recordEvent({ type: 'animal.cull_mark_cleared', entityType: 'animal', entityId: mark.animalId, occurredAt: date, data: { markId: id, reason: mark.reason } });
  return row;
}
