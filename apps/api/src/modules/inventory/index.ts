import { LANGUAGES, type LanguageCode } from '@yap/shared/i18n';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as counts from './counts.service';
import { countPdf, documentPdf } from './documents.service';
import { itemByCodeQuery, itemsByCode } from './item-codes.service';
import * as itemsService from './items.service';
import * as stock from './stock.service';
import { lowStock } from './summary';
import * as warehouses from './warehouses.service';

const pdfQuery = z.object({ lang: z.enum(LANGUAGES.map((l) => l.code) as [LanguageCode, ...LanguageCode[]]).optional() });

/** The language asked for, else the signed-in user's own. */
async function pdfLanguage(requested?: LanguageCode): Promise<LanguageCode> {
  if (requested) return requested;
  const userId = ctx().userId;
  if (!userId) return 'uz';
  const [user] = await tx().select({ locale: schema.users.locale }).from(schema.users).where(eq(schema.users.id, userId));
  return LANGUAGES.some((l) => l.code === user?.locale) ? (user!.locale as LanguageCode) : 'uz';
}

function sendPdf(reply: FastifyReply, body: Buffer, name: string) {
  reply
    .header('content-type', 'application/pdf')
    .header('content-disposition', `attachment; filename="${encodeURIComponent(name)}.pdf"`)
    .send(body);
  return reply;
}

export default async function inventoryModule(app: FastifyInstance) {
  const r = routes(app, 'inventory');

  // Master data needs inventory.update: inventory.create is for documents, which agronomists,
  // zootechnicians and vets also enter.
  r.get('/warehouses', {
    access: 'inventory.view',
    query: warehouses.warehouseListQuery,
    handler: (req) => warehouses.list(req.query),
  });
  r.get('/warehouses/lookup', {
    access: 'authenticated',
    summary: 'Id and name only, for dropdowns in other modules',
    query: z.object({ search: z.string().trim().optional(), type: warehouses.warehouseListQuery.shape.type }),
    handler: (req) => warehouses.lookup(req.query),
  });
  r.get('/warehouses/:id', {
    access: 'inventory.view',
    params: idParam,
    handler: (req) => warehouses.get(req.params.id),
  });
  r.post('/warehouses', {
    access: 'inventory.update',
    body: warehouses.warehouseInput,
    handler: async (req, reply) => {
      reply.code(201);
      return warehouses.create(req.body);
    },
  });
  r.patch('/warehouses/:id', {
    access: 'inventory.update',
    params: idParam,
    body: warehouses.warehouseInput.partial(),
    handler: (req) => warehouses.update(req.params.id, req.body),
  });
  r.delete('/warehouses/:id', {
    access: 'inventory.delete',
    params: idParam,
    handler: (req) => warehouses.remove(req.params.id),
  });

  r.get('/items', {
    access: 'inventory.view',
    query: itemsService.itemListQuery,
    handler: (req) => itemsService.list(req.query),
  });
  r.get('/items/lookup', {
    access: 'authenticated',
    summary: 'For dropdowns in other modules. `category` may be a comma-separated list',
    query: itemsService.itemLookupQuery,
    handler: (req) => itemsService.lookup(req.query),
  });
  r.get('/items/by-code', {
    access: 'inventory.view',
    summary: 'Items that carry exactly this barcode, code or label. Empty when none. Never a near match.',
    query: itemByCodeQuery,
    handler: (req) => itemsByCode(req.query.code),
  });
  r.get('/items/:id', {
    access: 'inventory.view',
    params: idParam,
    handler: (req) => itemsService.get(req.params.id),
  });
  r.post('/items', {
    access: 'inventory.update',
    body: itemsService.itemInput,
    handler: async (req, reply) => {
      reply.code(201);
      return itemsService.createItem(req.body);
    },
  });
  r.patch('/items/:id', {
    access: 'inventory.update',
    params: idParam,
    body: itemsService.itemInput.partial(),
    handler: (req) => itemsService.update(req.params.id, req.body),
  });
  r.delete('/items/:id', {
    access: 'inventory.delete',
    params: idParam,
    handler: (req) => itemsService.remove(req.params.id),
  });

  r.get('/stock', {
    access: 'inventory.view',
    summary: 'Balances per item and warehouse',
    query: stock.balanceQuery,
    handler: (req) => stock.balances(req.query),
  });
  r.get('/stock/low', {
    access: 'inventory.view',
    summary: 'Items below their minimum quantity or days of stock',
    handler: () => lowStock(),
  });
  r.get('/stock/expiring', {
    access: 'inventory.view',
    summary: 'Batches expiring within `days`',
    query: stock.expiringQuery,
    handler: (req) => stock.expiring(req.query.days),
  });
  r.get('/stock/:id/batches', {
    access: 'inventory.view',
    summary: 'Batches of one item',
    params: idParam,
    query: stock.batchesQuery,
    handler: (req) => stock.batches(req.params.id, req.query),
  });

  r.post('/receipts', {
    access: 'inventory.create',
    summary: 'Receive stock. With `payment`, also posts the expense or debt (needs finance.create)',
    body: stock.receiptInput,
    handler: async (req, reply) => {
      reply.code(201);
      return stock.createReceipt(req.body);
    },
  });
  r.post('/issues', {
    access: 'inventory.create',
    summary: 'Issue stock to a cost center',
    body: stock.issueInput,
    handler: async (req, reply) => {
      reply.code(201);
      return stock.createIssue(req.body);
    },
  });
  r.post('/transfers', {
    access: 'inventory.create',
    summary: 'Move stock between warehouses',
    body: stock.transferInput,
    handler: async (req, reply) => {
      reply.code(201);
      return stock.createTransfer(req.body);
    },
  });

  r.get('/movements', {
    access: 'inventory.view',
    summary: 'Movement journal. `type` may be a comma-separated list',
    query: stock.movementsQuery,
    handler: (req) => stock.movements(req.query),
  });

  const docParams = z.object({ docNo: z.string().min(1).max(40) });
  r.get('/documents/:docNo/pdf', {
    access: 'inventory.view',
    summary: 'Receipt order, issue requisition or transfer note as PDF',
    params: docParams,
    query: pdfQuery,
    handler: async (req, reply) =>
      sendPdf(reply, await documentPdf(req.params.docNo, await pdfLanguage(req.query.lang)), req.params.docNo),
  });
  r.post('/documents/:docNo/reverse', {
    access: 'inventory.delete',
    summary: 'Undo a mistaken receipt or issue',
    params: docParams,
    handler: (req) => stock.reverseDocument(req.params.docNo),
  });

  r.get('/counts', {
    access: 'inventory.view',
    query: counts.countListQuery,
    handler: (req) => counts.list(req.query),
  });
  r.post('/counts', {
    access: 'inventory.create',
    summary: 'Start a stock count: a draft sheet with the book quantities',
    body: counts.countCreateInput,
    handler: async (req, reply) => {
      reply.code(201);
      return counts.create(req.body);
    },
  });
  r.get('/counts/:id', {
    access: 'inventory.view',
    params: idParam,
    handler: (req) => counts.get(req.params.id),
  });
  r.patch('/counts/:id', {
    access: 'inventory.create',
    params: idParam,
    body: counts.countUpdateInput,
    handler: (req) => counts.update(req.params.id, req.body),
  });
  r.post('/counts/:id/approve', {
    access: 'inventory.update',
    summary: 'Apply the counted quantities to stock',
    params: idParam,
    handler: (req) => counts.approve(req.params.id),
  });
  r.delete('/counts/:id', {
    access: 'inventory.create',
    summary: 'Delete a draft count',
    params: idParam,
    handler: (req) => counts.remove(req.params.id),
  });
  r.get('/counts/:id/pdf', {
    access: 'inventory.view',
    summary: 'Count act as PDF',
    params: idParam,
    query: pdfQuery,
    handler: async (req, reply) => {
      const count = await counts.get(req.params.id);
      return sendPdf(reply, await countPdf(req.params.id, await pdfLanguage(req.query.lang)), count.docNo ?? 'count');
    },
  });
}
