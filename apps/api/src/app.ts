import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { MAX_UPLOAD_BYTES } from '@yap/shared';
import { config, isProd, isTest } from './config';
import { AppError, safeError } from './core/errors';
import { databaseAnswers, deepHealth } from './core/health';
import { MODULE_PLUGINS } from './modules';

export interface LogStream {
  write(line: string): void;
}

/**
 * Every line the API logs through pino passes through these, Fastify's own and the jobs' included.
 * The defaults would write a failed query's parameters, which can be a person's words, and the query
 * string, which can be a searched name or phone, or the token of a file link.
 */
const LOG_SERIALIZERS = {
  // Fastify's type asks for pino's default shape, but pino writes whatever comes back.
  err: (err: unknown) => (err instanceof Error ? safeError(err) : err) as { type: string; message: string; stack: string },
  req: (req: FastifyRequest) => ({ method: req.method, url: req.url.split('?')[0], remoteAddress: req.ip }),
};

function loggerOptions(stream?: LogStream) {
  if (stream) return { stream, serializers: LOG_SERIALIZERS };
  if (isTest) return false;
  return { serializers: LOG_SERIALIZERS, ...(isProd ? {} : { transport: { target: 'pino-pretty' }, level: 'info' }) };
}

/** Drizzle wraps driver errors; the Postgres error is the cause. */
function postgresError(err: unknown): { code: string; detail?: string; constraint?: string } | null {
  for (const candidate of [err, (err as { cause?: unknown })?.cause]) {
    const code = (candidate as { code?: unknown })?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return candidate as { code: string };
  }
  return null;
}

function mapPostgresError(pg: NonNullable<ReturnType<typeof postgresError>>): AppError | null {
  switch (pg.code) {
    case '23505':
      return new AppError(409, 'ALREADY_EXISTS', 'A record with these values already exists', { constraint: pg.constraint });
    case '23503':
      return pg.detail?.includes('is still referenced')
        ? new AppError(409, 'IN_USE', 'This record is in use and cannot be deleted')
        : new AppError(400, 'INVALID_REFERENCE', 'A linked record does not exist', { constraint: pg.constraint });
    case '23514':
    case '23502':
    case '22P02':
    case '22007':
    case '22003':
    // Text with a NUL in it, which Postgres cannot store, and a date it cannot hold, such as year 0.
    case '22021':
    case '22P05':
    case '22008':
      return new AppError(400, 'INVALID_INPUT', 'Some values are not valid');
    case '42501':
      return new AppError(403, 'FORBIDDEN', 'You do not have permission to do this');
    case '40001':
    case '40P01':
      return new AppError(409, 'RETRY', 'The record was being changed by someone else, please try again');
    default:
      return null;
  }
}

/** busboy's errors for a body that is not valid multipart. They carry no code or status to go by. */
const MALFORMED_MULTIPART = /^Multipart: |multipart data$|^The needle cannot/;

function errorHandler(error: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  if (hasZodFastifySchemaValidationErrors(error)) {
    const fieldErrors: Record<string, string> = {};
    // `message` is zod's English: `fieldIssues` lets the web app say it in the person's language.
    const fieldIssues: Record<string, { code: string; min?: unknown; max?: unknown; inclusive?: unknown }> = {};
    for (const issue of error.validation) {
      const path = issue.instancePath.replace(/^\//, '').replaceAll('/', '.') || '_';
      fieldErrors[path] = issue.message ?? 'Invalid value';
      const { minimum, maximum, inclusive } = issue.params as Record<string, unknown>;
      fieldIssues[path] = { code: issue.keyword, min: minimum, max: maximum, inclusive };
    }
    return reply.code(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'Please check the highlighted fields', details: { fieldErrors, fieldIssues } },
    });
  }

  const known =
    error instanceof AppError ? error : (postgresError(error) && mapPostgresError(postgresError(error)!)) || null;
  if (known) {
    return reply.code(known.status).send({ error: { code: known.code, message: known.message, details: known.details } });
  }

  // Drizzle refuses an UPDATE with no columns, e.g. a PATCH with an empty body.
  if (error.message === 'No values to set') {
    return reply.code(400).send({ error: { code: 'NOTHING_TO_UPDATE', message: 'No changes were sent' } });
  }

  if (MALFORMED_MULTIPART.test(error.message)) {
    return reply.code(400).send({ error: { code: 'INVALID_UPLOAD', message: 'This upload is broken, please send it again' } });
  }

  if (error.statusCode === 429) {
    return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many attempts, please wait a minute' } });
  }
  if (error.statusCode && error.statusCode < 500) {
    return reply.code(error.statusCode).send({ error: { code: error.code ?? 'BAD_REQUEST', message: error.message } });
  }

  // Unknown failures go to the log, and the client gets nothing internal.
  req.log.error({ err: error }, 'unhandled error');
  return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server' } });
}

/**
 * `logStream` lets a test read what would reach the log; tests otherwise run with the logger off.
 * `docs` serves /api/docs. It is a map of the whole API open to strangers, so production asks for it.
 */
export async function buildApp(logStream?: LogStream, docs = !isProd || config.API_DOCS === 'true'): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(logStream),
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } }),
  );

  // Answers hold personal data, so no browser or proxy keeps one unless the route says it may.
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  // The API serves JSON only, so a CSP adds nothing here, and it would break Swagger UI. HSTS comes
  // from infra/nginx.conf, which also covers the pages and knows whether the request came over TLS.
  await app.register(helmet, { contentSecurityPolicy: false, hsts: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  await app.register(cookie);
  // An upload is one file. The other limits stop a body that is nothing but thousands of small fields.
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 11, fieldSize: 64 * 1024 } });
  await app.register(rateLimit, { global: false });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Yuksalish Agro Platform API', version: '1.0.0' },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });
  if (docs) await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.get('/api/health', { schema: { hide: true } }, async (_req, reply) => {
    if (await databaseAnswers()) return { status: 'ok' };
    return reply.code(503).send({ status: 'failing' });
  });

  // That alerts are not getting out is no business of a stranger, so only the server itself gets the detail.
  app.get('/api/health/deep', { schema: { hide: true } }, async (req, reply) => {
    const report = await deepHealth();
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
    return reply.code(report.status === 'ok' ? 200 : 503).send(local ? report : { status: report.status });
  });

  await app.register(
    async (v1) => {
      for (const [name, plugin] of Object.entries(MODULE_PLUGINS)) {
        await v1.register(plugin, { prefix: `/${name}` });
      }
    },
    { prefix: '/api/v1' },
  );

  await app.ready();
  return app;
}
