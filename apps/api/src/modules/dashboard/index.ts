import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { dashboard } from './dashboard.service';
import { kpiQuery, kpis } from './kpis.service';

export default async function dashboardModule(app: FastifyInstance) {
  const r = routes(app, 'dashboard');

  r.get('/', {
    access: 'dashboard.view',
    summary: 'The farm on one screen: the blocks this reader may see, in the order that suits their role',
    handler: (req) => dashboard(req.log),
  });

  r.get('/kpis', {
    access: 'dashboard.view',
    summary: 'Key indicators for a period of whole months; null means not enough data',
    query: kpiQuery,
    handler: (req) => kpis(req.query, req.log),
  });
}
