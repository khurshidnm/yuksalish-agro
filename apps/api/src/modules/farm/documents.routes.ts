import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './documents.service';

export function registerDocuments(app: FastifyInstance) {
  const r = routes(app, 'farm');

  r.get('/documents', {
    access: 'farm.view',
    summary: 'Document archive. Filter by object, type, or expiry.',
    query: service.documentListQuery,
    handler: (req) => service.listDocuments(req.query),
  });

  r.get('/documents/:id', {
    access: 'farm.view',
    params: idParam,
    handler: (req) => service.getDocument(req.params.id),
  });

  r.post('/documents', {
    access: 'farm.create',
    body: service.documentInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.createDocument(req.body);
    },
  });

  r.patch('/documents/:id', {
    access: 'farm.update',
    params: idParam,
    body: service.documentInput.partial(),
    handler: (req) => service.updateDocument(req.params.id, req.body),
  });

  r.delete('/documents/:id', {
    access: 'farm.delete',
    params: idParam,
    handler: (req) => service.removeDocument(req.params.id),
  });
}
