/**
 * The assistant's accuracy score: `pnpm --filter @yap/api ai:eval`. Real messages through the real
 * model, against a private copy of the demo data that is dropped afterwards. Rerun it after any
 * change to the prompt, the model or the readiness rules. AI_MODEL picks the model to score.
 *   --holdout    the blind set in holdout.ts. Never tune against it: fix a class of problem, then
 *                write new cases, or the score stops meaning anything.
 *   --repeat=3   run each case three times.
 *
 * Only a person's confirm may create a record, so a single new transaction fails the whole run.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const OWNER = 'postgres://yap:yap_dev@localhost:5434';
const name = `yap_eval_${process.pid}`;
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const useHoldout = args.includes('--holdout');
/** --cases=/abs/path.ts scores any file with `export default Case[]`. */
const casesFile = args.find((a) => a.startsWith('--cases='))?.split('=')[1];
/** The model can differ from run to run, so a case only counts as right if it is right every time. */
const REPEAT = Number(args.find((a) => a.startsWith('--repeat='))?.split('=')[1]) || 1;
const CONCURRENCY = 4;

async function adminQuery(sql: string) {
  const client = new pg.Client({ connectionString: `${OWNER}/postgres` });
  await client.connect();
  await client.query(sql);
  await client.end();
}

// Before anything reads config: a private database, no Telegram, no chat limits.
Object.assign(process.env, {
  DATABASE_URL: `postgres://yap_app:yap_app_dev@localhost:5434/${name}`,
  DATABASE_OWNER_URL: `${OWNER}/${name}`,
  AI_DATABASE_URL: `postgres://yap_ai:yap_ai_dev@localhost:5434/${name}`,
  TELEGRAM_BOT_TOKEN: '',
  JOBS_ENABLED: 'false',
  AI_CHAT_PER_MINUTE: '100000',
  AI_CHAT_PER_DAY: '100000',
});

/** A case may name the field it expects a question about instead of a readiness code. */
const FIELD_CODES: Record<string, RegExp> = {
  amount: /^(AMOUNT_|MORE_THAN_OWED$)/,
  target: /^TARGET_/,
  item: /^ITEM_/,
  date: /^DATE_/,
  counterparty: /^(COUNTERPARTY_|NO_OPEN_DEBT$)/,
  category: /^(CATEGORY_|WAGE_OR_SERVICE$|GOODS_STOCK_OR_DIRECT$)/,
  qty: /^(QUANTITY_|UNIT_MISMATCH$|PRICE_UNIT_UNCLEAR$)/,
  paymentMethod: /^(PAYMENT_METHOD_REQUIRED|ACCOUNT_)/,
  currency: /^(CURRENCY_|FX_RATE_REQUIRED$)/,
};

interface Outcome {
  id: string;
  group: string;
  verdict: 'right' | 'extra_question' | 'wrong';
  why: string;
  /** Cards that came out and match nothing expected: the ones a person could confirm by mistake. */
  badCards?: number;
  transcript: string[];
}

async function main() {
  await adminQuery(`CREATE DATABASE ${name}`);
  const { applySchema } = await import('../src/db/apply-schema');
  await applySchema(`${OWNER}/${name}`);
  execFileSync(join(here, '..', 'node_modules', '.bin', 'tsx'), ['--env-file=../../.env', 'src/seed/index.ts'], {
    cwd: join(here, '..'),
    stdio: 'ignore',
    env: process.env,
  });

  const CASES: import('./cases').Case[] = casesFile
    ? (await import(casesFile)).default
    : useHoldout
      ? (await import('./holdout' as string)).HOLDOUT
      : (await import('./cases')).CASES;
  const { chat } = await import('../src/modules/ai/assistant');
  const { getProvider } = await import('../src/modules/ai/provider');
  const { withPlatform } = await import('../src/core/context');
  const { mergeSettings } = await import('../src/core/settings');
  const { db, schema, closeDb } = await import('../src/db/client');
  const { eq } = await import('drizzle-orm');
  const { todayIso, addDays } = await import('@yap/shared');

  const provider = getProvider();
  console.log(`Model: ${provider.model}\n`);

  const [user] = await db.select().from(schema.users).where(eq(schema.users.phone, '+998900000001'));
  const member = await withPlatform(async (trx) => {
    const [row] = await trx
      .select({ id: schema.memberships.id, tenantId: schema.memberships.tenantId, farmId: schema.memberships.farmId, permissions: schema.roles.permissions, settings: schema.tenants.settings })
      .from(schema.memberships)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
      .where(eq(schema.memberships.userId, user.id));
    return row;
  });
  const identity = {
    userId: user.id, tenantId: member.tenantId, farmId: member.farmId, membershipId: member.id, roleKey: 'owner',
    permissions: member.permissions, settings: mergeSettings(member.settings), currency: 'UZS', timezone: 'Asia/Tashkent', source: 'user' as const,
  };

  const countTransactions = async () => {
    const client = new pg.Client({ connectionString: `${OWNER}/${name}` });
    await client.connect();
    const { rows } = await client.query('select count(*)::int as n from transactions');
    await client.end();
    return rows[0].n as number;
  };
  const before = await countTransactions();

  const check = (expected: Record<string, unknown>, card: any): string[] => {
    const f = card.fields;
    const wrong: string[] = [];
    const has = (value: string | undefined | null, part: string) => (value ?? '').toLowerCase().includes(part.toLowerCase());
    if (card.kind !== expected.kind) wrong.push(`kind ${card.kind}`);
    if (f.amount !== expected.amount) wrong.push(`amount ${f.amount}`);
    if (expected.currency && f.currency !== expected.currency) wrong.push(`currency ${f.currency}`);
    // A stock card names no category: the item decides it when the receipt is written.
    if (expected.category && card.kind !== 'stock_purchase' && f.category?.name !== expected.category) wrong.push(`category ${f.category?.name}`);
    if (expected.targetType && f.target?.type !== expected.targetType) wrong.push(`target type ${f.target?.type}`);
    if (expected.target && !has(f.target?.name, expected.target as string)) wrong.push(`target ${f.target?.name}`);
    if (expected.account && !has(f.account?.name, expected.account as string)) wrong.push(`account ${f.account?.name}`);
    if (expected.item && f.item?.name !== expected.item) wrong.push(`item ${f.item?.name}`);
    if (expected.qty && f.qty !== expected.qty) wrong.push(`qty ${f.qty}`);
    if (expected.counterparty && !has(f.counterparty?.name, expected.counterparty as string)) wrong.push(`counterparty ${f.counterparty?.name}`);
    if (expected.treatment && f.costTreatment !== expected.treatment) wrong.push(`treatment ${f.costTreatment}`);
    if (expected.daysAgo !== undefined && f.date !== addDays(todayIso(), -(expected.daysAgo as number))) wrong.push(`date ${f.date}`);
    return wrong;
  };

  async function run(c: (typeof CASES)[number]): Promise<Outcome> {
    const transcript: string[] = [];
    let conversationId: string | undefined;
    const cards = new Map<string, any>();
    const calls: { name: string; status: string; code?: string }[] = [];
    let last: any = null;
    for (const text of c.say) {
      const reply = await chat(identity as never, { conversationId, message: text });
      conversationId = reply.conversationId;
      last = reply.message;
      calls.push(...(last.toolCalls as typeof calls));
      for (const a of last.attachments) if (a.type === 'proposal') cards.set(a.proposal.id, a.proposal);
      transcript.push(`> ${text}`, `  ${String(last.text).replace(/\n+/g, ' ').slice(0, 200)}`);
      transcript.push(`  [${(last.toolCalls as typeof calls).map((t) => `${t.name}${t.code ? `:${t.code}` : ''}`).join(', ')}]`);
    }
    const found = [...cards.values()];
    const expectedCards = c.refuses || c.usesTool ? [] : (c.cards ?? []);
    const badCards = found.filter((card) => !expectedCards.some((want) => check(want as never, card).length === 0)).length;
    const out = (verdict: Outcome['verdict'], why: string): Outcome => ({ id: c.id, group: c.group, verdict, why, transcript, badCards });

    if (c.usesTool) {
      // The tool is a guess at how: the same figures can be reached through several, or the catalog in the context.
      if (found.length) return out('wrong', `drafted ${found[0].kind} ${found[0].fields.amount}, should only answer`);
      return String(last.text).trim() ? out('right', '') : out('wrong', 'no answer');
    }
    if (c.refuses) {
      if (found.length) return out('wrong', `drafted ${found[0].kind} ${found[0].fields.amount}, should be refused`);
      return out('right', '');
    }
    if (c.asks) {
      const unwanted = found.filter((card) => !expectedCards.some((want) => check(want as never, card).length === 0));
      if (unwanted.length) return out('wrong', `drafted ${unwanted[0].fields.amount} ${unwanted[0].fields.category?.name} instead of asking`);
      const codes = calls.map((t) => t.code).filter(Boolean) as string[];
      const named = (code: string, wanted: string) => code === wanted || FIELD_CODES[wanted]?.test(code);
      if (c.asks.length && !codes.some((code) => c.asks!.some((wanted) => named(code, wanted))) && !String(last.text).includes('?')) {
        return out('wrong', `no question (${codes.join(',') || 'no code'})`);
      }
      return out('right', '');
    }
    const expected = c.cards ?? [];
    if (found.length === 0 && expected.length === 0) return out('right', '');
    if (found.length === 0) return out('extra_question', `no card: ${calls.map((t) => t.code).filter(Boolean).join(',') || 'nothing drafted'}`);
    const problems: string[] = [];
    for (const want of expected) {
      const near = found.find((card) => check(want as never, card).length === 0);
      if (!near) problems.push(`expected ${want.amount}: ${found.map((card) => check(want as never, card).join(' ')).join(' / ')}`);
    }
    if (found.length !== expected.length && problems.length === 0) problems.push(`${found.length} cards, expected ${expected.length}`);
    if (problems.length) return out('wrong', problems.join('; '));
    return out('right', '');
  }

  const queue = CASES.filter((c) => only.length === 0 || only.includes(c.id) || only.includes(c.group)).flatMap((c) =>
    Array.from({ length: REPEAT }, () => c),
  );
  const results: Outcome[] = [];
  const started = Date.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const result = await run(c).catch((error) => ({ id: c!.id, group: c!.group, verdict: 'wrong' as const, why: `error: ${error.message}`, transcript: [] }));
        results.push(result);
        console.log(`${result.verdict === 'right' ? 'ok   ' : result.verdict === 'wrong' ? 'WRONG' : 'ask? '} ${result.id}${result.why ? `  ${result.why}` : ''}`);
      }
    }),
  );

  const after = await countTransactions();
  const groups = [...new Set(results.map((r) => r.group))];
  console.log('\nBy group:');
  for (const group of groups) {
    const rows = results.filter((r) => r.group === group);
    console.log(`  ${group.padEnd(10)} ${rows.filter((r) => r.verdict === 'right').length}/${rows.length}`);
  }
  const right = results.filter((r) => r.verdict === 'right').length;
  const wrong = results.filter((r) => r.verdict === 'wrong');
  const extra = results.filter((r) => r.verdict === 'extra_question');
  console.log(`\nScore: ${right}/${results.length} right (${((right / results.length) * 100).toFixed(1)}%)`);
  console.log(`Wrong: ${wrong.length}. Asked when it need not: ${extra.length}.`);
  if (REPEAT > 1) {
    const ids = [...new Set(results.map((r) => r.id))];
    const steady = ids.filter((id) => results.filter((r) => r.id === id).every((r) => r.verdict === 'right'));
    console.log(`Right on every run: ${steady.length}/${ids.length} cases.`);
  }
  // The figure that matters most: a card that could be confirmed with something wrong on it. A record it
  // asked about instead is not one, even in a message whose other card came out right.
  const wrongCards = results.filter((r) => (r.badCards ?? 0) > 0);
  console.log(`Runs with a card that matches nothing expected: ${wrongCards.length}, in cases: ${[...new Set(wrongCards.map((r) => r.id))].join(' ') || 'none'}.`);
  console.log(`Records created without a confirm: ${after - before}. Took ${((Date.now() - started) / 1000).toFixed(0)} s.`);
  for (const r of [...wrong, ...extra]) console.log(`\n--- ${r.id}: ${r.why}\n${r.transcript.join('\n')}`);
  await closeDb();
  if (after !== before) throw new Error('A record was created without a confirm');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    process.exit(process.exitCode ?? 0);
  });
