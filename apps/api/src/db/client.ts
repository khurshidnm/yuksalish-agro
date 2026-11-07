import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config';
import * as schema from './schema';

export { schema };

function logLostConnection(error: Error) {
  console.error('[db] connection lost:', error.message);
}

/**
 * Nothing waits for ever. The longest honest wait is on a person or a network: an upload arriving, or
 * a run of Telegram sends with a transaction open. Model calls hold no transaction, so these do not
 * cut them. `query_timeout` is for a server that stops answering and so cannot enforce its own limit.
 */
const SERVER_LIMITS = {
  connectionTimeoutMillis: 30_000,
  statement_timeout: 60_000,
  query_timeout: 70_000,
  idle_in_transaction_session_timeout: 300_000,
  options: '-c transaction_timeout=900000',
} satisfies pg.PoolConfig;

/**
 * A connection can die at any moment, for example when Postgres restarts. pg then emits 'error' on
 * the client, and on the pool too while the client is idle, and an 'error' nobody hears ends the whole
 * API. A client in use has no listener of the pool's, and a transaction adds none, so each client
 * gets its own. The query that was running still fails as it should, and the pool replaces the client.
 */
function newPool(connectionString: string, max: number, limits: pg.PoolConfig = SERVER_LIMITS): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, ...limits });
  pool.on('connect', (client) => client.on('error', logLostConnection));
  // An idle client's error reaches the pool after the client's own listener has logged it.
  pool.on('error', () => {});
  return pool;
}

export const pool = newPool(config.DATABASE_URL, 30);

/** The health checks' own, so that a pool full of requests cannot make the server look dead. */
export const healthPool = newPool(config.DATABASE_URL, 2, {
  connectionTimeoutMillis: 3_000,
  statement_timeout: 3_000,
  query_timeout: 3_000,
  idleTimeoutMillis: 60_000,
});

/** Do not query this directly in request code: use tx() from core/context so RLS applies. */
export const db = drizzle(pool, { schema, casing: 'snake_case' });

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Read-only AI connection (spec 15.2). Created on first use. */
let aiDb: Db | undefined;
export function getAiDb(): Db {
  if (!aiDb) {
    const url =
      config.AI_DATABASE_URL ??
      config.DATABASE_URL.replace(/\/\/[^@]*@/, '//yap_ai:yap_ai_dev@');
    aiDb = drizzle(newPool(url, 5), { schema, casing: 'snake_case' });
  }
  return aiDb;
}

export async function closeDb(): Promise<void> {
  await Promise.all([pool.end(), healthPool.end()]);
}
