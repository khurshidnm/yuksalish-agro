import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../core/context';
import { AppError } from '../../core/errors';
import { routes } from '../../core/http';
import { idParam, isoDate, listQuery } from '../../core/query';
import { dataCoverage, runStatistics, tenantLanguage } from './analysis';
import { chat, type ChatEvent, type ChatInput } from './assistant';
import { deleteConversation, getConversation, listConversations } from './conversations';
import { extractDocument } from './documents';
import { gatherFigures, saveSummary, writeSummary, type SummaryKind } from './executive';
import * as insights from './insights.service';
import { getProvider, notConfigured } from './provider';
import * as records from './records/service';
import { asAi } from './role';

const chatBody = z.object({
  conversationId: z.uuid().optional(),
  message: z.string().trim().min(1).max(2000),
  language: z.enum(['uz', 'uz-Cyrl', 'ru', 'en']).optional(),
});

/** Provider failures are ours to look into; the client only gets a stable code. */
function logProviderFailure(req: FastifyRequest, error: unknown) {
  if (error instanceof AppError && error.code.startsWith('AI_PROVIDER')) {
    req.log.error({ err: error.cause ?? error }, 'AI provider call failed');
  }
}

const STREAM_KEEP_ALIVE_MS = 20_000;

/** Server-sent events, so tool activity shows up while the assistant works. */
async function streamChat(req: FastifyRequest, reply: FastifyReply, run: (onEvent: (e: ChatEvent) => void) => Promise<unknown>) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // A model call can take minutes, and a proxy with a fixed limit would cut a silent connection.
  reply.raw.flushHeaders();
  const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), STREAM_KEEP_ALIVE_MS);
  const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    send('done', await run((event) => send(event.type, event)));
  } catch (error) {
    logProviderFailure(req, error);
    const known = error instanceof AppError;
    if (!known) req.log.error({ err: error }, 'AI chat failed');
    send('failure', {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : 'Something went wrong on the server',
      details: known ? error.details : undefined,
    });
  } finally {
    clearInterval(keepAlive);
  }
  reply.raw.end();
  return reply;
}

export default async function aiModule(app: FastifyInstance) {
  const r = routes(app, 'ai');

  r.get('/status', {
    access: 'ai.view',
    summary: 'Whether the assistant is configured. Statistical insights work either way.',
    handler: () => {
      const provider = getProvider();
      return {
        assistant: { configured: provider.configured, provider: provider.name, model: provider.model },
        statistics: { enabled: true },
      };
    },
  });

  r.get('/coverage', {
    access: 'ai.view',
    summary: 'How much data each analysis has, against what it needs',
    handler: () => dataCoverage(),
  });

  r.get('/insights', {
    access: 'ai.view',
    query: insights.insightListQuery,
    handler: (req) => insights.list(req.query),
  });

  r.get('/insights/:id', {
    access: 'ai.view',
    params: idParam,
    handler: (req) => insights.get(req.params.id),
  });

  r.post('/insights/run', {
    access: 'ai.create',
    summary: 'Run the statistical analyses now',
    handler: () => runStatistics(),
  });

  r.post('/insights/:id/decision', {
    access: 'ai.update',
    summary: 'Accept or reject a recommendation',
    params: idParam,
    body: insights.decisionInput,
    handler: (req) => insights.decide(req.params.id, req.body),
  });

  r.post('/insights/:id/outcome', {
    access: 'ai.update',
    summary: 'Record what came of a decided recommendation',
    params: idParam,
    body: insights.outcomeInput,
    handler: (req) => insights.recordOutcome(req.params.id, req.body.outcome),
  });

  r.post('/chat', {
    access: 'ai.view',
    summary: 'Ask the assistant. Answers carry their sources and confidence.',
    transaction: false,
    body: chatBody,
    handler: async (req) => {
      try {
        return await chat(req.identity, req.body as ChatInput);
      } catch (error) {
        logProviderFailure(req as unknown as FastifyRequest, error);
        throw error;
      }
    },
  });

  // A person acting on a proposal the assistant prepared. Owner-only is enforced in the service.
  r.get('/proposals', {
    access: 'ai.view',
    summary: 'Drafts waiting for this person, from any channel',
    handler: () => records.listPending(),
  });
  r.get('/proposals/:id', { access: 'ai.view', params: idParam, handler: (req) => records.getProposal(req.params.id) });
  r.patch('/proposals/:id', {
    access: 'finance.create',
    summary: 'Change a draft from its card. Answers with questions if it is no longer complete.',
    params: idParam,
    body: z.object({
      amount: z.number().positive().optional(),
      date: isoDate.optional(),
      paymentMethod: z.enum(['cash', 'bank', 'card', 'debt']).optional(),
      categoryId: z.uuid().optional(),
      costCenterId: z.uuid().optional(),
      accountId: z.uuid().optional(),
      toAccountId: z.uuid().optional(),
      counterpartyId: z.uuid().optional(),
      itemId: z.uuid().optional(),
      warehouseId: z.uuid().optional(),
      qty: z.number().positive().optional(),
      description: z.string().trim().max(200).optional(),
    }),
    handler: (req) => records.updateProposal(req.params.id, req.body),
  });
  r.post('/proposals/:id/confirm', {
    access: 'finance.create',
    summary: 'Record it, through the same service as manual entry. The stamp says which version of the card was read.',
    params: idParam,
    body: z.object({ stamp: z.string().min(1).max(64), acknowledged: z.boolean().optional() }),
    handler: (req) => records.confirmProposal(req.params.id, req.body),
  });
  r.post('/proposals/:id/reject', { access: 'ai.view', params: idParam, handler: (req) => records.rejectProposal(req.params.id) });
  r.post('/proposals/:id/undo', { access: 'finance.create', params: idParam, handler: (req) => records.undoProposal(req.params.id) });
  r.get('/aliases', { access: 'ai.view', summary: 'Phrases the assistant has learned on this farm', handler: () => records.listAliases() });
  r.delete('/aliases/:id', { access: 'ai.create', params: idParam, handler: (req) => records.deleteAlias(req.params.id) });

  r.post('/chat/stream', {
    access: 'ai.view',
    summary: 'Same as /chat, as server-sent events with live tool activity',
    transaction: false,
    body: chatBody,
    handler: (req, reply) => {
      // A plain HTTP error while one is still possible; the stream only opens if it can work.
      if (!getProvider().configured) throw notConfigured();
      return streamChat(req as unknown as FastifyRequest, reply, (onEvent) =>
        chat(req.identity, req.body as ChatInput, onEvent),
      );
    },
  });

  r.get('/conversations', {
    access: 'ai.view',
    query: listQuery.pick({ page: true, pageSize: true }),
    handler: (req) => listConversations(req.query),
  });

  r.get('/conversations/:id', {
    access: 'ai.view',
    params: idParam,
    handler: (req) => getConversation(req.params.id),
  });

  r.delete('/conversations/:id', {
    access: 'ai.view',
    params: idParam,
    handler: (req) => deleteConversation(req.params.id),
  });

  r.post('/summaries', {
    access: 'ai.create',
    summary: 'Write the weekly or monthly summary now',
    transaction: false,
    body: z.object({ kind: z.enum(['week', 'month']) }),
    handler: async (req) => {
      const kind = req.body.kind as SummaryKind;
      const { figures, language } = await withTenant(req.identity, async () => ({
        figures: await gatherFigures(kind),
        language: await asAi(tenantLanguage),
      }));
      const written = await writeSummary(figures, language);
      return withTenant(req.identity, () => saveSummary(figures, written, language, { notify: false }));
    },
  });

  r.post('/extract-document', {
    access: 'ai.create',
    summary: 'Read a stored photo or PDF into proposed fields. Writes nothing.',
    transaction: false,
    body: z.object({ fileId: z.uuid() }),
    handler: (req) => extractDocument(req.identity, req.body.fileId),
  });
}
