import { createHmac, randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@yap/shared';
import { db, schema } from '../src/db/client';
import { tx, withPlatform } from '../src/core/context';
import { unseal, sha256 } from '../src/core/crypto';
import { generalCostCenterId } from '../src/core/costCenters';
import { postTransaction } from '../src/core/ledger';
import { addMember } from '../src/core/tenancy';
import { signAccessToken } from '../src/core/tokens';
import {
  RETRY_MINUTES,
  assertSafeUrl,
  collectEvents,
  deliverDue,
  isPrivateAddress,
  matchesEvent,
} from '../src/modules/settings/webhooks.service';
import { createFixture, getApp, type Fixture } from './helpers';

const phone = () => `+998${Math.floor(100_000_000 + Math.random() * 899_999_999)}`;

async function request(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const app = await getApp();
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    payload: payload ? JSON.stringify(payload) : undefined,
  });
  let body: any = null;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, data: body?.data, raw: res.body };
}

/** A signed-in member with an arbitrary role, for the custom roles `f.as()` cannot make. */
async function memberWith(f: Fixture, permissions: string[]) {
  const roleId = uuidv7();
  await f.run(() =>
    tx().insert(schema.roles).values({ id: roleId, tenantId: f.tenantId, key: `t_${randomBytes(3).toString('hex')}`, name: 'Test role', permissions }),
  );
  const { userId, membershipId } = await addMember({ tenantId: f.tenantId, farmId: f.farmId, roleId, phone: phone(), fullName: 'Custom Person', password: 'Password123!' });
  const token = await signAccessToken({ userId, membershipId, tenantId: f.tenantId, farmId: f.farmId });
  return {
    userId,
    membershipId,
    roleId,
    get: (url: string) => request(token, 'GET', url),
    post: (url: string, body: unknown = {}) => request(token, 'POST', url, body),
    patch: (url: string, body: unknown) => request(token, 'PATCH', url, body),
    delete: (url: string) => request(token, 'DELETE', url),
  };
}

async function loginWith(p: string, password: string) {
  const app = await getApp();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { phone: p, password } });
  return { status: res.statusCode, body: res.json() };
}

describe('profile and policy', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  it('owner edits the profile, director reads it, a shepherd is refused', async () => {
    const owner = await f.as('owner');
    const updated = await owner.patch('/settings/profile', { tenant: { tin: '123456789' }, farm: { district: 'Qorovulbozor' } });
    expect(updated.status).toBe(200);
    expect(updated.data.tenant.tin).toBe('123456789');
    expect(updated.data.farm.district).toBe('Qorovulbozor');

    const director = await f.as('director');
    expect((await director.get('/settings/profile')).status).toBe(200);
    expect((await director.patch('/settings/profile', { tenant: { tin: '1' } })).status).toBe(403);
    expect((await (await f.as('shepherd')).get('/settings/profile')).status).toBe(403);
  });

  it('a partial policy edit keeps the other values and defaults', async () => {
    const owner = await f.as('owner');
    const before = (await owner.get('/settings/policy')).data;
    expect(before.finance.approvalThreshold).toBe(5_000_000);

    const after = await owner.patch('/settings/policy', { finance: { approvalThreshold: 1_000_000 } });
    expect(after.status).toBe(200);
    expect(after.data.finance).toEqual({ approvalThreshold: 1_000_000, makerChecker: true, overheadBase: 'head' });
    expect(after.data.feed).toEqual(before.feed);
    // The fixture's 2FA setting survives an edit of a different section.
    expect(after.data.security.enforce2fa).toBe(false);

    await owner.patch('/settings/policy', { finance: { overheadBase: 'area' } });
    const again = (await owner.get('/settings/policy')).data;
    expect(again.finance.approvalThreshold).toBe(1_000_000);
    expect(again.finance.overheadBase).toBe('area');
  });

  it('a saved policy applies to the very next request', async () => {
    const g = await createFixture();
    const owner = await g.as('owner');
    await owner.patch('/settings/policy', { security: { enforce2fa: true } });
    const session = await g.as('accountant');
    const denied = await session.get('/finance/counterparties');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED');
  });

  it.each([
    [{ finance: { approvalThreshold: -1 } }],
    [{ inventory: { costingMethod: 'lifo' } }],
    [{ feed: { deviationPercent: 150 } }],
    [{ finance: { unknownSetting: 1 } }],
    [{ somethingElse: true }],
    [{ timezone: 'Mars/Olympus' }],
    [{ currency: 'XYZ' }],
  ])('rejects invalid policy %j', async (body) => {
    const owner = await f.as('owner');
    const res = await owner.patch('/settings/policy', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('the base currency locks once a transaction exists', async () => {
    const g = await createFixture();
    const owner = await g.as('owner');
    expect((await owner.patch('/settings/policy', { currency: 'USD' })).data.currency).toBe('USD');
    await owner.patch('/settings/policy', { currency: 'UZS' });

    await g.run(async () => {
      const [account] = await tx().insert(schema.accounts).values({ tenantId: g.tenantId, farmId: g.farmId, name: 'Kassa', type: 'cash' }).returning();
      const [category] = await tx().select().from(schema.financeCategories).where(sql`key = 'feed'`);
      await postTransaction({ date: '2026-11-01', type: 'expense', amount: 100, paymentMethod: 'cash', accountId: account.id, categoryId: category.id, costCenterId: await generalCostCenterId() });
    });

    const res = await owner.patch('/settings/policy', { currency: 'USD' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CURRENCY_LOCKED');
  });

  it('policy changes are journalled', async () => {
    const g = await createFixture();
    const owner = await g.as('owner');
    await owner.patch('/settings/policy', { feed: { winterDays: 130 } });
    const rows = await g.run(() => tx().select().from(schema.events).where(sql`type = 'settings.policy_changed'`));
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toEqual({ changes: { feed: { winterDays: 130 } } });
    expect(rows[0].createdBy).toBe(owner.userId);
  });
});

describe('users', () => {
  it('a new person gets a one-time password that works and is never returned again', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const p = phone();
    const res = await owner.post('/settings/users', { phone: p, fullName: 'Yangi Xodim', roleId: f.roleIds.shepherd });
    expect(res.status).toBe(201);
    expect(res.data.existingUser).toBe(false);
    expect(res.data.oneTimePassword).toMatch(/^[\w-]{12}$/);
    expect(res.data.member.roleKey).toBe('shepherd');

    const login = await loginWith(p, res.data.oneTimePassword);
    expect(login.status).toBe(200);
    expect(login.body.data.session.role.key).toBe('shepherd');

    const list = await owner.get('/settings/users', { search: 'Yangi' });
    expect(list.body.meta.total).toBe(1);
    expect(JSON.stringify(list.body)).not.toContain(res.data.oneTimePassword);
    expect(JSON.stringify(list.body)).not.toContain('passwordHash');
  });

  it('an existing person is added without touching their password', async () => {
    const f = await createFixture();
    const g = await createFixture();
    const existing = phone();
    await addMember({ tenantId: g.tenantId, farmId: g.farmId, roleId: g.roleIds.agronomist, phone: existing, fullName: 'Bor Xodim', password: 'Password123!' });

    const owner = await f.as('owner');
    const res = await owner.post('/settings/users', { phone: existing, fullName: 'Ignored Name', roleId: f.roleIds.shepherd });
    expect(res.status).toBe(201);
    expect(res.data.existingUser).toBe(true);
    expect(res.data.oneTimePassword).toBeNull();
    expect(res.data.member.fullName).toBe('Bor Xodim');
    expect((await loginWith(existing, 'Password123!')).status).toBe(200);

    const duplicate = await owner.post('/settings/users', { phone: existing, fullName: 'X Y', roleId: f.roleIds.shepherd });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('ALREADY_MEMBER');
  });

  it('refuses an invalid phone and a role from another tenant', async () => {
    const f = await createFixture();
    const g = await createFixture();
    const owner = await f.as('owner');
    const bad = await owner.post('/settings/users', { phone: '123456789012345678', fullName: 'Ab Cd', roleId: f.roleIds.shepherd });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_PHONE');
    const foreign = await owner.post('/settings/users', { phone: phone(), fullName: 'Ab Cd', roleId: g.roleIds.owner });
    expect(foreign.status).toBe(404);
  });

  it('nobody can hand out a role stronger than their own', async () => {
    const f = await createFixture();
    const manager = await memberWith(f, ['users.view', 'users.create', 'users.update', 'livestock.view']);
    const denied = await manager.post('/settings/users', { phone: phone(), fullName: 'Ab Cd', roleId: f.roleIds.owner });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('CANNOT_GRANT_PERMISSION');
    expect(denied.body.error.details.missing).toContain('finance.view');

    const shepherd = await f.as('shepherd');
    const escalate = await manager.patch(`/settings/users/${shepherd.membershipId}`, { roleId: f.roleIds.accountant });
    expect(escalate.status).toBe(403);
  });

  it('nobody can manage a colleague with more rights', async () => {
    const f = await createFixture();
    const manager = await memberWith(f, ['users.view', 'users.update']);
    const owner = await f.as('owner');
    expect((await manager.post(`/settings/users/${owner.membershipId}/block`)).body.error.code).toBe('CANNOT_MANAGE_HIGHER_ROLE');
    expect((await manager.post(`/settings/users/${owner.membershipId}/reset-password`)).body.error.code).toBe('CANNOT_MANAGE_HIGHER_ROLE');
  });

  it('a member without users permissions is refused', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    expect((await shepherd.get('/settings/users')).status).toBe(403);
    expect((await shepherd.post('/settings/users', { phone: phone(), fullName: 'Ab Cd', roleId: f.roleIds.shepherd })).status).toBe(403);
    expect((await shepherd.get('/settings/roles')).status).toBe(403);
  });

  it('changes a role, but not your own', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    const res = await owner.patch(`/settings/users/${shepherd.membershipId}`, { roleId: f.roleIds.veterinarian });
    expect(res.status).toBe(200);
    expect(res.data.roleKey).toBe('veterinarian');
    expect((await shepherd.get('/livestock/none')).status).toBe(404);

    const self = await owner.patch(`/settings/users/${owner.membershipId}`, { roleId: f.roleIds.investor });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('CANNOT_CHANGE_OWN_ROLE');
  });

  it('blocking takes effect at once, ends sessions, and keeps the records', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const p = phone();
    const added = await owner.post('/settings/users', { phone: p, fullName: 'Ketgan Xodim', roleId: f.roleIds.accountant });
    const login = await loginWith(p, added.data.oneTimePassword);
    const token = login.body.data.accessToken;
    const created = await request(token, 'POST', '/finance/counterparties', { name: 'Yozuv', type: 'buyer' });
    expect(created.status).toBe(201);

    const blocked = await owner.post(`/settings/users/${added.data.member.id}/block`);
    expect(blocked.status).toBe(200);
    expect(blocked.data.status).toBe('blocked');

    // The access token is still inside its 15 minutes and must already be dead.
    const refused = await request(token, 'GET', '/finance/counterparties');
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('ACCOUNT_BLOCKED');

    const { refreshTokens } = schema;
    const sessions = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, added.data.member.userId));
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

    const row = await f.run(() => tx().select().from(schema.counterparties).where(eq(schema.counterparties.id, created.data.id)));
    expect(row).toHaveLength(1);

    const unblocked = await owner.post(`/settings/users/${added.data.member.id}/unblock`);
    expect(unblocked.data.status).toBe('active');
    expect((await request(token, 'GET', '/finance/counterparties')).status).toBe(200);
  });

  it('nobody can block themselves', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const res = await owner.post(`/settings/users/${owner.membershipId}/block`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANNOT_BLOCK_SELF');
  });

  it('the last active owner cannot be blocked or demoted, a second owner frees them', async () => {
    const f = await createFixture();
    const first = await f.as('owner');
    const manager = await memberWith(f, DEFAULT_ROLE_PERMISSIONS.owner);

    const blockLast = await manager.post(`/settings/users/${first.membershipId}/block`);
    expect(blockLast.status).toBe(409);
    expect(blockLast.body.error.code).toBe('LAST_OWNER');
    const demoteLast = await manager.patch(`/settings/users/${first.membershipId}`, { roleId: f.roleIds.director });
    expect(demoteLast.status).toBe(409);

    await first.post('/settings/users', { phone: phone(), fullName: 'Ikkinchi Ega', roleId: f.roleIds.owner });
    expect((await manager.post(`/settings/users/${first.membershipId}/block`)).status).toBe(200);
  });

  it('an admin resets a password, except for someone who also works elsewhere', async () => {
    const f = await createFixture();
    const g = await createFixture();
    const owner = await f.as('owner');
    const p = phone();
    const added = await owner.post('/settings/users', { phone: p, fullName: 'Parol Xodim', roleId: f.roleIds.shepherd });

    const reset = await owner.post(`/settings/users/${added.data.member.id}/reset-password`);
    expect(reset.status).toBe(200);
    expect((await loginWith(p, added.data.oneTimePassword)).status).toBe(401);
    expect((await loginWith(p, reset.data.oneTimePassword)).status).toBe(200);

    await addMember({ tenantId: g.tenantId, farmId: g.farmId, roleId: g.roleIds.owner, phone: p, fullName: 'Parol Xodim', password: 'x' });
    const refused = await owner.post(`/settings/users/${added.data.member.id}/reset-password`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('USER_HAS_OTHER_WORKSPACES');
  });

  it('lookup returns names for staff, and nothing for an outside investor', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    const seen = await shepherd.get('/settings/users/lookup');
    expect(seen.status).toBe(200);
    expect(seen.data.some((u: any) => u.id === owner.userId && u.roleKey === 'owner')).toBe(true);
    expect(Object.keys(seen.data[0]).sort()).toEqual(['fullName', 'id', 'name', 'roleKey']);

    const investor = await f.as('investor');
    expect((await investor.get('/settings/users/lookup')).data).toEqual([]);
  });

  it('hides contact details from a user manager without pii.view', async () => {
    const f = await createFixture();
    await f.as('owner');
    const manager = await memberWith(f, ['users.view']);
    const list = await manager.get('/settings/users');
    expect(list.status).toBe(200);
    expect(list.body.data.every((m: any) => m.phone === null && m.email === null)).toBe(true);
  });

  it('never lists members of another tenant', async () => {
    const f = await createFixture();
    const g = await createFixture();
    await g.as('owner');
    const owner = await f.as('owner');
    const list = await owner.get('/settings/users');
    expect(list.body.data.map((m: any) => m.userId)).toEqual([owner.userId]);
  });
});

describe('roles', () => {
  it('lists the matrix with member counts', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await f.as('shepherd');
    const res = await owner.get('/settings/roles');
    expect(res.data).toHaveLength(11);
    const shepherd = res.data.find((r: any) => r.key === 'shepherd');
    expect(shepherd.memberCount).toBe(1);
    expect(shepherd.isSystem).toBe(true);
    expect(shepherd.permissions).toEqual(DEFAULT_ROLE_PERMISSIONS.shepherd);
  });

  it('creates a custom role, assigns it, and refuses to delete it while in use', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const created = await owner.post('/settings/roles', { name: 'Hisobchi yordamchisi', permissions: ['finance.view', 'tasks.view'] });
    expect(created.status).toBe(201);
    expect(created.data.key).toMatch(/^custom_/);
    expect(created.data.isSystem).toBe(false);

    const added = await owner.post('/settings/users', { phone: phone(), fullName: 'Yordamchi Xodim', roleId: created.data.id });
    expect(added.status).toBe(201);

    const inUse = await owner.delete(`/settings/roles/${created.data.id}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('ROLE_IN_USE');

    await owner.patch(`/settings/users/${added.data.member.id}`, { roleId: f.roleIds.shepherd });
    expect((await owner.delete(`/settings/roles/${created.data.id}`)).status).toBe(200);
  });

  it('a permission edit reaches members on their next request', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    expect((await shepherd.get('/finance/counterparties')).status).toBe(403);
    await owner.patch(`/settings/roles/${f.roleIds.shepherd}`, { permissions: [...DEFAULT_ROLE_PERMISSIONS.shepherd, 'finance.view'] });
    expect((await shepherd.get('/finance/counterparties')).status).toBe(200);
  });

  it('rejects unknown permissions', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const res = await owner.post('/settings/roles', { name: 'Yomon', permissions: ['finance.everything'] });
    expect(res.status).toBe(400);
  });

  it('nobody grants a permission they lack, but they can keep or remove what is there', async () => {
    const f = await createFixture();
    const manager = await memberWith(f, ['users.view', 'users.create', 'users.update', 'tasks.view']);

    const create = await manager.post('/settings/roles', { name: 'Kuchli', permissions: ['finance.view'] });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('CANNOT_GRANT_PERMISSION');

    const raise = await manager.patch(`/settings/roles/${f.roleIds.shepherd}`, { permissions: [...DEFAULT_ROLE_PERMISSIONS.shepherd, 'finance.view'] });
    expect(raise.status).toBe(403);

    // The shepherd role holds rights this manager lacks. Saving it minus one right is not a grant.
    const keep = DEFAULT_ROLE_PERMISSIONS.shepherd.filter((p) => p !== 'feed.view');
    expect((await manager.patch(`/settings/roles/${f.roleIds.shepherd}`, { permissions: keep })).status).toBe(200);
  });

  it('an empty edit changes nothing', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const res = await owner.patch(`/settings/roles/${f.roleIds.investor}`, {});
    expect(res.status).toBe(200);
    expect(res.data.key).toBe('investor');
  });

  it('protects system roles and the owner role', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');

    const del = await owner.delete(`/settings/roles/${f.roleIds.investor}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('SYSTEM_ROLE');

    const rename = await owner.patch(`/settings/roles/${f.roleIds.investor}`, { name: 'Boshqa nom' });
    expect(rename.body.error.code).toBe('SYSTEM_ROLE');

    const lockOwner = await owner.patch(`/settings/roles/${f.roleIds.owner}`, { permissions: ['tasks.view'] });
    expect(lockOwner.status).toBe(409);
    expect(lockOwner.body.error.code).toBe('OWNER_ROLE_LOCKED');

    const edited = await owner.patch(`/settings/roles/${f.roleIds.investor}`, { permissions: ['dashboard.view'] });
    expect(edited.status).toBe(200);
    expect(edited.data.key).toBe('investor');
  });

  it('a role in another tenant is invisible', async () => {
    const f = await createFixture();
    const g = await createFixture();
    const owner = await f.as('owner');
    expect((await owner.patch(`/settings/roles/${g.roleIds.investor}`, { permissions: [] })).status).toBe(404);
  });
});

describe('api keys', () => {
  it('shows the key once and stores only its hash', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const created = await owner.post('/settings/api-keys', { name: 'Molxona NVR', scopes: ['events:write'] });
    expect(created.status).toBe(201);
    expect(created.data.key).toMatch(/^yap_/);
    expect(created.data.keyPrefix).toBe(created.data.key.slice(0, 12));

    const list = await owner.get('/settings/api-keys');
    expect(list.data).toHaveLength(1);
    expect(list.data[0].key).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain(created.data.key);
    expect(JSON.stringify(list.body)).not.toContain('keyHash');

    const [row] = await f.run(() => tx().select().from(schema.apiKeys));
    expect(row.keyHash).toBe(sha256(created.data.key));
  });

  it('revoking is final, and a director can only read', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const created = await owner.post('/settings/api-keys', { name: 'Datchik', scopes: ['events:write'] });
    expect((await director.get('/settings/api-keys')).status).toBe(200);
    expect((await director.post('/settings/api-keys', { name: 'Yangi kalit', scopes: ['*'] })).status).toBe(403);

    expect((await owner.delete(`/settings/api-keys/${created.data.id}`)).data.revokedAt).toBeTruthy();
    expect((await owner.delete(`/settings/api-keys/${created.data.id}`)).status).toBe(404);
  });

  it('rejects unknown scopes and foreign keys', async () => {
    const f = await createFixture();
    const g = await createFixture();
    const owner = await f.as('owner');
    expect((await owner.post('/settings/api-keys', { name: 'Yomon', scopes: ['root'] })).status).toBe(400);
    const foreign = await (await g.as('owner')).post('/settings/api-keys', { name: 'Begona', scopes: ['*'] });
    expect((await owner.delete(`/settings/api-keys/${foreign.data.id}`)).status).toBe(404);
  });
});

describe('audit log and journal', () => {
  it('auditors read the log, shepherds and investors do not', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await owner.post('/finance/counterparties', { name: 'Audit', type: 'buyer', phone: '+998901112233' });

    const auditor = await f.as('auditor');
    const log = await auditor.get('/settings/audit', { entity: 'counterparties' });
    expect(log.status).toBe(200);
    expect(log.body.meta.total).toBe(1);
    expect(log.data[0].userName).toBeTruthy();
    expect(log.data[0].after.name).toBe('Audit');
    expect(log.data[0].after.phone).toBe('+998901112233');

    expect((await (await f.as('shepherd')).get('/settings/audit')).status).toBe(403);
    expect((await (await f.as('investor')).get('/settings/audit')).status).toBe(403);
  });

  it('never returns credentials, even to the owner', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await owner.post('/settings/api-keys', { name: 'Sirli kalit', scopes: ['*'] });
    const log = await owner.get('/settings/audit', { entity: 'api_keys' });
    expect(log.body.meta.total).toBe(1);
    expect(log.data[0].after.name).toBe('Sirli kalit');
    expect(log.data[0].after.key_hash).toBeUndefined();
  });

  it('removes personal data and money for a role without pii.view or finance.view', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const [account] = await f.run(() =>
      tx().insert(schema.accounts).values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Kassa', type: 'cash', openingBalance: 1_000_000 }).returning(),
    );
    await owner.post('/finance/counterparties', { name: 'Maxfiy', type: 'buyer', phone: '+998907654321' });
    const reader = await memberWith(f, ['audit.view']);

    const people = await reader.get('/settings/audit?entity=counterparties');
    expect(people.data[0].after.name).toBe('Maxfiy');
    expect(people.data[0].after.phone).toBeUndefined();
    expect(people.data[0].userName).toBeNull();
    expect(people.data[0].ip).toBeNull();

    const money = await reader.get('/settings/audit?entity=accounts');
    expect(money.data[0].entityId).toBe(account.id);
    expect(money.data[0].after.opening_balance).toBeUndefined();
    expect(money.data[0].after.cost_center_id).toBeUndefined();
    expect(money.data[0].after.name).toBe('Kassa');
  });

  it('keeps look-alike fields that are not money', async () => {
    const f = await createFixture();
    await f.run(async () => {
      const costCenterId = await generalCostCenterId();
      const [account] = await tx().insert(schema.accounts).values({ tenantId: f.tenantId, farmId: f.farmId, name: 'K', type: 'cash' }).returning();
      const [category] = await tx().select().from(schema.financeCategories).where(sql`key = 'feed'`);
      await postTransaction({ date: '2026-11-01', type: 'expense', amount: 700, paymentMethod: 'cash', accountId: account.id, categoryId: category.id, costCenterId });
    });
    const reader = await memberWith(f, ['audit.view']);
    const log = await reader.get('/settings/audit?entity=transactions');
    const after = log.data[0].after;
    expect(after.amount).toBeUndefined();
    expect(after.amount_base).toBeUndefined();
    expect(after.cost_center_id).toBeTruthy();
    expect(after.cost_treatment).toBe('expense');
    expect(after.payment_method).toBe('cash');

    const journal = await reader.get('/settings/journal?type=transaction.expense');
    expect(journal.data[0].data.amountBase).toBeUndefined();
    expect(journal.data[0].data.costCenterId).toBeTruthy();
  });

  it('filters by action, day and user, and pages', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const a = await owner.post('/finance/counterparties', { name: 'A', type: 'buyer' });
    await director.post('/finance/counterparties', { name: 'B', type: 'buyer' });
    await owner.patch(`/finance/counterparties/${a.data.id}`, { name: 'A2' });

    const updates = await owner.get('/settings/audit', { entity: 'counterparties', action: 'update' });
    expect(updates.body.meta.total).toBe(1);
    expect(updates.data[0].before.name).toBe('A');

    const byDirector = await owner.get('/settings/audit', { entity: 'counterparties', userId: director.userId });
    expect(byDirector.data.map((r: any) => r.after.name)).toEqual(['B']);

    const future = await owner.get('/settings/audit', { entity: 'counterparties', from: '2099-01-01' });
    expect(future.body.meta.total).toBe(0);
    const { todayIso } = await import('@yap/shared');
    const today = await owner.get('/settings/audit', { entity: 'counterparties', from: todayIso(), to: todayIso() });
    expect(today.body.meta.total).toBe(3);

    const entities = await owner.get('/settings/audit/entities');
    expect(entities.data).toContain('counterparties');
  });

  it('a second farm in the tenant does not see the first farm\'s changes', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await owner.post('/finance/counterparties', { name: 'Farm one', type: 'buyer' });

    const secondFarmId = await withPlatform(async (trx) => {
      const [farm] = await trx.insert(schema.farms).values({ tenantId: f.tenantId, name: 'Ikkinchi ferma' }).returning();
      return farm.id;
    });
    const added = await addMember({ tenantId: f.tenantId, farmId: secondFarmId, roleId: f.roleIds.owner, phone: phone(), fullName: 'Farm Two', password: 'x' });
    const token = await signAccessToken({ userId: added.userId, membershipId: added.membershipId, tenantId: f.tenantId, farmId: secondFarmId });

    const log = await request(token, 'GET', '/settings/audit?entity=counterparties');
    expect(log.status).toBe(200);
    expect(log.body.meta.total).toBe(0);
  });

  it('journal filters by type prefix, source and severity', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await owner.post('/finance/counterparties', { name: 'J', type: 'buyer' });
    await owner.patch('/settings/policy', { feed: { winterDays: 121 } });

    const prefix = await owner.get('/settings/journal', { type: 'settings.' });
    expect(prefix.data.map((e: any) => e.type)).toEqual(['settings.policy_changed']);
    expect(prefix.data[0].severity).toBe('attention');
    expect(prefix.data[0].userName).toBeTruthy();

    const attention = await owner.get('/settings/journal', { severity: 'attention' });
    expect(attention.body.meta.total).toBe(1);

    expect((await (await f.as('shepherd')).get('/settings/journal')).status).toBe(403);
  });
});

describe('webhooks', () => {
  const publicDns = async () => ['93.184.216.34'];
  const URL_OK = 'https://93.184.216.34/hooks/yap';

  async function journalEvent(f: Fixture, type: string, data: Record<string, unknown> = {}) {
    await f.run(() =>
      tx().insert(schema.events).values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        type,
        data,
        // Old enough to be past the commit lag.
        createdAt: new Date(Date.now() - 60_000),
      }),
    );
  }

  const ok = () => vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;

  it('matches exact types, prefixes and everything', () => {
    expect(matchesEvent(['sale.created'], 'sale.created')).toBe(true);
    expect(matchesEvent(['sale.*'], 'sale.created')).toBe(true);
    expect(matchesEvent(['*'], 'anything.at.all')).toBe(true);
    expect(matchesEvent(['sale.*'], 'salesman.created')).toBe(false);
    expect(matchesEvent(['sale.created'], 'sale.updated')).toBe(false);
  });

  it.each([
    ['127.0.0.1'], ['10.1.2.3'], ['172.16.0.1'], ['192.168.1.1'], ['169.254.169.254'], ['100.64.0.1'],
    ['0.0.0.0'], ['::1'], ['fd00::1'], ['fe80::1'], ['::ffff:10.0.0.1'], ['::ffff:a00:1'], ['::ffff:7f00:1'],
  ])('treats %s as private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([['8.8.8.8'], ['93.184.216.34'], ['172.32.0.1'], ['2606:4700::1111']])('treats %s as public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it('refuses internal targets when saving, including a name that resolves inside', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    for (const url of ['http://127.0.0.1:6381/', 'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:7f00:1]/']) {
      const res = await owner.post('/settings/webhooks', { url, eventTypes: ['*'] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WEBHOOK_URL_NOT_ALLOWED');
    }
    await expect(assertSafeUrl('https://sneaky.example/x', async () => ['10.0.0.5'])).rejects.toMatchObject({
      code: 'WEBHOOK_URL_NOT_ALLOWED',
    });
    await expect(assertSafeUrl('https://mixed.example/x', async () => ['8.8.8.8', '127.0.0.1'])).rejects.toMatchObject({
      code: 'WEBHOOK_URL_NOT_ALLOWED',
    });
    await expect(assertSafeUrl('https://fine.example/x', publicDns)).resolves.toBeUndefined();
  });

  it('shows the secret once, seals it, and needs settings.update', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const created = await owner.post('/settings/webhooks', { url: URL_OK, eventTypes: ['sale.*'] });
    expect(created.status).toBe(201);
    expect(created.data.secret).toMatch(/^whsec_/);

    const [row] = await f.run(() => tx().select().from(schema.webhookSubscriptions));
    expect(row.secret).not.toContain(created.data.secret);
    expect(unseal(row.secret)).toBe(created.data.secret);

    const list = await owner.get('/settings/webhooks');
    expect(list.data[0].secret).toBeUndefined();
    expect((await (await f.as('director')).post('/settings/webhooks', { url: URL_OK, eventTypes: ['*'] })).status).toBe(403);
  });

  it('delivers matching new events once, signed, and skips history', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await journalEvent(f, 'sale.created', { number: 'old' });
    const sub = await owner.post('/settings/webhooks', { url: URL_OK, eventTypes: ['sale.*', 'animal.lambed'] });

    await journalEvent(f, 'sale.created', { number: 'new' });
    await journalEvent(f, 'animal.vaccinated');
    await journalEvent(f, 'animal.lambed');

    expect(await f.run(() => collectEvents())).toBe(2);
    expect(await f.run(() => collectEvents())).toBe(0);

    const fetchImpl = ok();
    const tally = await f.run(() => deliverDue({ fetchImpl, resolve: publicDns }));
    expect(tally).toEqual({ delivered: 2, failed: 0, retried: 0 });

    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe(URL_OK);
    expect(init.redirect).toBe('manual');
    const body = init.body as string;
    expect(JSON.parse(body).data).toEqual({ number: 'new' });

    const [, t, v1] = init.headers['x-yap-signature'].match(/^t=(\d+),v1=([0-9a-f]+)$/);
    expect(v1).toBe(createHmac('sha256', sub.data.secret).update(`${t}.${body}`).digest('hex'));

    expect((await f.run(() => deliverDue({ fetchImpl, resolve: publicDns }))).delivered).toBe(0);
  });

  it('leaves an event that may still be committing for the next run', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await owner.post('/settings/webhooks', { url: URL_OK, eventTypes: ['*'] });
    await f.run(() =>
      tx().insert(schema.events).values({ tenantId: f.tenantId, farmId: f.farmId, type: 'sale.created' }),
    );
    expect(await f.run(() => collectEvents())).toBe(0);
  });

  it('retries on the schedule, then gives up and keeps the error', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const sub = await owner.post('/settings/webhooks', { url: URL_OK, eventTypes: ['*'] });
    await journalEvent(f, 'alert.raised');
    await f.run(() => collectEvents());

    const failing = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    let now = new Date();
    const expected = RETRY_MINUTES;
    for (let attempt = 1; attempt <= expected.length; attempt++) {
      const tally = await f.run(() => deliverDue({ fetchImpl: failing, resolve: publicDns, now }));
      expect(tally).toEqual({ delivered: 0, failed: 0, retried: 1 });
      const [row] = await f.run(() => tx().select().from(schema.webhookDeliveries));
      expect(row.attempts).toBe(attempt);
      expect(row.lastStatusCode).toBe(500);
      expect(row.nextAttemptAt.getTime() - now.getTime()).toBe(expected[attempt - 1] * 60_000);

      // Not due a moment later.
      expect((await f.run(() => deliverDue({ fetchImpl: failing, resolve: publicDns, now: new Date(now.getTime() + 1000) }))).retried).toBe(0);
      now = row.nextAttemptAt;
    }

    expect(await f.run(() => deliverDue({ fetchImpl: failing, resolve: publicDns, now }))).toEqual({ delivered: 0, failed: 1, retried: 0 });
    const log = await owner.get(`/settings/webhooks/${sub.data.id}/deliveries`, { status: 'failed' });
    expect(log.body.meta.total).toBe(1);
    expect(log.data[0].lastError).toBe('HTTP 500');
    expect(log.data[0].attempts).toBe(6);

    const retried = await owner.post(`/settings/webhooks/${sub.data.id}/deliveries/${log.data[0].id}/retry`);
    expect(retried.status).toBe(200);
    const fetchImpl = ok();
    expect((await f.run(() => deliverDue({ fetchImpl, resolve: publicDns }))).delivered).toBe(1);
  });

  it('a network failure is logged and retried, a redirect is not followed', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const sub = await owner.post('/settings/webhooks', { url: URL_OK, eventTypes: ['*'] });
    await owner.post(`/settings/webhooks/${sub.data.id}/test`);

    const down = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect((await f.run(() => deliverDue({ fetchImpl: down, resolve: publicDns }))).retried).toBe(1);
    const log = await owner.get(`/settings/webhooks/${sub.data.id}/deliveries`);
    expect(log.data[0].lastError).toContain('ECONNREFUSED');
    expect(log.data[0].eventType).toBe('webhook.test');

    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } })) as unknown as typeof fetch;
    const later = new Date(Date.now() + 2 * 60_000);
    expect((await f.run(() => deliverDue({ fetchImpl: redirect, resolve: publicDns, now: later }))).retried).toBe(1);
    const [row] = await f.run(() => tx().select().from(schema.webhookDeliveries));
    expect(row.lastError).toBe('HTTP 302');
  });

  it('does not send to an address that later resolves inside', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const sub = await owner.post('/settings/webhooks', { url: URL_OK, eventTypes: ['*'] });
    await owner.post(`/settings/webhooks/${sub.data.id}/test`);
    await f.run(() => tx().update(schema.webhookSubscriptions).set({ url: 'https://rebound.example/x' }));
    const fetchImpl = ok();
    const tally = await f.run(() => deliverDue({ fetchImpl, resolve: async () => ['10.0.0.9'] }));
    expect(tally.retried).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('an empty edit is refused cleanly', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const sub = await owner.post('/settings/webhooks', { url: URL_OK, eventTypes: ['*'] });
    const res = await owner.patch(`/settings/webhooks/${sub.data.id}`, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOTHING_TO_UPDATE');
  });

  it('an inactive subscription sends nothing, and tenants stay separate', async () => {
    const f = await createFixture();
    const g = await createFixture();
    const owner = await f.as('owner');
    const sub = await owner.post('/settings/webhooks', { url: URL_OK, eventTypes: ['*'] });
    await owner.patch(`/settings/webhooks/${sub.data.id}`, { active: false });
    await journalEvent(f, 'sale.created');
    expect(await f.run(() => collectEvents())).toBe(0);

    const stranger = await g.as('owner');
    expect((await stranger.patch(`/settings/webhooks/${sub.data.id}`, { active: true })).status).toBe(404);
    expect((await stranger.get(`/settings/webhooks/${sub.data.id}/deliveries`)).body.meta.total).toBe(0);
    expect((await stranger.delete(`/settings/webhooks/${sub.data.id}`)).status).toBe(404);
  });
});

describe('data export', () => {
  async function exportFixture() {
    const f = await createFixture();
    const g = await createFixture();
    const owner = await f.as('owner');
    await owner.post('/finance/counterparties', { name: 'Bizniki', type: 'buyer' });
    await (await g.as('owner')).post('/finance/counterparties', { name: 'Begona', type: 'buyer' });
    await owner.post('/settings/api-keys', { name: 'Eksport kaliti', scopes: ['*'] });
    return { f, owner };
  }

  async function raw(owner: { userId: string; membershipId: string }, f: Fixture, url: string) {
    const token = await signAccessToken({ userId: owner.userId, membershipId: owner.membershipId, tenantId: f.tenantId, farmId: f.farmId });
    return request(token, 'GET', url);
  }

  it('produces one valid JSON document with this tenant only and no secrets', async () => {
    const { f, owner } = await exportFixture();
    const res = await raw(owner, f, '/settings/export');
    expect(res.status).toBe(200);
    const doc = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    expect(Object.keys(doc).sort()).toEqual(['exportedAt', 'tables', 'tenant', 'users']);
    expect(doc.tenant.id).toBe(f.tenantId);
    expect(doc.tables.counterparties.map((c: any) => c.name)).toEqual(['Bizniki']);
    // Table rows only: the composite-FK indexes and constraints stay out of the document.
    expect(res.raw).not.toMatch(/"(tid|tfk)_[0-9a-f]{24}"/);
    expect(doc.tables.species.length).toBeGreaterThan(0);
    expect(doc.tables.finance_categories.length).toBeGreaterThan(10);
    expect(doc.tables.api_keys[0].name).toBe('Eksport kaliti');
    expect(doc.tables.idempotency_keys).toBeUndefined();
    expect(doc.users.some((u: any) => u.id === owner.userId)).toBe(true);

    expect(res.raw).not.toContain('Begona');
    for (const secret of ['key_hash', 'password_hash', 'totp_secret']) expect(res.raw).not.toContain(secret);
  });

  it('needs settings.view and pii.view', async () => {
    const f = await createFixture();
    expect((await (await f.as('shepherd')).get('/settings/export')).status).toBe(403);
    expect((await (await f.as('auditor')).get('/settings/export')).status).toBe(403);
    const noPii = await memberWith(f, ['settings.view']);
    const res = await noPii.get('/settings/export');
    expect(res.status).toBe(403);
    expect((await noPii.get('/settings/export/counterparties')).status).toBe(403);
    expect((await (await f.as('director')).get('/settings/export')).status).toBe(200);
  });

  it('limits the export to the active farm', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await owner.post('/finance/counterparties', { name: 'Birinchi ferma', type: 'buyer' });
    const secondFarmId = await withPlatform(async (trx) => {
      const [farm] = await trx.insert(schema.farms).values({ tenantId: f.tenantId, name: 'Ikkinchi' }).returning();
      return farm.id;
    });
    const added = await addMember({ tenantId: f.tenantId, farmId: secondFarmId, roleId: f.roleIds.owner, phone: phone(), fullName: 'Ikkinchi Ega', password: 'x' });
    const token = await signAccessToken({ userId: added.userId, membershipId: added.membershipId, tenantId: f.tenantId, farmId: secondFarmId });
    const res = await request(token, 'GET', '/settings/export');
    expect(res.raw).not.toContain('Birinchi ferma');
  });

  it('exports one table as CSV, escaped and safe to open in Excel', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await owner.post('/finance/counterparties', { name: 'Vergul, "qo\'shtirnoq"', type: 'buyer', notes: '=HYPERLINK("http://evil")' });
    const res = await raw(owner, f, '/settings/export/counterparties');
    expect(res.status).toBe(200);
    expect(res.raw.startsWith('﻿')).toBe(true);
    expect(res.raw).toContain('"Vergul, ""qo\'shtirnoq"""');
    expect(res.raw).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(res.raw.split('\r\n')[0]).toContain('name');
  });

  it('refuses a table outside the export list', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    for (const table of ['users', 'refresh_tokens', 'idempotency_keys', 'no_such_table']) {
      expect((await raw(owner, f, `/settings/export/${table}`)).status).toBe(404);
    }
  });

  it('leaves a trace in the journal', async () => {
    const { f, owner } = await exportFixture();
    await raw(owner, f, '/settings/export');
    await raw(owner, f, '/settings/export/counterparties');
    const rows = await f.run(() => tx().select().from(schema.events).where(sql`type = 'settings.exported'`));
    expect(rows.map((e) => e.data.scope).sort()).toEqual(['all', 'counterparties']);
    expect(rows.every((e) => e.createdBy === owner.userId && e.severity === 'attention')).toBe(true);
  });

  it('gives an overview with row counts', async () => {
    const { f, owner } = await exportFixture();
    const res = await owner.get('/settings/export/overview');
    expect(res.status).toBe(200);
    expect(res.data.find((t: any) => t.name === 'counterparties').rows).toBe(1);
    expect(res.data.some((t: any) => t.name === 'webhook_deliveries')).toBe(false);
    expect(f.tenantId).toBeTruthy();
  });
});

describe('platform administration', () => {
  async function admin() {
    const p = phone();
    const [user] = await db
      .insert(schema.users)
      .values({ phone: p, fullName: 'Platform Admin', passwordHash: 'x', isPlatformAdmin: true })
      .returning();
    const token = await signAccessToken({ userId: user.id, membershipId: null, tenantId: null, farmId: null });
    return {
      get: (url: string) => request(token, 'GET', url),
      post: (url: string, body: unknown = {}) => request(token, 'POST', url, body),
      patch: (url: string, body: unknown) => request(token, 'PATCH', url, body),
      delete: (url: string) => request(token, 'DELETE', url),
    };
  }

  it('refuses everyone who is not a platform admin', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    expect((await owner.get('/platform/tenants')).status).toBe(403);
    expect((await owner.post('/platform/plans', { key: 'x', name: 'Xx', modules: [] })).status).toBe(403);
    const app = await getApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/platform/tenants' })).statusCode).toBe(401);
  });

  it('a platform admin signs in with no tenant and lists tenants', async () => {
    const pa = await admin();
    const f = await createFixture();
    const list = await pa.get(`/platform/tenants?search=${encodeURIComponent('Test')}&pageSize=200`);
    expect(list.status).toBe(200);
    const row = list.body.data.find((t: any) => t.id === f.tenantId);
    expect(row.status).toBe('active');
    expect(row.farmCount).toBe(1);
    expect(row.memberCount).toBe(0);
    expect(list.body.meta.total).toBeGreaterThan(0);
  });

  it('creates a tenant from a plan, with a working owner login', async () => {
    const pa = await admin();
    const key = `plan_${randomBytes(3).toString('hex')}`;
    const plan = await pa.post('/platform/plans', { key, name: 'Boshlang\'ich', modules: ['livestock', 'feed'], priceMonthly: 500_000 });
    expect(plan.status).toBe(201);

    const p = phone();
    const created = await pa.post('/platform/tenants', {
      tenant: { name: 'Yangi Ferma', planId: plan.data.id },
      farm: { name: 'Bosh ferma', totalAreaHa: 50 },
      owner: { phone: p, fullName: 'Ferma Egasi' },
    });
    expect(created.status).toBe(201);
    expect(created.data.tenant.modules).toEqual(['livestock', 'feed']);
    expect(created.data.tenant.planName).toBe('Boshlang\'ich');
    expect(created.data.existingUser).toBe(false);

    const login = await loginWith(p, created.data.oneTimePassword);
    expect(login.status).toBe(200);
    const { session, accessToken } = login.body.data;
    expect(session.role.key).toBe('owner');
    expect(session.tenant.name).toBe('Yangi Ferma');

    // Security policy defaults stay on for a real tenant, so the owner must enrol.
    expect(session.mustEnroll2fa).toBe(true);
    const gated = await request(accessToken, 'GET', '/settings/profile');
    expect(gated.body.error.code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED');
  });

  it('an existing person becomes owner without a new password', async () => {
    const pa = await admin();
    const f = await createFixture();
    const p = phone();
    await addMember({ tenantId: f.tenantId, farmId: f.farmId, roleId: f.roleIds.shepherd, phone: p, fullName: 'Bor Odam', password: 'Password123!' });
    const created = await pa.post('/platform/tenants', {
      tenant: { name: 'Ikkinchi Tenant' },
      farm: { name: 'Ferma' },
      owner: { phone: p, fullName: 'Bor Odam' },
    });
    expect(created.data.existingUser).toBe(true);
    expect(created.data.oneTimePassword).toBeNull();
    expect((await loginWith(p, 'Password123!')).status).toBe(200);
  });

  it('refuses an unknown plan and an invalid module', async () => {
    const pa = await admin();
    const base = { farm: { name: 'Ferma' }, owner: { phone: phone(), fullName: 'Ab Cd' } };
    expect((await pa.post('/platform/tenants', { ...base, tenant: { name: 'Xx', planId: uuidv7() } })).status).toBe(404);
    expect((await pa.post('/platform/tenants', { ...base, tenant: { name: 'Xx', modules: ['nope'] } })).status).toBe(400);
  });

  it('suspending refuses members at once and reactivating restores them', async () => {
    const pa = await admin();
    const f = await createFixture();
    const owner = await f.as('owner');
    expect((await owner.get('/finance/counterparties')).status).toBe(200);

    expect((await pa.post(`/platform/tenants/${f.tenantId}/suspend`)).data.status).toBe('suspended');
    const refused = await owner.get('/finance/counterparties');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('TENANT_SUSPENDED');

    const again = await pa.post(`/platform/tenants/${f.tenantId}/suspend`);
    expect(again.status).toBe(409);

    await pa.post(`/platform/tenants/${f.tenantId}/reactivate`);
    expect((await owner.get('/finance/counterparties')).status).toBe(200);
  });

  it('switching a module off stops it for that tenant', async () => {
    const pa = await admin();
    const f = await createFixture();
    const owner = await f.as('owner');
    await pa.patch(`/platform/tenants/${f.tenantId}`, { modules: ['livestock'] });
    const res = await owner.get('/finance/counterparties');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MODULE_DISABLED');
  });

  it('an empty edit is safe', async () => {
    const pa = await admin();
    const f = await createFixture();
    expect((await pa.patch(`/platform/tenants/${f.tenantId}`, {})).status).toBe(200);
    const key = `plan_${randomBytes(3).toString('hex')}`;
    const plan = await pa.post('/platform/plans', { key, name: 'Bo\'sh', modules: [] });
    expect((await pa.patch(`/platform/plans/${plan.data.id}`, {})).status).toBe(400);
  });

  it('plans are retired, not deleted', async () => {
    const pa = await admin();
    const key = `plan_${randomBytes(3).toString('hex')}`;
    const plan = await pa.post('/platform/plans', { key, name: 'Eski', modules: [] });
    const retired = await pa.delete(`/platform/plans/${plan.data.id}`);
    expect(retired.data.active).toBe(false);
    expect((await pa.get('/platform/plans')).data.some((p: any) => p.id === plan.data.id)).toBe(true);
    expect((await pa.post('/platform/plans', { key, name: 'Dublikat', modules: [] })).status).toBe(409);
  });

  it('a platform session cannot read business data at all', async () => {
    const f = await createFixture();
    await f.run(async () => {
      const [sheep] = await tx().select().from(schema.species).where(sql`key = 'sheep'`);
      await tx().insert(schema.animals).values({ tenantId: f.tenantId, farmId: f.farmId, tag: 'YA-1', speciesId: sheep.id, sex: 'female', category: 'ewe', origin: 'purchased', purchasePrice: 4_200_000 });
      const [account] = await tx().insert(schema.accounts).values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Kassa', type: 'cash' }).returning();
      const [category] = await tx().select().from(schema.financeCategories).where(sql`key = 'feed'`);
      await postTransaction({ date: '2026-11-01', type: 'expense', amount: 1000, paymentMethod: 'cash', accountId: account.id, categoryId: category.id, costCenterId: await generalCostCenterId() });
    });

    const seen = await withPlatform(async (trx) => ({
      animals: await trx.select().from(schema.animals),
      transactions: await trx.select().from(schema.transactions),
      accounts: await trx.select().from(schema.accounts),
      counterparties: await trx.select().from(schema.counterparties),
      events: await trx.select().from(schema.events),
      audit: await trx.select().from(schema.auditLogs),
    }));
    expect(seen).toEqual({ animals: [], transactions: [], accounts: [], counterparties: [], events: [], audit: [] });

    // Writing into a tenant's business tables is refused too.
    await expect(
      withPlatform((trx) => trx.insert(schema.counterparties).values({ tenantId: f.tenantId, farmId: f.farmId, name: 'X', type: 'other' })),
    ).rejects.toThrow();

    const pa = await admin();
    const detail = await pa.get(`/platform/tenants/${f.tenantId}`);
    expect(detail.status).toBe(200);
    expect(Object.keys(detail.data).sort()).toEqual(
      ['createdAt', 'farmCount', 'id', 'legalName', 'memberCount', 'modules', 'name', 'planId', 'planName', 'status', 'tin'].sort(),
    );

    // A platform token has no tenant, so tenant routes refuse it.
    const denied = await pa.get('/livestock/none');
    expect([403, 404]).toContain(denied.status);
    const finance = await pa.get('/finance/counterparties');
    expect(finance.status).toBe(403);
    expect(finance.body.error.code).toBe('NO_ACTIVE_FARM');
  });

  it('reports totals without any business figures', async () => {
    const pa = await admin();
    const res = await pa.get('/platform/stats');
    expect(res.status).toBe(200);
    expect(Object.keys(res.data).sort()).toEqual(['activeTenants', 'farms', 'members', 'tenants']);
  });
});
