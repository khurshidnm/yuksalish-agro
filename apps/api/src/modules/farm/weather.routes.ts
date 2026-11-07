import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@yap/shared';
import { routes } from '../../core/http';
import { isoDate } from '../../core/query';
import * as weather from './weather.service';

const readers: Permission[] = ['farm.view', 'crops.view', 'dashboard.view'];

export function registerWeather(app: FastifyInstance) {
  const r = routes(app, 'farm');

  r.get('/weather/forecast', {
    access: readers,
    summary: 'Stored forecast from today',
    query: z.object({ days: z.coerce.number().int().min(1).max(16).default(7) }),
    handler: (req) => weather.forecast(req.query.days),
  });

  r.get('/weather/hourly', {
    access: readers,
    summary: 'Stored forecast points from the past hour on, hourly for about 2.5 days, then 6-hourly',
    query: z.object({ hours: z.coerce.number().int().min(1).max(240).default(72) }),
    handler: (req) => weather.hourlyForecast(new Date(Date.now() - 3_600_000), req.query.hours),
  });

  r.get('/weather', {
    access: readers,
    summary: 'Stored daily weather for a period',
    query: z.object({ from: isoDate, to: isoDate }),
    handler: (req) => weather.weatherRange(req.query.from, req.query.to),
  });

  r.post('/weather/refresh', {
    access: 'farm.update',
    summary: 'Fetch weather now. Reports unavailable instead of failing.',
    transaction: false,
    handler: (req) => weather.refreshWeatherDetached(req.identity),
  });
}
