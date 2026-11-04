import { addDays, DOCUMENT_TYPES } from '@yap/shared';
import { expiryState } from '@yap/shared/formulas/land';
import { and, desc, eq, gte, isNotNull, lt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ctx, today, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { schema } from '../../db/client';
import { signedFileUrl } from '../files';

const { documents: t, files } = schema;

/** "Soon" for a document: the same 30 days the expiry reminders use. */
const WARN_DAYS = 30;

export const documentInput = z.object({
  id: clientId,
  type: z.enum(DOCUMENT_TYPES),
  title: z.string().trim().min(1).max(200),
  number: z.string().trim().max(80).nullish(),
  fileId: z.uuid().nullish(),
  issueDate: isoDate.nullish(),
  expiryDate: isoDate.nullish(),
  /** Any object: 'field', 'facility', 'animal', 'asset', 'counterparty', ... */
  entityType: z.string().trim().max(40).nullish(),
  entityId: z.uuid().nullish(),
  notes: z.string().trim().max(1000).nullish(),
});
export type DocumentInput = z.infer<typeof documentInput>;

export const documentListQuery = listQuery.extend({
  type: z.enum(DOCUMENT_TYPES).optional(),
  entityType: z.string().trim().max(40).optional(),
  entityId: z.uuid().optional(),
  expiry: z.enum(['expired', 'expiring']).optional(),
  withinDays: z.coerce.number().int().min(0).max(3650).default(WARN_DAYS),
});

function assertDates(issueDate: string | null | undefined, expiryDate: string | null | undefined): void {
  if (issueDate && expiryDate && expiryDate < issueDate) {
    throw badRequest('EXPIRY_BEFORE_ISSUE', 'The expiry date is before the issue date');
  }
}

function assertEntityPair(entityType: string | null | undefined, entityId: string | null | undefined): void {
  if (!entityType !== !entityId) {
    throw badRequest('ENTITY_INCOMPLETE', 'A linked object needs both a type and an id');
  }
}

/** The foreign key alone would accept another tenant's file, because FK checks bypass RLS. */
async function assertFile(fileId: string | null | undefined): Promise<void> {
  if (!fileId) return;
  const [file] = await tx().select({ id: files.id }).from(files).where(and(eq(files.id, fileId), eq(files.farmId, ctx().farmId)));
  if (!file) throw badRequest('FILE_NOT_FOUND', 'The attached file was not found');
}

export async function listDocuments(q: z.infer<typeof documentListQuery>) {
  const now = today();
  const where = and(
    eq(t.farmId, ctx().farmId),
    q.type ? eq(t.type, q.type) : undefined,
    q.entityType ? eq(t.entityType, q.entityType) : undefined,
    q.entityId ? eq(t.entityId, q.entityId) : undefined,
    q.expiry === 'expired' ? and(isNotNull(t.expiryDate), lt(t.expiryDate, now)) : undefined,
    q.expiry === 'expiring'
      ? and(isNotNull(t.expiryDate), gte(t.expiryDate, now), lte(t.expiryDate, addDays(now, q.withinDays)))
      : undefined,
    searchAny(q.search, [t.title, t.number, t.notes]),
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select({
        id: t.id,
        type: t.type,
        title: t.title,
        number: t.number,
        fileId: t.fileId,
        fileName: files.name,
        fileMimeType: files.mimeType,
        issueDate: t.issueDate,
        expiryDate: t.expiryDate,
        entityType: t.entityType,
        entityId: t.entityId,
        notes: t.notes,
        createdAt: t.createdAt,
      })
      .from(t)
      .leftJoin(files, eq(files.id, t.fileId))
      .where(where)
      .orderBy(
        ...sortBy(
          q.sort,
          { title: t.title, type: t.type, issueDate: t.issueDate, expiryDate: t.expiryDate, createdAt: t.createdAt },
          // Documents needing attention come first, then the newest.
          [sql`${t.expiryDate} asc nulls last`, desc(t.createdAt)],
          t.id,
        ),
      )
      .limit(limit)
      .offset(offset),
  );
  const data = await Promise.all(
    page.data.map(async (row) => ({
      ...row,
      expiryState: expiryState(row.expiryDate, now, WARN_DAYS),
      fileUrl: row.fileId ? await signedFileUrl(row.fileId) : null,
    })),
  );
  return { ...page, data };
}

async function getRow(id: string) {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Document');
  return row;
}

export async function getDocument(id: string) {
  const row = await getRow(id);
  return {
    ...row,
    expiryState: expiryState(row.expiryDate, today(), WARN_DAYS),
    fileUrl: row.fileId ? await signedFileUrl(row.fileId) : null,
  };
}

export async function createDocument(input: DocumentInput) {
  assertDates(input.issueDate, input.expiryDate);
  assertEntityPair(input.entityType, input.entityId);
  await assertFile(input.fileId);
  const c = ctx();
  const { id, ...values } = input;
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({ type: 'document.created', entityType: 'document', entityId: row.id, data: { title: row.title, type: row.type } });
  return row;
}

export async function updateDocument(id: string, input: Partial<DocumentInput>) {
  const current = await getRow(id);
  assertDates(
    input.issueDate === undefined ? current.issueDate : input.issueDate,
    input.expiryDate === undefined ? current.expiryDate : input.expiryDate,
  );
  assertEntityPair(
    input.entityType === undefined ? current.entityType : input.entityType,
    input.entityId === undefined ? current.entityId : input.entityId,
  );
  await assertFile(input.fileId);
  const { id: _ignored, ...values } = input;
  const [row] = await tx().update(t).set(values).where(eq(t.id, id)).returning();
  return row;
}

export async function removeDocument(id: string) {
  const row = await getRow(id);
  await tx().delete(t).where(eq(t.id, id));
  await recordEvent({ type: 'document.deleted', entityType: 'document', entityId: id, data: { title: row.title } });
  return { id };
}
