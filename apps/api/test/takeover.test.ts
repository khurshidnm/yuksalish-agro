/**
 * The attack on logins. `users` has no tenant_id and no RLS, because one person can work for several
 * tenants, so only the rules in the services stand between a farm owner and the platform admin. Here
 * an owner, with every right a tenant can give, goes after logins that are not wholly theirs.
 */
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { generate, generateSecret } from 'otplib';
import { describe, expect, it } from 'vitest';
import { withPlatform } from '../src/core/context';
import { seal } from '../src/core/crypto';
import { addMember } from '../src/core/tenancy';
import { signAccessToken } from '../src/core/tokens';
import { db, schema } from '../src/db/client';
import { createFixture, getApp, type Client, type Fixture } from './helpers';

const PASSWORD = 'Password123!';
const phone = () => `+998${Math.floor(100_000_000 + Math.random() * 899_999_999)}`;

async function call(token: string, method: 'GET' | 'POST', url: string, payload?: object) {
  const app = await getApp();
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    payload: payload ? JSON.stringify(payload) : undefined,
  });
  return { status: res.statusCode, body: res.json(), cookie: res.cookies.find((c) => c.name === 'yap_rt')?.value };
}

async function signIn(number: string, password = PASSWORD) {
  const app = await getApp();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { phone: number, password } });
  return { status: res.statusCode, body: res.json(), cookie: res.cookies.find((c) => c.name === 'yap_rt')?.value };
}

async function refresh(cookie: string) {
  const app = await getApp();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: `yap_rt=${cookie}` } });
  return { status: res.statusCode, data: res.json().data, cookie: res.cookies.find((c) => c.name === 'yap_rt')?.value };
}

/** Everything about a login that an attack could change. */
async function account(userId: string) {
  const [{ updatedAt: _updatedAt, lastLoginAt: _lastLoginAt, ...identity }] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  return identity;
}

const membershipsOf = (userId: string) =>
  withPlatform((trx) => trx.select().from(schema.memberships).where(eq(schema.memberships.userId, userId)));

interface Person {
  userId: string;
  phone: string;
  /** Signed in, on no farm in particular: enough to answer an invitation. */
  token: string;
}

async function platformAdmin(): Promise<Person & { secret: string }> {
  const number = phone();
  const secret = generateSecret();
  const [admin] = await db
    .insert(schema.users)
    .values({ phone: number, fullName: 'Platform Admin', passwordHash: await bcrypt.hash(PASSWORD, 4), isPlatformAdmin: true, totpEnabled: true, totpSecret: seal(secret) })
    .returning();
  return { userId: admin.id, phone: number, secret, token: await signAccessToken({ userId: admin.id, membershipId: null, tenantId: null, farmId: null }) };
}

async function workerElsewhere(role: 'shepherd' | 'owner' = 'shepherd') {
  const home = await createFixture();
  const number = phone();
  const { userId, membershipId } = await addMember({
    tenantId: home.tenantId,
    farmId: home.farmId,
    roleId: home.roleIds[role],
    phone: number,
    fullName: 'Worker Elsewhere',
    password: PASSWORD,
  });
  const token = await signAccessToken({ userId, membershipId, tenantId: home.tenantId, farmId: home.farmId });
  return { home, userId, membershipId, phone: number, token };
}

async function noFarmYet(): Promise<Person> {
  const number = phone();
  const [user] = await db.insert(schema.users).values({ phone: number, fullName: 'No Farm Yet', passwordHash: await bcrypt.hash(PASSWORD, 4) }).returning();
  return { userId: user.id, phone: number, token: await signAccessToken({ userId: user.id, membershipId: null, tenantId: null, farmId: null }) };
}

async function attacker() {
  const f = await createFixture();
  return { f, owner: await f.as('owner') };
}

/** The only way anyone ends up on a farm they did not start on: they say yes, signed in as themselves. */
async function joinByChoice(f: Fixture, owner: Client, person: Person) {
  const invited = await owner.post('/settings/users', { phone: person.phone, fullName: 'Agreed To Join', roleId: f.roleIds.shepherd });
  const accepted = await call(person.token, 'POST', `/auth/invitations/${invited.data.invitation.id}/accept`, {});
  expect(accepted.status).toBe(200);
  const [member] = (await owner.get('/settings/users', { search: person.phone })).data;
  return { membershipId: member.id as string, accessToken: accepted.body.data.accessToken as string, cookie: accepted.cookie! };
}

const strangers: [string, () => Promise<Person>][] = [
  ['the platform admin', platformAdmin],
  ['someone on another tenant', () => workerElsewhere()],
  ['the owner of another tenant', () => workerElsewhere('owner')],
  ['someone with no farm yet', noFarmYet],
];

describe('attaching a person who did not agree', () => {
  it.each(strangers)('%s only gets an invitation, and nothing about them changes', async (_who, stranger) => {
    const { f, owner } = await attacker();
    const victim = await stranger();
    const before = await account(victim.userId);
    const held = await membershipsOf(victim.userId);

    const sent = await owner.post('/settings/users', { phone: victim.phone, fullName: 'Typed By Owner', email: 'typed@example.com', roleId: f.roleIds.owner });

    expect(sent.data.member).toBeNull();
    expect(sent.data.oneTimePassword).toBeNull();
    expect(sent.data.invitation.id).toBeTruthy();
    expect(JSON.stringify(sent.body)).not.toContain(victim.userId);
    expect(JSON.stringify(sent.body)).not.toContain(before.fullName);
    expect(await account(victim.userId)).toEqual(before);
    expect(await membershipsOf(victim.userId)).toEqual(held);
    expect((await owner.get('/settings/users', { search: victim.phone })).data).toEqual([]);
    expect((await owner.get('/settings/users', { search: before.fullName })).data).toEqual([]);
    expect((await owner.get('/settings/users/lookup', { search: before.fullName })).data).toEqual([]);
  });

  it.each([
    ['with spaces', (n: string) => `+${n.slice(1, 4)} ${n.slice(4, 6)} ${n.slice(6, 9)}-${n.slice(9, 11)}-${n.slice(11)}`],
    ['without the plus', (n: string) => n.slice(1)],
    ['without the country code', (n: string) => n.slice(4)],
  ])('spelling the phone %s reaches the same login, not a new one with a known password', async (_how, spell) => {
    const { f, owner } = await attacker();
    const admin = await platformAdmin();
    const sent = await owner.post('/settings/users', { phone: spell(admin.phone), fullName: 'Typed By Owner', roleId: f.roleIds.shepherd });
    expect(sent.data.oneTimePassword).toBeNull();
    expect(sent.data.member).toBeNull();
    expect(await db.select().from(schema.users).where(eq(schema.users.phone, admin.phone))).toHaveLength(1);
  });

  it('nobody answers for them: not the owner, not a colleague, not another phone', async () => {
    const { f, owner } = await attacker();
    const admin = await platformAdmin();
    const invitation = (await owner.post('/settings/users', { phone: admin.phone, fullName: 'Typed By Owner', roleId: f.roleIds.owner })).data.invitation;

    const colleague = await f.as('director');
    const decoy = await noFarmYet();
    for (const client of [owner, colleague]) {
      expect((await client.post(`/auth/invitations/${invitation.id}/accept`)).status).toBe(404);
    }
    expect((await call(decoy.token, 'POST', `/auth/invitations/${invitation.id}/accept`, {})).status).toBe(404);
    expect(await membershipsOf(admin.userId)).toEqual([]);
  });
});

describe('reaching past the tenant by id', () => {
  it('every action on someone in another tenant is not found, by membership or by login, and changes nothing', async () => {
    const { f, owner } = await attacker();
    const victim = await workerElsewhere('owner');
    const before = await account(victim.userId);
    const held = await membershipsOf(victim.userId);

    for (const id of [victim.membershipId, victim.userId]) {
      for (const action of ['block', 'unblock', 'reset-password', 'reset-2fa']) {
        const res = await owner.post(`/settings/users/${id}/${action}`);
        expect([action, res.status, res.body.error?.code]).toEqual([action, 404, 'NOT_FOUND']);
      }
      expect((await owner.patch(`/settings/users/${id}`, { roleId: f.roleIds.shepherd })).status).toBe(404);
    }

    expect(await account(victim.userId)).toEqual(before);
    expect(await membershipsOf(victim.userId)).toEqual(held);
    expect((await call(victim.token, 'GET', '/hr/employees/lookup')).status).toBe(200);
    expect((await signIn(victim.phone)).status).toBe(200);
  });

  it('a login from outside cannot be pulled in through a task or an employee record, which would show their name', async () => {
    const { owner } = await attacker();
    const victim = await workerElsewhere();

    const task = await owner.post('/tasks', { title: 'Reveal who this is', assigneeUserId: victim.userId });
    expect([task.status, task.body.error?.code]).toEqual([400, 'ASSIGNEE_NOT_MEMBER']);

    const employee = await owner.post('/hr/employees', {
      fullName: 'Reveal',
      position: 'Shepherd',
      hireDate: '2026-01-05',
      payType: 'monthly',
      baseRate: 1_000_000,
      userId: victim.userId,
    });
    expect([employee.status, employee.body.error?.code]).toEqual([400, 'USER_NOT_ON_FARM']);
  });

  it('the platform routes stay closed to the strongest role a tenant has', async () => {
    const { f, owner } = await attacker();
    const admin = await platformAdmin();
    const before = await account(admin.userId);

    expect((await owner.get('/platform/users', { search: admin.phone })).status).toBe(403);
    expect((await owner.get('/platform/tenants')).status).toBe(403);
    for (const action of ['block', 'unblock', 'reset-password', 'reset-2fa']) {
      expect((await owner.post(`/platform/users/${admin.userId}/${action}`)).status).toBe(403);
    }
    expect((await owner.post(`/platform/tenants/${f.tenantId}/reactivate`)).status).toBe(403);
    expect(await account(admin.userId)).toEqual(before);
  });
});

describe('someone who joined by choice keeps the rest of their account', () => {
  const adminSession = async (admin: Awaited<ReturnType<typeof platformAdmin>>) => {
    const app = await getApp();
    const { challengeToken } = (await signIn(admin.phone)).body.data;
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/verify',
      payload: { challengeToken, code: await generate({ secret: admin.secret }) },
    });
    expect(verified.statusCode).toBe(200);
    return { accessToken: verified.json().data.accessToken as string, cookie: verified.cookies.find((c) => c.name === 'yap_rt')!.value };
  };

  it('a platform admin who joined cannot have their password or 2FA reset', async () => {
    const { f, owner } = await attacker();
    const admin = await platformAdmin();
    const { membershipId } = await joinByChoice(f, owner, admin);
    const before = await account(admin.userId);

    for (const action of ['reset-password', 'reset-2fa']) {
      const refused = await owner.post(`/settings/users/${membershipId}/${action}`);
      expect([refused.status, refused.body.error.code]).toEqual([409, 'USER_HAS_OTHER_WORKSPACES']);
    }
    expect(await account(admin.userId)).toEqual(before);
  });

  it('blocking a platform admin closes this farm and leaves the platform alone, however often it is tried', async () => {
    const { f, owner } = await attacker();
    const admin = await platformAdmin();
    const platform = await adminSession(admin);
    const { membershipId, accessToken } = await joinByChoice(f, owner, admin);

    let session = platform.cookie;
    let token = platform.accessToken;
    for (let round = 0; round < 2; round += 1) {
      expect((await owner.post(`/settings/users/${membershipId}/block`)).status).toBe(200);
      expect((await call(accessToken, 'GET', '/hr/employees/lookup')).status).toBe(401);
      expect((await call(token, 'GET', '/platform/stats')).status).toBe(200);

      const kept = await refresh(session);
      expect(kept.status).toBe(200);
      expect(kept.data.session.tenant).toBeNull();
      expect((await call(kept.data.accessToken, 'GET', '/platform/stats')).status).toBe(200);
      expect((await call(kept.data.accessToken, 'GET', '/hr/employees/lookup')).status).toBe(403);

      // Let back in, a refresh puts the session on the farm: the position to be struck from again.
      expect((await owner.post(`/settings/users/${membershipId}/unblock`)).status).toBe(200);
      const back = await refresh(kept.cookie!);
      expect(back.data.session.tenant.id).toBe(f.tenantId);
      session = back.cookie!;
      token = back.data.accessToken;
    }
  });

  it('blocking someone on two tenants signs them out of this one only, as often as it is tried', async () => {
    const { f, owner } = await attacker();
    const person = await workerElsewhere();
    const home = await signIn(person.phone);
    const { membershipId, accessToken, cookie } = await joinByChoice(f, owner, person);
    const before = await account(person.userId);

    let homeCookie = home.cookie!;
    let homeToken = home.body.data.accessToken as string;
    for (let round = 0; round < 3; round += 1) {
      expect((await owner.post(`/settings/users/${membershipId}/block`)).status).toBe(200);
      expect((await call(accessToken, 'GET', '/hr/employees/lookup')).status).toBe(401);
      expect((await call(homeToken, 'GET', '/hr/employees/lookup')).status).toBe(200);

      const stillHome = await refresh(homeCookie);
      expect(stillHome.status).toBe(200);
      expect(stillHome.data.session.tenant.id).toBe(person.home.tenantId);
      homeToken = stillHome.data.accessToken;
      homeCookie = stillHome.cookie!;
      expect((await owner.post(`/settings/users/${membershipId}/unblock`)).status).toBe(200);
    }

    expect((await refresh(cookie)).status).toBe(401);
    expect(await account(person.userId)).toEqual(before);
    const held = await membershipsOf(person.userId);
    expect(held.find((m) => m.id === person.membershipId)?.status).toBe('active');
  });

  it('a person kept elsewhere stays out of reach even while blocked there', async () => {
    const { f, owner } = await attacker();
    const person = await workerElsewhere();
    const { membershipId } = await joinByChoice(f, owner, person);
    await withPlatform((trx) => trx.update(schema.memberships).set({ status: 'blocked' }).where(eq(schema.memberships.id, person.membershipId)));

    for (const action of ['reset-password', 'reset-2fa']) {
      expect((await owner.post(`/settings/users/${membershipId}/${action}`)).status).toBe(409);
    }
  });

  it('a login with an invitation waiting from another tenant is out of reach, or the owner could sign in and accept it', async () => {
    const { f, owner } = await attacker();
    const added = await owner.post('/settings/users', { phone: phone(), fullName: 'Ours For Now', roleId: f.roleIds.shepherd });
    const { id: membershipId, userId, phone: number } = added.data.member;

    const rival = await createFixture();
    const rivalOwner = await rival.as('owner');
    const invitation = (await rivalOwner.post('/settings/users', { phone: number, fullName: 'Hired Elsewhere', roleId: rival.roleIds.director })).data.invitation;
    const before = await account(userId);

    for (const action of ['reset-password', 'reset-2fa']) {
      const refused = await owner.post(`/settings/users/${membershipId}/${action}`);
      expect([refused.status, refused.body.error.code]).toEqual([409, 'USER_HAS_OTHER_WORKSPACES']);
    }
    expect(await account(userId)).toEqual(before);

    // An invitation that lapsed no longer holds anything back.
    await withPlatform((trx) => trx.update(schema.invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invitations.id, invitation.id)));
    expect((await owner.post(`/settings/users/${membershipId}/reset-password`)).status).toBe(200);
  });

  it('an invitation from this tenant itself does not count against it', async () => {
    const { f, owner } = await attacker();
    const added = await owner.post('/settings/users', { phone: phone(), fullName: 'Ours', roleId: f.roleIds.shepherd });
    const { id: membershipId, phone: number } = added.data.member;
    await withPlatform((trx) =>
      trx.insert(schema.invitations).values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        phone: number,
        fullName: 'Ours',
        roleId: f.roleIds.agronomist,
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    );
    expect((await owner.post(`/settings/users/${membershipId}/reset-password`)).status).toBe(200);
  });

  it('an owner cannot lift a block that is not theirs', async () => {
    const { f, owner } = await attacker();
    const person = await workerElsewhere();
    const { membershipId } = await joinByChoice(f, owner, person);

    await withPlatform((trx) => trx.update(schema.users).set({ status: 'blocked' }).where(eq(schema.users.id, person.userId)));
    await owner.post(`/settings/users/${membershipId}/block`);
    await owner.post(`/settings/users/${membershipId}/unblock`);
    expect((await account(person.userId)).status).toBe('blocked');
    const refused = await signIn(person.phone);
    expect([refused.status, refused.body.error.code]).toEqual([401, 'ACCOUNT_BLOCKED']);
  });
});

describe('what an owner may still do', () => {
  it('a login wholly on this tenant can be reset, and the one-time password works', async () => {
    const { f, owner } = await attacker();
    const added = await owner.post('/settings/users', { phone: phone(), fullName: 'Ours', roleId: f.roleIds.shepherd });
    const reset = await owner.post(`/settings/users/${added.data.member.id}/reset-password`);
    expect(reset.status).toBe(200);
    expect((await signIn(added.data.member.phone, reset.data.oneTimePassword)).status).toBe(200);
    expect((await owner.post(`/settings/users/${added.data.member.id}/reset-2fa`)).status).toBe(200);
  });

  it('blocking someone who works only here still ends every session they have', async () => {
    const { f, owner } = await attacker();
    const person = await noFarmYet();
    const before = await signIn(person.phone);
    const { membershipId, cookie } = await joinByChoice(f, owner, person);
    expect((await owner.post(`/settings/users/${membershipId}/block`)).status).toBe(200);
    expect((await refresh(cookie)).status).toBe(401);
    expect((await refresh(before.cookie!)).status).toBe(401);
  });
});
