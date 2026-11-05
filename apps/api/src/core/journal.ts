import type { EventSource, Severity } from '@yap/shared';
import { schema } from '../db/client';
import { ctx, tx } from './context';

export interface EventInput {
  /** Dotted type, e.g. 'animal.vaccinated'. */
  type: string;
  entityType?: string;
  entityId?: string | null;
  severity?: Severity;
  data?: Record<string, unknown>;
  /** A business date (YYYY-MM-DD) or an exact time. Defaults to now. */
  occurredAt?: string | Date;
  source?: EventSource;
  photoFileId?: string | null;
  deviceId?: string | null;
  /** The same device and key again is not stored, and the result says so. */
  dedupKey?: string;
}

/** Midday at UTC+5, so a business date stays on the same local day in any report. */
function toTimestamp(value: string | Date | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    return new Date(value.length === 10 ? `${value}T12:00:00+05:00` : value);
  }
  return new Date();
}

/** Append to the unified journal (spec 4.1 p.4). False means this event is already there. */
export async function recordEvent(input: EventInput): Promise<boolean> {
  const c = ctx();
  const stored = await tx()
    .insert(schema.events)
    .values({
      tenantId: c.tenantId,
      farmId: c.farmId,
      occurredAt: toTimestamp(input.occurredAt),
      source: input.source ?? c.source,
      type: input.type,
      severity: input.severity ?? 'info',
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      data: input.data ?? {},
      photoFileId: input.photoFileId ?? null,
      deviceId: input.deviceId ?? null,
      dedupKey: input.dedupKey,
      createdBy: c.userId,
    })
    .onConflictDoNothing()
    .returning({ id: schema.events.id });
  return stored.length > 0;
}
