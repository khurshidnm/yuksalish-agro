import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, tx, withTenant } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { routes } from '../../core/http';
import { idParam, listQuery } from '../../core/query';
import { openUpload, storage, uploadRateLimit, withUploadMemory } from '../../core/storage';
import { verifyFileToken } from '../../core/tokens';
import * as service from './files.service';

export { signedFileUrl } from './files.service';

const { files } = schema;

/** SVG and HTML are refused: they can carry scripts. */
const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/** Types shown in the browser. Anything else downloads. */
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

/** The declared type is client input, so binary formats must also match by signature. */
function signatureMatches(mime: string, body: Buffer): boolean {
  const starts = (...bytes: number[]) => bytes.every((b, i) => body[i] === b);
  switch (mime) {
    case 'image/jpeg':
      return starts(0xff, 0xd8, 0xff);
    case 'image/png':
      return starts(0x89, 0x50, 0x4e, 0x47);
    case 'image/webp':
      return starts(0x52, 0x49, 0x46, 0x46);
    case 'application/pdf':
      return starts(0x25, 0x50, 0x44, 0x46);
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return starts(0x50, 0x4b);
    default:
      return true;
  }
}

export default async function filesModule(app: FastifyInstance) {
  const r = routes(app, 'files');

  r.post('/', {
    access: 'member',
    summary: 'Upload a photo or document (multipart, field name "file")',
    config: uploadRateLimit,
    handler: (req) =>
      withUploadMemory(req, async () => {
        const upload = await openUpload(req);
        const extension = ALLOWED_TYPES[upload.mimeType];
        if (!extension) throw badRequest('FILE_TYPE_NOT_ALLOWED', 'This file type is not allowed');
        const body = await upload.read();
        if (!signatureMatches(upload.mimeType, body)) {
          throw badRequest('FILE_TYPE_NOT_ALLOWED', 'The file content does not match its type');
        }
        return service.storeFile({ ...upload, extension }, body).catch((err) => {
          // Not awaited: this request's transaction is about to roll back, and the note has to outlive it.
          if (service.isLimitError(err)) {
            withTenant(req.identity, () => service.noteLimitReached(err.code)).catch((failure) =>
              req.log.error({ err: failure }, 'could not note a storage limit'),
            );
          }
          throw err;
        });
      }),
  });

  r.get('/usage', {
    access: 'member',
    summary: "The workspace's storage and the caller's uploads in the last 24 hours, against their limits",
    handler: () => service.storageUsage(),
  });

  r.get('/unused', {
    access: 'member',
    summary: 'Files nothing points at: the caller\'s own, or all of them with settings.update',
    query: listQuery.pick({ page: true, pageSize: true }),
    handler: (req) => service.listUnused(req.query),
  });

  r.delete('/:id', {
    access: 'member',
    summary: 'Delete a file nothing points at: the caller\'s own, or any with settings.update',
    params: idParam,
    handler: (req) => service.deleteFile(req.params.id),
  });

  r.get('/:id', {
    access: 'member',
    summary: 'File metadata with a fresh signed URL',
    params: idParam,
    handler: async (req) => {
      const [file] = await tx()
        .select({ id: files.id, name: files.name, mimeType: files.mimeType, sizeBytes: files.sizeBytes })
        .from(files)
        .where(and(eq(files.id, req.params.id), eq(files.farmId, ctx().farmId)));
      if (!file) throw notFound('File');
      return { ...file, url: await service.signedFileUrl(file.id) };
    },
  });

  r.get('/:id/content', {
    access: 'public',
    summary: 'File content, authorised by the signed token in the URL',
    params: idParam,
    query: z.object({ token: z.string() }),
    handler: async (req, reply) => {
      const claims = await verifyFileToken(req.query.token);
      if (claims.fileId !== req.params.id) throw notFound('File');
      const file = await withTenant({ userId: null, tenantId: claims.tenantId, farmId: claims.farmId }, async () => {
        const [row] = await tx().select().from(files).where(eq(files.id, claims.fileId));
        return row;
      });
      if (!file) throw notFound('File');
      const body = await storage.stream(file.storageKey).catch((err) => {
        // The row outlived its bytes. Anything else, such as storage being down, stays a real error.
        if (err?.code === 'ENOENT' || err?.name === 'NoSuchKey') throw notFound('File');
        throw err;
      });
      const disposition = INLINE_TYPES.has(file.mimeType) ? 'inline' : 'attachment';
      const name = encodeURIComponent(file.name);
      reply
        .header('content-type', file.mimeType)
        .header('content-disposition', `${disposition}; filename*=UTF-8''${name}`)
        .header('x-content-type-options', 'nosniff')
        .header('content-length', file.sizeBytes)
        .send(body);
      return reply;
    },
  });
}
