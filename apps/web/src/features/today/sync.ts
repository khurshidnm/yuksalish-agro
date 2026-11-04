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

/**
 * For someone not allowed to change the saved record. Their version goes into the farm journal and
 * the zootechnician is alerted, so nothing is lost and a person who may decide does.
 */
export async function sendToManager(record: OutboxRecord): Promise<void> {
  await api.post(
    '/today/conflicts',
    {
      id: record.id,
      herdId: record.meta.herdId,
      date: record.meta.date,
      serverLogId: record.serverId,
      mine: fields(record),
    },
    { idempotencyKey: `conflict-${record.id}` },
  );
  await outbox.settled(record.id);
}
