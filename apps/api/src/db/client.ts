import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config';
import * as schema from './schema';

export { schema };

function logLostConnection(error: Error) {
  console.error('[db] connection lost:', error.message);
}

/**
 * A connection can die at any moment, for example when Postgres restarts. pg then emits 'error' on
 * the client, and on the pool too while the client is idle, and an 'error' nobody hears ends the whole
 * API. A client in use has no listener of the pool's, and a transaction adds none, so each client
 * gets its own. The query that was running still fails as it should, and the pool replaces the client.
 */
function newPool(connectionString: string, max: number): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  pool.on('connect', (client) => client.on('error', logLostConnection));
  // An idle client's error reaches the pool after the client's own listener has logged it.
  pool.on('error', () => {});
  return pool;
}

export const pool = newPool(config.DATABASE_URL, 30);

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
  await pool.end();
}
