import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as care from './lamb-care.service';
import * as deskService from './lambing-desk.service';
import * as pens from './pens.service';
import * as scans from './scans.service';

// The same choice as the breeding routes: whoever may record a lambing may record what surrounds it.
const WRITE = ['livestock.create', 'health.update'] as const;
const CHANGE = ['livestock.update', 'health.update'] as const;

export function registerLambingDesk(app: FastifyInstance) {
  const r = routes(app, 'livestock');

  // ─── Pregnancy scanning ───────────────────────────────────────────────────

  r.get('/scans/ewes', {
    access: 'livestock.view',
    summary: 'Pregnant ewes by the number of foetuses their scan found',
    query: scans.scanEwesQuery,
    handler: (req) => scans.scanEwes(req.query),
  });

  r.post('/scans/bulk', {
    access: [...WRITE],
    summary: 'A scanning day: one foetus count per ewe, by tag; 0 closes the pregnancy',
    body: scans.bulkScanInput,
    handler: async (req, reply) => {
      reply.code(201);
      return scans.bulkScan(req.body);
    },
  });

  r.get('/breeding/:id/scans', {
    access: 'livestock.view',
    params: idParam,
    handler: (req) => scans.listScans(req.params.id),
  });

  r.post('/breeding/:id/scans', {
    access: [...WRITE],
    summary: 'Record a pregnancy scan; a count of 0 closes the pregnancy as not pregnant',
    params: idParam,
    body: scans.scanInput,
    handler: async (req, reply) => {
      reply.code(201);
      return scans.recordScan(req.params.id, req.body);
    },
  });

  // ─── The desk and the night watch ─────────────────────────────────────────

  r.get('/lambing-desk', {
    access: 'livestock.view',
    summary: 'Lambing desk: counts, ewes due, lambs needing attention, pens',
    query: deskService.watchQuery,
    handler: (req) => deskService.desk(req.query.days),
  });

  r.get('/lambing-desk/watch', {
    access: 'livestock.view',
    summary: 'Night-watch list: ewes due soon and overdue, soonest first',
    query: deskService.watchQuery,
    handler: (req) => deskService.nightWatch(req.query.days),
  });

  // ─── Newborn care ─────────────────────────────────────────────────────────

  r.get('/lambs/attention', {
    access: 'livestock.view',
    summary: 'Live lambs with no colostrum on record, and orphans on the bottle',
    handler: () => care.lambsNeedingAttention(),
  });

  r.get('/lambs/:id/care', {
    access: 'livestock.view',
    params: idParam,
    handler: (req) => care.getCare(req.params.id),
  });

  r.post('/lambs/:id/care', {
    access: [...WRITE],
    summary: 'Record or correct newborn care: colostrum, navel, who raises the lamb',
    params: idParam,
    body: care.careInput,
    handler: (req) => care.saveCare(req.params.id, req.body),
  });

  // ─── Lambing pens ─────────────────────────────────────────────────────────

  r.get('/pens', {
    access: 'livestock.view',
    summary: 'Lambing pens with who is in each',
    handler: () => pens.listPens(),
  });

  r.get('/pens/sections', {
    access: 'livestock.view',
    summary: 'Barn sections, and which of them are lambing pens',
    handler: () => pens.listSections(),
  });

  r.post('/pens/sections/:id', {
    access: [...CHANGE],
    summary: 'Mark a barn section as a lambing pen, or take the mark off',
    params: idParam,
    body: pens.penMarkInput,
    handler: (req) => pens.markPen(req.params.id, req.body.lambingPen),
  });

  r.post('/pens/stays', {
    access: [...WRITE],
    summary: 'Put a ewe and her newborn lambs into a pen',
    body: pens.penStayInput,
    handler: async (req, reply) => {
      reply.code(201);
      return pens.putInPen(req.body);
    },
  });

  r.post('/pens/stays/:id/release', {
    access: [...WRITE],
    summary: 'Let a ewe and her lambs out of the pen',
    params: idParam,
    body: pens.penReleaseInput,
    handler: (req) => pens.releaseFromPen(req.params.id, req.body),
  });
}
