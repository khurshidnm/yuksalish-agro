import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { tx } from '../src/core/context';
import { schema } from '../src/db/client';
import { setProvider } from '../src/modules/ai/provider';
import { confirmProposal } from '../src/modules/ai/records/service';
import { Scripted, asOwner, call, ready, say, today, world } from './ai-world';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(apiRoot, '..', '..', path), 'utf8');
const source = (path: string) => readFileSync(join(apiRoot, 'src', path), 'utf8');

const compose = read('docker-compose.prod.yml');
const nginx = read('infra/nginx.conf');

describe('settings reach the containers', () => {
  const example = read('infra/env.production.example');
  const offered = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  const passed = [...new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))];

  it('everything env.production.example offers is used by the stack, and the reverse', () => {
    expect(offered.filter((name) => !passed.includes(name))).toEqual([]);
    expect(passed.filter((name) => !offered.includes(name))).toEqual([]);
  });

  it('everything the API reads is passed to it, or is left on its default on purpose', () => {
    // An empty value would coerce the numbers among these to 0, so they are not passed through.
    const onDefaults = ['API_PORT', 'ACCESS_TOKEN_TTL_MIN', 'REFRESH_TOKEN_TTL_DAYS', 'BCRYPT_ROUNDS', 'STORAGE_DIR', 'JOBS_ENABLED'];
    const migrateOnly = ['DATABASE_OWNER_URL', 'PLATFORM_ADMIN_PHONE', 'PLATFORM_ADMIN_PASSWORD'];
    const files = readdirSync(join(apiRoot, 'src'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const inCode = files.flatMap((f) => [...source(f).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
    const declared = [...source('config.ts').matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
    const apiEnv = compose.slice(compose.indexOf('x-api-env'), compose.indexOf('services:'));
    const missing = [...new Set([...inCode, ...declared])].filter((name) => !onDefaults.includes(name) && !migrateOnly.includes(name) && !apiEnv.includes(`${name}:`));
    expect(missing).toEqual([]);
  });
});

describe('a deploy', () => {
  it('gives the API longer to stop than its Telegram shutdown waits', () => {
    const wait = Number(/const SHUTDOWN_WAIT_MS = ([\d_]+);/.exec(source('modules/notifications/bot.ts'))![1].replaceAll('_', ''));
    const api = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  web:'));
    expect(Number(/stop_grace_period: (\d+)s/.exec(api)?.[1] ?? 10) * 1000).toBeGreaterThan(wait);
  });

  it('leaves nginx able to find an API container that got a new address', () => {
    const upstream = /upstream api \{[^}]*\}/.exec(nginx)![0];
    expect(upstream).toMatch(/^\s*zone /m);
    expect(upstream).toContain('resolver 127.0.0.11');
    expect(upstream).toContain('server api:4000 resolve;');
    // `resolve` is in open-source nginx from 1.27.3, so an older image would not start.
    const [, major, minor] = /FROM nginxinc\/nginx-unprivileged:(\d+)\.(\d+)/.exec(read('apps/web/Dockerfile'))!;
    expect(Number(major) * 1000 + Number(minor)).toBeGreaterThanOrEqual(1028);
  });
});

describe('the assistant behind two proxies', () => {
  const claude = /timeout: ([\d_]+), maxRetries: (\d+)/.exec(source('modules/ai/provider/claude.ts'))!;
  const gemini = /timeout: ([\d_]+), retryOptions: \{ attempts: (\d+)/.exec(source('modules/ai/provider/gemini.ts'))!;
  const ms = (text: string) => Number(text.replaceAll('_', ''));
  const longestCall = Math.max(ms(claude[1]) * (Number(claude[2]) + 1), ms(gemini[1]) * Number(gemini[2]));

  it('nginx outlasts every attempt of one model call', () => {
    const location = /location \/api\/v1\/ai\/ \{[^}]*\}/.exec(nginx)![0];
    expect(Number(/proxy_read_timeout (\d+)s/.exec(location)![1]) * 1000).toBeGreaterThan(longestCall);
  });

  it('so does the TLS proxy snippet people copy, and it does not buffer the stream', () => {
    const snippet = /```nginx\n([\s\S]*?)```/.exec(read('docs/deployment.md'))![1];
    expect(Number(/proxy_read_timeout (\d+)s/.exec(snippet)![1]) * 1000).toBeGreaterThan(longestCall);
    expect(snippet).toContain('proxy_buffering off;');
    expect(snippet).toContain('proxy_http_version 1.1;');
  });
});

describe('logs', () => {
  it('nginx writes no query string or referrer: they can hold a searched phone or a file token', () => {
    const format = /log_format no_query '([^']*)'/.exec(nginx)![1];
    expect(format).not.toMatch(/\$request\b|\$request_uri|\$args|\$query_string|\$http_referer/);
    expect(nginx).toContain('access_log /var/log/nginx/access.log no_query;');
  });
});

describe('docs/erd.md', () => {
  it('knows every table: rerun src/db/erd.ts after a schema change', () => {
    const erd = read('docs/erd.md');
    const tables = Object.values(schema as Record<string, unknown>).filter((value): value is PgTable => is(value, PgTable)).map((table) => getTableConfig(table).name);
    expect(tables.length).toBeGreaterThan(50);
    expect(tables.filter((name) => !new RegExp(`^ {2}${name} \\{$`, 'm').test(erd))).toEqual([]);
  });
});

describe('docs/assistant.md', () => {
  afterEach(() => setProvider(undefined));

  it('the example of several records in one message gives two cards', async () => {
    const example = /Several records in one message:\*\* "([^"]+)" gives two cards/.exec(read('docs/assistant.md'))![1];
    const w = await world();
    setProvider(new Scripted([
      { ...call('draft_expense', {}), content: [
        { type: 'tool_use', id: 'a', name: 'draft_expense', input: { amount: 500_000, category: 'meals', paymentMethod: 'cash' } },
        { type: 'tool_use', id: 'b', name: 'draft_expense', input: { amount: 200_000, category: 'communication', paymentMethod: 'cash' } },
      ] },
      say('Tasdiqlang.'),
    ]));
    const res = await w.owner.post('/ai/chat', { message: example });
    expect(res.data.message.attachments.map((a: any) => a.question?.code ?? a.type)).toEqual(['proposal', 'proposal']);
  });

  it('step 5: money records carry ai_proposal, and a stock purchase stays with its receipt', async () => {
    const w = await world();
    const written = (id: string) => asOwner(w, () => tx().select({ sourceType: schema.transactions.sourceType }).from(schema.transactions).where(and(eq(schema.transactions.farmId, w.f.farmId), eq(schema.transactions.date, today), eq(schema.transactions.id, id))));

    const stock = await ready(w, 'stock_purchase', { item: 'Dizel', qty: 100, amount: 1_500_000, paymentMethod: 'cash' }, "Dizel 100 litr, 1.5 mln naqd to'ladim");
    const receipt = await asOwner(w, () => confirmProposal(stock.id, { stamp: stock.stamp, acknowledged: true }));
    expect(receipt.result?.type).toBe('stock_receipt');
    expect(await written(receipt.result!.id)).toEqual([{ sourceType: 'stock_batch' }]);

    const expense = await ready(w, 'expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }, 'Elektrga 3 mln naqd');
    const booked = await asOwner(w, () => confirmProposal(expense.id, { stamp: expense.stamp, acknowledged: true }));
    expect(await written(booked.result!.id)).toEqual([{ sourceType: 'ai_proposal' }]);
  });
});
