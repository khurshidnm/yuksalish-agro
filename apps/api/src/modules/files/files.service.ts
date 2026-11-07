import { and, desc, eq, getTableColumns, gt, is, sql, type AnyColumn } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { schema } from '../../db/client';
import { ctx, hasPermission, tx } from '../../core/context';
import { conflict, forbidden, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { paged, sumOf, type ListQuery } from '../../core/query';
import { storage } from '../../core/storage';
import { signFileToken } from '../../core/tokens';

const { events, files } = schema;

const MB = 1024 * 1024;

/** Postgres stops when its disk fills, and the money records and alerts with it, so uploads stop first. */
const MIN_FREE_DISK_BYTES = 2 * 1024 * MB;

/** The owner hears of it from here, while there is still time to act before uploads stop. */
const LOW_DISK_BYTES = 2 * MIN_FREE_DISK_BYTES;

const LIMIT_EVENT = 'file.limit_reached';

const storageFull = () => conflict('STORAGE_FULL', 'The server is out of disk space');

/** Fresh signed URL for a stored file, for modules returning file links. */
export async function signedFileUrl(id: string): Promise<string> {
  const c = ctx();
  return `/api/v1/files/${id}/content?token=${await signFileToken(id, c.tenantId, c.farmId)}`;
}

async function storedBytes() {
  const c = ctx();
  const [{ all }] = await tx().select({ all: sumOf(files.sizeBytes) }).from(files).where(eq(files.tenantId, c.tenantId));
  const [{ mine }] = await tx()
    .select({ mine: sumOf(files.sizeBytes) })
    .from(files)
    .where(and(eq(files.tenantId, c.tenantId), eq(files.createdBy, c.userId!), gt(files.createdAt, sql`now() - interval '24 hours'`)));
  return { all, mine };
}

async function assertRoomFor(bytes: number): Promise<void> {
  const free = await storage.freeBytes();
  if (free !== null && free - bytes < MIN_FREE_DISK_BYTES) throw storageFull();

  // Two uploads at once must not both pass on the same total.
  const { tenantId, settings } = ctx();
  await tx().execute(sql`select pg_advisory_xact_lock(hashtextextended(${`files:${tenantId}`}, 0))`);
  const { all, mine } = await storedBytes();
  const { quotaMb, dailyUploadMb } = settings.storage;
  if (all + bytes > quotaMb * MB) {
    throw conflict('STORAGE_QUOTA_REACHED', 'This workspace has used all of its file storage', { usedMb: Math.ceil(all / MB), quotaMb });
  }
  if (mine + bytes > dailyUploadMb * MB) {
    throw conflict('DAILY_UPLOAD_LIMIT_REACHED', 'You have reached the daily upload limit', { limitMb: dailyUploadMb });
  }
}

export async function storeFile(upload: { name: string; mimeType: string; extension: string }, body: Buffer) {
  const c = ctx();
  await assertRoomFor(body.length);

  const id = uuidv7();
  const storageKey = `${c.tenantId}/${id}.${upload.extension}`;
  const { name, mimeType } = upload;
  await tx().insert(files).values({
    id,
    tenantId: c.tenantId,
    farmId: c.farmId,
    createdBy: c.userId,
    storageKey,
    name,
    mimeType,
    sizeBytes: body.length,
  });
  await recordEvent({ type: 'file.uploaded', entityType: 'file', entityId: id, data: { name, mimeType, sizeBytes: body.length } });

  // Last, so nothing above can leave bytes on the disk that no row counts.
  try {
    await storage.put(storageKey, body, mimeType);
  } catch (err) {
    await storage.delete(storageKey).catch(() => {});
    throw (err as { code?: string }).code === 'ENOSPC' ? storageFull() : err;
  }
  return { id, name, mimeType, url: await signedFileUrl(id) };
}

/** The room left while it is running out, or null. The disk is also the database's. */
export async function lowDisk(): Promise<{ freeGb: number; stopsAtGb: number } | null> {
  const free = await storage.freeBytes();
  if (free === null || free >= LOW_DISK_BYTES) return null;
  const gb = 1024 * MB;
  return { freeGb: Math.floor((free / gb) * 10) / 10, stopsAtGb: MIN_FREE_DISK_BYTES / gb };
}

export const isLimitError = (err: unknown) =>
  ['STORAGE_QUOTA_REACHED', 'DAILY_UPLOAD_LIMIT_REACHED', 'STORAGE_FULL'].includes((err as { code?: string }).code ?? '');

/** The owner should learn of this from the journal, once a day per person, not once per refused file. */
export async function noteLimitReached(code: string): Promise<void> {
  const c = ctx();
  const [seen] = await tx()
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.farmId, c.farmId),
        eq(events.type, LIMIT_EVENT),
        eq(events.createdBy, c.userId!),
        sql`${events.data}->>'code' = ${code}`,
        gt(events.occurredAt, sql`now() - interval '24 hours'`),
      ),
    )
    .limit(1);
  if (!seen) await recordEvent({ type: LIMIT_EVENT, severity: 'attention', data: { code } });
}

export async function storageUsage() {
  const { quotaMb, dailyUploadMb } = ctx().settings.storage;
  const { all, mine } = await storedBytes();
  return { usedMb: Math.ceil(all / MB), quotaMb, uploadedTodayMb: Math.ceil(mine / MB), dailyUploadMb };
}

/**
 * Every column that points at a file, by the name the schema gives them all. Read from the schema, so
 * a table added later is covered without anyone remembering this list.
 */
const FILE_POINTERS: { table: PgTable; column: AnyColumn; many: boolean }[] = Object.values(schema as Record<string, unknown>)
  .filter((value): value is PgTable => is(value, PgTable))
  .flatMap((table) =>
    Object.entries(getTableColumns(table))
      .filter(([key]) => /fileIds?$/i.test(key))
      .map(([key, column]) => ({ table, column, many: key.endsWith('s') })),
  );

/** Ids of every file something points at. A stored investor report is such a file, through its journal entry. */
function usedFiles() {
  const pointers = FILE_POINTERS.map(({ table, column, many }) =>
    many ? sql`select jsonb_array_elements_text(${column}) as id from ${table}` : sql`select ${column}::text as id from ${table}`,
  );
  const reports = sql`select ${events.entityId}::text as id from ${events} where ${events.entityType} = 'file' and ${events.type} not like 'file.%'`;
  return sql.join([...pointers, reports], sql` union all `);
}

const canManageAllFiles = () => hasPermission('settings.update');

/** What can be deleted: a person's own, or everything for someone who runs the workspace. */
export async function listUnused(q: Pick<ListQuery, 'page' | 'pageSize'>) {
  const c = ctx();
  const where = and(
    eq(files.farmId, c.farmId),
    canManageAllFiles() ? undefined : eq(files.createdBy, c.userId!),
    sql`not exists (select 1 from (${usedFiles()}) used where used.id = ${files.id}::text)`,
  );
  return paged(q, files, where, (limit, offset) =>
    tx()
      .select({ id: files.id, name: files.name, mimeType: files.mimeType, sizeBytes: files.sizeBytes, createdAt: files.createdAt })
      .from(files)
      .where(where)
      .orderBy(desc(files.createdAt), desc(files.id))
      .limit(limit)
      .offset(offset),
  );
}

export async function deleteFile(id: string) {
  const c = ctx();
  const [file] = await tx()
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.farmId, c.farmId)))
    .for('update');
  if (!file) throw notFound('File');
  if (file.createdBy !== c.userId && !canManageAllFiles()) throw forbidden(undefined, 'FORBIDDEN', { required: 'settings.update' });

  const result = await tx().execute<{ used: boolean }>(
    sql`select exists (select 1 from (${usedFiles()}) used where used.id = ${id}) as used`,
  );
  if (result.rows[0].used) throw conflict('IN_USE', 'This file is attached to a record');

  await tx().delete(files).where(eq(files.id, id));
  await recordEvent({
    type: 'file.deleted',
    entityType: 'file',
    entityId: id,
    data: { name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes },
  });
  // Last: a failure here undoes the row, and the file stays whole.
  await storage.delete(file.storageKey);
  return { id };
}
