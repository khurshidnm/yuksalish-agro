import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import { runAction } from './actions.service';
import * as service from './notifications.service';

export default async function notificationsModule(app: FastifyInstance) {
  const r = routes(app, 'notifications');

  r.get('/', {
    access: 'authenticated',
    summary: "The signed-in user's notifications, newest first",
    query: service.notificationListQuery,
    handler: (req) => service.list(req.query),
  });

  r.post('/actions', {
    access: 'authenticated',
    summary: 'Take the decision a notification offers, e.g. that cash handed over arrived. The owner decides again',
    body: z.object({
      kind: z.string().max(40),
      id: z.uuid(),
      button: z.string().max(40),
      reason: z.string().trim().max(500).optional(),
    }),
    handler: (req) => runAction({ kind: req.body.kind, id: req.body.id }, req.body.button, { reason: req.body.reason }),
  });

  r.get('/unread-count', {
    access: 'authenticated',
    handler: () => service.unreadCount(),
  });

  r.post('/read-all', {
    access: 'authenticated',
    handler: () => service.markAllRead(),
  });

  r.post('/:id/read', {
    access: 'authenticated',
    params: idParam,
    handler: (req) => service.markRead(req.params.id),
  });

  r.get('/preferences', {
    access: 'authenticated',
    summary: 'Channels per event type. In-app is always on.',
    handler: () => service.getPreferences(),
  });

  r.put('/preferences', {
    access: 'authenticated',
    body: service.preferenceInput,
    handler: (req) => service.setPreference(req.body.eventType, req.body.channels),
  });

  r.put('/language', {
    access: 'authenticated',
    summary: 'The language of messages sent outside the app, usually the one chosen on screen',
    body: service.languageInput,
    handler: (req) => service.setLanguage(req.body.language),
  });

  r.get('/telegram', {
    access: 'authenticated',
    summary: 'Whether the bot is configured and this user is linked',
    handler: () => service.telegramStatus(),
  });

  r.post('/telegram/link', {
    access: 'authenticated',
    summary: 'One-time code for /start in the bot',
    handler: () => service.createTelegramLink(),
  });

  r.delete('/telegram', {
    access: 'authenticated',
    handler: () => service.unlinkTelegram(),
  });
}
