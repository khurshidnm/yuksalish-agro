import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import * as codes from './codes.service';

export function registerCodes(app: FastifyInstance) {
  const r = routes(app, 'livestock');

  r.get('/animals/by-code', {
    access: 'livestock.view',
    summary: 'Animals that carry exactly this tag or identifier. Empty when none; two when two do. Never a near match.',
    query: codes.byCodeQuery,
    handler: (req) => codes.byCode(req.query.code),
  });

  r.post('/animals/match-codes', {
    access: 'livestock.view',
    summary: 'The same exact lookup for many codes at once: the preview of a scale file. Writes nothing.',
    body: codes.matchCodesInput,
    handler: (req) => codes.matchCodes(req.body.codes),
  });

  r.post('/animals/tag-labels', {
    access: 'livestock.view',
    summary: 'What to print on tags for the chosen animals or a whole herd. Writes nothing.',
    body: codes.tagLabelsInput,
    handler: (req) => codes.tagLabels(req.body),
  });
}
