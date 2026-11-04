import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, tx, withTenant } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import { storage } from '../../core/storage';
import { signFileToken, verifyFileToken } from '../../core/tokens';

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

async function fileUrl(id: string): Promise<string> {
  const c = ctx();
  return `/api/v1/files/${id}/content?token=${await signFileToken(id, c.tenantId, c.farmId)}`;
}

/** Fresh signed URL for a stored file, for modules returning file links. */
export const signedFileUrl = fileUrl;

export default async function filesModule(app: FastifyInstance) {
  const r = routes(app, 'files');

  r.post('/', {
    access: 'authenticated',
    summary: 'Upload a photo or document (multipart, field name "file")',
    handler: async (req) => {
      const part = await req.file();
      if (!part) throw badRequest('FILE_REQUIRED', 'No file was sent');
      const ext = ALLOWED_TYPES[part.mimetype];
      if (!ext) throw badRequest('FILE_TYPE_NOT_ALLOWED', 'This file type is not allowed');
      const body = await part.toBuffer();
      if (!signatureMatches(part.mimetype, body)) {
        throw badRequest('FILE_TYPE_NOT_ALLOWED', 'The file content does not match its type');
      }

      const c = ctx();
      const id = uuidv7();
      const storageKey = `${c.tenantId}/${id}.${ext}`;
      await storage.put(storageKey, body, part.mimetype);
      await tx().insert(files).values({
        id,
        tenantId: c.tenantId,
        farmId: c.farmId,
        createdBy: c.userId,
        storageKey,
        name: part.filename.slice(0, 255),
        mimeType: part.mimetype,
        sizeBytes: body.length,
      });
      return { id, name: part.filename, mimeType: part.mimetype, url: await fileUrl(id) };
    },
  });

  r.get('/:id', {
    access: 'authenticated',
    summary: 'File metadata with a fresh signed URL',
    params: idParam,
    handler: async (req) => {
      const [file] = await tx()
        .select({ id: files.id, name: files.name, mimeType: files.mimeType, sizeBytes: files.sizeBytes })
        .from(files)
        .where(and(eq(files.id, req.params.id), eq(files.farmId, ctx().farmId)));
      if (!file) throw notFound('File');
      return { ...file, url: await fileUrl(file.id) };
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
      const body = await storage.get(file.storageKey).catch((err) => {
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
        .send(body);
      return reply;
    },
  });
}
