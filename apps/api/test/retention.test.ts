import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { recordEvent } from '../src/core/journal';
import { mergeSettings } from '../src/core/settings';
import { ALL_JOBS } from '../src/jobs';
import { raiseAlert } from '../src/modules/alerts/alerts.service';
import { applyRetention, retentionJob } from '../src/modules/settings/retention';
import { createFixture, type Fixture } from './helpers';

const {
  aiConversations,
  aiMessages,
  events,
  farms,
  idempotencyKeys,
  importJobs,
  notifications,
  refreshTokens,
  roles,
  telegramLinkCodes,
  tenants,
  webhookDeliveries,
} = schema;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const run = (f: Fixture) => f.run(() => applyRetention());

async function addNotification(f: Fixture, createdAt: Date, extra: Partial<typeof notifications.$inferInsert> = {}) {
  const { userId } = await f.as('owner');
  const id = uuidv7();
  await f.run(() =>
    tx().insert(notifications).values({ id, tenantId: f.tenantId, farmId: f.farmId, userId, title: 'Xabar', createdAt, ...extra }),
  );
  return id;
}

const notificationIds = async (f: Fixture) =>
  (await f.run(() => tx().select({ id: notifications.id }).from(notifications))).map((row) => row.id);

describe('notifications', () => {
  it('go after a year, read or not, but not a day sooner', async () => {
    const f = await createFixture();
    await addNotification(f, daysAgo(366));
    await addNotification(f, daysAgo(366), { readAt: daysAgo(300), deliveries: { telegram: 'sent' } });
    const kept = await addNotification(f, daysAgo(364));

    await run(f);

    expect(await notificationIds(f)).toEqual([kept]);
  });

  it('stay while a delivery is waiting to go out, however old', async () => {
    const f = await createFixture();
    const waiting = await addNotification(f, daysAgo(900), { deliveries: { in_app: 'sent', telegram: 'pending' } });
    await addNotification(f, daysAgo(900), { deliveries: { telegram: 'failed', telegram_attempts: '5' } });

    await run(f);

    expect(await notificationIds(f)).toEqual([waiting]);
  });

  it('of another tenant or another farm stay, while one for no farm goes', async () => {
    const f = await createFixture();
    const g = await createFixture();
    const [other] = await f.run(() => tx().insert(farms).values({ tenantId: f.tenantId, name: 'Ikkinchi ferma' }).returning());
    const otherFarm = await addNotification(f, daysAgo(400), { farmId: other.id });
    const otherTenant = await addNotification(g, daysAgo(400));
    await addNotification(f, daysAgo(400));
    await addNotification(f, daysAgo(400), { farmId: null });

    await run(f);

    expect(await notificationIds(f)).toEqual([otherFarm]);
    expect(await notificationIds(g)).toEqual([otherTenant]);
  });
});

describe('stored answers to repeated requests', () => {
  it('go after 30 days, and only this tenant\'s', async () => {
    const f = await createFixture();
    const g = await createFixture();
    const add = (x: Fixture, key: string, createdAt: Date) =>
      x.run(() => tx().insert(idempotencyKeys).values({ tenantId: x.tenantId, key, path: '/x', statusCode: 200, createdAt }));
    await add(f, 'old', daysAgo(31));
    await add(f, 'new', daysAgo(29));
    await add(g, 'other', daysAgo(31));

    await run(f);

    const keys = (x: Fixture) => x.run(() => tx().select({ key: idempotencyKeys.key }).from(idempotencyKeys));
    expect(await keys(f)).toEqual([{ key: 'new' }]);
    expect(await keys(g)).toEqual([{ key: 'other' }]);
  });

  it('a recent one still answers the repeat instead of doing the work again', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const send = () => owner.post('/finance/counterparties', { name: 'Takror', type: 'supplier' }, { 'idempotency-key': 'repeat-1' });
    const first = await send();
    expect(first.status).toBe(201);

    await run(f);

    const second = await send();
    expect(second.data.id).toBe(first.data.id);
    expect(second.headers['idempotent-replay']).toBe('true');
  });
});

describe('webhook deliveries', () => {
  it('go once finished and past 90 days, but one still retrying stays', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const hook = await owner.post('/settings/webhooks', { url: 'https://93.184.216.34/hooks/yap', eventTypes: ['*'] });
    const add = (status: string, createdAt: Date) =>
      f.run(() =>
        tx().insert(webhookDeliveries).values({
          tenantId: f.tenantId,
          farmId: f.farmId,
          subscriptionId: hook.data.id,
          eventType: 'test.happened',
          payload: {},
          status,
          createdAt,
        }),
      );
    await add('delivered', daysAgo(91));
    await add('failed', daysAgo(91));
    await add('pending', daysAgo(91));
    await add('delivered', daysAgo(89));

    await run(f);

    const left = await f.run(() => tx().select().from(webhookDeliveries));
    expect(left.map((row) => row.status).sort()).toEqual(['delivered', 'pending']);
    expect(left.find((row) => row.status === 'delivered')!.createdAt.getTime()).toBeGreaterThan(daysAgo(90).getTime());
  });
});

describe('what the assistant looked up', () => {
  const proposalId = uuidv7();
  const answer = {
    text: 'Kassada 99 mln bor.',
    outcome: 'answered',
    asked: [],
    toolCalls: [{ name: 'cash_position', input: { accountId: 'x' }, status: 'ok', rows: 1, durationMs: 12 }],
    attachments: [
      { type: 'table', title: 'Kassa', columns: ['balance'], rows: [{ balance: 99_000_000 }], total: 1 },
      { type: 'chart', chart: 'bar', title: 'Kassa', xKey: 'month', yKeys: ['balance'], rows: [{ month: 'Yan', balance: 1 }] },
      { type: 'proposal', proposal: { id: proposalId, fields: { amount: 500 } } },
    ],
    sources: [{ tool: 'cash_position', tables: ['accounts'], rows: 1 }],
    confidence: { level: 'high', basis: 'data' },
    model: 'test-model',
    usage: { inputTokens: 10, outputTokens: 5 },
  };

  async function conversation(f: Fixture, userId: string, createdAt: Date, content: object = answer) {
    const [row] = await f.run(() =>
      tx().insert(aiConversations).values({ tenantId: f.tenantId, farmId: f.farmId, userId, title: 'Kassa' }).returning(),
    );
    await f.run(() =>
      tx().insert(aiMessages).values([
        { tenantId: f.tenantId, conversationId: row.id, role: 'user', content: { text: 'Kassada qancha bor?' }, createdAt },
        { tenantId: f.tenantId, conversationId: row.id, role: 'assistant', content, createdAt },
      ]),
    );
    return row.id;
  }

  const stored = async (f: Fixture, conversationId: string, role: string) => {
    const rows = await f.run(() => tx().select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)));
    return rows.find((row) => row.role === role)!.content as Record<string, any>;
  };

  it('goes after 90 days, and the words, the tool names and the cards stay', async () => {
    const f = await createFixture();
    const { userId } = await f.as('owner');
    const old = await conversation(f, userId, daysAgo(91));
    const recent = await conversation(f, userId, daysAgo(89));

    const removed = await run(f);

    expect(removed.aiToolData).toBe(1);
    expect(await stored(f, old, 'assistant')).toEqual({
      text: answer.text,
      outcome: answer.outcome,
      asked: [],
      toolCalls: [{ name: 'cash_position', status: 'ok', rows: 1, durationMs: 12 }],
      attachments: [answer.attachments[2]],
      confidence: answer.confidence,
      model: answer.model,
    });
    expect(await stored(f, old, 'user')).toEqual({ text: 'Kassada qancha bor?' });
    expect(await stored(f, recent, 'assistant')).toEqual(answer);
  });

  it('copes with an answer that used no tools', async () => {
    const f = await createFixture();
    const { userId } = await f.as('owner');
    const id = await conversation(f, userId, daysAgo(91), { text: 'Salom', toolCalls: [], attachments: [], sources: [] });

    await run(f);

    expect(await stored(f, id, 'assistant')).toEqual({ text: 'Salom', toolCalls: [], attachments: [] });
  });

  it('an answer that held money stays hidden from someone who has lost finance.view', async () => {
    const f = await createFixture();
    const accountant = await f.as('accountant');
    const id = await conversation(f, accountant.userId, daysAgo(91));
    await run(f);

    await f.run(() => tx().update(roles).set({ permissions: ['ai.view'] }).where(eq(roles.id, f.roleIds.accountant)));

    const seen = await accountant.get(`/ai/conversations/${id}`);
    expect(seen.status).toBe(200);
    expect(JSON.stringify(seen.data.messages)).not.toContain('99 mln');
  });

  it('of another farm is left for that farm\'s run', async () => {
    const f = await createFixture();
    const { userId } = await f.as('owner');
    const [other] = await f.run(() => tx().insert(farms).values({ tenantId: f.tenantId, name: 'Ikkinchi ferma' }).returning());
    const [row] = await f.run(() =>
      tx().insert(aiConversations).values({ tenantId: f.tenantId, farmId: other.id, userId, title: 'Boshqa' }).returning(),
    );
    await f.run(() =>
      tx().insert(aiMessages).values({ tenantId: f.tenantId, conversationId: row.id, role: 'assistant', content: answer, createdAt: daysAgo(91) }),
    );

    await run(f);

    expect(await stored(f, row.id, 'assistant')).toEqual(answer);
  });
});

describe('imports', () => {
  const held = { rows: [{ row: 2, values: { phone: '+998901112233' } }], errors: [{ row: 2, message: 'Xato' }], warnings: [{ row: 3, message: 'Diqqat' }] };
  const add = (f: Fixture, status: string, createdAt: Date) =>
    f.run(async () => {
      const [row] = await tx()
        .insert(importJobs)
        .values({ tenantId: f.tenantId, farmId: f.farmId, template: 'animals', fileName: 'a.xlsx', status, totalRows: 3, importedRows: 2, summary: { new: 2 }, createdAt, ...held })
        .returning();
      return row.id;
    });
  const load = (f: Fixture) => f.run(() => tx().select().from(importJobs));

  it('never finished go after 90 days, with the personal data they hold', async () => {
    const f = await createFixture();
    await add(f, 'preview', daysAgo(91));
    await add(f, 'discarded', daysAgo(91));
    const open = await add(f, 'preview', daysAgo(89));

    const removed = await run(f);

    expect(removed.abandonedImports).toBe(2);
    expect((await load(f)).map((row) => row.id)).toEqual([open]);
  });

  it('finished keep the record of what came in, without the rows', async () => {
    const f = await createFixture();
    const old = await add(f, 'confirmed', daysAgo(91));
    const recent = await add(f, 'confirmed', daysAgo(89));

    const removed = await run(f);

    expect(removed.importedRows).toBe(1);
    const rows = await load(f);
    expect(rows.find((row) => row.id === old)).toMatchObject({ status: 'confirmed', totalRows: 3, importedRows: 2, summary: { new: 2 }, rows: [], errors: [], warnings: [] });
    expect(rows.find((row) => row.id === recent)).toMatchObject(held);
    expect((await run(f)).importedRows).toBe(0);
  });
});

describe('another farm of the same tenant', () => {
  it('keeps its webhook log and imports until its own run', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const hook = await owner.post('/settings/webhooks', { url: 'https://93.184.216.34/hooks/yap', eventTypes: ['*'] });
    const [other] = await f.run(() => tx().insert(farms).values({ tenantId: f.tenantId, name: 'Ikkinchi ferma' }).returning());
    const old = daysAgo(400);
    await f.run(async () => {
      await tx().insert(webhookDeliveries).values({
        tenantId: f.tenantId,
        farmId: other.id,
        subscriptionId: hook.data.id,
        eventType: 'test.happened',
        payload: {},
        status: 'delivered',
        createdAt: old,
      });
      await tx().insert(importJobs).values([
        { tenantId: f.tenantId, farmId: other.id, template: 'animals', fileName: 'a.xlsx', status: 'preview', createdAt: old },
        { tenantId: f.tenantId, farmId: other.id, template: 'animals', fileName: 'b.xlsx', status: 'confirmed', rows: [{ row: 2 }], createdAt: old },
      ]);
    });

    const removed = await run(f);

    expect(removed).toMatchObject({ webhookDeliveries: 0, abandonedImports: 0, importedRows: 0 });
  });
});

describe('sessions and Telegram link codes', () => {
  it('go only long after they stopped working', async () => {
    const f = await createFixture();
    const { userId } = await f.as('owner');
    const token = (expiresAt: Date) => ({ userId, tokenHash: randomBytes(16).toString('hex'), familyId: uuidv7(), expiresAt });
    const code = (expiresAt: Date) => ({ code: randomBytes(6).toString('hex'), userId, expiresAt });
    const dead = token(daysAgo(31));
    const kept = token(daysAgo(29));
    const live = token(daysAgo(-5));
    const deadCode = code(daysAgo(8));
    const keptCode = code(daysAgo(6));
    await f.run(async () => {
      await tx().insert(refreshTokens).values([dead, kept, live]);
      await tx().insert(telegramLinkCodes).values([deadCode, keptCode]);
    });

    const removed = await run(f);

    expect(removed).toMatchObject({ sessions: 1, linkCodes: 1 });
    const hashes = [dead, kept, live].map((t) => t.tokenHash);
    const tokens = await f.run(() => tx().select({ hash: refreshTokens.tokenHash }).from(refreshTokens).where(inArray(refreshTokens.tokenHash, hashes)));
    expect(tokens.map((t) => t.hash).sort()).toEqual([kept.tokenHash, live.tokenHash].sort());
    const codes = await f.run(() => tx().select({ code: telegramLinkCodes.code }).from(telegramLinkCodes).where(inArray(telegramLinkCodes.code, [deadCode.code, keptCode.code])));
    expect(codes).toEqual([{ code: keptCode.code }]);
  });
});

describe('what stays for ever', () => {
  /** Every table of one tenant: the rest of the suite shares this database and runs at the same time. */
  const tenantTables = async (db: pg.Client) =>
    (
      await db.query(
        `select c.table_name from information_schema.columns c
         join information_schema.tables t using (table_schema, table_name)
         where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'`,
      )
    ).rows.map((row) => row.table_name as string);

  async function counts(db: pg.Client, tenantId: string) {
    const result: Record<string, number> = {};
    for (const table of await tenantTables(db)) {
      result[table] = Number((await db.query(`select count(*) from "${table}" where tenant_id = $1`, [tenantId])).rows[0].count);
    }
    return result;
  }

  it('ten years on, the job takes nothing from any table it does not name', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    expect((await owner.post('/finance/counterparties', { name: 'Eski hamkor', type: 'supplier' })).status).toBe(201);
    await f.run(() => raiseAlert({ ruleKey: 'test.rule', dedupKey: 'test:1', severity: 'attention', title: 'Eski', body: 'Eski' }));
    await f.run(() => recordEvent({ type: 'test.old' }));
    await addNotification(f, daysAgo(4000));

    const db = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
    await db.connect();
    try {
      await db.query(`set session_replication_role = replica`);
      const { rows } = await db.query(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public' and column_name in ('created_at', 'at', 'occurred_at') and table_name = any($1)`,
        [await tenantTables(db)],
      );
      for (const { table_name: table, column_name: column } of rows) {
        await db.query(`update "${table}" set "${column}" = "${column}" - interval '10 years' where tenant_id = $1`, [f.tenantId]);
      }
      const before = await counts(db, f.tenantId);
      expect(before).toMatchObject({ counterparties: 1, alerts: 1 });
      expect(before.audit_logs).toBeGreaterThan(0);

      await run(f);

      const after = await counts(db, f.tenantId);
      const changed = Object.keys(after).filter((table) => after[table] !== before[table]).sort();
      expect(changed).toEqual(['events', 'notifications']);
      expect(after.notifications).toBe(before.notifications - 1);
      expect(after.events).toBe(before.events + 1);
    } finally {
      await db.end();
    }
  });
});

describe('the policy', () => {
  it('is the tenant\'s own, read when the job runs', async () => {
    const f = await createFixture();
    const g = await createFixture();
    const owner = await f.as('owner');
    expect((await owner.patch('/settings/policy', { retention: { notificationDays: 60 } })).status).toBe(200);
    expect((await owner.get('/settings/policy')).data.retention).toMatchObject({ notificationDays: 60, idempotencyDays: 30 });
    await addNotification(f, daysAgo(61));
    const kept = await addNotification(g, daysAgo(61));

    for (const x of [f, g]) {
      const [{ settings }] = await x.run(() => tx().select({ settings: tenants.settings }).from(tenants));
      await x.run(retentionJob.run, { settings: mergeSettings(settings) });
    }

    expect(await notificationIds(f)).toEqual([]);
    expect(await notificationIds(g)).toEqual([kept]);
  });

  it('refuses a time so short it could post a record twice, and anything but whole days', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const patch = (retention: unknown) => owner.patch('/settings/policy', { retention });
    expect((await patch({ idempotencyDays: 29 })).status).toBe(400);
    expect((await patch({ notificationDays: 29 })).status).toBe(400);
    expect((await patch({ webhookDeliveryDays: 6 })).status).toBe(400);
    expect((await patch({ importDays: 90.5 })).status).toBe(400);
    expect((await patch({ auditDays: 30 })).status).toBe(400);
    expect((await patch({ idempotencyDays: 30 })).status).toBe(200);
  });

  it('is not for a shepherd to change', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    expect((await shepherd.patch('/settings/policy', { retention: { notificationDays: 60 } })).status).toBe(403);
  });
});

describe('the job', () => {
  it('runs every day', () => {
    const job = ALL_JOBS.find((j) => j.name === 'settings.retention');
    expect(job?.cron).toBe('45 3 * * *');
  });

  it('notes in the journal what it removed, and only when it removed something', async () => {
    const f = await createFixture();
    await addNotification(f, daysAgo(400));
    const notes = () => f.run(() => tx().select().from(events).where(eq(events.type, 'retention.applied')));

    expect((await run(f)).notifications).toBe(1);

    const [note, ...others] = await notes();
    expect(others).toEqual([]);
    expect(note.source).toBe('system');
    expect(note.data).toMatchObject({ removed: { notifications: 1, idempotencyKeys: 0 }, days: { notificationDays: 365 } });

    const again = await run(f);
    expect(Object.values(again).every((count) => count === 0)).toBe(true);
    expect(await notes()).toHaveLength(1);
  });
});
