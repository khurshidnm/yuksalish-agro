import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { generate } from 'otplib';
import pg from 'pg';
import { tx } from '../src/core/context';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { passwordProblem } from '../src/core/passwords';
import { addMember } from '../src/core/tenancy';
import { sha256, unseal } from '../src/core/crypto';
import { config } from '../src/config';
import { db, schema } from '../src/db/client';
import { ensurePlatformAdmin, resetPlatformAdmin } from '../src/db/platform-admin';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { normalizePhone } from '../src/modules/auth/auth.service';
import { CODE_STEP, LOCK_MINUTES, MAX_FAILURES } from '../src/modules/auth/lockout.service';
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

const cookieOf = (res: Awaited<ReturnType<typeof post>>) => res.cookies.find((c) => c.name === 'yap_rt')!.value;
const refreshWith = (token: string) => post('/refresh', {}, { cookie: `yap_rt=${token}` });

async function tokenRow(token: string) {
  const [row] = await db.select().from(schema.refreshTokens).where(eq(schema.refreshTokens.tokenHash, sha256(token)));
  return row;
}

/** Moves this token's rotation past the grace window, and keeps it behind anything used since. */
const threeMinutesPass = async (token: string) => {
  const { familyId } = await tokenRow(token);
  await db
    .update(schema.refreshTokens)
    .set({ rotatedAt: sql`${schema.refreshTokens.rotatedAt} - interval '3 minutes'` })
    .where(and(eq(schema.refreshTokens.familyId, familyId), isNotNull(schema.refreshTokens.rotatedAt)));
};

const from = (address: string) => ({ 'x-forwarded-for': address });
const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

/** A code for a later time step than one just used, which is what the app shows 30 seconds on. */
const nextCode = (secret: string) => generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });

async function enrol(phone: string) {
  const { accessToken } = (await login(phone)).body.data;
  const { secret } = (await post('/2fa/setup', {}, bearer(accessToken))).body.data;
  const enabled = await post('/2fa/enable', { code: await generate({ secret }) }, bearer(accessToken));
  expect(enabled.status).toBe(200);
  return { accessToken, secret, recoveryCodes: enabled.body.data.recoveryCodes as string[] };
}

const failures = (phone: string, address: string) =>
  db.select().from(schema.signInFailures).where(and(eq(schema.signInFailures.phone, phone), eq(schema.signInFailures.address, address)));

async function journal(f: Awaited<ReturnType<typeof createFixture>>, type: string) {
  return f.run(() => tx().select().from(schema.events).where(eq(schema.events.type, type)));
}

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

  it('rotates the refresh token, and each one gives a new one', async () => {
    const { phone } = await createUser();
    const rt1 = cookieOf(await login(phone));
    const second = await refreshWith(rt1);
    expect(second.status).toBe(200);
    expect(cookieOf(second)).not.toBe(rt1);
  });

  it('allows a parallel refresh within the grace window', async () => {
    const { phone } = await createUser();
    const first = await login(phone);
    const rt1 = first.cookies.find((c) => c.name === 'yap_rt')!.value;
    expect((await post('/refresh', {}, { cookie: `yap_rt=${rt1}` })).status).toBe(200);
    expect((await post('/refresh', {}, { cookie: `yap_rt=${rt1}` })).status).toBe(200);
  });

  describe('a token replayed after its grace', () => {
    it('is a lost reply while nothing newer was used: the phone stays signed in, three minutes on', async () => {
      const { phone } = await createUser();
      const rt1 = cookieOf(await login(phone));

      // The server rotates, then the phone goes out of coverage and the answer never arrives.
      const dropped = cookieOf(await refreshWith(rt1));
      await threeMinutesPass(rt1);

      const back = await refreshWith(rt1);
      expect(back.status).toBe(200);
      expect((await post('/refresh', {}, { cookie: `yap_rt=${cookieOf(back)}` })).status).toBe(200);
      expect((await tokenRow(dropped)).revokedAt).not.toBeNull();
    });

    it('survives the same loss again and again, ending with one good token', async () => {
      const { phone } = await createUser();
      const rt1 = cookieOf(await login(phone));
      const lost = [cookieOf(await refreshWith(rt1))];
      await threeMinutesPass(rt1);
      lost.push(cookieOf(await refreshWith(rt1)));
      await threeMinutesPass(rt1);

      const back = await refreshWith(rt1);
      expect(back.status).toBe(200);
      for (const token of lost) expect((await tokenRow(token)).revokedAt).not.toBeNull();
      expect((await tokenRow(cookieOf(back))).revokedAt).toBeNull();
    });

    it('works mid-session too, not only on the first token', async () => {
      const { phone } = await createUser();
      const rt1 = cookieOf(await login(phone));
      const rt2 = cookieOf(await refreshWith(rt1));
      await refreshWith(rt2);
      await threeMinutesPass(rt2);
      expect((await refreshWith(rt2)).status).toBe(200);
    });

    it('is theft once something newer was used, and the whole family ends', async () => {
      const { phone } = await createUser();
      const rt1 = cookieOf(await login(phone));
      const rt2 = cookieOf(await refreshWith(rt1));
      const rt3 = cookieOf(await refreshWith(rt2));
      await threeMinutesPass(rt1);

      const replay = await refreshWith(rt1);
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('SESSION_REVOKED');
      expect((await refreshWith(rt3)).status).toBe(401);
    });

    it('stays theft after a lost reply was recovered and the new token used', async () => {
      const { phone } = await createUser();
      const rt1 = cookieOf(await login(phone));
      await refreshWith(rt1);
      await threeMinutesPass(rt1);
      const rt3 = cookieOf(await refreshWith(rt1));
      const rt4 = cookieOf(await refreshWith(rt3));
      await threeMinutesPass(rt1);

      expect((await refreshWith(rt1)).status).toBe(401);
      expect((await refreshWith(rt4)).status).toBe(401);
    });

    it('catches a thief who got in first, when the owner comes back with the token that replay cancelled', async () => {
      const { phone } = await createUser();
      const stolen = cookieOf(await login(phone));
      const owners = cookieOf(await refreshWith(stolen));
      await threeMinutesPass(stolen);

      const thief = await refreshWith(stolen);
      expect(thief.status).toBe(200);

      const owner = await refreshWith(owners);
      expect(owner.status).toBe(401);
      expect(owner.body.error.code).toBe('SESSION_REVOKED');
      expect((await refreshWith(cookieOf(thief))).status).toBe(401);
    });

    it('two tabs replaying together do not cancel each other, and neither ends up with a dead token', async () => {
      const { phone } = await createUser();
      const rt1 = cookieOf(await login(phone));
      await refreshWith(rt1);
      await threeMinutesPass(rt1);

      const tabs = await Promise.all([refreshWith(rt1), refreshWith(rt1)]);
      expect(tabs.map((tab) => tab.status)).toEqual([200, 200]);
      for (const tab of tabs) expect((await tokenRow(cookieOf(tab))).revokedAt).toBeNull();
    });

    it('racing the newer token ends the whole family, whichever gets there first, with nothing left for a thief', async () => {
      const { phone } = await createUser();
      for (let round = 0; round < 12; round += 1) {
        const stolen = cookieOf(await login(phone));
        const owners = cookieOf(await refreshWith(stolen));
        await threeMinutesPass(stolen);
        const { familyId } = await tokenRow(stolen);

        await Promise.all([refreshWith(stolen), refreshWith(owners)]);

        const live = await db
          .select()
          .from(schema.refreshTokens)
          .where(and(eq(schema.refreshTokens.familyId, familyId), isNull(schema.refreshTokens.revokedAt)));
        expect(live).toEqual([]);
      }
    });

    it('cannot bring back a session that was signed out', async () => {
      const { phone } = await createUser();
      const rt1 = cookieOf(await login(phone));
      const rt2 = cookieOf(await refreshWith(rt1));
      await post('/logout', {}, { cookie: `yap_rt=${rt2}` });
      await threeMinutesPass(rt1);
      expect((await refreshWith(rt1)).status).toBe(401);
    });

    it('cannot bring back a session ended by a new password', async () => {
      const { phone } = await createUser();
      const first = await login(phone);
      const rt1 = cookieOf(first);
      await refreshWith(rt1);
      const changed = await post(
        '/change-password',
        { currentPassword: 'Password123!', newPassword: 'Another-Good-One-7' },
        bearer(first.body.data.accessToken),
      );
      expect(changed.status).toBe(200);
      await threeMinutesPass(rt1);
      expect((await refreshWith(rt1)).status).toBe(401);
    });

    it('does not outlive its expiry', async () => {
      const { phone } = await createUser();
      const rt1 = cookieOf(await login(phone));
      await refreshWith(rt1);
      await threeMinutesPass(rt1);
      await db.update(schema.refreshTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.refreshTokens.tokenHash, sha256(rt1)));
      const late = await refreshWith(rt1);
      expect(late.status).toBe(401);
      expect(late.body.error.code).toBe('SESSION_EXPIRED');
    });

    it('a stranger with an unknown token touches nothing', async () => {
      const unknown = await refreshWith('not-a-real-token');
      expect(unknown.status).toBe(401);
      expect(unknown.body.error.code).toBe('NO_SESSION');
    });
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

    expect((await post('/2fa/enable', { code: '000000' }, auth)).status).toBe(400);
    expect((await post('/2fa/enable', { code: await generate({ secret }) }, auth)).status).toBe(200);

    const secondLogin = await login(phone);
    expect(secondLogin.body.data.accessToken).toBeUndefined();
    expect(secondLogin.body.data.twoFactorRequired).toBe(true);

    const { challengeToken } = secondLogin.body.data;
    expect((await post('/2fa/verify', { challengeToken, code: '000000' })).status).toBe(400);
    const verified = await post('/2fa/verify', { challengeToken, code: await nextCode(secret) });
    expect(verified.status).toBe(200);
    expect(verified.body.data.accessToken).toBeTruthy();
  });

  it('a reload of the setup page keeps the secret already in the phone, until 2FA is on', async () => {
    const { phone } = await createUser();
    const auth = bearer((await login(phone)).body.data.accessToken);

    const first = (await post('/2fa/setup', {}, auth)).body.data;
    const reload = (await post('/2fa/setup', {}, auth)).body.data;
    expect(reload).toEqual(first);

    // The entry scanned on the first load is the one that finishes enrolment.
    expect((await post('/2fa/enable', { code: await generate({ secret: first.secret }) }, auth)).status).toBe(200);
    const after = await post('/2fa/setup', {}, auth);
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe('TWO_FACTOR_ALREADY_ENABLED');
  });

  it('two tabs starting setup together are shown one secret, and that is the one stored', async () => {
    const { phone, userId } = await createUser();
    const auth = bearer((await login(phone)).body.data.accessToken);
    const shown = await Promise.all([post('/2fa/setup', {}, auth), post('/2fa/setup', {}, auth), post('/2fa/setup', {}, auth)]);
    const secrets = new Set(shown.map((r) => r.body.data.secret));
    expect(secrets.size).toBe(1);
    const [stored] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(secrets.has(unseal(stored.totpSecret!))).toBe(true);
  });

  it('a new start after a reset, or after a secret that can no longer be read, gets a new secret', async () => {
    const { phone, userId } = await createUser();
    const auth = bearer((await login(phone)).body.data.accessToken);
    const first = (await post('/2fa/setup', {}, auth)).body.data.secret;

    await db.update(schema.users).set({ totpSecret: null }).where(eq(schema.users.id, userId));
    const second = (await post('/2fa/setup', {}, auth)).body.data.secret;
    expect(second).not.toBe(first);

    await db.update(schema.users).set({ totpSecret: 'sealed with an old key' }).where(eq(schema.users.id, userId));
    const third = await post('/2fa/setup', {}, auth);
    expect(third.status).toBe(200);
    expect(third.body.data.secret).not.toBe(second);
    expect((await post('/2fa/enable', { code: await generate({ secret: third.body.data.secret }) }, auth)).status).toBe(200);
  });

  it('a wrong code or password is never a 401, which the web would read as a dead session and send again', async () => {
    const { phone } = await createUser();
    const { accessToken } = await enrol(phone);
    const auth = bearer(accessToken);
    for (const url of ['/2fa/disable', '/2fa/replace', '/2fa/recovery-codes']) {
      const res = await post(url, { code: '000000' }, auth);
      expect([url, res.status, res.body.error.code]).toEqual([url, 400, 'INVALID_CODE']);
    }
    const wrong = await post('/change-password', { currentPassword: 'Not-the-one-9', newPassword: 'Another-Good-One-7' }, auth);
    expect([wrong.status, wrong.body.error.code]).toEqual([400, 'WRONG_PASSWORD']);

    const fresh = (await createUser()).phone;
    const enrolling = bearer((await login(fresh)).body.data.accessToken);
    await post('/2fa/setup', {}, enrolling);
    const typo = await post('/2fa/enable', { code: '000000' }, enrolling);
    expect([typo.status, typo.body.error.code]).toEqual([400, 'INVALID_CODE']);
  });

  it('compares an unknown phone against a hash that costs the same as a real one', async () => {
    const compare = vi.spyOn(bcrypt, 'compare');
    await login('+998000000001', 'wrong-password');
    const dummy = compare.mock.calls[0][1];
    compare.mockRestore();
    expect(bcrypt.getRounds(dummy)).toBe(config.BCRYPT_ROUNDS);
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

  it('changing the password invalidates the old one and other sessions, and keeps this one', async () => {
    const { phone } = await createUser();
    const other = await login(phone);
    const otherCookie = other.cookies.find((c) => c.name === 'yap_rt')!.value;
    const { accessToken } = (await login(phone)).body.data;
    const res = await post('/change-password', { currentPassword: 'Password123!', newPassword: 'tuyaqush-Xolmon-44' }, bearer(accessToken));
    expect(res.status).toBe(200);
    expect((await login(phone)).status).toBe(401);
    expect((await login(phone, 'tuyaqush-Xolmon-44')).status).toBe(200);

    expect((await post('/refresh', {}, { cookie: `yap_rt=${otherCookie}` })).status).toBe(401);
    const cookie = res.cookies.find((c) => c.name === 'yap_rt')!.value;
    expect((await post('/refresh', {}, { cookie: `yap_rt=${cookie}` })).status).toBe(200);
  });
});

describe('choosing a password', () => {
  const change = async (phone: string, newPassword: string) => {
    const { accessToken } = (await login(phone)).body.data;
    return post('/change-password', { currentPassword: 'Password123!', newPassword }, bearer(accessToken));
  };

  it('refuses what a guesser tries first, whatever it is dressed in', () => {
    const phone = '+998931000010';
    const common = [
      '1234567890', '0987654321', 'aaaaaaaaaa', 'qwertyuiop', 'password123', 'Password123!', 'P@ssw0rd123', 'parol12345', 'Parol2026!',
      'Yuksalish2026!', 'yuksalish2026', 'Toshkent2026', '1q2w3e4r5t', 'qwerty123456', '123123123123', 'passwordpassword', 'ПАРОЛЬ12345',
    ];
    for (const password of common) expect([password, passwordProblem(password, phone)]).toEqual([password, 'PASSWORD_TOO_COMMON']);
    for (const password of ['+998931000010', '998931000010a', 'x931000010y']) {
      expect([password, passwordProblem(password, phone)]).toEqual([password, 'PASSWORD_CONTAINS_PHONE']);
    }
    expect(passwordProblem('short-one', phone)).toBe('PASSWORD_TOO_SHORT');
    for (const password of ["mening qo'ylarim ko'p", 'tuyaqush-Xolmon-44', 'xK9#mQ2$vL']) expect(passwordProblem(password, phone)).toBeNull();
  });

  it('applies on change, and leaves a weak password someone already has working', async () => {
    const { phone } = await createUser();
    expect((await change(phone, 'parol12345')).body.error.code).toBe('PASSWORD_TOO_COMMON');
    expect((await change(phone, `x${phone.slice(-9)}y`)).body.error.code).toBe('PASSWORD_CONTAINS_PHONE');
    expect((await change(phone, 'Password123!')).body.error.code).toBe('PASSWORD_TOO_COMMON');
    expect((await change(phone, '123456789')).status).toBe(400);
    expect((await login(phone)).status).toBe(200);
  });

  it('refuses the password it already is', async () => {
    const { phone } = await createUser();
    const { accessToken } = (await login(phone)).body.data;
    await post('/change-password', { currentPassword: 'Password123!', newPassword: 'tuyaqush-Xolmon-44' }, bearer(accessToken));
    const same = await post('/change-password', { currentPassword: 'tuyaqush-Xolmon-44', newPassword: 'tuyaqush-Xolmon-44' }, bearer(accessToken));
    expect(same.body.error.code).toBe('PASSWORD_UNCHANGED');
  });

  it('refuses what bcrypt would silently cut off', async () => {
    const { phone } = await createUser();
    expect((await change(phone, `${'tuyaqush-Xolmon-'.repeat(4)}12345678`)).status).toBe(200);
    const { phone: other } = await createUser();
    expect((await change(other, `${'tuyaqush-Xolmon-'.repeat(4)}123456789`)).body.error.code).toBe('PASSWORD_TOO_LONG');
  });
});

describe('issued passwords', () => {
  async function issued() {
    const f = await createFixture();
    const owner = await f.as('owner');
    const phone = `+998${Math.floor(100_000_000 + Math.random() * 899_999_999)}`;
    const added = await owner.post('/settings/users', { phone, fullName: 'Yangi Xodim', roleId: f.roleIds.shepherd });
    return { f, owner, phone, oneTimePassword: added.data.oneTimePassword as string, member: added.data.member };
  }

  it('open nothing but the screen to choose a new one', async () => {
    const { phone, oneTimePassword } = await issued();
    const { accessToken, session } = (await login(phone, oneTimePassword)).body.data;
    expect(session.mustChangePassword).toBe(true);

    const app = await getApp();
    const get = (url: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: bearer(accessToken) });
    for (const url of ['/hr/employees/lookup', '/settings/users/lookup', '/tasks']) {
      const res = await get(url);
      expect([url, res.statusCode, res.json().error?.code]).toEqual([url, 403, 'PASSWORD_CHANGE_REQUIRED']);
    }
    expect((await get('/auth/me')).statusCode).toBe(200);
  });

  it('stop working once the person has chosen their own', async () => {
    const { phone, oneTimePassword } = await issued();
    const { accessToken } = (await login(phone, oneTimePassword)).body.data;
    const changed = await post('/change-password', { currentPassword: oneTimePassword, newPassword: 'tuyaqush-Xolmon-44' }, bearer(accessToken));
    expect(changed.body.data.session.mustChangePassword).toBe(false);
    expect((await login(phone, oneTimePassword)).status).toBe(401);

    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/hr/employees/lookup', headers: bearer(changed.body.data.accessToken) });
    expect(res.statusCode).toBe(200);
  });

  it('come back with a reset, which also lifts a lock on the person', async () => {
    const { owner, phone, oneTimePassword, member } = await issued();
    const { accessToken } = (await login(phone, oneTimePassword)).body.data;
    await post('/change-password', { currentPassword: oneTimePassword, newPassword: 'tuyaqush-Xolmon-44' }, bearer(accessToken));

    for (let i = 0; i < MAX_FAILURES; i++) await post('/login', { phone, password: 'wrong-password' }, from('203.0.113.70'));
    const reset = await owner.post(`/settings/users/${member.id}/reset-password`);
    const again = await post('/login', { phone, password: reset.data.oneTimePassword }, from('203.0.113.70'));
    expect(again.status).toBe(200);
    expect(again.body.data.session.mustChangePassword).toBe(true);
  });
});

describe('the sign-in lock', () => {
  const wrong = (phone: string, address: string) => post('/login', { phone, password: 'wrong-password' }, from(address));

  async function lock(phone: string, address: string) {
    let last = await wrong(phone, address);
    for (let i = 1; i < MAX_FAILURES; i++) {
      expect(last.status).toBe(401);
      last = await wrong(phone, address);
    }
    return last;
  }

  it('locks one phone from one address, says so, and tells the journal once', async () => {
    const { f, phone, userId } = await createUser();
    const locked = await lock(phone, '203.0.113.1');
    expect(locked.status).toBe(423);
    expect(locked.body.error).toMatchObject({ code: 'ACCOUNT_LOCKED', details: { minutes: LOCK_MINUTES } });

    // Even the right password waits, or the lock would tell a guesser when they were right.
    expect((await post('/login', { phone, password: 'Password123!' }, from('203.0.113.1'))).status).toBe(423);
    expect((await wrong(phone, '203.0.113.1')).status).toBe(423);

    const events = await journal(f, 'auth.locked');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ severity: 'attention', entityId: userId, data: { step: 'password' } });
  });

  it('a stranger elsewhere locks nobody out', async () => {
    const { phone } = await createUser();
    await lock(phone, '203.0.113.2');
    expect((await post('/login', { phone, password: 'Password123!' }, from('203.0.113.3'))).status).toBe(200);
  });

  it('never outlasts 15 minutes, however many tries come during it', async () => {
    const { phone } = await createUser();
    await lock(phone, '203.0.113.4');
    const [before] = await failures(phone, '203.0.113.4');
    expect(before.lockedUntil!.getTime()).toBeLessThanOrEqual(Date.now() + LOCK_MINUTES * 60_000);
    for (let i = 0; i < 3; i++) await wrong(phone, '203.0.113.4');
    expect((await failures(phone, '203.0.113.4'))[0].lockedUntil).toEqual(before.lockedUntil);

    await db
      .update(schema.signInFailures)
      .set({ lockedUntil: new Date(Date.now() - 1000), windowStartedAt: new Date(Date.now() - LOCK_MINUTES * 60_000 - 1000) })
      .where(eq(schema.signInFailures.phone, phone));
    expect((await wrong(phone, '203.0.113.4')).status).toBe(401);
    expect((await failures(phone, '203.0.113.4'))[0]).toMatchObject({ failures: 1, lockedUntil: null });
    expect((await post('/login', { phone, password: 'Password123!' }, from('203.0.113.4'))).status).toBe(200);
  });

  it('forgets old failures, and the right password clears the count', async () => {
    const { phone } = await createUser();
    for (let i = 0; i < MAX_FAILURES - 1; i++) await wrong(phone, '203.0.113.5');
    expect((await post('/login', { phone, password: 'Password123!' }, from('203.0.113.5'))).status).toBe(200);
    expect(await failures(phone, '203.0.113.5')).toEqual([]);

    for (let i = 0; i < MAX_FAILURES - 1; i++) await wrong(phone, '203.0.113.5');
    await db
      .update(schema.signInFailures)
      .set({ windowStartedAt: new Date(Date.now() - LOCK_MINUTES * 60_000 - 1000) })
      .where(eq(schema.signInFailures.phone, phone));
    expect((await wrong(phone, '203.0.113.5')).status).toBe(401);
  });

  it('treats a phone with no account the same, so a lock reveals nothing', async () => {
    const locked = await lock('+998000000002', '203.0.113.6');
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('parallel guesses cannot start two locks or lift one', async () => {
    const { f, phone } = await createUser();
    await Promise.all(Array.from({ length: MAX_FAILURES + 4 }, () => wrong(phone, '203.0.113.7')));
    expect((await journal(f, 'auth.locked')).length).toBeLessThanOrEqual(1);
    expect((await post('/login', { phone, password: 'Password123!' }, from('203.0.113.7'))).status).toBe(423);
  });

  it('counts wrong codes for the account from any address, since only the password holder gets that far', async () => {
    const { f, phone } = await createUser();
    const { secret } = await enrol(phone);
    const { challengeToken } = (await login(phone)).body.data;
    const guess = (i: number) => post('/2fa/verify', { challengeToken, code: '000000' }, from(`203.0.113.${100 + i}`));
    for (let i = 1; i < MAX_FAILURES; i++) expect((await guess(i)).status).toBe(400);
    expect((await guess(MAX_FAILURES)).status).toBe(423);

    const right = await post('/2fa/verify', { challengeToken, code: await nextCode(secret) }, from('203.0.113.200'));
    expect(right.status).toBe(423);
    expect((await journal(f, 'auth.locked'))[0].data).toEqual({ step: 'code' });
    expect((await failures(phone, CODE_STEP))[0].lockedUntil).not.toBeNull();
  });

  it('a platform admin has no farm, so theirs goes to the platform record', async () => {
    const phone = `+998${Math.floor(100_000_000 + Math.random() * 899_999_999)}`;
    const [admin] = await db
      .insert(schema.users)
      .values({ phone, fullName: 'Platform Admin', passwordHash: await bcrypt.hash('Password123!', 4), isPlatformAdmin: true })
      .returning();
    await lock(phone, '203.0.113.8');
    const trail = await db.select().from(schema.platformAudit).where(eq(schema.platformAudit.targetId, admin.id));
    expect(trail.map((row) => row.action)).toEqual(['auth.locked']);
  });
});

describe('one-time codes', () => {
  it('a code signs in once, even with the challenge it came with', async () => {
    const { phone } = await createUser();
    const { secret } = await enrol(phone);
    const code = await nextCode(secret);
    const { challengeToken } = (await login(phone)).body.data;
    expect((await post('/2fa/verify', { challengeToken, code })).status).toBe(200);

    const replay = await post('/2fa/verify', { challengeToken, code });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('INVALID_CODE');
    const freshChallenge = (await login(phone)).body.data.challengeToken;
    expect((await post('/2fa/verify', { challengeToken: freshChallenge, code })).status).toBe(400);
  });

  it('two people racing with one code: one gets in', async () => {
    const { phone } = await createUser();
    const { secret } = await enrol(phone);
    const code = await nextCode(secret);
    const { challengeToken } = (await login(phone)).body.data;
    const results = await Promise.all([post('/2fa/verify', { challengeToken, code }), post('/2fa/verify', { challengeToken, code })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('the code that turned 2FA on cannot sign in afterwards', async () => {
    const { phone } = await createUser();
    const { accessToken } = (await login(phone)).body.data;
    const { secret } = (await post('/2fa/setup', {}, bearer(accessToken))).body.data;
    const code = await generate({ secret });
    expect((await post('/2fa/enable', { code }, bearer(accessToken))).status).toBe(200);
    const { challengeToken } = (await login(phone)).body.data;
    expect((await post('/2fa/verify', { challengeToken, code })).status).toBe(400);
  });
});

describe('recovery codes', () => {
  async function enrolled() {
    const user = await createUser();
    return { ...user, ...(await enrol(user.phone)) };
  }
  const signInWith = async (phone: string, code: string) => {
    const { challengeToken } = (await login(phone)).body.data;
    return post('/2fa/verify', { challengeToken, code });
  };

  it('come as ten at enrolment, different, and stored only hashed', async () => {
    const { userId, recoveryCodes } = await enrolled();
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);

    const rows = await db.select().from(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId));
    expect(rows).toHaveLength(10);
    const stored = JSON.stringify(rows);
    for (const code of recoveryCodes) {
      expect(stored).not.toContain(code);
      expect(stored).not.toContain(code.replaceAll('-', ''));
    }
    expect(rows.map((r) => r.codeHash)).toContain(sha256(`${userId}:${recoveryCodes[0].replaceAll('-', '')}`));
  });

  it('each signs in once, however it is typed, and the farm hears of it', async () => {
    const { f, phone, recoveryCodes } = await enrolled();
    const typed = recoveryCodes[0].toLowerCase().replaceAll('-', ' ');
    const first = await signInWith(phone, typed);
    expect(first.status).toBe(200);
    expect(first.body.data.recoveryCodeUsed).toBe(true);
    expect(first.body.data.session.user.recoveryCodesLeft).toBe(9);
    expect(await journal(f, 'auth.recovery_code_used')).toHaveLength(1);

    expect((await signInWith(phone, recoveryCodes[0])).status).toBe(400);
    expect((await signInWith(phone, recoveryCodes[1])).status).toBe(200);
  });

  it('belong to one person', async () => {
    const a = await enrolled();
    const b = await enrolled();
    expect((await signInWith(b.phone, a.recoveryCodes[0])).status).toBe(400);
  });

  it('asking for new ones takes a code, and the old ones stop', async () => {
    const { accessToken, secret, phone, recoveryCodes } = await enrolled();
    expect((await post('/2fa/recovery-codes', { code: '000000' }, bearer(accessToken))).status).toBe(400);
    const fresh = await post('/2fa/recovery-codes', { code: await nextCode(secret) }, bearer(accessToken));
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.recoveryCodes).toHaveLength(10);
    expect(fresh.body.data.session.user.recoveryCodesLeft).toBe(10);
    expect((await signInWith(phone, recoveryCodes[0])).status).toBe(400);
    expect((await signInWith(phone, fresh.body.data.recoveryCodes[0])).status).toBe(200);
  });

  it('are the way to a new phone, even for a role that must keep 2FA', async () => {
    const f = await createFixture({ settings: { security: { enforce2fa: true } } });
    const phone = `+998${Math.floor(100_000_000 + Math.random() * 899_999_999)}`;
    const { userId } = await addMember({ tenantId: f.tenantId, farmId: f.farmId, roleId: f.roleIds.owner, phone, fullName: 'Ega', password: 'Password123!' });
    const { recoveryCodes } = await enrol(phone);

    const inWithCode = await signInWith(phone, recoveryCodes[0]);
    const { accessToken } = inWithCode.body.data;
    const stale = inWithCode.cookies.find((c) => c.name === 'yap_rt')!.value;
    const off = await post('/2fa/disable', { code: recoveryCodes[1] }, bearer(accessToken));
    expect(off.body.error.code).toBe('TWO_FACTOR_REQUIRED_BY_POLICY');

    expect((await post('/2fa/replace', { code: '000000' }, bearer(accessToken))).status).toBe(400);
    const replaced = await post('/2fa/replace', { code: recoveryCodes[1] }, bearer(accessToken));
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.session).toMatchObject({ mustEnroll2fa: true, user: { totpEnabled: false, recoveryCodesLeft: null } });
    expect(await db.select().from(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId))).toEqual([]);
    expect((await post('/refresh', {}, { cookie: `yap_rt=${stale}` })).status).toBe(401);
    expect(await journal(f, 'auth.two_factor_replaced')).toHaveLength(1);

    const again = await post('/2fa/setup', {}, bearer(replaced.body.data.accessToken));
    expect(again.status).toBe(200);
    const enabled = await post('/2fa/enable', { code: await generate({ secret: again.body.data.secret }) }, bearer(replaced.body.data.accessToken));
    expect(enabled.body.data.recoveryCodes).toHaveLength(10);
  });

  it('turning 2FA off, where allowed, removes them', async () => {
    const { accessToken, secret, userId } = await enrolled();
    expect((await post('/2fa/disable', { code: await nextCode(secret) }, bearer(accessToken))).status).toBe(200);
    expect(await db.select().from(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId))).toEqual([]);
  });

  it('turning it on twice does not hand out new codes without proof', async () => {
    const { accessToken, secret } = await enrolled();
    const twice = await post('/2fa/enable', { code: await nextCode(secret) }, bearer(accessToken));
    expect(twice.body.error.code).toBe('TWO_FACTOR_ALREADY_ENABLED');
  });
});

describe('the platform admin, from the server', () => {
  let client: pg.Client;
  const connect = async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
    await client.connect();
    return client;
  };
  afterEach(() => client?.end());

  const phone = () => `+998${Math.floor(100_000_000 + Math.random() * 899_999_999)}`;
  const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);

  it('stores the first admin the way sign-in will look for them', async () => {
    const number = phone();
    const spaced = `${number.slice(0, 4)} ${number.slice(4, 6)} ${number.slice(6, 9)}-${number.slice(9)}`;
    const log = quiet();
    await ensurePlatformAdmin(await connect(), spaced, 'tuyaqush-Xolmon-44');
    log.mockRestore();
    expect((await login(number, 'tuyaqush-Xolmon-44')).status).toBe(200);
  });

  it('refuses a first password people would guess, and a phone that is not one', async () => {
    const c = await connect();
    await expect(ensurePlatformAdmin(c, phone(), 'Yuksalish2026!')).rejects.toThrow('PASSWORD_TOO_COMMON');
    await expect(ensurePlatformAdmin(c, 'not a phone', 'tuyaqush-Xolmon-44')).rejects.toThrow('PLATFORM_ADMIN_PHONE');
  });

  it('resets a lost password and authenticator, and leaves a record', async () => {
    const number = phone();
    const [admin] = await db
      .insert(schema.users)
      .values({ phone: number, fullName: 'Platform Admin', passwordHash: await bcrypt.hash('Password123!', 4), isPlatformAdmin: true, totpEnabled: true, totpSecret: 'sealed' })
      .returning();
    await db.insert(schema.recoveryCodes).values({ userId: admin.id, codeHash: `z${number}` });
    await db.insert(schema.signInFailures).values({ phone: number, address: '203.0.113.9', failures: 3 });

    const { oneTimePassword } = await resetPlatformAdmin(await connect(), number);

    expect((await login(number)).status).toBe(401);
    const signedIn = await login(number, oneTimePassword);
    expect(signedIn.body.data.accessToken).toBeTruthy();
    expect(signedIn.body.data.session).toMatchObject({ mustChangePassword: true, mustEnroll2fa: true });
    expect(await db.select().from(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, admin.id))).toEqual([]);
    expect(await failures(number, '203.0.113.9')).toEqual([]);
    const trail = await db.select().from(schema.platformAudit).where(eq(schema.platformAudit.targetId, admin.id));
    expect(trail.map((row) => row.action)).toEqual(['reset-admin command']);
  });

  it('reaches only platform admins', async () => {
    const { phone: staff } = await createUser();
    await expect(resetPlatformAdmin(await connect(), staff)).rejects.toThrow('No platform admin');
    expect((await login(staff)).status).toBe(200);
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
