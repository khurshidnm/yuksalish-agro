import type { FastifyInstance } from 'fastify';
import { routes } from '../../core/http';
import { idParam } from '../../core/query';
import * as service from './notifications.service';

export default async function notificationsModule(app: FastifyInstance) {
  const r = routes(app, 'notifications');

  r.get('/', {
    access: 'authenticated',
    summary: "The signed-in user's notifications, newest first",
    query: service.notificationListQuery,
    handler: (req) => service.list(req.query),
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
