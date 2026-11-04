import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PII_VIEW } from '@yap/shared';
import { forbidden } from '../../core/errors';
import { routes } from '../../core/http';
import { idParam, listQuery } from '../../core/query';
import { withTenant, type Identity } from '../../core/context';
import { recordEvent } from '../../core/journal';
import * as keys from './api-keys.service';
import * as audit from './audit.service';
import * as exporter from './export.service';
import * as profile from './profile.service';
import * as users from './users.service';
import * as webhooks from './webhooks.service';

/** Taking all of a farm's data out is itself something the journal should show. */
async function authorizeExport(identity: Identity, scope: string): Promise<void> {
  if (!new Set(identity.permissions).has(PII_VIEW)) {
    throw forbidden('A full export contains personal data', 'FORBIDDEN', { required: PII_VIEW });
  }
  await withTenant(identity, () =>
    recordEvent({ type: 'settings.exported', severity: 'attention', data: { scope } }),
  );
}

export default async function settingsModule(app: FastifyInstance) {
  const r = routes(app, 'settings');

  // Profile and policy
  r.get('/profile', { access: 'settings.view', handler: () => profile.getProfile() });
  r.patch('/profile', {
    access: 'settings.update',
    body: profile.profileInput,
    handler: (req) => profile.updateProfile(req.body),
  });
  r.get('/policy', { access: 'settings.view', handler: () => profile.getPolicy() });
  r.patch('/policy', {
    access: 'settings.update',
    body: profile.policyInput,
    handler: (req) => profile.updatePolicy(req.body),
  });

  // People
  r.get('/users', {
    access: 'users.view',
    query: users.memberListQuery,
    handler: (req) => users.listMembers(req.query),
  });
  r.get('/users/lookup', {
    access: 'authenticated',
    summary: 'Names for dropdowns in other modules',
    query: z.object({ search: z.string().trim().optional() }),
    handler: (req) => users.lookupMembers(req.query.search),
  });
  r.post('/users', {
    access: 'users.create',
    summary: 'Add a person to this farm. A new login gets a one-time password, shown once.',
    body: users.memberInput,
    handler: async (req, reply) => {
      reply.code(201);
      return users.addMember(req.body);
    },
  });
  r.patch('/users/:id', {
    access: 'users.update',
    summary: 'Change role. :id is the membership.',
    params: idParam,
    body: z.object({ roleId: z.uuid() }),
    handler: (req) => users.changeRole(req.params.id, req.body.roleId),
  });
  r.post('/users/:id/block', {
    access: 'users.update',
    params: idParam,
    handler: (req) => users.blockMember(req.params.id),
  });
  r.post('/users/:id/unblock', {
    access: 'users.update',
    params: idParam,
    handler: (req) => users.unblockMember(req.params.id),
  });
  r.post('/users/:id/reset-password', {
    access: 'users.update',
    params: idParam,
    handler: (req) => users.resetPassword(req.params.id),
  });

  // Roles
  r.get('/roles', {
    access: 'users.view',
    query: listQuery.pick({ search: true }),
    handler: (req) => users.listRoles(req.query),
  });
  r.post('/roles', {
    access: 'users.create',
    body: users.roleInput,
    handler: async (req, reply) => {
      reply.code(201);
      return users.createRole(req.body);
    },
  });
  r.patch('/roles/:id', {
    access: 'users.update',
    params: idParam,
    body: users.roleInput.partial(),
    handler: (req) => users.updateRole(req.params.id, req.body),
  });
  r.delete('/roles/:id', {
    access: 'users.delete',
    params: idParam,
    handler: (req) => users.deleteRole(req.params.id),
  });

  // API keys
  r.get('/api-keys', { access: 'settings.view', handler: () => keys.listKeys() });
  r.post('/api-keys', {
    access: 'settings.update',
    summary: 'Create a key. The key is shown once.',
    body: keys.apiKeyInput,
    handler: async (req, reply) => {
      reply.code(201);
      return keys.createKey(req.body);
    },
  });
  r.delete('/api-keys/:id', {
    access: 'settings.update',
    summary: 'Revoke a key',
    params: idParam,
    handler: (req) => keys.revokeKey(req.params.id),
  });

  // Audit log and journal
  r.get('/audit', {
    access: 'audit.view',
    query: audit.auditQuery,
    handler: (req) => audit.listAudit(req.query),
  });
  r.get('/audit/entities', { access: 'audit.view', handler: () => audit.auditEntities() });
  r.get('/journal', {
    access: 'audit.view',
    query: audit.journalQuery,
    handler: (req) => audit.listJournal(req.query),
  });

  // Webhooks
  r.get('/webhooks', { access: 'settings.view', handler: () => webhooks.listWebhooks() });
  r.post('/webhooks', {
    access: 'settings.update',
    summary: 'Subscribe a URL to event types. The signing secret is shown once.',
    body: webhooks.webhookInput,
    handler: async (req, reply) => {
      reply.code(201);
      return webhooks.createWebhook(req.body);
    },
  });
  r.patch('/webhooks/:id', {
    access: 'settings.update',
    params: idParam,
    body: webhooks.webhookUpdate,
    handler: (req) => webhooks.updateWebhook(req.params.id, req.body),
  });
  r.delete('/webhooks/:id', {
    access: 'settings.update',
    params: idParam,
    handler: (req) => webhooks.deleteWebhook(req.params.id),
  });
  r.get('/webhooks/:id/deliveries', {
    access: 'settings.view',
    summary: 'Delivery log with errors',
    params: idParam,
    query: webhooks.deliveryQuery,
    handler: (req) => webhooks.listDeliveries(req.params.id, req.query),
  });
  r.post('/webhooks/:id/test', {
    access: 'settings.update',
    summary: 'Queue a test event',
    params: idParam,
    handler: (req) => webhooks.queueTest(req.params.id),
  });
  r.post('/webhooks/:id/deliveries/:deliveryId/retry', {
    access: 'settings.update',
    params: z.object({ id: z.uuid(), deliveryId: z.uuid() }),
    handler: (req) => webhooks.retryDelivery(req.params.id, req.params.deliveryId),
  });

  // Full export (spec 20.3)
  r.get('/export/overview', {
    access: 'settings.view',
    summary: 'Tables in the export, with row counts',
    handler: () => exporter.exportOverview(),
  });
  r.get('/export', {
    access: 'settings.view',
    summary: 'Everything for this farm as one JSON document',
    transaction: false,
    handler: async (req, reply) => {
      await authorizeExport(req.identity, 'all');
      const stream = new PassThrough();
      reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', 'attachment; filename="yap-export.json"');
      void exporter.writeJsonExport(req.identity, stream);
      return reply.send(stream);
    },
  });
  r.get('/export/:table', {
    access: 'settings.view',
    summary: 'One table as CSV',
    transaction: false,
    params: z.object({ table: z.string().regex(/^[a-z0-9_]+$/).max(63) }),
    handler: async (req, reply) => {
      await exporter.assertExportable(req.identity, req.params.table);
      await authorizeExport(req.identity, req.params.table);
      const stream = new PassThrough();
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${req.params.table}.csv"`);
      void exporter.writeCsvExport(req.identity, req.params.table, stream);
      return reply.send(stream);
    },
  });
}
