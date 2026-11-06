import { describe, expect, it, vi } from 'vitest';
import { addMember } from '../src/core/tenancy';
import { MAX_FAILURES } from '../src/modules/auth/lockout.service';
import { createFixture, getApp, type Fixture } from './helpers';

// Limits are off under test, because every other test comes from one address. Here they are the subject.
vi.mock('../src/config', async (original) => ({ ...(await original<typeof import('../src/config')>()), isTest: false }));
vi.mock('../src/app', async (original) => {
  const app = await original<typeof import('../src/app')>();
  return { ...app, buildApp: () => app.buildApp({ write: () => {} }) };
});

const PASSWORD = 'Password123!';
const WRONG = 'wrong-password';

async function post(url: string, payload: object, address: string, headers: Record<string, string> = {}) {
  const app = await getApp();
  const res = await app.inject({ method: 'POST', url: `/api/v1/auth${url}`, payload, headers: { 'x-forwarded-for': address, ...headers } });
  return { status: res.statusCode, body: res.json() };
}

const signIn = (phone: string, password: string, address: string) => post('/login', { phone, password }, address);

const newPhone = () => `+998${Math.floor(100_000_000 + Math.random() * 899_999_999)}`;

async function people(f: Fixture, count: number): Promise<string[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const phone = newPhone();
      await addMember({ tenantId: f.tenantId, farmId: f.farmId, roleId: f.roleIds.shepherd, phone, fullName: `Person ${i}`, password: PASSWORD });
      return phone;
    }),
  );
}

describe('signing in from one address', () => {
  it('fifteen people on one wifi all get in with the right password', async () => {
    const room = await people(await createFixture(), 15);

    const answers = [];
    for (const phone of room) answers.push((await signIn(phone, PASSWORD, '203.0.113.10')).status);

    expect(answers).toEqual(Array(15).fill(200));
  });

  it('the person who mistypes spends only their own tries, and the lock is reached on a shared address', async () => {
    const [guessed, ...room] = await people(await createFixture(), 13);
    const address = '203.0.113.11';
    for (const phone of room) expect((await signIn(phone, PASSWORD, address)).status).toBe(200);

    for (let i = 1; i < MAX_FAILURES; i++) expect((await signIn(guessed, WRONG, address)).status).toBe(401);
    const tenth = await signIn(guessed, WRONG, address);

    expect(tenth.status).toBe(423);
    expect(tenth.body.error.code).toBe('ACCOUNT_LOCKED');
    expect((await signIn(guessed, PASSWORD, address)).status).toBe(423);
    expect((await signIn(room[0], PASSWORD, address)).status).toBe(200);
  });

  it('hammering one phone stops at 20 tries, however the number is spelled', async () => {
    const [phone] = await people(await createFixture(), 1);
    const address = '203.0.113.12';
    const spellings = [phone, phone.slice(1), phone.slice(4), `${phone.slice(0, 4)} ${phone.slice(4, 6)} ${phone.slice(6)}`];

    const answers = [];
    for (let i = 0; i < 21; i++) answers.push((await signIn(spellings[i % 4], WRONG, address)).status);

    // 9 wrong, the 10th starts the lock, 10 more are told about it, and try 21 is over the limit.
    expect(answers).toEqual([...Array(9).fill(401), ...Array(11).fill(423), 429]);
    expect((await signIn(phone, PASSWORD, '203.0.113.13')).status).toBe(200);
  });

  it('trying many phones from one address is limited after 100, for that address only', async () => {
    const f = await createFixture();
    const [victim] = await people(f, 1);
    const address = '203.0.113.14';

    const answers = [];
    for (let i = 0; i < 100; i++) answers.push((await signIn(`+99899${String(i).padStart(7, '0')}`, WRONG, address)).status);
    const over = await signIn('+998991000000', WRONG, address);

    expect(answers).toEqual(Array(100).fill(401));
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('RATE_LIMITED');
    expect((await signIn(victim, PASSWORD, address)).status).toBe(429);
    expect((await signIn(victim, PASSWORD, '203.0.113.15')).status).toBe(200);
  });

  it('a body that fails validation still counts against the address', async () => {
    const address = '203.0.113.16';
    const answers = [];
    for (let i = 0; i < 101; i++) answers.push((await post('/login', { phone: '1' }, address)).status);
    expect(answers).toEqual([...Array(100).fill(400), 429]);
  });

  it('the second step takes a crowd too', async () => {
    const address = '203.0.113.17';
    const answers = [];
    for (let i = 0; i < 11; i++) answers.push((await post('/2fa/verify', { challengeToken: 'not-a-token', code: '123456' }, address)).status);
    expect(answers).toEqual(Array(11).fill(401));
  });

  it('eleven first-day passwords change from one address, and one person is still held to ten tries', async () => {
    const room = await people(await createFixture(), 12);
    const address = '203.0.113.18';
    const tokens = [];
    for (const phone of room) tokens.push((await signIn(phone, PASSWORD, address)).body.data.accessToken as string);
    const change = (token: string, currentPassword: string) =>
      post('/change-password', { currentPassword, newPassword: 'tuyaqush-Xolmon-44' }, address, { authorization: `Bearer ${token}` });

    const answers = [];
    for (const token of tokens.slice(1)) answers.push((await change(token, PASSWORD)).status);
    expect(answers).toEqual(Array(11).fill(200));

    const guesses = [];
    for (let i = 0; i < 11; i++) guesses.push((await change(tokens[0], WRONG)).status);
    expect(guesses).toEqual([...Array(9).fill(400), 423, 429]);
  });
});

describe('the limit on test alerts', () => {
  it('counts only what was sent, so refused calls cost the director nothing', async () => {
    const f = await createFixture();
    const [shepherd, investor, director, owner] = await Promise.all([f.as('shepherd'), f.as('investor'), f.as('director'), f.as('owner')]);

    for (let i = 0; i < 6; i++) expect((await shepherd.post('/alerts/test')).status).toBe(403);
    for (let i = 0; i < 6; i++) expect((await investor.post('/alerts/test')).status).toBe(403);

    const sent = [];
    for (let i = 0; i < 6; i++) sent.push((await director.post('/alerts/test')).status);
    expect(sent).toEqual([200, 200, 200, 200, 200, 429]);

    const again = await owner.post('/alerts/test');
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('RATE_LIMITED');
  });

  it('one farm does not use up another farm\'s allowance', async () => {
    const [one, other] = await Promise.all([createFixture(), createFixture()]);
    const director = await one.as('director');
    for (let i = 0; i < 6; i++) await director.post('/alerts/test');

    expect((await (await other.as('director')).post('/alerts/test')).status).toBe(200);
  });
});
