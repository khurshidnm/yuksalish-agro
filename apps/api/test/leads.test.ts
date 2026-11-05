import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../src/core/tokens';
import { db, schema } from '../src/db/client';
import { createFixture, getApp } from './helpers';

const uniquePhone = () => `+99890${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

const form = (overrides: Record<string, unknown> = {}) => ({
  fullName: 'Karim Aliyev',
  phone: uniquePhone(),
  farmName: 'Oltin Vodiy',
  region: 'Qashqadaryo',
  farmType: 'livestock',
  farmSize: '300 ha, 800 qo\'y',
  message: 'Demo ko\'rmoqchiman',
  language: 'uz',
  source: '/',
  consent: true,
  elapsedMs: 12_000,
  ...overrides,
});

async function send(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, token?: string) {
  const app = await getApp();
  const response = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = response.body ? response.json() : null;
  return { status: response.statusCode, body: json, data: json?.data };
}

async function adminToken() {
  const [user] = await db
    .insert(schema.users)
    .values({ phone: uniquePhone(), fullName: 'Platform Admin', passwordHash: 'x', isPlatformAdmin: true })
    .returning();
  return { id: user.id, token: await signAccessToken({ userId: user.id, membershipId: null, tenantId: null, farmId: null }) };
}

const rowsFor = (phone: string) => db.select().from(schema.leads).where(eq(schema.leads.phone, phone));

describe('contact form', () => {
  it('saves an enquiry without signing in, and tells the visitor nothing else', async () => {
    const full = uniquePhone();
    const typed = `${full.slice(4, 6)} ${full.slice(6, 9)} ${full.slice(9, 11)} ${full.slice(11)}`;

    const sent = await send('POST', '/leads', form({ phone: typed }));

    expect(sent.status).toBe(201);
    expect(sent.data).toEqual({ received: true });
    const [lead] = await rowsFor(full);
    expect(lead).toMatchObject({ fullName: 'Karim Aliyev', status: 'new', farmType: 'livestock', submissions: 1 });
    expect(lead.consentAt).toBeInstanceOf(Date);
    expect(lead.contactedAt).toBeNull();
  });

  it('needs consent, a name and a real phone number', async () => {
    expect((await send('POST', '/leads', form({ consent: false }))).status).toBe(400);
    expect((await send('POST', '/leads', form({ fullName: 'A' }))).status).toBe(400);
    const badPhone = await send('POST', '/leads', form({ phone: 'abc-def-ghij' }));
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.error.code).toBe('INVALID_PHONE');
  });

  it('answers a bot like a person but keeps nothing', async () => {
    const filledTrap = form({ website: 'https://spam.example' });
    const tooFast = form({ elapsedMs: 200 });

    expect((await send('POST', '/leads', filledTrap)).data).toEqual({ received: true });
    expect((await send('POST', '/leads', tooFast)).data).toEqual({ received: true });

    expect(await rowsFor(filledTrap.phone as string)).toHaveLength(0);
    expect(await rowsFor(tooFast.phone as string)).toHaveLength(0);
  });

  it('joins a repeat enquiry to the open lead', async () => {
    const phone = uniquePhone();
    await send('POST', '/leads', form({ phone, message: 'Birinchi' }));
    await send('POST', '/leads', form({ phone, message: 'Ikkinchi' }));

    const rows = await rowsFor(phone);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ submissions: 2, message: 'Ikkinchi' });
  });

  it('opens a new lead when the earlier one is closed', async () => {
    const { token } = await adminToken();
    const phone = uniquePhone();
    await send('POST', '/leads', form({ phone }));
    const [first] = await rowsFor(phone);
    await send('PATCH', `/leads/${first.id}`, { status: 'lost' }, token);

    await send('POST', '/leads', form({ phone }));

    expect(await rowsFor(phone)).toHaveLength(2);
  });

  it('keeps leads away from the assistant at the database', async () => {
    const result = await db.execute(sql`select has_table_privilege('yap_ai', 'leads', 'select') as allowed`);
    expect(result.rows[0].allowed).toBe(false);
  });
});

describe('managing leads', () => {
  it('is for platform administrators only', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');

    expect((await send('GET', '/leads')).status).toBe(401);
    expect((await owner.get('/leads')).status).toBe(403);
    expect((await owner.get('/leads/stats')).status).toBe(403);
    expect((await owner.patch(`/leads/${randomUUID()}`, { status: 'won' })).status).toBe(403);
  });

  it('finds leads by phone and by status', async () => {
    const { token } = await adminToken();
    const phone = uniquePhone();
    await send('POST', '/leads', form({ phone, fullName: 'Topiladigan Odam' }));

    const found = await send('GET', `/leads?search=${encodeURIComponent(phone.slice(1))}`, undefined, token);
    expect(found.data).toHaveLength(1);
    expect(found.data[0].fullName).toBe('Topiladigan Odam');
    expect(found.body.meta.total).toBe(1);

    const closed = await send('GET', `/leads?search=${encodeURIComponent(phone.slice(1))}&status=won`, undefined, token);
    expect(closed.data).toHaveLength(0);
  });

  it('counts every status, including the empty ones', async () => {
    const { token } = await adminToken();
    const before = (await send('GET', '/leads/stats', undefined, token)).data;
    await send('POST', '/leads', form());

    const after = (await send('GET', '/leads/stats', undefined, token)).data;

    expect(after.new).toBe(before.new + 1);
    expect(after.total).toBe(before.total + 1);
    expect(Object.keys(after).sort()).toEqual(['contacted', 'lost', 'new', 'qualified', 'total', 'won']);
  });

  it('stamps first contact once, and keeps notes', async () => {
    const { token } = await adminToken();
    const phone = uniquePhone();
    await send('POST', '/leads', form({ phone }));
    const [lead] = await rowsFor(phone);

    const noted = await send('PATCH', `/leads/${lead.id}`, { notes: 'Ertaga qo\'ng\'iroq' }, token);
    expect(noted.data.contactedAt).toBeNull();

    const contacted = await send('PATCH', `/leads/${lead.id}`, { status: 'contacted' }, token);
    expect(contacted.data.status).toBe('contacted');
    expect(contacted.data.notes).toBe('Ertaga qo\'ng\'iroq');
    const firstStamp = contacted.data.contactedAt;
    expect(firstStamp).not.toBeNull();

    const later = await send('PATCH', `/leads/${lead.id}`, { status: 'qualified' }, token);
    expect(later.data.contactedAt).toBe(firstStamp);
  });

  it('removes a lead for good, for administrators only', async () => {
    const { token } = await adminToken();
    const f = await createFixture();
    const owner = await f.as('owner');
    const phone = uniquePhone();
    await send('POST', '/leads', form({ phone }));
    const [lead] = await rowsFor(phone);

    expect((await owner.delete(`/leads/${lead.id}`)).status).toBe(403);
    expect(await rowsFor(phone)).toHaveLength(1);

    expect((await send('DELETE', `/leads/${lead.id}`, undefined, token)).status).toBe(200);
    expect(await rowsFor(phone)).toHaveLength(0);
    expect((await send('DELETE', `/leads/${lead.id}`, undefined, token)).status).toBe(404);
  });

  it('refuses an unknown lead and an unknown status', async () => {
    const { token } = await adminToken();
    expect((await send('PATCH', `/leads/${randomUUID()}`, { status: 'won' }, token)).status).toBe(404);
    expect((await send('GET', '/leads?status=maybe', undefined, token)).status).toBe(400);
  });
});

describe('managing users', () => {
  const login = (phone: string, password: string) => send('POST', '/auth/login', { phone, password });

  async function member(password = 'Boshlangich2026!') {
    const phone = uniquePhone();
    const [user] = await db
      .insert(schema.users)
      .values({ phone, fullName: 'Oddiy Xodim', passwordHash: await bcrypt.hash(password, 4) })
      .returning();
    return { user, phone, password };
  }

  it('is for platform administrators only', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    expect((await owner.get('/platform/users')).status).toBe(403);
    expect((await owner.post(`/platform/users/${owner.userId}/block`)).status).toBe(403);
    expect((await owner.post(`/platform/users/${owner.userId}/reset-password`)).status).toBe(403);
  });

  it('lists people across tenants with their workplaces, and never their secrets', async () => {
    const { token } = await adminToken();
    const f = await createFixture();
    const owner = await f.as('owner');

    const list = await send('GET', '/platform/users?pageSize=200', undefined, token);
    const row = list.data.find((user: { id: string }) => user.id === owner.userId);

    expect(row.memberships.length).toBeGreaterThan(0);
    expect(row.memberships[0]).toMatchObject({ role: 'owner', status: 'active' });
    for (const user of list.data) {
      expect(user).not.toHaveProperty('passwordHash');
      expect(user).not.toHaveProperty('totpSecret');
    }
  });

  it('blocks an account everywhere and ends its sessions', async () => {
    const { token } = await adminToken();
    const { user, phone, password } = await member();
    expect((await login(phone, password)).status).toBe(200);

    const blocked = await send('POST', `/platform/users/${user.id}/block`, {}, token);
    expect(blocked.data.status).toBe('blocked');

    const refused = await login(phone, password);
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('ACCOUNT_BLOCKED');
    const open = await db.select().from(schema.refreshTokens).where(eq(schema.refreshTokens.userId, user.id));
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((row) => row.revokedAt !== null)).toBe(true);

    expect((await send('POST', `/platform/users/${user.id}/block`, {}, token)).body.error.code).toBe('USER_STATUS_UNCHANGED');

    await send('POST', `/platform/users/${user.id}/unblock`, {}, token);
    expect((await login(phone, password)).status).toBe(200);
  });

  it('replaces a password with a one-time one', async () => {
    const { token } = await adminToken();
    const { user, phone, password } = await member();

    const reset = await send('POST', `/platform/users/${user.id}/reset-password`, {}, token);

    expect(reset.data.oneTimePassword.length).toBeGreaterThan(8);
    expect((await login(phone, password)).status).toBe(401);
    expect((await login(phone, reset.data.oneTimePassword)).status).toBe(200);
  });

  it('will not let an administrator lock themselves out', async () => {
    const { id, token } = await adminToken();
    expect((await send('POST', `/platform/users/${id}/block`, {}, token)).body.error.code).toBe('CANNOT_BLOCK_SELF');
    expect((await send('POST', `/platform/users/${id}/reset-password`, {}, token)).body.error.code).toBe('CANNOT_RESET_SELF');
  });

  it('refuses an unknown user', async () => {
    const { token } = await adminToken();
    expect((await send('POST', `/platform/users/${randomUUID()}/block`, {}, token)).status).toBe(404);
    expect((await send('POST', `/platform/users/${randomUUID()}/reset-password`, {}, token)).status).toBe(404);
  });
});
