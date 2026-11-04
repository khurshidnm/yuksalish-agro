import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config';
import * as schema from './schema';

export { schema };

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 30 });

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
    aiDb = drizzle(new pg.Pool({ connectionString: url, max: 5 }), { schema, casing: 'snake_case' });
  }
  return aiDb;
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
