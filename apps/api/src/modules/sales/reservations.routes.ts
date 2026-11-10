import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './reservations.service';

export function registerReservations(app: FastifyInstance) {
  const r = routes(app, 'sales');

  r.get('/reservations', {
    access: 'sales.view',
    summary: 'Animals held for buyers. Agreed price needs finance.view, a typed-in name and phone need pii.view.',
    query: service.reservationListQuery,
    handler: (req) => service.list(req.query),
  });

  r.post('/reservations', {
    access: 'sales.create',
    summary: 'Hold an animal for a buyer. One open reservation per animal: a second is refused with ANIMAL_RESERVED.',
    body: service.reservationInput,
    handler: async (req, reply) => {
      reply.code(201);
      return service.create(req.body);
    },
  });

  r.post('/reservations/:id/cancel', {
    access: 'sales.update',
    summary: 'Cancel an open reservation',
    params: idParam,
    body: service.reservationCancelInput,
    handler: (req) => service.cancel(req.params.id, req.body.reason),
  });

  r.post('/reservations/:id/convert', {
    access: 'sales.create',
    summary: 'Turn a reservation into a draft sale. Moves no money: the sale is confirmed in the sales order.',
    params: idParam,
    body: service.reservationConvertInput,
    handler: (req) => service.convert(req.params.id, req.body),
  });
}
