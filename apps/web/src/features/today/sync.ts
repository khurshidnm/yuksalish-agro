/** Settling a conflict between an offline daily log and the one already on the server. */
import { api } from '@/lib/api';
import { bodyWithPhotos, outbox, type OutboxRecord } from '@/lib/outbox';

export interface ServerDailyLog {
  id: string;
  updatedAt: string;
  herdName: string | null;
  waterL: number | null;
  condition: string;
  notes: string | null;
  lines: { itemId: string; itemName: string; unit: string; actualQty: number }[];
}

function fields(record: OutboxRecord) {
  const { lines, waterL, condition, notes } = bodyWithPhotos(record);
  return { lines, waterL, condition, notes };
}

/** Replace the saved record with mine. Stock is reversed and issued again on the server. */
export async function keepMine(record: OutboxRecord): Promise<void> {
  const path = `/livestock/daily-logs/${record.serverId}`;
  const server = await api.get<ServerDailyLog>(path);
  await api.patch(path, { ...fields(record), baseUpdatedAt: server.updatedAt });
  await outbox.settled(record.id);
}

/** Keep what is saved. Mine is removed from this phone at the person's own choice. */
export async function keepServer(record: OutboxRecord): Promise<void> {
  await outbox.discard(record.id);
}

/** The saved log this record is about, if any: a refused first record has none. */
function savedLogId(record: OutboxRecord): string | null {
  return record.serverId ?? (record.method === 'PATCH' ? (record.path.split('/').pop() ?? null) : null);
}

/**
 * For someone who cannot get their record in: it clashes with a saved one they may not change, or the
 * server refused it. Their version goes into the farm journal and the zootechnician is alerted, so
 * nothing is lost and a person who may decide does.
 */
export async function sendToManager(record: OutboxRecord): Promise<void> {
  await api.post(
    '/today/conflicts',
    {
      id: record.id,
      herdId: record.meta.herdId,
      date: record.meta.date,
      serverLogId: savedLogId(record),
      mine: fields(record),
    },
    { idempotencyKey: `conflict-${record.id}` },
  );
  await outbox.settled(record.id);
}
