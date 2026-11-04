/**
 * The AI layer's database identity (spec 4.1 p.8, 15.2).
 *
 * Inside these helpers `tx()` is a transaction of the yap_ai role, whose grants allow reading
 * business tables and writing only ai_insights, ai_messages and ai_conversations. RLS applies as
 * for any role. So "AI never changes financial records" is enforced by Postgres, not by care in
 * this module, and module summary functions, which use `tx()`, run under the same limits.
 *
 * The context's transaction is swapped for the duration and restored after. Code in here must
 * not start concurrent work, as with any single transaction.
 */
import { sql } from 'drizzle-orm';
import { ctx } from '../../core/context';
import { getAiDb } from '../../db/client';

async function onAiRole<T>(readOnly: boolean, fn: () => Promise<T>): Promise<T> {
  const c = ctx();
  const outer = c.tx;
  return getAiDb().transaction(
    async (trx) => {
      await trx.execute(sql`select
        set_config('app.tenant_id', ${c.tenantId}, true),
        set_config('app.user_id', ${c.userId ?? ''}, true)`);
      c.tx = trx;
      try {
        return await fn();
      } finally {
        c.tx = outer;
      }
    },
    { accessMode: readOnly ? 'read only' : 'read write' },
  );
}

/** Read as yap_ai in a READ ONLY transaction. Every AI read goes through here. */
export const asAi = <T>(fn: () => Promise<T>): Promise<T> => onAiRole(true, fn);

/** Write AI output as yap_ai. The role's grants limit this to the ai_* tables. */
export const asAiWriter = <T>(fn: () => Promise<T>): Promise<T> => onAiRole(false, fn);
