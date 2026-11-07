import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@yap/shared';
import { buildApp } from '../src/app';
import { tx } from '../src/core/context';
import { isPrivateAddress, requestPublic } from '../src/core/outbound';
import { signAccessToken } from '../src/core/tokens';
import { schema } from '../src/db/client';
import { issueFormToken } from '../src/modules/leads/leads.service';
import { assertSafeUrl, deliverDue } from '../src/modules/settings/webhooks.service';
import { createFixture, getApp, type Client, type Fixture } from './helpers';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

async function tokenFor(f: Fixture, client: Client) {
  return signAccessToken({ userId: client.userId, membershipId: client.membershipId, tenantId: f.tenantId, farmId: f.farmId });
}

describe('malformed input', () => {
  const lead = (fields: Record<string, unknown>) => ({
    fullName: 'Karim Aliyev',
    phone: `+99890${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    consent: true,
    formToken: issueFormToken(Date.now() - 12_000),
    ...fields,
  });

  async function postLead(body: unknown) {
    const app = await getApp();
    return app.inject({ method: 'POST', url: '/api/v1/leads', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  }

  it.each([
    ['a name', { fullName: 'Karim\u0000Aliyev' }],
    ['a message', { message: 'a\u0000b' }],
    ['a value inside JSON', { utm: { utm_source: 'a\u0000b' } }],
  ])('refuses a NUL character in %s', async (_where, fields) => {
    const res = await postLead(lead(fields));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
  });

  describe('as a signed-in user', () => {
    const BOUNDARY = 'yap-test';
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const header = (name: string) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`;
    const whole = (name: string) => Buffer.concat([Buffer.from(header(name), 'latin1'), PNG, Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]);

    let f: Fixture;
    let auth: Record<string, string>;

    beforeAll(async () => {
      f = await createFixture();
      auth = { authorization: `Bearer ${await tokenFor(f, await f.as('owner'))}` };
    });

    async function upload(url: string, contentType: string, payload: Buffer | string) {
      const app = await getApp();
      return app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { ...auth, 'content-type': contentType }, payload });
    }

    it('takes a well-formed upload, so the refusals below are about the shape', async () => {
      const res = await upload('/files', `multipart/form-data; boundary=${BOUNDARY}`, whole('a.png'));
      expect(res.statusCode).toBe(200);
    });

    it('refuses a NUL character in a file name', async () => {
      for (const url of ['/files', '/import/animals']) {
        const res = await upload(url, `multipart/form-data; boundary=${BOUNDARY}`, whole('a\u0000.png'));
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('INVALID_INPUT');
      }
    });

    it('holds both upload routes to the same limit, and says what it is', async () => {
      const over = Buffer.concat([Buffer.from(header('a.png'), 'latin1'), PNG, Buffer.alloc(MAX_UPLOAD_BYTES), Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]);
      for (const url of ['/files', '/import/animals']) {
        const res = await upload(url, `multipart/form-data; boundary=${BOUNDARY}`, over);
        expect(res.statusCode).toBe(413);
        expect(res.json().error).toMatchObject({ code: 'FILE_TOO_LARGE', details: { maxMb: MAX_UPLOAD_BYTES / 1024 / 1024 } });
      }
    });

    it.each([
      ['no boundary', 'multipart/form-data', whole('a.png')],
      ['a boundary too long to parse', `multipart/form-data; boundary=${'x'.repeat(300)}`, whole('a.png')],
      ['a body that is not multipart', `multipart/form-data; boundary=${BOUNDARY}`, 'garbage garbage'],
      ['a body cut off in the headers', `multipart/form-data; boundary=${BOUNDARY}`, whole('a.png').subarray(0, 40)],
      ['a body cut off in the file', `multipart/form-data; boundary=${BOUNDARY}`, Buffer.concat([Buffer.from(header('a.png'), 'latin1'), PNG])],
    ])('refuses an upload with %s', async (_name, contentType, body) => {
      for (const url of ['/files', '/import/animals']) {
        const res = await upload(url, contentType, body);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('INVALID_UPLOAD');
      }
    });

    it('never answers a bad query value with a 500, on any route', async () => {
      const app = await getApp();
      const { paths } = app.swagger() as { paths: Record<string, { get?: { parameters?: { in: string; name: string }[] } }> };
      const failed: string[] = [];
      for (const [path, methods] of Object.entries(paths)) {
        if (!methods.get) continue;
        const url = path.replace(/\{[^}]+\}/g, uuidv7());
        const names = (methods.get.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
        for (const value of ['a%00b', '0000-01-01', '0000-01', '9999-12-31', '99999999999999']) {
          const query = [...names, 'search'].map((name) => `${name}=${value}`).join('&');
          const res = await app.inject({ method: 'GET', url: `${url}?${query}`, headers: auth });
          if (res.statusCode >= 500) failed.push(`${res.statusCode} ${path} ${value}`);
        }
      }
      expect(Object.keys(paths).length).toBeGreaterThan(200);
      expect(failed).toEqual([]);
    }, 60_000);
  });
});

describe('API reference', () => {
  it('is served in development, and production leaves it off unless told', async () => {
    const development = await getApp();
    expect((await development.inject({ url: '/api/docs/json' })).statusCode).toBe(200);

    const production = await buildApp(undefined, false);
    for (const url of ['/api/docs', '/api/docs/', '/api/docs/json', '/api/docs/yaml']) {
      expect((await production.inject({ url })).statusCode).toBe(404);
    }
    await production.close();
  });

  it('the setting reaches the API and is off by default', () => {
    expect(read('docker-compose.prod.yml')).toContain('API_DOCS: ${API_DOCS:-}');
    expect(/^API_DOCS=$/m.test(read('infra/env.production.example'))).toBe(true);
  });
});

describe('response headers', () => {
  it('asks nothing to keep a copy of an API answer, errors included', async () => {
    const app = await getApp();
    for (const url of ['/api/v1/auth/me', '/api/v1/leads/form-token', '/api/health', '/api/v1/no-such-route']) {
      expect((await app.inject({ url })).headers['cache-control']).toBe('no-store');
    }
  });

  it('leaves HSTS to nginx, which sends it once for pages and API alike', async () => {
    const app = await getApp();
    expect((await app.inject({ url: '/api/health' })).headers['strict-transport-security']).toBeUndefined();

    const nginx = read('infra/nginx.conf');
    const snippet = read('infra/nginx-security-headers.inc');
    const line = 'add_header Strict-Transport-Security $hsts always;';
    expect(snippet).toContain(line);
    // A location's own add_header cancels the server's, so only those without one may rely on it.
    expect(nginx.slice(0, nginx.indexOf('location '))).toContain(line);
    const locations = nginx.split(/^ {4}location /m).slice(1);
    for (const location of locations) {
      if (location.includes('add_header')) expect(location).toContain('security-headers.inc');
    }
    expect(/map \$http_x_forwarded_proto \$hsts \{\s*https\s+"max-age=31536000";\s*default\s+"";\s*\}/.test(nginx)).toBe(true);
  });

  it('nginx hides its version and the policy limits where forms can post', () => {
    expect(read('infra/nginx.conf')).toContain('server_tokens off;');
    expect(read('infra/nginx-security-headers.inc')).toContain("form-action 'self'");
  });

  it('the web image is on an exact, non-root nginx from a line that still gets fixes', () => {
    const [, major, minor] = /^FROM nginxinc\/nginx-unprivileged:(\d+)\.(\d+)\.\d+-alpine$/m.exec(read('apps/web/Dockerfile'))!;
    expect(Number(major) * 1000 + Number(minor)).toBeGreaterThanOrEqual(1030);
  });
});

describe('addresses tenants give us', () => {
  it.each([
    // The forms that used to get through.
    ['::127.0.0.1'], ['::7f00:1'], ['2002:7f00:1::'], ['fec0::1'], ['198.18.0.1'], ['198.19.255.255'], ['192.0.0.192'],
    // Every other way to spell the inside.
    ['::1'], ['::'], ['0:0:0:0:0:0:0:1'], ['0:0:0:0:0:ffff:7f00:1'], ['::ffff:169.254.169.254'], ['FE80::1'], ['febf::1'], ['FD00::1'], ['fc00::1'],
    ['64:ff9b::7f00:1'], ['64:ff9b:1::1'], ['100::1'], ['ff02::1'], ['2001:0:4136:e378:8000:63bf:3fff:fdd2'], ['2001:db8::1'], ['3fff::1'],
    ['0.1.2.3'], ['100.127.255.255'], ['192.0.2.7'], ['198.51.100.7'], ['203.0.113.7'], ['192.88.99.1'], ['224.0.0.1'], ['240.0.0.1'], ['255.255.255.255'],
    // Not an address at all.
    ['nonsense'], [''],
  ])('treats %s as private', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([['8.8.8.8'], ['1.1.1.1'], ['100.63.255.255'], ['100.128.0.1'], ['172.15.255.255'], ['172.32.0.1'], ['192.0.1.1'], ['198.17.255.255'], ['198.20.0.1'], ['223.255.255.255'], ['2606:4700::1111'], ['2a00:1450:4001::1'], ['2400:cb00::1']])(
    'treats %s as public',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it.each([['[::127.0.0.1]'], ['[::7f00:1]:4000'], ['[2002:7f00:1::]'], ['[fec0::1]'], ['198.18.0.1'], ['192.0.0.192'], ['2130706433'], ['0x7f.1'], ['0177.0.0.1']])(
    'refuses https://%s as a webhook address, however it is written',
    async (host) => {
      await expect(assertSafeUrl(`https://${host}/`)).rejects.toMatchObject({ code: 'WEBHOOK_URL_NOT_ALLOWED' });
    },
  );

  describe('at the moment of connecting', () => {
    let server: Server;
    let port: number;
    const hits: string[] = [];

    beforeAll(async () => {
      server = createServer((req, res) => {
        hits.push(req.url ?? '');
        res.end('reached');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise((resolve) => server.close(resolve)));
    afterEach(() => {
      hits.length = 0;
    });

    const signal = () => AbortSignal.timeout(3_000);

    it('never reaches a private address, as a literal or by name', async () => {
      await expect(requestPublic(`http://127.0.0.1:${port}/`, { method: 'GET', signal: signal() })).rejects.toThrow('not a public address');
      await expect(requestPublic(`http://[::ffff:7f00:1]:${port}/`, { method: 'GET', signal: signal() })).rejects.toThrow('not a public address');
      await expect(requestPublic(`http://localhost:${port}/`, { method: 'GET', signal: signal() })).rejects.toThrow('public address');
      await expect(requestPublic(`http://mixed.example:${port}/`, { method: 'GET', signal: signal() }, async () => ['8.8.8.8', '127.0.0.1'])).rejects.toThrow('public address');
      expect(hits).toEqual([]);
    });

    it('does not send a webhook to a name that changes its answer after the check', async () => {
      const f = await createFixture();
      const owner = await f.as('owner');
      const sub = await owner.post('/settings/webhooks', { url: 'https://93.184.216.34/hook', eventTypes: ['*'] });
      await owner.post(`/settings/webhooks/${sub.data.id}/test`);
      await f.run(() => tx().update(schema.webhookSubscriptions).set({ url: `http://rebind.example:${port}/hook` }));

      // The first answer passes the check before the send. The next is what a rebinding server gives.
      const answers = [['93.184.216.34'], ['127.0.0.1']];
      const rebinding = async () => answers.shift() ?? ['127.0.0.1'];
      const tally = await f.run(() => deliverDue({ resolve: rebinding }));

      expect(tally.retried).toBe(1);
      expect(answers).toEqual([]);
      expect(hits).toEqual([]);
      const [row] = await f.run(() => tx().select().from(schema.webhookDeliveries));
      expect(row.lastError).toContain('public address');
    });
  });
});
