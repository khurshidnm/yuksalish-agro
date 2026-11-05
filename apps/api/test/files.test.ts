import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_UPLOAD_BYTES, ROLE_KEYS, todayIso, type RoleKey } from '@yap/shared';
import { tx } from '../src/core/context';
import { recordEvent } from '../src/core/journal';
import { UPLOADS_PER_MINUTE, storage, withUploadMemory } from '../src/core/storage';
import { addMember } from '../src/core/tenancy';
import { signAccessToken } from '../src/core/tokens';
import { pool, schema } from '../src/db/client';
import { evaluateRules } from '../src/modules/alerts/rules';
import { createFixture, type Client, type Fixture } from './helpers';

const { dailyLogs, documents, events, files, herds } = schema;

const MB = 1024 * 1024;
const BOUNDARY = 'yapfiles';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function tokenFor(f: Fixture, role: RoleKey): Promise<string> {
  const client = await f.as(role);
  return signAccessToken({ userId: client.userId, membershipId: client.membershipId, tenantId: f.tenantId, farmId: f.farmId });
}

const multipart = (body: Buffer, name = 'photo.png', type = 'image/png') =>
  Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
    body,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);

const png = (size: number) => Buffer.concat([PNG, Buffer.alloc(size - PNG.length)]);

async function send(f: Fixture, role: RoleKey, url: string, payload: Buffer, contentType = `multipart/form-data; boundary=${BOUNDARY}`) {
  const res = await f.app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${await tokenFor(f, role)}`, 'content-type': contentType },
    payload,
  });
  const json = res.json();
  return { status: res.statusCode, data: json.data, error: json.error };
}

const upload = (f: Fixture, role: RoleKey, size = 100) => send(f, role, '/api/v1/files', multipart(png(size)));

const journal = (f: Fixture, type: string) =>
  f.run(() => tx().select().from(events).where(and(eq(events.farmId, f.farmId), eq(events.type, type))));

const storedFile = async (f: Fixture, id: string) => {
  const [row] = await f.run(() => tx().select().from(files).where(eq(files.id, id)));
  return row;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('uploading', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  it.each(ROLE_KEYS)('lets a %s attach a photo, and writes it in the journal', async (role) => {
    const res = await upload(f, role);
    expect(res.status).toBe(200);
    const [event] = (await journal(f, 'file.uploaded')).filter((e) => e.entityId === res.data.id);
    expect(event).toMatchObject({ entityType: 'file', data: { name: 'photo.png', mimeType: 'image/png', sizeBytes: 100 } });
  });

  it('needs no particular permission, so a role made by hand can attach a file too', async () => {
    const custom = await createFixture();
    const owner = await custom.as('owner');
    const role = await owner.post('/settings/roles', { name: 'Kassir', permissions: ['finance.view'] });
    expect(role.status).toBe(201);
    const member = await addMember({
      tenantId: custom.tenantId,
      farmId: custom.farmId,
      roleId: role.data.id,
      phone: `+998${Math.floor(100_000_000 + Math.random() * 899_999_999)}`,
      fullName: 'Kassir',
      password: 'Password123!',
    });
    const token = await signAccessToken({ ...member, tenantId: custom.tenantId, farmId: custom.farmId });
    const res = await custom.app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart(png(100)),
    });
    expect(res.statusCode).toBe(200);
  });

  it('asks a role with 2FA to enrol first, as every other route does', async () => {
    const strict = await createFixture({ settings: { security: { enforce2fa: true } } });
    const res = await upload(strict, 'owner');
    expect(res.status).toBe(403);
    expect(res.error.code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED');
  });

  it('takes a file of exactly the limit, and refuses one byte more with the limit in the answer', async () => {
    expect((await upload(f, 'owner', MAX_UPLOAD_BYTES)).status).toBe(200);
    const res = await upload(f, 'owner', MAX_UPLOAD_BYTES + 1);
    expect(res.status).toBe(413);
    expect(res.error).toMatchObject({ code: 'FILE_TOO_LARGE', details: { maxMb: 15 } });
  });

  it('agrees with the proxy: nginx lets the largest file through, with only room for the wrapper', () => {
    const nginx = readFileSync(new URL('../../../infra/nginx.conf', import.meta.url), 'utf8');
    const proxyLimit = Number(/client_max_body_size (\d+)m;/.exec(nginx)![1]) * MB;
    expect(proxyLimit).toBeGreaterThan(MAX_UPLOAD_BYTES);
    expect(proxyLimit - MAX_UPLOAD_BYTES).toBeLessThanOrEqual(MB);
  });

  it('stores a name it can use, whatever the client sends', async () => {
    const res = await send(f, 'owner', '/api/v1/files', multipart(png(100), `\u0007${'a'.repeat(300)}`));
    expect(res.status).toBe(200);
    expect(res.data.name).toBe('a'.repeat(255));
    expect((await storedFile(f, res.data.id)).name).toBe('a'.repeat(255));
  });

  it('serves back the same bytes, from a stream', async () => {
    const body = png(70_000);
    body.fill(7, 100);
    const { data } = await send(f, 'owner', '/api/v1/files', multipart(body));
    const res = await f.app.inject({ method: 'GET', url: data.url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe('70000');
    expect(res.rawPayload.equals(body)).toBe(true);
  });

  it('answers not found for a row whose bytes are gone', async () => {
    const { data } = await upload(f, 'owner');
    await storage.delete((await storedFile(f, data.id)).storageKey);
    expect((await f.app.inject({ method: 'GET', url: data.url })).statusCode).toBe(404);
  });

  it('holds a limited amount of uploads in memory at once, and frees it after each', async () => {
    const full = { headers: { 'content-length': String(MAX_UPLOAD_BYTES) } };
    let finish = () => {};
    const stop = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const held = Array.from({ length: 6 }, () => withUploadMemory(full, () => stop));
    await expect(withUploadMemory(full, async () => 'more')).rejects.toMatchObject({ status: 429, code: 'UPLOADS_BUSY' });
    await expect(withUploadMemory({ headers: {} }, async () => 'unknown size')).rejects.toMatchObject({ code: 'UPLOADS_BUSY' });
    await expect(withUploadMemory({ headers: { 'content-length': '1000' } }, async () => 'small')).resolves.toBe('small');
    finish();
    await Promise.all(held);
    await expect(withUploadMemory(full, async () => 'room again')).resolves.toBe('room again');

    await expect(withUploadMemory(full, () => Promise.reject(new Error('broke')))).rejects.toThrow('broke');
    const again = Array.from({ length: 6 }, () => withUploadMemory(full, async () => 'ok'));
    await expect(Promise.all(again)).resolves.toHaveLength(6);
  });

  it('turns a person away past the limit per minute, and only that person', async () => {
    const busy = await createFixture();
    for (let i = 0; i < UPLOADS_PER_MINUTE; i++) expect((await upload(busy, 'shepherd')).status).toBe(200);
    const res = await upload(busy, 'shepherd');
    expect(res.status).toBe(429);
    expect(res.error.code).toBe('RATE_LIMITED');
    expect((await upload(busy, 'mechanic')).status).toBe(200);
  });
});

describe('a body that is not a good upload', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  const part = (headers: string, body: string) => `--${BOUNDARY}\r\n${headers}\r\n\r\n${body}\r\n`;
  const file = 'Content-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png';
  const field = (n: number) => part(`Content-Disposition: form-data; name="f${n}"`, 'x');

  it.each([
    ['no file in it', Buffer.from(`${field(1)}--${BOUNDARY}--\r\n`), 400],
    ['no end', Buffer.from(`--${BOUNDARY}\r\n${file}\r\n\r\nabc`), 400],
    ['no headers', Buffer.from(`--${BOUNDARY}\r\n\r\n\r\n--${BOUNDARY}--\r\n`), 400],
    ['nothing', Buffer.alloc(0), 400],
    ['thousands of fields before the file', Buffer.from(`${Array.from({ length: 5000 }, (_, n) => field(n)).join('')}${part(file, 'abc')}--${BOUNDARY}--\r\n`), 413],
    ['a field of 1 MB', Buffer.from(`${part('Content-Disposition: form-data; name="big"', 'x'.repeat(MB))}${part(file, 'abc')}--${BOUNDARY}--\r\n`), 400],
  ])('refuses one with %s', async (_name, body, status) => {
    for (const url of ['/api/v1/files', '/api/v1/import/animals']) {
      const res = await send(f, 'owner', url, body);
      expect([url, res.status]).toEqual([url, status]);
    }
  });

  it.each([
    ['a multipart type with no boundary', 'multipart/form-data'],
    ['a type that is not multipart', 'application/octet-stream'],
    ['JSON', 'application/json'],
  ])('refuses %s', async (_name, type) => {
    for (const url of ['/api/v1/files', '/api/v1/import/animals']) {
      const res = await send(f, 'owner', url, Buffer.from('{}'), type);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });

  describe('over a real connection', () => {
    let port: number;
    beforeAll(async () => {
      await f.app.listen({ port: 0, host: '127.0.0.1' });
      port = (f.app.server.address() as { port: number }).port;
    });
    afterAll(() => new Promise((resolve) => f.app.server.close(resolve)));

    /** Sends the start of an upload that claims the full size, then hangs up. */
    const abandon = (token: string, path: string) =>
      new Promise<void>((resolve) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(
            `POST ${path} HTTP/1.1\r\nHost: yap\r\nAuthorization: Bearer ${token}\r\n` +
              `Content-Type: multipart/form-data; boundary=${BOUNDARY}\r\nContent-Length: ${MAX_UPLOAD_BYTES}\r\n\r\n` +
              `--${BOUNDARY}\r\n${file}\r\n\r\n`,
          );
          socket.write(png(1000), () => setTimeout(() => socket.destroy(), 100));
        });
        socket.on('close', () => resolve());
        socket.on('error', () => {});
      });

    it('lets go of everything when the client hangs up halfway', async () => {
      const token = await tokenFor(f, 'owner');
      for (let i = 0; i < 7; i++) {
        await abandon(token, '/api/v1/files');
        await abandon(token, '/api/v1/import/animals');
      }
      await vi.waitFor(() => expect(pool.totalCount - pool.idleCount).toBe(0));

      const full = { headers: { 'content-length': String(MAX_UPLOAD_BYTES) } };
      await expect(Promise.all(Array.from({ length: 6 }, () => withUploadMemory(full, async () => 'ok')))).resolves.toHaveLength(6);
      expect((await upload(f, 'owner')).status).toBe(200);
    });
  });
});

describe('storage limits', () => {
  it('stops a workspace at its quota, says how full it is, and tells the journal once', async () => {
    const f = await createFixture({ settings: { storage: { quotaMb: 1, dailyUploadMb: 100 } } });
    expect((await upload(f, 'shepherd', 600 * 1024)).status).toBe(200);

    const refused = await upload(f, 'mechanic', 600 * 1024);
    expect(refused.status).toBe(409);
    expect(refused.error).toMatchObject({ code: 'STORAGE_QUOTA_REACHED', details: { usedMb: 1, quotaMb: 1 } });
    expect((await upload(f, 'shepherd', 300 * 1024)).status).toBe(200);
    expect((await upload(f, 'mechanic', 600 * 1024)).status).toBe(409);

    await vi.waitFor(async () => expect(await journal(f, 'file.limit_reached')).toHaveLength(1));
    await upload(f, 'mechanic', 600 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [event] = await journal(f, 'file.limit_reached');
    expect((await journal(f, 'file.limit_reached')).length).toBe(1);
    expect(event).toMatchObject({ severity: 'attention', data: { code: 'STORAGE_QUOTA_REACHED' }, createdBy: (await f.as('mechanic')).userId });
  });

  it('does not let uploads at the same moment pass on the same total', async () => {
    const f = await createFixture({ settings: { storage: { quotaMb: 1, dailyUploadMb: 100 } } });
    const results = await Promise.all(Array.from({ length: 6 }, () => upload(f, 'owner', 600 * 1024)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
  });

  it('stops one person at the daily limit, and leaves the others free', async () => {
    const f = await createFixture({ settings: { storage: { quotaMb: 100, dailyUploadMb: 1 } } });
    expect((await upload(f, 'shepherd', 600 * 1024)).status).toBe(200);

    const refused = await upload(f, 'shepherd', 600 * 1024);
    expect(refused.status).toBe(409);
    expect(refused.error).toMatchObject({ code: 'DAILY_UPLOAD_LIMIT_REACHED', details: { limitMb: 1 } });
    expect((await upload(f, 'mechanic', 600 * 1024)).status).toBe(200);
  });

  it('counts only the last 24 hours towards a person, and everything towards the workspace', async () => {
    const f = await createFixture({ settings: { storage: { quotaMb: 3, dailyUploadMb: 1 } } });
    const { data } = await upload(f, 'shepherd', 800 * 1024);
    await f.run(() => tx().update(files).set({ createdAt: new Date(Date.now() - 25 * 3600 * 1000) }).where(eq(files.id, data.id)));

    expect((await upload(f, 'shepherd', 800 * 1024)).status).toBe(200);
    const usage = await (await f.as('shepherd')).get('/files/usage');
    expect(usage.data).toEqual({ usedMb: 2, quotaMb: 3, uploadedTodayMb: 1, dailyUploadMb: 1 });
  });

  it('is set in the policy, by those who may change it', async () => {
    const f = await createFixture({ settings: { storage: { quotaMb: 100, dailyUploadMb: 15 } } });
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');

    expect((await owner.get('/settings/policy')).data.storage).toEqual({ quotaMb: 100, dailyUploadMb: 15 });
    expect((await shepherd.patch('/settings/policy', { storage: { quotaMb: 999 } })).status).toBe(403);
    expect((await owner.patch('/settings/policy', { storage: { quotaMb: 1 } })).status).toBe(400);
    expect((await owner.patch('/settings/policy', { storage: { quota: 500 } })).status).toBe(400);

    expect((await owner.patch('/settings/policy', { storage: { dailyUploadMb: 20 } })).status).toBe(200);
    expect((await owner.get('/settings/policy')).data.storage).toEqual({ quotaMb: 100, dailyUploadMb: 20 });
    expect((await upload(f, 'owner', 14 * MB)).status).toBe(200);
    expect((await upload(f, 'owner', 7 * MB)).error.code).toBe('DAILY_UPLOAD_LIMIT_REACHED');
  });

  it('stops every upload while the disk is nearly full, because Postgres shares it', async () => {
    const f = await createFixture();
    vi.spyOn(storage, 'freeBytes').mockResolvedValue(1024 * MB);
    const res = await upload(f, 'owner');
    expect(res.status).toBe(409);
    expect(res.error.code).toBe('STORAGE_FULL');
    expect(await f.run(() => tx().select().from(files))).toEqual([]);
  });

  it('tells the owner while there is still room, and takes it back once there is more', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    const alertOf = async (client: Client) => (await client.get('/alerts')).body.data.find((a: { ruleKey: string }) => a.ruleKey === 'disk_low');

    vi.spyOn(storage, 'freeBytes').mockResolvedValue(3.05 * 1024 * MB);
    await f.run(() => evaluateRules());
    const alert = await alertOf(owner);
    expect(alert).toMatchObject({ severity: 'attention', status: 'open', link: '/settings?tab=files', data: { freeGb: 3, stopsAtGb: 2 } });
    expect(alert.title).toBeTruthy();
    expect(await alertOf(shepherd)).toBeUndefined();
    const told = await f.run(() => tx().select().from(schema.notifications).where(eq(schema.notifications.userId, owner.userId)));
    expect(told).toHaveLength(1);
    expect((await upload(f, 'owner')).status).toBe(200);

    vi.spyOn(storage, 'freeBytes').mockResolvedValue(4 * 1024 * MB);
    await f.run(() => evaluateRules());
    expect((await owner.get('/alerts', { status: 'resolved' })).body.data[0]).toMatchObject({ ruleKey: 'disk_low' });
  });

  it('has nothing to say about a disk that is not ours', async () => {
    const f = await createFixture();
    vi.spyOn(storage, 'freeBytes').mockResolvedValue(null);
    await f.run(() => evaluateRules());
    const alerts = await f.run(() => tx().select().from(schema.alerts).where(eq(schema.alerts.ruleKey, 'disk_low')));
    expect(alerts).toEqual([]);
  });

  it('leaves no row and no journal entry when the bytes cannot be written', async () => {
    const f = await createFixture();
    vi.spyOn(storage, 'put').mockRejectedValue(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
    const remove = vi.spyOn(storage, 'delete');
    const res = await upload(f, 'owner');
    expect(res.error.code).toBe('STORAGE_FULL');
    expect(remove).toHaveBeenCalledOnce();
    expect(await f.run(() => tx().select().from(files))).toEqual([]);
    expect(await journal(f, 'file.uploaded')).toEqual([]);
  });

  it('counts an idempotent retry once', async () => {
    const f = await createFixture({ settings: { storage: { quotaMb: 1, dailyUploadMb: 100 } } });
    const token = await tokenFor(f, 'shepherd');
    const retry = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
          'idempotency-key': 'photo-1',
        },
        payload: multipart(png(600 * 1024)),
      });
    const first = await retry();
    const second = await retry();
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json().data.id).toBe(first.json().data.id);
    expect(await f.run(() => tx().select().from(files))).toHaveLength(1);
  });
});

describe('deleting a file nothing uses', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  const remove = async (role: RoleKey, id: string) => (await f.as(role)).delete(`/files/${id}`);
  const stored = async (role: RoleKey = 'shepherd') => (await upload(f, role)).data.id as string;

  it('frees the bytes and the quota, and writes it in the journal', async () => {
    const small = await createFixture({ settings: { storage: { quotaMb: 1, dailyUploadMb: 100 } } });
    const { data } = await upload(small, 'shepherd', 700 * 1024);
    const { storageKey } = await storedFile(small, data.id);
    expect((await upload(small, 'shepherd', 700 * 1024)).status).toBe(409);

    const res = await (await small.as('shepherd')).delete(`/files/${data.id}`);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ id: data.id });

    await expect(storage.get(storageKey)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await storedFile(small, data.id)).toBeUndefined();
    expect((await small.app.inject({ method: 'GET', url: data.url })).statusCode).toBe(404);
    const [event] = await journal(small, 'file.deleted');
    expect(event).toMatchObject({ entityId: data.id, data: { name: 'photo.png', mimeType: 'image/png', sizeBytes: 700 * 1024 } });
    expect((await upload(small, 'shepherd', 700 * 1024)).status).toBe(200);
  });

  it('is for the person who uploaded it, or someone who runs the workspace', async () => {
    const id = await stored('shepherd');
    const refused = await remove('mechanic', id);
    expect(refused.status).toBe(403);
    expect(await journal(f, 'file.deleted')).toEqual([]);
    expect((await remove('owner', id)).status).toBe(200);
  });

  it('cannot see another workspace or farm', async () => {
    const id = await stored();
    const other = await createFixture();
    expect((await (await other.as('owner')).delete(`/files/${id}`)).status).toBe(404);
    expect(await storedFile(f, id)).toBeDefined();
  });

  it('answers not found the second time', async () => {
    const id = await stored();
    await remove('shepherd', id);
    expect((await remove('shepherd', id)).status).toBe(404);
  });

  it('refuses while a record points at it through a foreign key', async () => {
    const id = await stored();
    await f.run(() => tx().insert(documents).values({ tenantId: f.tenantId, farmId: f.farmId, type: 'contract', title: 'Ijara', fileId: id }));
    const res = await remove('owner', id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IN_USE');
    expect(await storedFile(f, id)).toBeDefined();
  });

  it('refuses while a list of photos holds it', async () => {
    const id = await stored();
    await f.run(async () => {
      const [herd] = await tx().insert(herds).values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Poda' }).returning();
      await tx()
        .insert(dailyLogs)
        .values({ tenantId: f.tenantId, farmId: f.farmId, herdId: herd.id, date: todayIso(), headCount: 1, photoFileIds: [id] });
    });
    expect((await remove('owner', id)).body.error.code).toBe('IN_USE');
  });

  it('refuses while the journal shows it as a photo, or as a stored report', async () => {
    const photo = await stored();
    const report = await stored();
    await f.run(async () => {
      await recordEvent({ type: 'camera.motion', photoFileId: photo });
      await recordEvent({ type: 'report.investor_generated', entityType: 'file', entityId: report, data: { fileId: report } });
    });
    expect((await remove('owner', photo)).body.error.code).toBe('IN_USE');
    expect((await remove('owner', report)).body.error.code).toBe('IN_USE');
  });

  it('lists what can go: for a person their own, for the owner all of it', async () => {
    const farm = await createFixture();
    const mine = (await upload(farm, 'shepherd')).data.id;
    const theirs = (await upload(farm, 'mechanic')).data.id;
    const attached = (await upload(farm, 'shepherd')).data.id;
    await farm.run(() =>
      tx().insert(documents).values({ tenantId: farm.tenantId, farmId: farm.farmId, type: 'contract', title: 'Ijara', fileId: attached }),
    );

    const seen = async (role: RoleKey) => (await (await farm.as(role)).get('/files/unused')).data.map((row: any) => row.id).sort();
    expect(await seen('shepherd')).toEqual([mine]);
    expect(await seen('owner')).toEqual([mine, theirs].sort());
    const [row] = (await (await farm.as('shepherd')).get('/files/unused')).data;
    expect(row).toMatchObject({ name: 'photo.png', mimeType: 'image/png', sizeBytes: 100 });
  });
});
