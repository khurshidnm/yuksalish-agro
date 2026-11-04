import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@yap/shared';
import { ctx, tx } from '../../core/context';
import { AppError, badRequest } from '../../core/errors';
import { routes } from '../../core/http';
import { idParam, isoDate, listQuery } from '../../core/query';
import { schema } from '../../db/client';
import { ENTITY_KEYS, exportEntity, listEntities } from './export.service';
import { LANG_CODES, type LanguageCode } from './i18n';
import * as service from './import.service';
import { TEMPLATE_KEYS } from './templates';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Who may do what depends on the template, so handlers check that in full through assertTemplate.
 * This list is only the guard's gate, which also applies the 2FA policy. All of these belong to
 * modules that cannot be switched off: listing `farm.create` here would refuse a tenant without
 * that module for every template.
 */
const SIGNED_IN: Permission[] = ['dashboard.view', 'tasks.view', 'settings.view', 'users.view', 'audit.view'];

const langQuery = z.object({ lang: z.enum(LANG_CODES).optional() });

async function languageOf(requested: LanguageCode | undefined): Promise<LanguageCode> {
  if (requested) return requested;
  const [user] = await tx().select({ locale: schema.users.locale }).from(schema.users).where(eq(schema.users.id, ctx().userId!));
  return (LANG_CODES as readonly string[]).includes(user?.locale ?? '') ? (user!.locale as LanguageCode) : 'uz';
}

function sendFile(reply: FastifyReply, file: { body: Buffer; fileName: string; contentType?: string }) {
  reply
    .header('content-type', file.contentType ?? XLSX)
    .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
    .send(file.body);
  return reply;
}

export default async function importModule(app: FastifyInstance) {
  const r = routes(app, 'import');

  r.get('/templates', {
    access: SIGNED_IN,
    summary: 'Templates and exports, with what the caller may use',
    handler: async () => ({ ...(await service.listTemplates()), exports: listEntities() }),
  });

  r.get('/templates/:key', {
    access: SIGNED_IN,
    summary: 'Download a blank template with dropdowns and instructions',
    params: z.object({ key: z.enum(TEMPLATE_KEYS) }),
    query: langQuery,
    handler: async (req, reply) =>
      sendFile(reply, await service.templateFile(req.params.key, await languageOf(req.query.lang))),
  });

  r.get('/jobs', {
    access: SIGNED_IN,
    summary: 'Import history',
    query: listQuery,
    handler: (req) => service.listJobs(req.query),
  });

  r.get('/jobs/:id', {
    access: SIGNED_IN,
    params: idParam,
    handler: (req) => service.getJob(req.params.id),
  });

  r.get('/jobs/:id/rows', {
    access: SIGNED_IN,
    summary: 'Previewed rows with their outcome',
    params: idParam,
    query: service.jobRowsQuery,
    handler: (req) => service.jobRows(req.params.id, req.query),
  });

  r.get('/jobs/:id/errors.xlsx', {
    access: SIGNED_IN,
    summary: 'The failed rows with their reasons, ready to fix and upload again',
    params: idParam,
    handler: async (req, reply) => sendFile(reply, await service.errorFile(req.params.id)),
  });

  r.post('/jobs/:id/confirm', {
    access: SIGNED_IN,
    summary: 'Write every valid row in one transaction',
    params: idParam,
    handler: async (req) => {
      try {
        return await service.confirmJob(req.params.id);
      } catch (err) {
        if (err instanceof AppError && err.code === 'IMPORT_ROW_FAILED') {
          req.log.error({ err: err.cause }, 'import row failed');
        }
        throw err;
      }
    },
  });

  r.post('/jobs/:id/discard', {
    access: SIGNED_IN,
    params: idParam,
    handler: (req) => service.discardJob(req.params.id),
  });

  r.get('/export/:entity', {
    access: SIGNED_IN,
    summary: 'Download a list as Excel or CSV',
    params: z.object({ entity: z.enum(ENTITY_KEYS) }),
    query: langQuery.extend({
      format: z.enum(['xlsx', 'csv']).default('xlsx'),
      from: isoDate.optional(),
      to: isoDate.optional(),
    }),
    handler: async (req, reply) => {
      const { format, lang, from, to } = req.query;
      return sendFile(reply, await exportEntity(req.params.entity, format, await languageOf(lang), { from, to }));
    },
  });

  r.post('/:template', {
    access: SIGNED_IN,
    summary: 'Upload a filled template (multipart, field "file"). Validates every row and writes nothing',
    params: z.object({ template: z.enum(TEMPLATE_KEYS) }),
    query: langQuery,
    handler: async (req) => {
      const part = await req.file();
      if (!part) throw badRequest('FILE_REQUIRED', 'No file was sent');
      const body = await part.toBuffer();
      return service.preview(req.params.template, { body, name: part.filename }, await languageOf(req.query.lang));
    },
  });
}
