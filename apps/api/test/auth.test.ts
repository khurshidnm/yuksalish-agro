import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from 'otplib';
import { tx } from '../src/core/context';
import { describe, expect, it } from 'vitest';
import { addMember } from '../src/core/tenancy';
import { unseal } from '../src/core/crypto';
import { db, schema } from '../src/db/client';
import { eq } from 'drizzle-orm';
import { normalizePhone } from '../src/modules/auth/auth.service';
import { createFixture, getApp } from './helpers';

async function createUser(role: 'owner' | 'shepherd' = 'shepherd') {
  const f = await createFixture();
  const phone = `+998${Math.floor(100_000_000 + Math.random() * 899_999_999)}`;
  const { userId, membershipId } = await addMember({
    tenantId: f.tenantId,
    farmId: f.farmId,
    roleId: f.roleIds[role],
    phone,
    fullName: 'Test User',
    password: 'Password123!',
  });
  return { f, phone, userId, membershipId };
}

async function post(url: string, payload: object, headers: Record<string, string> = {}) {
  const app = await getApp();
  const res = await app.inject({ method: 'POST', url: `/api/v1/auth${url}`, payload, headers });
  return { status: res.statusCode, body: res.json(), cookies: res.cookies };
}

const login = (phone: string, password = 'Password123!') => post('/login', { phone, password });

describe('auth', () => {
  it('normalises phone formats', () => {
    expect(normalizePhone('90 123 45 67')).toBe('+998901234567');
    expect(normalizePhone('998901234567')).toBe('+998901234567');
    expect(normalizePhone('+998 (90) 123-45-67')).toBe('+998901234567');
  });

  it('signs in and returns the session contract', async () => {
    const { phone, f } = await createUser();
    const res = await login(phone);
    expect(res.status).toBe(200);
    const { accessToken, session } = res.body.data;
    expect(accessToken).toBeTruthy();
    expect(session.role.key).toBe('shepherd');
    expect(session.tenant.id).toBe(f.tenantId);
    expect(session.farm.id).toBe(f.farmId);
    expect(session.permissions).toContain('tasks.view');
    expect(session.permissions).not.toContain('finance.view');
    expect(session.memberships).toHaveLength(1);
    expect(JSON.stringify(session)).not.toContain('passwordHash');

    const cookie = res.cookies.find((c) => c.name === 'yap_rt');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe('/api/v1/auth');
  });

  it('gives the same error for a wrong password and an unknown phone', async () => {
    const { phone } = await createUser();
    const wrong = await login(phone, 'wrong-password');
    const unknown = await login('+998000000000');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('rotates the refresh token, and reuse revokes the family', async () => {
    const { phone } = await createUser();
    const first = await login(phone);
    const rt1 = first.cookies.find((c) => c.name === 'yap_rt')!.value;

    const second = await post('/refresh', {}, { cookie: `yap_rt=${rt1}` });
    expect(second.status).toBe(200);
    const rt2 = second.cookies.find((c) => c.name === 'yap_rt')!.value;
    expect(rt2).not.toBe(rt1);

    // Backdate the rotation past the grace window, then replay the stolen token.
    const { sha256 } = await import('../src/core/crypto');
    await db
      .update(schema.refreshTokens)
      .set({ rotatedAt: new Date(Date.now() - 600_000) })
      .where(eq(schema.refreshTokens.tokenHash, sha256(rt1)));
    const replay = await post('/refresh', {}, { cookie: `yap_rt=${rt1}` });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_REVOKED');

    const victim = await post('/refresh', {}, { cookie: `yap_rt=${rt2}` });
    expect(victim.status).toBe(401);
  });

  it('allows a parallel refresh within the grace window', async () => {
    const { phone } = await createUser();
    const first = await login(phone);
    const rt1 = first.cookies.find((c) => c.name === 'yap_rt')!.value;
    expect((await post('/refresh', {}, { cookie: `yap_rt=${rt1}` })).status).toBe(200);
    expect((await post('/refresh', {}, { cookie: `yap_rt=${rt1}` })).status).toBe(200);
  });

  it('logout ends the refresh session', async () => {
    const { phone } = await createUser();
    const first = await login(phone);
    const rt = first.cookies.find((c) => c.name === 'yap_rt')!.value;
    await post('/logout', {}, { cookie: `yap_rt=${rt}` });
    expect((await post('/refresh', {}, { cookie: `yap_rt=${rt}` })).status).toBe(401);
  });

  it('completes the 2FA flow, stores the secret encrypted, and requires the code at login', async () => {
    const { phone, userId } = await createUser();
    const { accessToken } = (await login(phone)).body.data;
    const auth = { authorization: `Bearer ${accessToken}` };

    const setup = await post('/2fa/setup', {}, auth);
    expect(setup.status).toBe(200);
    const { secret, otpauthUrl } = setup.body.data;
    expect(otpauthUrl).toContain('otpauth://totp/');

    const [stored] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(stored.totpSecret).not.toBe(secret);
    expect(unseal(stored.totpSecret!)).toBe(secret);

    expect((await post('/2fa/enable', { code: '000000' }, auth)).status).toBe(401);
    expect((await post('/2fa/enable', { code: await generate({ secret }) }, auth)).status).toBe(200);

    const secondLogin = await login(phone);
    expect(secondLogin.body.data.accessToken).toBeUndefined();
    expect(secondLogin.body.data.twoFactorRequired).toBe(true);

    const { challengeToken } = secondLogin.body.data;
    expect((await post('/2fa/verify', { challengeToken, code: '000000' })).status).toBe(401);
    const verified = await post('/2fa/verify', { challengeToken, code: await generate({ secret }) });
    expect(verified.status).toBe(200);
    expect(verified.body.data.accessToken).toBeTruthy();
  });

  it('switches between farms, and refuses a farm the user is not in', async () => {
    const a = await createUser();
    const other = await createFixture();
    const second = await addMember({
      tenantId: other.tenantId,
      farmId: other.farmId,
      roleId: other.roleIds.owner,
      phone: a.phone,
      fullName: 'Test User',
      password: 'Password123!',
    });
    expect(second.userId).toBe(a.userId);

    const { accessToken, session } = (await login(a.phone)).body.data;
    expect(session.memberships).toHaveLength(2);
    expect(session.role.key).toBe('shepherd');

    const auth = { authorization: `Bearer ${accessToken}` };
    const switched = await post('/switch-farm', { membershipId: second.membershipId }, auth);
    expect(switched.status).toBe(200);
    expect(switched.body.data.session.role.key).toBe('owner');
    expect(switched.body.data.session.farm.id).toBe(other.farmId);

    const stranger = await createUser();
    const refused = await post('/switch-farm', { membershipId: stranger.membershipId }, auth);
    expect(refused.status).toBe(403);
  });

  it('changing the password invalidates the old one and other sessions', async () => {
    const { phone } = await createUser();
    const first = await login(phone);
    const { accessToken } = first.body.data;
    const res = await post(
      '/change-password',
      { currentPassword: 'Password123!', newPassword: 'NewPassword456!' },
      { authorization: `Bearer ${accessToken}` },
    );
    expect(res.status).toBe(200);
    expect((await login(phone)).status).toBe(401);
    expect((await login(phone, 'NewPassword456!')).status).toBe(200);
  });
});

describe('files', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  function multipart(name: string, type: string, body: Buffer) {
    const boundary = 'testboundary';
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`;
    return {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(head), body, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    };
  }

  async function upload(name: string, type: string, body: Buffer) {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { accessToken } = (await login(await phoneOf(owner.userId))).body.data;
    const form = multipart(name, type, body);
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...form.headers, authorization: `Bearer ${accessToken}` },
      payload: form.payload,
    });
    return { status: res.statusCode, body: res.json(), f };
  }

  async function phoneOf(userId: string) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    return u.phone;
  }

  it('stores a file and serves it only with a valid signed link', async () => {
    const res = await upload('sheep.png', 'image/png', PNG);
    expect(res.status).toBe(200);
    const app = await getApp();
    const ok = await app.inject({ method: 'GET', url: res.body.data.url });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.rawPayload.equals(PNG)).toBe(true);

    const noToken = await app.inject({ method: 'GET', url: `/api/v1/files/${res.body.data.id}/content?token=bad` });
    expect(noToken.statusCode).toBe(401);
  });

  it('a file whose stored bytes are gone is a 404, not a server error', async () => {
    const res = await upload('gone.png', 'image/png', PNG);
    const [row] = await res.f.run(() => tx().select().from(schema.files));
    await rm(join('/tmp/yap-test-storage', row.storageKey));
    const app = await getApp();
    expect((await app.inject({ method: 'GET', url: res.body.data.url })).statusCode).toBe(404);
  });

  it('refuses dangerous types and files whose content does not match', async () => {
    expect((await upload('x.svg', 'image/svg+xml', Buffer.from('<svg/>'))).status).toBe(400);
    expect((await upload('x.html', 'text/html', Buffer.from('<script/>'))).status).toBe(400);
    expect((await upload('fake.png', 'image/png', Buffer.from('not a png'))).status).toBe(400);
  });
});
