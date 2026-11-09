import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest } from '../../core/errors';
import { routes } from '../../core/http';
import { idParam, isoMonth } from '../../core/query';
import { deliverSaved } from './delivery';
import { canRun, enabledModules, getDefinitionOrThrow, PERIOD_PRESETS, runReport, visibleColumns, VIEW_ROW_LIMIT } from './engine';
import { EXPORT_FORMATS, exportReport, type ExportFormat } from './export';
import { enumLabel, resolveLang, t } from './i18n';
import { assertCanReadInvestorReport, investorArchive, investorData, investorPdf, reportingMonth } from './investor';
import { REPORTS, REPORTS_BY_KEY } from './registry';
import * as saved from './saved.service';
import type { FilterDef, Lang, ReportDefinition } from './types';

const { users } = schema;

const keyParam = z.object({ key: z.string().max(80) });
/** Filters differ per report, so they are validated by the engine against its definition. */
const rawQuery = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const RESERVED = ['lang', 'columns', 'groupBy', 'format'];

function flatten(query: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(query).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]));
}

function runOptions(query: Record<string, string | string[]>, lang: Lang) {
  const flat = flatten(query);
  const raw = Object.fromEntries(Object.entries(flat).filter(([k]) => !RESERVED.includes(k)));
  return {
    raw,
    lang,
    columns: flat.columns?.split(',').filter(Boolean),
    groupBy: flat.groupBy || undefined,
  };
}

/** The language asked for, otherwise the one the user chose in their profile. */
async function languageOf(requested: string | string[] | undefined): Promise<Lang> {
  if (typeof requested === 'string' && requested) return resolveLang(requested);
  const [user] = await tx().select({ locale: users.locale }).from(users).where(eq(users.id, ctx().userId!));
  return resolveLang(user?.locale);
}

function describeFilter(filter: FilterDef, lang: Lang) {
  const base = { key: filter.key, type: filter.type, label: t(lang, `filters.${filter.key}`) };
  switch (filter.type) {
    case 'period':
      return { ...base, preset: filter.preset };
    case 'month':
      return { ...base, default: filter.default };
    case 'number':
      return { ...base, default: filter.default, min: filter.min, max: filter.max };
    case 'select':
      return { ...base, options: filter.values.map((value) => ({ value, label: enumLabel(lang, filter.enumGroup, value) })) };
    case 'lookup':
      // An empty season is not "all": the screen names the season the report falls back to.
      return {
        ...base,
        path: filter.path,
        params: filter.params,
        ...(filter.defaultSeason ? { emptyLabel: t(lang, `seasonDefault.${filter.defaultSeason}`) } : {}),
      };
  }
}

function describe(def: ReportDefinition, lang: Lang) {
  return {
    key: def.key,
    module: def.module,
    title: t(lang, `catalog.${def.key}.title`),
    description: t(lang, `catalog.${def.key}.description`),
    money: !!def.money,
    filters: def.filters.map((filter) => describeFilter(filter, lang)),
    // Only what this caller may see, so the builder cannot offer a hidden column.
    columns: visibleColumns(def).map((c) => ({
      key: c.key,
      label: t(lang, `columns.${c.label ?? c.key}`, c.labelParams),
      type: c.type,
      sum: !!c.sum,
    })),
    compare: def.compare ? { filter: def.compare.filter } : null,
    hasChart: !!def.chart,
  };
}

function sendFile(reply: FastifyReply, file: { body: Buffer; contentType: string; filename: string }) {
  reply
    .header('content-type', file.contentType)
    .header('content-disposition', `attachment; filename="${file.filename}"`)
    .header('x-content-type-options', 'nosniff')
    .send(file.body);
  return reply;
}

export default async function reportsModule(app: FastifyInstance) {
  const r = routes(app, 'reports');

  r.get('/', {
    access: 'reports.view',
    summary: 'Reports this user may run',
    query: z.object({ lang: z.string().optional() }),
    handler: async (req) => {
      const lang = await languageOf(req.query.lang);
      const modules = await enabledModules();
      return {
        presets: PERIOD_PRESETS,
        reports: REPORTS.filter((def) => modules.has(def.module) && canRun(def)).map((def) => describe(def, lang)),
      };
    },
  });

  // Static paths are matched before /:key, so a report key can never shadow these.
  r.get('/saved', {
    access: 'reports.view',
    summary: 'Saved reports',
    handler: () => saved.listSaved(),
  });

  r.post('/saved', {
    access: 'reports.view',
    summary: 'Save a report with its columns, filters, grouping and schedule',
    body: saved.savedInput,
    handler: async (req, reply) => {
      reply.code(201);
      return saved.createSaved(req.body);
    },
  });

  r.patch('/saved/:id', {
    access: 'reports.view',
    params: idParam,
    body: saved.savedPatch,
    handler: (req) => saved.updateSaved(req.params.id, req.body),
  });

  r.delete('/saved/:id', {
    access: 'reports.view',
    params: idParam,
    handler: (req) => saved.removeSaved(req.params.id),
  });

  r.post('/saved/:id/send', {
    access: 'reports.view',
    summary: 'Send a saved report to its recipients now',
    params: idParam,
    handler: async (req) => ({ recipients: await deliverSaved(await saved.getManaged(req.params.id)) }),
  });

  r.get('/investor', {
    access: 'reports.view',
    summary: 'Investor one-pager data for a month (spec 14.2)',
    query: z.object({ month: isoMonth.optional() }),
    handler: async (req) => {
      assertCanReadInvestorReport();
      return investorData(req.query.month ?? reportingMonth(today()));
    },
  });

  r.get('/investor/pdf', {
    access: 'reports.view',
    summary: 'Investor one-pager as PDF',
    query: z.object({ month: isoMonth.optional(), lang: z.string().optional() }),
    handler: async (req, reply) => {
      assertCanReadInvestorReport();
      const month = req.query.month ?? reportingMonth(today());
      const lang = await languageOf(req.query.lang);
      const body = await investorPdf(await investorData(month), lang);
      return sendFile(reply, { body, contentType: 'application/pdf', filename: `investor_${month}.pdf` });
    },
  });

  r.get('/investor/archive', {
    access: 'reports.view',
    summary: 'Monthly investor PDFs already generated',
    handler: async () => {
      assertCanReadInvestorReport();
      return investorArchive();
    },
  });

  r.get('/:key', {
    access: 'reports.view',
    summary: 'Run a report. Query takes its filters, plus columns, groupBy and lang',
    params: keyParam,
    query: rawQuery,
    handler: async (req) => {
      const def = getDefinitionOrThrow(REPORTS_BY_KEY, req.params.key);
      const lang = await languageOf(req.query.lang);
      return runReport(def, { ...runOptions(req.query, lang), limit: VIEW_ROW_LIMIT });
    },
  });

  r.get('/:key/export', {
    access: 'reports.view',
    summary: 'Download a report as xlsx, csv or pdf',
    params: keyParam,
    query: rawQuery,
    handler: async (req, reply) => {
      const def = getDefinitionOrThrow(REPORTS_BY_KEY, req.params.key);
      const format = req.query.format;
      if (typeof format !== 'string' || !EXPORT_FORMATS.includes(format as ExportFormat)) {
        throw badRequest('INVALID_FORMAT', 'Choose xlsx, csv or pdf');
      }
      const lang = await languageOf(req.query.lang);
      const result = await runReport(def, runOptions(req.query, lang));
      return sendFile(reply, await exportReport(result, format as ExportFormat));
    },
  });
}
