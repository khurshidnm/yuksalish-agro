import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isTest } from '../../config';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './catalogue.service';

// The same limits as the public contact form (modules/leads): enough for a person correcting a
// typo, too few to fill the table from one address.
const submitLimit = isTest ? {} : { rateLimit: { max: 5, timeWindow: '10 minutes' } };
// A page view, and a whole village can share one address.
const pageLimit = isTest ? {} : { rateLimit: { max: 60, timeWindow: '1 minute' } };

// Deliberately loose: an address that is not a catalogue is "not found", whatever it looks like.
const slugParam = z.object({ slug: z.string().min(1).max(60) });
const animalParam = z.object({ animalId: z.uuid() });

export function registerCatalogue(app: FastifyInstance) {
  const r = routes(app, 'sales');

  r.get('/catalogue/pages/:slug', {
    access: 'public',
    summary: 'Public catalogue of a farm: the animals it chose to offer. 404 unless the farm switched it on.',
    params: slugParam,
    config: pageLimit,
    handler: (req) => service.publicCatalogue(req.params.slug),
  });

  r.post('/catalogue/pages/:slug/requests', {
    access: 'public',
    summary: 'Pre-order from the public catalogue. Needs the form token from GET /leads/form-token.',
    params: slugParam,
    body: service.catalogueRequestInput,
    config: submitLimit,
    handler: async (req, reply) => {
      const result = await service.submitRequest(req.params.slug, req.body, req.log);
      reply.code(201);
      return result;
    },
  });

  r.get('/catalogue/listings', {
    access: 'sales.view',
    summary: 'Animals marked to show in the catalogue. The published price needs finance.view.',
    query: service.listingListQuery,
    handler: (req) => service.listListings(req.query),
  });

  r.put('/catalogue/listings/:animalId', {
    access: 'sales.update',
    summary: 'Show an animal in the catalogue, with or without a published price',
    params: animalParam,
    body: service.listingInput,
    handler: (req) => service.setListing(req.params.animalId, req.body),
  });

  r.delete('/catalogue/listings/:animalId', {
    access: 'sales.update',
    summary: 'Take an animal off the catalogue',
    params: animalParam,
    handler: (req) => service.removeListing(req.params.animalId),
  });

  r.get('/catalogue/requests', {
    access: 'sales.view',
    summary: 'Pre-orders from the catalogue. Name and phone need pii.view.',
    query: service.requestListQuery,
    handler: (req) => service.listRequests(req.query),
  });

  r.post('/catalogue/requests/:id/reserve', {
    access: 'sales.create',
    summary: 'Answer a pre-order by holding an animal for the visitor',
    params: idParam,
    body: service.requestReserveInput,
    handler: (req) => service.reserveFromRequest(req.params.id, req.body),
  });

  r.post('/catalogue/requests/:id/close', {
    access: 'sales.update',
    summary: 'Close a pre-order without a reservation, or once it is dealt with',
    params: idParam,
    handler: (req) => service.closeRequest(req.params.id),
  });
}
