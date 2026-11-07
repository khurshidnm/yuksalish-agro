import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, DEFAULT_ROLE_PERMISSIONS, monthOf, ROLE_KEYS, todayIso, type RoleKey } from '@yap/shared';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { ensureCostCenter, generalCostCenterId } from '../src/core/costCenters';
import { approveTransaction } from '../src/core/ledger';
import { addMember } from '../src/core/tenancy';
import { signAccessToken } from '../src/core/tokens';
import * as payroll from '../src/modules/hr/payroll.service';
import { attendanceToday, reminders } from '../src/modules/hr/summary';
import { seedHr, seedPayroll } from '../src/seed/hr';
import { SEED } from '../src/seed/names';
import { createFixture, getApp, type Client, type Fixture } from './helpers';

const { accounts, animals, dailyLogs, fieldOperations, fields, healthRecords, herds, lambingRecords, roles, species, transactions } =
  schema;

/** September 2026: 30 days, Sundays on the 6th, 13th, 20th and 27th, so 26 working days. */
const MONTH = '2026-09';
const FROM = '2026-09-01';
const TO = '2026-09-30';

const employeeBody = (over: object = {}) => ({
  fullName: 'Alisher Navro',
  position: 'Mexanizator',
  hireDate: '2026-01-01',
  payType: 'monthly',
  baseRate: 5_200_000,
  ...over,
});

async function hire(owner: Client, over: object = {}) {
  const res = await owner.post('/hr/employees', employeeBody(over));
  expect(res.status).toBe(201);
  return res.data as { id: string };
}

/** Everyone present every working day of the month. */
async function fillMonth(owner: Client, employeeIds: string[]) {
  const res = await owner.post('/hr/timesheets/bulk', {
    from: FROM,
    to: TO,
    employeeIds,
    status: 'present',
    sundaysOff: true,
  });
  expect(res.status).toBe(200);
  return res.data.written as number;
}

const line = (run: any, employeeId: string) => run.lines.find((l: any) => l.employeeId === employeeId);

async function makeField(f: Fixture, number: string) {
  return f.run(async () => {
    const [field] = await tx()
      .insert(fields)
      .values({ tenantId: f.tenantId, farmId: f.farmId, number, areaHa: 10 })
      .returning();
    const costCenterId = await ensureCostCenter('field', field.id, `Dala ${number}`);
    return { fieldId: field.id, costCenterId };
  });
}

async function makeHerd(f: Fixture, name: string) {
  return f.run(async () => {
    const [herd] = await tx().insert(herds).values({ tenantId: f.tenantId, farmId: f.farmId, name }).returning();
    const costCenterId = await ensureCostCenter('herd', herd.id, name);
    return { herdId: herd.id, costCenterId };
  });
}

const fieldWork = (f: Fixture, i: { employeeId: string; fieldId: string; date: string; ha: number; type?: string; details?: Record<string, unknown>; status?: string }) =>
  f.run(() =>
    tx()
      .insert(fieldOperations)
      .values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        type: i.type ?? 'tillage',
        date: i.date,
        fieldId: i.fieldId,
        employeeId: i.employeeId,
        areaDoneHa: i.ha,
        details: i.details ?? {},
        status: i.status ?? 'done',
      }),
  );

async function makeCashAccount(f: Fixture) {
  return f.run(async () => {
    const [account] = await tx()
      .insert(accounts)
      .values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Kassa', type: 'cash', openingBalance: 100_000_000 })
      .returning();
    return account.id;
  });
}

async function createRun(client: Client, month = MONTH) {
  const res = await client.post('/hr/payroll', { month });
  expect(res.status).toBe(201);
  return res.data;
}

const payrollTransactions = (f: Fixture, runId: string, sourceType = 'payroll_run') =>
  f.run(() =>
    tx()
      .select()
      .from(transactions)
      .where(and(eq(transactions.sourceType, sourceType), eq(transactions.sourceId, runId))),
  );

async function grantRole(f: Fixture, role: 'investor', permissions: string[]) {
  await f.run(() =>
    tx()
      .update(roles)
      .set({ permissions: [...DEFAULT_ROLE_PERMISSIONS[role], ...permissions] })
      .where(and(eq(roles.tenantId, f.tenantId), eq(roles.key, role))),
  );
}

describe('employees', () => {
  let f: Fixture;
  let owner: Client;
  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
  });

  it('creates, reads, edits and lists', async () => {
    const created = await hire(owner, { fullName: 'Karim Salom', phone: '+998901112233', pieceRates: { ha: 45_000 } });
    const got = await owner.get(`/hr/employees/${created.id}`);
    expect(got.data.fullName).toBe('Karim Salom');
    expect(got.data.baseRate).toBe(5_200_000);
    expect(got.data.pieceRates).toEqual({ ha: 45_000 });

    const edited = await owner.patch(`/hr/employees/${created.id}`, { position: 'Brigadir', status: 'on_leave' });
    expect(edited.data.position).toBe('Brigadir');
    expect(edited.data.status).toBe('on_leave');

    const found = await owner.get('/hr/employees', { search: 'karim' });
    expect(found.body.data.map((e: any) => e.id)).toEqual([created.id]);
    const byPhone = await owner.get('/hr/employees', { search: '1112233' });
    expect(byPhone.body.meta.total).toBe(1);
  });

  it('rejects unknown piece-rate units and invalid input', async () => {
    const res = await owner.post('/hr/employees', employeeBody({ pieceRates: { bogus: 1 } }));
    expect(res.status).toBe(400);
    const missing = await owner.post('/hr/employees', { fullName: 'X' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a partial update does not reset pay to defaults', async () => {
    const e = await hire(owner, { baseRate: 7_000_000, pieceRates: { ha: 10 } });
    const res = await owner.patch(`/hr/employees/${e.id}`, { notes: 'x' });
    expect(res.data.baseRate).toBe(7_000_000);
    expect(res.data.pieceRates).toEqual({ ha: 10 });
    expect(res.data.payType).toBe('monthly');
  });

  it('a seasonal contract needs an end date', async () => {
    const res = await owner.post('/hr/employees', employeeBody({ payType: 'seasonal' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SEASON_END_REQUIRED');

    const monthly = await hire(owner);
    const patch = await owner.patch(`/hr/employees/${monthly.id}`, { payType: 'seasonal' });
    expect(patch.body.error.code).toBe('SEASON_END_REQUIRED');
  });

  it('a login can only be linked if it belongs to this farm, and only once', async () => {
    const other = await createFixture();
    const stranger = await other.as('shepherd');
    const refused = await owner.post('/hr/employees', employeeBody({ userId: stranger.userId }));
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('USER_NOT_ON_FARM');

    const shepherd = await f.as('shepherd');
    await hire(owner, { userId: shepherd.userId });
    const twice = await owner.post('/hr/employees', employeeBody({ userId: shepherd.userId }));
    expect(twice.status).toBe(409);
  });

  it('a herd from another tenant cannot be assigned, and an empty edit is refused', async () => {
    const other = await createFixture();
    const { herdId } = await makeHerd(other, 'Foreign');
    const refused = await owner.post('/hr/employees', employeeBody({ herdId }));
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('HERD_NOT_FOUND');

    const e = await hire(owner);
    const empty = await owner.patch(`/hr/employees/${e.id}`, {});
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('NOTHING_TO_UPDATE');
  });

  it('lists divisions and farm logins for the form', async () => {
    const divisions = await owner.get('/hr/divisions');
    expect(divisions.data.map((d: any) => d.key)).toContain('livestock');
    const users = await owner.get('/hr/linkable-users');
    expect(users.data.some((u: any) => u.id === owner.userId)).toBe(true);
    expect(JSON.stringify(users.data)).not.toContain('passwordHash');
  });

  it('an employee with records cannot be deleted, one without can', async () => {
    const free = await hire(owner);
    expect((await owner.delete(`/hr/employees/${free.id}`)).status).toBe(200);

    const worked = await hire(owner);
    await owner.put(`/hr/timesheets/${worked.id}/2026-09-01`, { status: 'present' });
    const res = await owner.delete(`/hr/employees/${worked.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IN_USE');
  });

  it("does not leak into another tenant", async () => {
    const e = await hire(owner);
    const other = await createFixture();
    const stranger = await other.as('owner');
    expect((await stranger.get('/hr/employees')).body.data).toEqual([]);
    expect((await stranger.get(`/hr/employees/${e.id}`)).status).toBe(404);
    expect((await stranger.patch(`/hr/employees/${e.id}`, { notes: 'x' })).status).toBe(404);
    expect((await stranger.get('/hr/employees/lookup')).data).toEqual([]);
  });
});

describe('privacy', () => {
  let f: Fixture;
  let owner: Client;
  let employeeId: string;

  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
    const e = await hire(owner, {
      fullName: 'Sardor Yuldash',
      phone: '+998907778899',
      passport: 'AA1234567',
      baseRate: 9_000_000,
      pieceRates: { ha: 50_000 },
    });
    employeeId = e.id;
  });

  it('a shepherd cannot read salaries, payroll or the staff list (spec 24.1)', async () => {
    const shepherd = await f.as('shepherd');
    expect((await shepherd.get('/hr/employees')).status).toBe(403);
    expect((await shepherd.get(`/hr/employees/${employeeId}`)).status).toBe(403);
    expect((await shepherd.get('/hr/payroll')).status).toBe(403);
    expect((await shepherd.get('/hr/kpi-rules')).status).toBe(403);
    expect((await shepherd.get('/hr/advances')).status).toBe(403);
    expect((await shepherd.get('/hr/timesheets', { month: MONTH })).status).toBe(403);
    expect((await shepherd.get('/hr/work-done', { from: FROM, to: TO })).status).toBe(403);
  });

  it('the dropdown lookup carries no money, phone or passport', async () => {
    const shepherd = await f.as('shepherd');
    const res = await shepherd.get('/hr/employees/lookup');
    expect(res.status).toBe(200);
    expect(Object.keys(res.data[0]).sort()).toEqual(['id', 'name', 'position', 'userId']);
    expect(res.data[0].name).toBe('Sardor Yuldash');
  });

  it('an investor sees positions instead of names, and cannot open HR', async () => {
    const investor = await f.as('investor');
    expect((await investor.get('/hr/employees')).status).toBe(403);
    const lookup = await investor.get('/hr/employees/lookup');
    expect(lookup.status).toBe(200);
    expect(JSON.stringify(lookup.data)).not.toContain('Sardor');
    expect(lookup.data[0].name).toBe('Mexanizator');
    expect(lookup.data[0].userId).toBeNull();
  });

  it('without pii.view, personal data and pay are hidden even with hr.view', async () => {
    await grantRole(f, 'investor', ['hr.view']);
    const investor = await f.as('investor');
    const res = await investor.get(`/hr/employees/${employeeId}`);
    expect(res.status).toBe(200);
    expect(res.data.fullName).toBe('Sardor Yuldash');
    expect(res.data.phone).toBeNull();
    expect(res.data.passport).toBeNull();
    expect(res.data.baseRate).toBeNull();
    expect(res.data.pieceRates).toBeNull();

    const list = await investor.get('/hr/employees');
    expect(JSON.stringify(list.body.data)).not.toContain('9000000');
    expect(JSON.stringify(list.body.data)).not.toContain('AA1234567');
    // Search must not become a way to confirm a hidden phone number.
    expect((await investor.get('/hr/employees', { search: '7778899' })).body.meta.total).toBe(0);
  });

  it('with pii.view but no money permission, pay stays hidden and cannot be changed', async () => {
    await grantRole(f, 'investor', ['hr.view', 'hr.update', 'pii.view']);
    const investor = await f.as('investor');
    const res = await investor.get(`/hr/employees/${employeeId}`);
    expect(res.data.phone).toBe('+998907778899');
    expect(res.data.baseRate).toBeNull();

    const change = await investor.patch(`/hr/employees/${employeeId}`, { baseRate: 1 });
    expect(change.status).toBe(403);
    expect(change.body.error.code).toBe('RATES_NOT_ALLOWED');
    expect((await owner.get(`/hr/employees/${employeeId}`)).data.baseRate).toBe(9_000_000);
  });

  it('payroll hides names without pii.view', async () => {
    const payroll = await createFixture();
    const boss = await payroll.as('owner');
    await hire(boss, { fullName: 'Hidden Name' });
    await grantRole(payroll, 'investor', ['payroll.view']);
    const run = await createRun(boss);
    const investor = await payroll.as('investor');
    const res = await investor.get(`/hr/payroll/${run.id}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.data)).not.toContain('Hidden Name');
  });
});

describe('termination', () => {
  it('blocks the login at once, keeps the records, and spares a job elsewhere', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const worker = await f.as('shepherd');

    // The same person also works at another tenant.
    const other = await createFixture();
    const [{ phone }] = await f.run(() =>
      tx().select({ phone: schema.users.phone }).from(schema.users).where(eq(schema.users.id, worker.userId)),
    );
    const elsewhere = await addMember({
      tenantId: other.tenantId,
      farmId: other.farmId,
      roleId: other.roleIds.shepherd,
      phone,
      fullName: 'Worker',
      password: 'Password123!',
    });

    const e = await hire(owner, { userId: worker.userId, position: "Cho'pon" });
    await owner.put(`/hr/timesheets/${e.id}/2026-09-01`, { status: 'present' });
    expect((await worker.get('/hr/employees/lookup')).status).toBe(200);

    const res = await owner.post(`/hr/employees/${e.id}/terminate`, { date: '2026-10-31', reason: "O'z xohishi bilan" });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('terminated');
    expect(res.data.terminationDate).toBe('2026-10-31');

    // The token is still valid, but the account no longer works.
    const denied = await worker.get('/hr/employees/lookup');
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe('ACCOUNT_BLOCKED');

    // Refresh tokens are gone too.
    const refreshRows = await f.run(() =>
      tx().select().from(schema.refreshTokens).where(eq(schema.refreshTokens.userId, worker.userId)),
    );
    expect(refreshRows.every((r) => r.revokedAt)).toBe(true);

    // The other tenant's membership is untouched and still works.
    const token = await signAccessToken({
      userId: worker.userId,
      membershipId: elsewhere.membershipId,
      tenantId: other.tenantId,
      farmId: other.farmId,
    });
    const app = await getApp();
    const stillWorks = await app.inject({
      method: 'GET',
      url: '/api/v1/hr/employees/lookup',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stillWorks.statusCode).toBe(200);

    // Their records stay.
    expect((await owner.get(`/hr/employees/${e.id}`)).data.fullName).toBe('Alisher Navro');
    const grid = await owner.get('/hr/timesheets', { month: MONTH });
    expect(grid.data.employees.find((p: any) => p.id === e.id).days['2026-09-01'].status).toBe('present');

    const events = await f.run(() =>
      tx().select().from(schema.events).where(and(eq(schema.events.entityId, e.id), eq(schema.events.type, 'employee.terminated'))),
    );
    expect(events).toHaveLength(1);
  });

  describe('ending the login', () => {
    const phone = () => `+998${Math.floor(100_000_000 + Math.random() * 899_999_999)}`;
    /** How a local number is typed in the Excel template. */
    const handTyped = (p: string) => `${p.slice(4, 6)} ${p.slice(6, 9)}-${p.slice(9, 11)}-${p.slice(11)}`;
    const dismiss = (owner: Client, id: string, body: object = {}) =>
      owner.post(`/hr/employees/${id}/terminate`, { date: todayIso(), ...body });

    async function login(f: Fixture, role: RoleKey, p = phone()) {
      const { userId, membershipId } = await addMember({ tenantId: f.tenantId, farmId: f.farmId, roleId: f.roleIds[role], phone: p, fullName: 'Rustam Sobirov', password: 'Password123!' });
      const token = await signAccessToken({ userId, membershipId, tenantId: f.tenantId, farmId: f.farmId });
      const app = await getApp();
      const stillIn = async () =>
        (await app.inject({ method: 'GET', url: '/api/v1/hr/employees/lookup', headers: { authorization: `Bearer ${token}` } })).statusCode === 200;
      return { p, userId, membershipId, stillIn };
    }
    const membershipStatus = async (f: Fixture, id: string) => {
      const [row] = await f.run(() => tx().select().from(schema.memberships).where(eq(schema.memberships.id, id)));
      return row.status;
    };

    it('an employee imported with the login\'s phone is dismissed for real', async () => {
      const f = await createFixture();
      const owner = await f.as('owner');
      const worker = await login(f, 'storekeeper');
      const e = await hire(owner, { phone: handTyped(worker.p) });
      expect(await worker.stillIn()).toBe(true);

      const res = await dismiss(owner, e.id);
      expect(res.status).toBe(200);
      expect(res.data.accessEnded).toBe(true);
      expect(await worker.stillIn()).toBe(false);
      expect(await membershipStatus(f, worker.membershipId)).toBe('blocked');
      const list = await owner.get('/settings/users', { status: 'blocked' });
      expect(list.data.map((m: any) => m.userId)).toEqual([worker.userId]);
    });

    it('the link is made when the record comes first, and when the login comes first', async () => {
      const f = await createFixture();
      const owner = await f.as('owner');

      const worker = await login(f, 'storekeeper');
      const afterLogin = await hire(owner, { phone: handTyped(worker.p) });
      expect((await owner.get(`/hr/employees/${afterLogin.id}`)).data.userId).toBe(worker.userId);

      const p = phone();
      const beforeLogin = await hire(owner, { phone: handTyped(p) });
      expect((await owner.get(`/hr/employees/${beforeLogin.id}`)).data.userId).toBeNull();
      const added = await owner.post('/settings/users', { phone: p, fullName: 'Rustam Sobirov', roleId: f.roleIds.shepherd });
      expect((await owner.get(`/hr/employees/${beforeLogin.id}`)).data.userId).toBe(added.data.member.userId);
    });

    it('correcting a phone on the record links it, and a link cleared by hand stays cleared', async () => {
      const f = await createFixture();
      const owner = await f.as('owner');
      const worker = await login(f, 'storekeeper');
      const e = await hire(owner, { phone: '901112233' });
      expect((await owner.patch(`/hr/employees/${e.id}`, { phone: worker.p })).data.userId).toBe(worker.userId);
      expect((await owner.patch(`/hr/employees/${e.id}`, { userId: null, phone: worker.p })).data.userId).toBeNull();
    });

    it('an invited person who accepts picks up the record waiting for them', async () => {
      const f = await createFixture();
      const owner = await f.as('owner');
      const home = await createFixture();
      const p = phone();
      await addMember({ tenantId: home.tenantId, farmId: home.farmId, roleId: home.roleIds.shepherd, phone: p, fullName: 'Bor Xodim', password: 'Password123!' });
      const e = await hire(owner, { phone: p });
      const invited = await owner.post('/settings/users', { phone: p, fullName: 'Bor Xodim', roleId: f.roleIds.shepherd });
      expect((await owner.get(`/hr/employees/${e.id}`)).data.userId).toBeNull();

      const app = await getApp();
      const signedIn = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { phone: p, password: 'Password123!' } });
      const accept = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/invitations/${invited.data.invitation.id}/accept`,
        headers: { authorization: `Bearer ${signedIn.json().data.accessToken}` },
      });
      expect(accept.statusCode).toBe(200);
      expect((await owner.get(`/hr/employees/${e.id}`)).data.userId).not.toBeNull();
    });

    it('a record from before the link is still caught at dismissal', async () => {
      const f = await createFixture();
      const owner = await f.as('owner');
      const worker = await login(f, 'storekeeper');
      const e = await hire(owner, { phone: worker.p });
      await f.run(() => tx().update(schema.employees).set({ userId: null }).where(eq(schema.employees.id, e.id)));

      const res = await dismiss(owner, e.id);
      expect(res.data.accessEnded).toBe(true);
      expect(res.data.userId).toBe(worker.userId);
      expect(await worker.stillIn()).toBe(false);
    });

    it('says so when there was no login to end', async () => {
      const f = await createFixture();
      const owner = await f.as('owner');
      const worker = await login(f, 'storekeeper');
      const noPhone = await hire(owner);
      const res = await dismiss(owner, noPhone.id);
      expect(res.status).toBe(200);
      expect(res.data.accessEnded).toBe(false);
      expect(await worker.stillIn()).toBe(true);
      const [event] = await f.run(() => tx().select().from(schema.events).where(and(eq(schema.events.entityId, noPhone.id), eq(schema.events.type, 'employee.terminated'))));
      expect(event.data.accessEnded).toBe(false);
    });

    it('the person dismissing can name the login when no phone matches', async () => {
      const f = await createFixture();
      const owner = await f.as('owner');
      const worker = await login(f, 'storekeeper');
      const e = await hire(owner, { phone: '901112233' });

      const res = await dismiss(owner, e.id, { userId: worker.userId });
      expect(res.data.accessEnded).toBe(true);
      expect(await worker.stillIn()).toBe(false);

      const other = await hire(owner);
      const stranger = (await createFixture()).as('shepherd');
      const refused = await dismiss(owner, other.id, { userId: (await stranger).userId });
      expect(refused.body.error.code).toBe('USER_NOT_ON_FARM');
    });

    it('two records sharing a phone is a question for a person, not a guess', async () => {
      const f = await createFixture();
      const owner = await f.as('owner');
      const p = phone();
      const first = await hire(owner, { phone: p });
      await hire(owner, { phone: handTyped(p), fullName: 'Boshqa Odam' });
      const added = await owner.post('/settings/users', { phone: p, fullName: 'Rustam Sobirov', roleId: f.roleIds.shepherd });
      expect(added.status).toBe(201);
      expect((await owner.get(`/hr/employees/${first.id}`)).data.userId).toBeNull();
    });

    it('a dismissal cannot do what the users page refuses', async () => {
      const f = await createFixture();
      const owner = await f.as('owner');
      const director = await f.as('director');

      const self = await hire(owner, { userId: director.userId });
      const refusedSelf = await dismiss(director, self.id);
      expect(refusedSelf.status).toBe(403);
      expect(refusedSelf.body.error.code).toBe('CANNOT_BLOCK_SELF');

      const boss = await hire(owner, { userId: owner.userId, fullName: 'Ega' });
      const refused = await dismiss(director, boss.id);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('CANNOT_MANAGE_HIGHER_ROLE');
      expect((await owner.get(`/hr/employees/${boss.id}`)).data.status).toBe('active');
      expect(await membershipStatus(f, owner.membershipId)).toBe('active');
    });

    it('the last owner cannot be dismissed out of the workspace', async () => {
      const f = await createFixture();
      const owner = await f.as('owner');
      const roleId = await f.run(async () => {
        const [role] = await tx()
          .insert(roles)
          .values({ tenantId: f.tenantId, key: 'ega_orinbosari', name: "Ega o'rinbosari", permissions: DEFAULT_ROLE_PERMISSIONS.owner })
          .returning();
        return role.id;
      });
      const { userId, membershipId } = await addMember({ tenantId: f.tenantId, farmId: f.farmId, roleId, phone: phone(), fullName: "Ega O'rinbosari", password: 'Password123!' });
      const token = await signAccessToken({ userId, membershipId, tenantId: f.tenantId, farmId: f.farmId });
      const e = await hire(owner, { userId: owner.userId, fullName: 'Ega' });

      const app = await getApp();
      const refused = await app.inject({
        method: 'POST',
        url: `/api/v1/hr/employees/${e.id}/terminate`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ date: todayIso() }),
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('LAST_OWNER');
      expect((await owner.get(`/hr/employees/${e.id}`)).data.status).toBe('active');
    });

    it('reinstating brings the login back, and only then says it did', async () => {
      const f = await createFixture();
      const owner = await f.as('owner');
      const worker = await login(f, 'storekeeper');
      const e = await hire(owner, { phone: worker.p });
      await dismiss(owner, e.id);
      expect((await owner.post(`/hr/employees/${e.id}/reinstate`)).status).toBe(200);
      expect(await worker.stillIn()).toBe(true);
    });

    it('the phone of a login is personal data on the link list too', async () => {
      const f = await createFixture();
      const roleId = await f.run(async () => {
        const [role] = await tx()
          .insert(roles)
          .values({ tenantId: f.tenantId, key: 'kadrlar', name: 'Kadrlar', permissions: ['hr.view', 'hr.update'] })
          .returning();
        return role.id;
      });
      const { userId, membershipId } = await addMember({ tenantId: f.tenantId, farmId: f.farmId, roleId, phone: phone(), fullName: 'Kadrlar Bolimi', password: 'Password123!' });
      const token = await signAccessToken({ userId, membershipId, tenantId: f.tenantId, farmId: f.farmId });
      const app = await getApp();
      const res = await app.inject({ method: 'GET', url: '/api/v1/hr/linkable-users', headers: { authorization: `Bearer ${token}` } });
      expect(res.json().data.every((u: any) => u.phone === null)).toBe(true);
    });
  });

  it('refuses a repeat, a future date and a date before hire', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner, { hireDate: '2026-06-01' });

    const future = await owner.post(`/hr/employees/${e.id}/terminate`, { date: addDays(todayIso(), 5) });
    expect(future.body.error.code).toBe('TERMINATION_IN_FUTURE');
    const early = await owner.post(`/hr/employees/${e.id}/terminate`, { date: '2026-05-31' });
    expect(early.body.error.code).toBe('TERMINATION_BEFORE_HIRE');

    expect((await owner.post(`/hr/employees/${e.id}/terminate`, { date: '2026-10-01' })).status).toBe(200);
    const again = await owner.post(`/hr/employees/${e.id}/terminate`, { date: '2026-10-02' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_TERMINATED');
    // Status cannot be flipped back through a plain edit.
    const patch = await owner.patch(`/hr/employees/${e.id}`, { status: 'active' });
    expect(patch.body.error.code).toBe('EMPLOYEE_TERMINATED');
  });

  it('reinstating restores the login', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const worker = await f.as('storekeeper');
    const e = await hire(owner, { userId: worker.userId });
    await owner.post(`/hr/employees/${e.id}/terminate`, { date: '2026-10-01' });
    expect((await worker.get('/hr/employees/lookup')).status).toBe(401);

    const res = await owner.post(`/hr/employees/${e.id}/reinstate`);
    expect(res.data.status).toBe('active');
    expect(res.data.terminationDate).toBeNull();
    expect((await worker.get('/hr/employees/lookup')).status).toBe(200);
  });

  it('a terminated person stops appearing in dropdowns', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner);
    await owner.post(`/hr/employees/${e.id}/terminate`, { date: '2026-10-01' });
    expect((await owner.get('/hr/employees/lookup')).data).toEqual([]);
  });

  it('a clerk without hr.update cannot terminate', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner);
    const accountant = await f.as('accountant');
    expect((await accountant.post(`/hr/employees/${e.id}/terminate`, { date: '2026-10-01' })).status).toBe(403);
  });
});

describe('timesheet', () => {
  let f: Fixture;
  let owner: Client;
  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
  });

  it('bulk fill writes 26 days and marks 4 Sundays off', async () => {
    const e = await hire(owner);
    expect(await fillMonth(owner, [e.id])).toBe(30);
    const grid = await owner.get('/hr/timesheets', { month: MONTH });
    const person = grid.data.employees.find((p: any) => p.id === e.id);
    expect(person.totals.present).toBe(26);
    expect(person.totals.dayOff).toBe(4);
    expect(person.days['2026-09-06'].status).toBe('day_off');
    expect(person.days['2026-09-07'].status).toBe('present');
    expect(grid.data.days).toHaveLength(30);
  });

  it('bulk fill keeps existing days unless told to overwrite', async () => {
    const e = await hire(owner);
    await owner.put(`/hr/timesheets/${e.id}/2026-09-01`, { status: 'sick' });
    await fillMonth(owner, [e.id]);
    const keep = await owner.get('/hr/timesheets', { month: MONTH });
    expect(keep.data.employees.find((p: any) => p.id === e.id).days['2026-09-01'].status).toBe('sick');

    await owner.post('/hr/timesheets/bulk', { from: FROM, to: TO, employeeIds: [e.id], status: 'present', overwrite: true });
    const over = await owner.get('/hr/timesheets', { month: MONTH });
    expect(over.data.employees.find((p: any) => p.id === e.id).days['2026-09-01'].status).toBe('present');
  });

  it('bulk fill skips days outside employment and stops at today', async () => {
    const e = await hire(owner, { hireDate: '2026-09-15' });
    const written = await owner.post('/hr/timesheets/bulk', { from: FROM, to: TO, employeeIds: [e.id], status: 'present' });
    expect(written.data.written).toBe(16);

    const today = todayIso();
    const later = await hire(owner);
    const res = await owner.post('/hr/timesheets/bulk', {
      from: addDays(today, -1),
      to: addDays(today, 3),
      employeeIds: [later.id],
      status: 'present',
    });
    expect(res.data.written).toBe(2);
  });

  it('bulk fill rejects a reversed or overlong range', async () => {
    const bad = await owner.post('/hr/timesheets/bulk', { from: TO, to: FROM, status: 'present' });
    expect(bad.body.error.code).toBe('INVALID_RANGE');
    const long = await owner.post('/hr/timesheets/bulk', { from: '2026-01-01', to: '2026-06-30', status: 'present' });
    expect(long.body.error.code).toBe('RANGE_TOO_LONG');
  });

  it('computes discipline: 24 present, 2 absent is 92.3 %', async () => {
    const solo = await createFixture();
    const boss = await solo.as('owner');
    const e = await hire(boss);
    await fillMonth(boss, [e.id]);
    await boss.put(`/hr/timesheets/${e.id}/2026-09-01`, { status: 'absent' });
    await boss.put(`/hr/timesheets/${e.id}/2026-09-02`, { status: 'absent' });
    const grid = await boss.get('/hr/timesheets', { month: MONTH });
    expect(grid.data.employees[0].attendancePercent).toBe(92.3);
    expect(grid.data.totals.attendancePercent).toBe(92.3);
  });

  it('refuses days outside employment and presence in the future', async () => {
    const e = await hire(owner, { hireDate: '2026-09-10' });
    const before = await owner.put(`/hr/timesheets/${e.id}/2026-09-09`, { status: 'present' });
    expect(before.body.error.code).toBe('OUTSIDE_EMPLOYMENT');

    const future = addDays(todayIso(), 2);
    const res = await owner.put(`/hr/timesheets/${e.id}/${future}`, { status: 'present' });
    expect(res.body.error.code).toBe('FUTURE_ATTENDANCE');
    // Planned leave in the future is fine.
    expect((await owner.put(`/hr/timesheets/${e.id}/${future}`, { status: 'vacation' })).status).toBe(200);
  });

  it('clears a day', async () => {
    const e = await hire(owner);
    await owner.put(`/hr/timesheets/${e.id}/2026-09-01`, { status: 'present' });
    expect((await owner.delete(`/hr/timesheets/${e.id}/2026-09-01`)).status).toBe(200);
    const grid = await owner.get('/hr/timesheets', { month: MONTH });
    expect(grid.data.employees.find((p: any) => p.id === e.id).days['2026-09-01']).toBeUndefined();
  });

  it('an accountant may fix the timesheet, an agronomist may not', async () => {
    const e = await hire(owner);
    const accountant = await f.as('accountant');
    expect((await accountant.put(`/hr/timesheets/${e.id}/2026-09-01`, { status: 'present' })).status).toBe(200);
    const agronomist = await f.as('agronomist');
    expect((await agronomist.put(`/hr/timesheets/${e.id}/2026-09-02`, { status: 'present' })).status).toBe(403);
  });
});

describe('self check-in', () => {
  it('records in and out with GPS, computing hours', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    const e = await hire(owner, { userId: shepherd.userId, position: "Cho'pon", baseRate: 4_000_000 });

    const before = await shepherd.get('/hr/me/today');
    expect(before.data.employee.id).toBe(e.id);
    expect(before.data.today).toBeNull();
    expect(JSON.stringify(before.data)).not.toContain('4000000');

    const in1 = await shepherd.post('/hr/me/check-in', { lat: 39.5, lng: 64.8 });
    expect(in1.status).toBe(200);
    expect(in1.data.status).toBe('present');
    expect(in1.data.lat).toBe(39.5);

    // A second tap changes nothing.
    const in2 = await shepherd.post('/hr/me/check-in', { lat: 1, lng: 1 });
    expect(in2.data.checkIn).toBe(in1.data.checkIn);
    expect(in2.data.lat).toBe(39.5);

    // Pretend the check-in was 9.5 hours ago.
    await f.run(() =>
      tx()
        .update(schema.timesheets)
        .set({ checkIn: sql`now() - interval '9.5 hours'` })
        .where(eq(schema.timesheets.employeeId, e.id)),
    );
    const out = await shepherd.post('/hr/me/check-out', { lat: 39.6, lng: 64.9 });
    expect(out.status).toBe(200);
    expect(out.data.hours).toBe(9.5);
    expect(out.data.checkOutLat).toBe(39.6);

    const after = await shepherd.get('/hr/me/today');
    expect(after.data.today.checkOut).toBeTruthy();
    expect(after.data.openShift).toBeNull();
  });

  it('works without GPS', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const mechanic = await f.as('mechanic');
    await hire(owner, { userId: mechanic.userId });
    const res = await mechanic.post('/hr/me/check-in', {});
    expect(res.status).toBe(200);
    expect(res.data.lat).toBeNull();
  });

  it('closes a night shift started yesterday', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const guard = await f.as('shepherd');
    const e = await hire(owner, { userId: guard.userId });
    await f.run(() =>
      tx()
        .insert(schema.timesheets)
        .values({
          tenantId: f.tenantId,
          farmId: f.farmId,
          employeeId: e.id,
          date: addDays(todayIso(), -1),
          status: 'present',
          checkIn: new Date(Date.now() - 12 * 3_600_000),
        }),
    );
    const res = await guard.post('/hr/me/check-out', {});
    expect(res.status).toBe(200);
    expect(res.data.date).toBe(addDays(todayIso(), -1));
    expect(res.data.hours).toBe(12);
  });

  it('checking out without checking in is refused', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    await hire(owner, { userId: shepherd.userId });
    const res = await shepherd.post('/hr/me/check-out', {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_CHECKED_IN');
  });

  it('a user with no employee record gets a clear answer', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    expect((await owner.get('/hr/me/today')).data.employee).toBeNull();
    expect((await owner.post('/hr/me/check-in', {})).status).toBe(404);
  });

  it('attendanceToday counts people present out of current staff', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    await hire(owner, { userId: shepherd.userId });
    await hire(owner);
    const gone = await hire(owner);
    await owner.post(`/hr/employees/${gone.id}/terminate`, { date: '2026-10-01' });
    await shepherd.post('/hr/me/check-in', {});
    expect(await f.run(() => attendanceToday())).toEqual({ present: 1, total: 2 });
  });
});

describe('location privacy', () => {
  it('GPS points are hidden from people without pii.view', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    const e = await hire(owner, { userId: shepherd.userId });
    await shepherd.post('/hr/me/check-in', { lat: 39.5, lng: 64.8 });

    const month = monthOf(todayIso());
    const full = await owner.get('/hr/timesheets', { month });
    const day = (grid: any) => grid.employees.find((p: any) => p.id === e.id).days[todayIso()];
    expect(day(full.data).lat).toBe(39.5);

    await grantRole(f, 'investor', ['hr.view']);
    const investor = await f.as('investor');
    const hidden = await investor.get('/hr/timesheets', { month });
    expect(hidden.status).toBe(200);
    expect(day(hidden.data).status).toBe('present');
    expect(day(hidden.data).lat).toBeNull();
    expect(day(hidden.data).lng).toBeNull();
  });
});

describe('work done (spec 11.4)', () => {
  it('gathers hectares, tonnes and head from the journals', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    const mechanic = await hire(owner);
    const vet = await hire(owner, { position: 'Veterinar' });
    const herdsman = await hire(owner, { userId: shepherd.userId, position: "Cho'pon" });
    const { fieldId } = await makeField(f, '1');
    const { herdId } = await makeHerd(f, 'Sovliqlar');

    await fieldWork(f, { employeeId: mechanic.id, fieldId, date: '2026-09-02', ha: 12.5 });
    await fieldWork(f, { employeeId: mechanic.id, fieldId, date: '2026-09-03', ha: 7.5 });
    await fieldWork(f, { employeeId: mechanic.id, fieldId, date: '2026-09-04', ha: 3, type: 'harvest', details: { grossT: 9.5 } });
    // Not counted: planned work and another month.
    await fieldWork(f, { employeeId: mechanic.id, fieldId, date: '2026-09-05', ha: 100, status: 'planned' });
    await fieldWork(f, { employeeId: mechanic.id, fieldId, date: '2026-10-01', ha: 100 });

    await f.run(async () => {
      const [ewe] = await tx()
        .select()
        .from(species)
        .where(eq(species.tenantId, f.tenantId));
      const [animal] = await tx()
        .insert(animals)
        .values({ tenantId: f.tenantId, farmId: f.farmId, tag: 'A1', speciesId: ewe.id, sex: 'female', category: 'ewe', origin: 'purchased', herdId })
        .returning();
      await tx().insert(healthRecords).values([
        { tenantId: f.tenantId, farmId: f.farmId, type: 'treatment', date: '2026-09-02', animalId: animal.id, vetEmployeeId: vet.id },
        { tenantId: f.tenantId, farmId: f.farmId, type: 'vaccination', date: '2026-09-03', herdId, headCount: 500, vetEmployeeId: vet.id },
      ]);
      await tx().insert(dailyLogs).values([
        { tenantId: f.tenantId, farmId: f.farmId, herdId, date: '2026-09-01', headCount: 500, createdBy: shepherd.userId },
        { tenantId: f.tenantId, farmId: f.farmId, herdId, date: '2026-09-02', headCount: 498, createdBy: shepherd.userId },
      ]);
    });

    const res = await owner.get('/hr/work-done', { from: FROM, to: TO });
    expect(res.status).toBe(200);
    const by = (id: string) => res.data.find((r: any) => r.employeeId === id);
    expect(by(mechanic.id)).toMatchObject({ hectares: 23, tons: 9.5, operations: 3 });
    expect(by(vet.id)).toMatchObject({ headTreated: 501, treatments: 2 });
    expect(by(herdsman.id)).toMatchObject({ headDays: 998, dailyLogs: 2 });

    const one = await owner.get('/hr/work-done', { from: FROM, to: TO, employeeId: vet.id });
    expect(one.data).toHaveLength(1);

    const bad = await owner.get('/hr/work-done', { from: TO, to: FROM });
    expect(bad.body.error.code).toBe('INVALID_RANGE');
  });
});

describe('payroll calculation', () => {
  it('monthly: full month pays the rate; 24 of 26 days pays 4 800 000', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const full = await hire(owner);
    const part = await hire(owner);
    await fillMonth(owner, [full.id, part.id]);
    await owner.put(`/hr/timesheets/${part.id}/2026-09-01`, { status: 'absent' });
    await owner.put(`/hr/timesheets/${part.id}/2026-09-02`, { status: 'absent' });

    const run = await createRun(owner);
    expect(line(run, full.id).base).toBe(5_200_000);
    expect(line(run, full.id).daysWorked).toBe(26);
    expect(line(run, part.id).base).toBe(4_800_000);
    expect(line(run, part.id).daysWorked).toBe(24);
  });

  it('monthly: paid leave and sickness do not reduce pay', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner);
    await fillMonth(owner, [e.id]);
    await owner.put(`/hr/timesheets/${e.id}/2026-09-01`, { status: 'sick' });
    await owner.put(`/hr/timesheets/${e.id}/2026-09-02`, { status: 'vacation' });
    expect(line(await createRun(owner), e.id).base).toBe(5_200_000);
  });

  it('monthly: a mid-month start is prorated', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    // Sep 16 to 30: 15 days employed, 2 Sundays off, 13 worked. 6 000 000 × 15/30 × 13/13.
    const e = await hire(owner, { hireDate: '2026-09-16', baseRate: 6_000_000 });
    await fillMonth(owner, [e.id]);
    expect(line(await createRun(owner), e.id).base).toBe(3_000_000);
  });

  it('monthly: a termination mid-month is prorated too', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    // Sep 1 to 15: 15 days, 2 Sundays off (6th, 13th), 13 worked.
    const e = await hire(owner, { baseRate: 6_000_000 });
    await fillMonth(owner, [e.id]);
    await owner.post(`/hr/employees/${e.id}/terminate`, { date: '2026-09-15' });
    await f.run(() =>
      tx()
        .delete(schema.timesheets)
        .where(and(eq(schema.timesheets.employeeId, e.id), sql`date > '2026-09-15'`)),
    );
    expect(line(await createRun(owner), e.id).base).toBe(3_000_000);
  });

  it('daily: 220 000 × 21 days', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner, { payType: 'daily', baseRate: 220_000 });
    await owner.post('/hr/timesheets/bulk', { from: '2026-09-01', to: '2026-09-21', employeeIds: [e.id], status: 'present' });
    expect(line(await createRun(owner), e.id).base).toBe(4_620_000);
  });

  it('seasonal: 18 000 000 over 180 days, 30 days present', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner, { payType: 'seasonal', baseRate: 18_000_000, hireDate: '2026-09-01', contractEndDate: '2027-02-27' });
    await owner.post('/hr/timesheets/bulk', { from: FROM, to: TO, employeeIds: [e.id], status: 'present' });
    expect(line(await createRun(owner), e.id).base).toBe(3_000_000);
  });

  it('piecework: 120.5 ha × 45 000 and base of zero for a piece worker', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner, { payType: 'piece', baseRate: 0, pieceRates: { ha: 45_000 } });
    const { fieldId } = await makeField(f, '1');
    await fieldWork(f, { employeeId: e.id, fieldId, date: '2026-09-02', ha: 100 });
    await fieldWork(f, { employeeId: e.id, fieldId, date: '2026-09-03', ha: 20.5 });
    const row = line(await createRun(owner), e.id);
    expect(row.base).toBe(0);
    expect(row.piecework).toBe(5_422_500);
    expect(row.gross).toBe(5_422_500);
  });

  it('piecework adds to a salary, across units', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    const e = await hire(owner, {
      userId: shepherd.userId,
      baseRate: 1_000_000,
      pieceRates: { head: 2_000, headDay: 10, t: 60_000 },
    });
    await fillMonth(owner, [e.id]);
    const { fieldId } = await makeField(f, '1');
    const { herdId } = await makeHerd(f, 'H');
    await fieldWork(f, { employeeId: e.id, fieldId, date: '2026-09-02', ha: 1, type: 'harvest', details: { grossT: 2 } });
    await f.run(async () => {
      await tx().insert(healthRecords).values({ tenantId: f.tenantId, farmId: f.farmId, type: 'vaccination', date: '2026-09-03', herdId, headCount: 100, vetEmployeeId: e.id });
      await tx().insert(dailyLogs).values({ tenantId: f.tenantId, farmId: f.farmId, herdId, date: '2026-09-04', headCount: 500, createdBy: shepherd.userId });
    });
    // 100 head × 2 000 + 500 head-days × 10 + 2 t × 60 000 = 200 000 + 5 000 + 120 000
    const row = line(await createRun(owner), e.id);
    expect(row.piecework).toBe(325_000);
    expect(row.base).toBe(1_000_000);
  });

  it('KPI: hectares bonus for a mechanic only, per hectare above the threshold', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const mechanic = await hire(owner, { position: 'Mexanizator', baseRate: 0 });
    const clerk = await hire(owner, { position: 'Buxgalter', baseRate: 0 });
    const { fieldId } = await makeField(f, '1');
    await fieldWork(f, { employeeId: mechanic.id, fieldId, date: '2026-09-02', ha: 72.5 });
    await fieldWork(f, { employeeId: clerk.id, fieldId, date: '2026-09-02', ha: 72.5 });
    const rule = await owner.post('/hr/kpi-rules', {
      name: 'Gektar',
      metric: 'hectares',
      position: 'Mexanizator',
      threshold: 30,
      rewardType: 'per_unit',
      amount: 10_000,
    });
    expect(rule.status).toBe(201);

    const run = await createRun(owner);
    // (72.5 − 30) × 10 000
    expect(line(run, mechanic.id).bonus).toBe(425_000);
    expect(line(run, mechanic.id).basis.kpi[0]).toMatchObject({ value: 72.5, bonus: 425_000 });
    expect(line(run, clerk.id).bonus).toBe(0);
  });

  it('KPI: survival bonus uses the shepherd’s herd', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const { herdId: goodHerd } = await makeHerd(f, 'Good');
    const { herdId: badHerd } = await makeHerd(f, 'Bad');
    const good = await hire(owner, { position: "Cho'pon", herdId: goodHerd, baseRate: 0 });
    const bad = await hire(owner, { position: "Cho'pon", herdId: badHerd, baseRate: 0 });
    const idle = await hire(owner, { position: "Cho'pon", baseRate: 0 });

    await f.run(async () => {
      const [sheep] = await tx().select().from(species).where(and(eq(species.tenantId, f.tenantId), eq(species.key, 'sheep')));
      const base = { tenantId: f.tenantId, farmId: f.farmId, speciesId: sheep.id };
      const [ewe1] = await tx().insert(animals).values({ ...base, tag: 'E1', sex: 'female', category: 'ewe', origin: 'purchased', herdId: goodHerd }).returning();
      const [ewe2] = await tx().insert(animals).values({ ...base, tag: 'E2', sex: 'female', category: 'ewe', origin: 'purchased', herdId: badHerd }).returning();
      await tx().insert(lambingRecords).values([
        { tenantId: f.tenantId, farmId: f.farmId, eweId: ewe1.id, date: '2026-08-01', lambsBorn: 10, lambsAlive: 10 },
        { tenantId: f.tenantId, farmId: f.farmId, eweId: ewe2.id, date: '2026-08-01', lambsBorn: 10, lambsAlive: 10 },
      ]);
      const lamb = (tag: string, damId: string, status: string, exitDate: string | null = null) => ({
        ...base,
        tag,
        sex: 'male',
        category: 'lamb_male',
        origin: 'born',
        birthDate: '2026-08-01',
        damId,
        status,
        exitDate,
      });
      // Good herd: 10 born, 9 alive (one died, one died only after this month and still counts).
      await tx().insert(animals).values([
        ...Array.from({ length: 8 }, (_, i) => lamb(`G${i}`, ewe1.id, 'active')),
        lamb('G8', ewe1.id, 'dead', '2026-10-05'),
        lamb('G9', ewe1.id, 'dead', '2026-09-05'),
      ]);
      // Bad herd: 10 born, 7 alive.
      await tx().insert(animals).values([
        ...Array.from({ length: 7 }, (_, i) => lamb(`B${i}`, ewe2.id, 'active')),
        ...Array.from({ length: 3 }, (_, i) => lamb(`D${i}`, ewe2.id, 'dead', '2026-09-02')),
      ]);
    });

    await owner.post('/hr/kpi-rules', {
      name: 'Saqlanish',
      metric: 'survival_percent',
      position: "Cho'pon",
      threshold: 90,
      rewardType: 'fixed',
      amount: 800_000,
    });
    const run = await createRun(owner);
    expect(line(run, good.id).basis.kpi[0].value).toBe(90);
    expect(line(run, good.id).bonus).toBe(800_000);
    expect(line(run, bad.id).basis.kpi[0].value).toBe(70);
    expect(line(run, bad.id).bonus).toBe(0);
    // No herd means farm-wide: 16 of 20 is 80 %.
    expect(line(run, idle.id).basis.kpi[0].value).toBe(80);
  });

  it('KPI: no lambs yet means no data and no bonus, not a failure', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner, { position: "Cho'pon" });
    await owner.post('/hr/kpi-rules', { name: 'S', metric: 'survival_percent', threshold: 0, rewardType: 'fixed', amount: 100 });
    const row = line(await createRun(owner), e.id);
    expect(row.basis.kpi[0].value).toBeNull();
    expect(row.bonus).toBe(0);
  });

  it('net = gross − advance − deductions', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner);
    await fillMonth(owner, [e.id]);
    const run = await createRun(owner);
    const l = line(run, e.id);
    const res = await owner.patch(`/hr/payroll/${run.id}/lines/${l.id}`, { bonus: 300_000, advance: 1_000_000, deductions: 50_000 });
    expect(res.status).toBe(200);
    const edited = line(res.data, e.id);
    expect(edited.gross).toBe(5_500_000);
    expect(edited.net).toBe(4_450_000);
    expect(res.data.totalGross).toBe(5_500_000);
    expect(res.data.totalNet).toBe(4_450_000);
  });

  it('includes only people employed in the month', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const before = await hire(owner, { hireDate: '2026-10-01' });
    const left = await hire(owner, { hireDate: '2026-01-01' });
    await owner.post(`/hr/employees/${left.id}/terminate`, { date: '2026-08-31' });
    const staying = await hire(owner);
    const run = await createRun(owner);
    expect(line(run, before.id)).toBeUndefined();
    expect(line(run, left.id)).toBeUndefined();
    expect(line(run, staying.id)).toBeDefined();
  });

  it('one run per month, none for the future', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await hire(owner);
    await createRun(owner);
    const twice = await owner.post('/hr/payroll', { month: MONTH });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ALREADY_EXISTS');

    const next = monthOf(addDays(todayIso(), 40));
    const future = await owner.post('/hr/payroll', { month: next });
    expect(future.status).toBe(400);
    expect(future.body.error.code).toBe('FUTURE_MONTH');
  });

  it('recalculation picks up the timesheet but keeps figures edited by hand', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const a = await hire(owner);
    const b = await hire(owner);
    await fillMonth(owner, [a.id, b.id]);
    const run = await createRun(owner);
    await owner.patch(`/hr/payroll/${run.id}/lines/${line(run, a.id).id}`, { bonus: 111_000, deductions: 22_000 });
    await owner.patch(`/hr/payroll/${run.id}/lines/${line(run, b.id).id}`, { base: 9_000_000 });

    await owner.put(`/hr/timesheets/${a.id}/2026-09-01`, { status: 'absent' });
    await owner.put(`/hr/timesheets/${a.id}/2026-09-02`, { status: 'absent' });
    await owner.put(`/hr/timesheets/${b.id}/2026-09-01`, { status: 'absent' });
    const newcomer = await hire(owner, { hireDate: '2026-09-29' });

    const res = await owner.post(`/hr/payroll/${run.id}/recalculate`);
    expect(res.status).toBe(200);
    expect(line(res.data, a.id).base).toBe(4_800_000);
    expect(line(res.data, a.id).bonus).toBe(111_000);
    expect(line(res.data, a.id).deductions).toBe(22_000);
    expect(line(res.data, a.id).net).toBe(4_889_000);
    expect(line(res.data, b.id).base).toBe(9_000_000);
    expect(line(res.data, b.id).daysWorked).toBe(25);
    expect(line(res.data, newcomer.id)).toBeDefined();
  });
});

describe('labour allocation (spec 11.6)', () => {
  it('splits by days worked and always adds up exactly', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const e = await hire(owner, { baseRate: 1_000_000.01 });
    await fillMonth(owner, [e.id]);
    const a = await makeField(f, 'A');
    const b = await makeField(f, 'B');
    const c = await makeField(f, 'C');
    await fieldWork(f, { employeeId: e.id, fieldId: a.fieldId, date: '2026-09-02', ha: 1 });
    await fieldWork(f, { employeeId: e.id, fieldId: b.fieldId, date: '2026-09-03', ha: 1 });
    await fieldWork(f, { employeeId: e.id, fieldId: c.fieldId, date: '2026-09-04', ha: 1 });

    const run = await createRun(owner);
    const l = line(run, e.id);
    expect(Object.values(l.allocation).reduce((s: number, v: any) => s + v, 0)).toBeCloseTo(1_000_000.01, 2);
    expect(Object.keys(l.allocation).sort()).toEqual([a.costCenterId, b.costCenterId, c.costCenterId].sort());

    const approved = await director.post(`/hr/payroll/${run.id}/approve`);
    expect(approved.status).toBe(200);
    const posted = await payrollTransactions(f, run.id);
    expect(posted).toHaveLength(3);
    const sum = posted.reduce((s, t) => s + t.amountBase, 0);
    expect(Math.round(sum * 100) / 100).toBe(1_000_000.01);
  });

  it('3 days on one field and 1 on another split 3:1, with a herd in the mix', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    const e = await hire(owner, { userId: shepherd.userId, baseRate: 4_000_000 });
    await fillMonth(owner, [e.id]);
    const field = await makeField(f, 'A');
    const herd = await makeHerd(f, 'H');
    await fieldWork(f, { employeeId: e.id, fieldId: field.fieldId, date: '2026-09-02', ha: 1 });
    await fieldWork(f, { employeeId: e.id, fieldId: field.fieldId, date: '2026-09-03', ha: 1 });
    // Two operations on one day are still one day.
    await fieldWork(f, { employeeId: e.id, fieldId: field.fieldId, date: '2026-09-03', ha: 1 });
    await fieldWork(f, { employeeId: e.id, fieldId: field.fieldId, date: '2026-09-04', ha: 1 });
    await f.run(() =>
      tx().insert(dailyLogs).values({ tenantId: f.tenantId, farmId: f.farmId, herdId: herd.herdId, date: '2026-09-05', headCount: 10, createdBy: shepherd.userId }),
    );

    const run = await createRun(owner);
    expect(line(run, e.id).allocation).toEqual({ [field.costCenterId]: 3_000_000, [herd.costCenterId]: 1_000_000 });
    expect(run.allocation.map((a: any) => a.amount)).toEqual([3_000_000, 1_000_000]);

    await director.post(`/hr/payroll/${run.id}/approve`);
    const posted = await payrollTransactions(f, run.id);
    const byCenter = Object.fromEntries(posted.map((t) => [t.costCenterId, t.amountBase]));
    expect(byCenter).toEqual({ [field.costCenterId]: 3_000_000, [herd.costCenterId]: 1_000_000 });
  });

  it('with no work logged, labour goes to the person’s herd, otherwise to general', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const herd = await makeHerd(f, 'H');
    const herdsman = await hire(owner, { herdId: herd.herdId, baseRate: 1_000_000 });
    const clerk = await hire(owner, { baseRate: 2_000_000 });
    await fillMonth(owner, [herdsman.id, clerk.id]);
    const general = await f.run(() => generalCostCenterId());
    const run = await createRun(owner);
    expect(line(run, herdsman.id).allocation).toEqual({ [herd.costCenterId]: 1_000_000 });
    expect(line(run, clerk.id).allocation).toEqual({ [general]: 2_000_000 });
  });

  it('an edited line re-splits its new gross', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner, { baseRate: 1_000_000 });
    await fillMonth(owner, [e.id]);
    const a = await makeField(f, 'A');
    const b = await makeField(f, 'B');
    await fieldWork(f, { employeeId: e.id, fieldId: a.fieldId, date: '2026-09-02', ha: 1 });
    await fieldWork(f, { employeeId: e.id, fieldId: b.fieldId, date: '2026-09-03', ha: 1 });
    const run = await createRun(owner);
    const res = await owner.patch(`/hr/payroll/${run.id}/lines/${line(run, e.id).id}`, { bonus: 500_000 });
    expect(line(res.data, e.id).allocation).toEqual({ [a.costCenterId]: 750_000, [b.costCenterId]: 750_000 });
  });

  it('deductions do not reduce labour cost, they stay payable', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const e = await hire(owner, { baseRate: 1_000_000 });
    await fillMonth(owner, [e.id]);
    const run = await createRun(owner);
    await owner.patch(`/hr/payroll/${run.id}/lines/${line(run, e.id).id}`, { deductions: 100_000 });
    await director.post(`/hr/payroll/${run.id}/approve`);
    const [posted] = await payrollTransactions(f, run.id);
    expect(posted.amountBase).toBe(1_000_000);
  });
});

describe('payroll approval', () => {
  async function setup() {
    const f = await createFixture();
    const owner = await f.as('owner');
    const accountant = await f.as('accountant');
    const director = await f.as('director');
    const e = await hire(owner, { baseRate: 6_000_000 });
    await fillMonth(owner, [e.id]);
    const run = await createRun(accountant);
    return { f, owner, accountant, director, e, run };
  }

  it('posts the salary as approved expense on credit, whatever its size', async () => {
    const { f, director, run } = await setup();
    const res = await director.post(`/hr/payroll/${run.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('approved');
    expect(res.data.approvedBy).toBe(director.userId);

    const [posted] = await payrollTransactions(f, run.id);
    expect(posted.type).toBe('expense');
    expect(posted.status).toBe('approved');
    expect(posted.amountBase).toBe(6_000_000);
    expect(posted.paymentMethod).toBe('debt');
    expect(posted.costTreatment).toBe('expense');
    expect(posted.accountId).toBeNull();
    expect(posted.date).toBe(TO);

    const [category] = await f.run(() =>
      tx().select().from(schema.financeCategories).where(eq(schema.financeCategories.id, posted.categoryId!)),
    );
    expect(category.key).toBe('salary');
  });

  it('the person who prepared it cannot approve it', async () => {
    const { f, owner, run } = await setup();
    const accountant = await f.as('accountant');
    const denied = await accountant.post(`/hr/payroll/${run.id}/approve`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('SAME_MAKER_CHECKER');
    expect(await payrollTransactions(f, run.id)).toEqual([]);

    expect((await owner.post(`/hr/payroll/${run.id}/approve`)).status).toBe(200);
  });

  it('editing the figures makes you the maker, so you cannot then approve', async () => {
    const { director, e, run } = await setup();
    await director.patch(`/hr/payroll/${run.id}/lines/${line(run, e.id).id}`, { bonus: 1 });
    const denied = await director.post(`/hr/payroll/${run.id}/approve`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('SAME_MAKER_CHECKER');
  });

  it('saving a line without a change does not make you the maker', async () => {
    const { director, e, run } = await setup();
    const l = line(run, e.id);
    const same = await director.patch(`/hr/payroll/${run.id}/lines/${l.id}`, { base: l.base, bonus: l.bonus });
    expect(same.status).toBe(200);
    expect(line(same.data, e.id).overrides).toEqual([]);
    expect((await director.post(`/hr/payroll/${run.id}/approve`)).status).toBe(200);
  });

  it('a single owner can approve alone when the tenant turns maker-checker off', async () => {
    const f = await createFixture({ settings: { finance: { makerChecker: false } } });
    const owner = await f.as('owner');
    const e = await hire(owner);
    await fillMonth(owner, [e.id]);
    const run = await createRun(owner);
    expect((await owner.post(`/hr/payroll/${run.id}/approve`)).status).toBe(200);
  });

  it('a second approval is refused and posts nothing more', async () => {
    const { f, director, owner, run } = await setup();
    await director.post(`/hr/payroll/${run.id}/approve`);
    const again = await owner.post(`/hr/payroll/${run.id}/approve`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_APPROVED');
    expect(await payrollTransactions(f, run.id)).toHaveLength(1);
  });

  it('two approvals at once post once', async () => {
    const { f, director, owner, run } = await setup();
    const results = await Promise.all([
      director.post(`/hr/payroll/${run.id}/approve`),
      owner.post(`/hr/payroll/${run.id}/approve`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await payrollTransactions(f, run.id)).toHaveLength(1);
  });

  it('an approved run and its month are frozen', async () => {
    const { owner, director, e, run } = await setup();
    await director.post(`/hr/payroll/${run.id}/approve`);

    const edit = await owner.patch(`/hr/payroll/${run.id}/lines/${line(run, e.id).id}`, { bonus: 1 });
    expect(edit.body.error.code).toBe('PAYROLL_NOT_DRAFT');
    expect((await owner.post(`/hr/payroll/${run.id}/recalculate`)).body.error.code).toBe('PAYROLL_NOT_DRAFT');
    expect((await owner.delete(`/hr/payroll/${run.id}`)).body.error.code).toBe('PAYROLL_NOT_DRAFT');

    const day = await owner.put(`/hr/timesheets/${e.id}/2026-09-01`, { status: 'absent' });
    expect(day.status).toBe(409);
    expect(day.body.error.code).toBe('PAYROLL_CLOSED');
    expect((await owner.delete(`/hr/timesheets/${e.id}/2026-09-01`)).body.error.code).toBe('PAYROLL_CLOSED');
    const bulk = await owner.post('/hr/timesheets/bulk', { from: FROM, to: TO, status: 'present' });
    expect(bulk.body.error.code).toBe('PAYROLL_CLOSED');
  });

  it('submit, return with a reason, edit, approve', async () => {
    const { f, accountant, director, e, run } = await setup();
    const submitted = await accountant.post(`/hr/payroll/${run.id}/submit`);
    expect(submitted.data.status).toBe('pending');

    const locked = await accountant.patch(`/hr/payroll/${run.id}/lines/${line(run, e.id).id}`, { bonus: 1 });
    expect(locked.body.error.code).toBe('PAYROLL_NOT_DRAFT');

    expect((await accountant.post(`/hr/payroll/${run.id}/return`, { reason: 'x' })).status).toBe(200);
    const notPending = await director.post(`/hr/payroll/${run.id}/return`, { reason: 'x' });
    expect(notPending.body.error.code).toBe('PAYROLL_NOT_PENDING');

    await accountant.post(`/hr/payroll/${run.id}/submit`);
    const back = await director.post(`/hr/payroll/${run.id}/return`, { reason: "Bonusni tekshiring" });
    expect(back.data.status).toBe('draft');
    expect(back.data.returnedReason).toBe('Bonusni tekshiring');

    await accountant.patch(`/hr/payroll/${run.id}/lines/${line(run, e.id).id}`, { bonus: 200_000 });
    await accountant.post(`/hr/payroll/${run.id}/submit`);
    expect((await director.post(`/hr/payroll/${run.id}/approve`)).data.returnedReason).toBeNull();
    const [posted] = await payrollTransactions(f, run.id);
    expect(posted.amountBase).toBe(6_200_000);
  });

  it('tells the approvers when a run is submitted, and the maker when it comes back', async () => {
    const { f, accountant, director, owner, run } = await setup();
    const shepherd = await f.as('shepherd');
    await accountant.post(`/hr/payroll/${run.id}/submit`);

    const inbox = (userId: string) =>
      f.run(() => tx().select().from(schema.notifications).where(eq(schema.notifications.userId, userId)));
    expect(await inbox(director.userId)).toHaveLength(1);
    expect(await inbox(owner.userId)).toHaveLength(1);
    // The maker has nothing to do, and a shepherd must never hear about payroll.
    expect(await inbox(accountant.userId)).toHaveLength(0);
    expect(await inbox(shepherd.userId)).toHaveLength(0);
    const [note] = await inbox(director.userId);
    expect(note.link).toBe(`/hr/payroll?run=${run.id}`);

    await director.post(`/hr/payroll/${run.id}/return`, { reason: 'Tekshiring' });
    const [back] = await inbox(accountant.userId);
    expect(back.body).toBe('Tekshiring');
  });

  it('only people with payroll.approve may approve', async () => {
    const { f, run } = await setup();
    const zootechnician = await f.as('zootechnician');
    expect((await zootechnician.post(`/hr/payroll/${run.id}/approve`)).status).toBe(403);
    const auditor = await f.as('auditor');
    expect((await auditor.post(`/hr/payroll/${run.id}/approve`)).status).toBe(403);
    expect((await auditor.get(`/hr/payroll/${run.id}`)).status).toBe(200);
  });

  it('a draft can be deleted, and a run in another tenant cannot be reached', async () => {
    const { owner, run } = await setup();
    const other = await createFixture();
    const stranger = await other.as('owner');
    expect((await stranger.get(`/hr/payroll/${run.id}`)).status).toBe(404);
    expect((await stranger.post(`/hr/payroll/${run.id}/approve`)).status).toBe(404);
    expect((await stranger.delete(`/hr/payroll/${run.id}`)).status).toBe(404);

    expect((await owner.delete(`/hr/payroll/${run.id}`)).status).toBe(200);
    expect((await owner.get(`/hr/payroll/${run.id}`)).status).toBe(404);
  });

  it('wages owed cannot be paid from the debts page too, or they would be paid twice', async () => {
    const { f, accountant, director, run } = await setup();
    const accountId = await makeCashAccount(f);
    await director.post(`/hr/payroll/${run.id}/approve`);
    const debts = (await accountant.get('/finance/debts', { direction: 'payable' })).data;
    const wages = debts.find((d: any) => d.isPayroll);
    expect(wages.outstanding).toBeGreaterThan(0);
    const refused = await accountant.post('/finance/debts/settle', {
      direction: 'payable',
      counterpartyId: wages.counterpartyId,
      accountId,
      amount: wages.outstanding,
      date: '2026-10-05',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('WAGES_PAID_FROM_PAYROLL');
    expect((await accountant.post(`/hr/payroll/${run.id}/pay`, { accountId, date: '2026-10-05' })).status).toBe(200);
  });

  it('payment settles the net as a debt payment, without adding cost', async () => {
    const { f, accountant, director, e, run } = await setup();
    const accountId = await makeCashAccount(f);
    await accountant.patch(`/hr/payroll/${run.id}/lines/${line(run, e.id).id}`, { deductions: 100_000 });

    const early = await accountant.post(`/hr/payroll/${run.id}/pay`, { accountId, date: '2026-10-05' });
    expect(early.body.error.code).toBe('PAYROLL_NOT_APPROVED');

    await director.post(`/hr/payroll/${run.id}/approve`);
    const paid = await accountant.post(`/hr/payroll/${run.id}/pay`, { accountId, date: '2026-10-05' });
    expect(paid.status).toBe(200);
    expect(paid.data.status).toBe('paid');

    const [payment] = await payrollTransactions(f, run.id, 'payroll_payment');
    expect(payment.type).toBe('debt_payment');
    expect(payment.amountBase).toBe(5_900_000);
    expect(payment.paymentMethod).toBe('cash');
    expect(payment.accountId).toBe(accountId);
    expect(payment.status).toBe('approved');
    expect(paid.data.paymentTransactionId).toBe(payment.id);

    const again = await accountant.post(`/hr/payroll/${run.id}/pay`, { accountId, date: '2026-10-05' });
    expect(again.body.error.code).toBe('ALREADY_PAID');
    expect(await payrollTransactions(f, run.id, 'payroll_payment')).toHaveLength(1);
  });

  it('payment skips a person whose advances exceed their earnings', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const a = await hire(owner, { baseRate: 1_000_000 });
    const b = await hire(owner, { baseRate: 500_000 });
    await fillMonth(owner, [a.id, b.id]);
    const accountId = await makeCashAccount(f);
    const run = await createRun(owner);
    await owner.patch(`/hr/payroll/${run.id}/lines/${line(run, b.id).id}`, { advance: 800_000 });
    await director.post(`/hr/payroll/${run.id}/approve`);
    await owner.post(`/hr/payroll/${run.id}/pay`, { accountId, date: '2026-10-05' });
    const [payment] = await payrollTransactions(f, run.id, 'payroll_payment');
    expect(payment.amountBase).toBe(1_000_000);
  });

  it('refuses an account from another farm', async () => {
    const { f, owner, director, run } = await setup();
    const other = await createFixture();
    const foreign = await makeCashAccount(other);
    await director.post(`/hr/payroll/${run.id}/approve`);
    const res = await owner.post(`/hr/payroll/${run.id}/pay`, { accountId: foreign, date: '2026-10-05' });
    expect(res.status).toBe(404);
    expect(f.tenantId).not.toBe(other.tenantId);
  });
});

describe('advances', () => {
  it('moves money at once and comes off the month’s payroll', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner);
    await fillMonth(owner, [e.id]);
    const accountId = await makeCashAccount(f);

    const res = await owner.post('/hr/advances', { employeeId: e.id, date: '2026-09-15', amount: 1_000_000, accountId });
    expect(res.status).toBe(201);
    expect(res.data.month).toBe(MONTH);
    expect(res.data.transactionStatus).toBe('approved');

    const [payment] = await f.run(() =>
      tx().select().from(transactions).where(eq(transactions.id, res.data.transactionId)),
    );
    expect(payment.type).toBe('debt_payment');
    expect(payment.accountId).toBe(accountId);

    const run = await createRun(owner);
    expect(line(run, e.id).advance).toBe(1_000_000);
    expect(line(run, e.id).net).toBe(4_200_000);

    const list = await owner.get('/hr/advances', { month: MONTH });
    expect(list.data[0].fullName).toBe('Alisher Navro');
    expect(list.data[0].transactionStatus).toBe('approved');
  });

  it('an advance waiting for approval is not deducted until it is approved', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const e = await hire(owner, { baseRate: 9_000_000 });
    await fillMonth(owner, [e.id]);
    const accountId = await makeCashAccount(f);
    const res = await owner.post('/hr/advances', { employeeId: e.id, date: '2026-09-15', amount: 6_000_000, accountId });
    expect(res.data.transactionStatus).toBe('pending');

    const run = await createRun(owner);
    expect(line(run, e.id).advance).toBe(0);

    await f.run(() => approveTransaction(res.data.transactionId), { userId: director.userId });
    const recalculated = await owner.post(`/hr/payroll/${run.id}/recalculate`);
    expect(line(recalculated.data, e.id).advance).toBe(6_000_000);
    expect(line(recalculated.data, e.id).net).toBe(3_000_000);
  });

  it('paid after the run was worked out stops its approval until it is recalculated', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const e = await hire(owner);
    await fillMonth(owner, [e.id]);
    const accountId = await makeCashAccount(f);
    const run = await createRun(owner);
    expect(line(run, e.id).net).toBe(5_200_000);
    expect((await owner.post('/hr/advances', { employeeId: e.id, date: '2026-09-15', amount: 1_000_000, accountId })).status).toBe(201);

    const refused = await director.post(`/hr/payroll/${run.id}/approve`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PAYROLL_ADVANCES_CHANGED');
    expect(await payrollTransactions(f, run.id)).toEqual([]);

    // 5 200 000 less the 1 000 000 already in hand.
    const recalculated = await owner.post(`/hr/payroll/${run.id}/recalculate`);
    expect(line(recalculated.data, e.id).net).toBe(4_200_000);
    expect((await director.post(`/hr/payroll/${run.id}/approve`)).status).toBe(200);
  });

  it('still waiting for approval stops the run, because approving it later would pay it twice', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const e = await hire(owner, { baseRate: 9_000_000 });
    await fillMonth(owner, [e.id]);
    const accountId = await makeCashAccount(f);
    const advance = await owner.post('/hr/advances', { employeeId: e.id, date: '2026-09-15', amount: 6_000_000, accountId });
    expect(advance.data.transactionStatus).toBe('pending');
    const run = await createRun(owner);

    const refused = await director.post(`/hr/payroll/${run.id}/approve`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PAYROLL_ADVANCES_WAITING');

    expect((await director.post(`/finance/transactions/${advance.data.transactionId}/reject`, { reason: 'xato' })).status).toBe(200);
    expect((await director.post(`/hr/payroll/${run.id}/approve`)).status).toBe(200);
  });

  it('typed into a line by hand is that person\'s figure, and does not stop the run', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const e = await hire(owner);
    await fillMonth(owner, [e.id]);
    const accountId = await makeCashAccount(f);
    const run = await createRun(owner);
    await owner.post('/hr/advances', { employeeId: e.id, date: '2026-09-15', amount: 1_000_000, accountId });
    await owner.patch(`/hr/payroll/${run.id}/lines/${line(run, e.id).id}`, { advance: 700_000 });
    expect((await director.post(`/hr/payroll/${run.id}/approve`)).status).toBe(200);
  });

  it('and a run being approved at the same moment: one of them sees the other', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const e = await hire(owner);
    await fillMonth(owner, [e.id]);
    const accountId = await makeCashAccount(f);
    const run = await createRun(owner);

    const [approved, advance] = await Promise.all([
      director.post(`/hr/payroll/${run.id}/approve`),
      owner.post('/hr/advances', { employeeId: e.id, date: '2026-09-15', amount: 1_000_000, accountId }),
    ]);
    expect([approved.status, advance.status].sort()).toEqual(approved.status === 200 ? [200, 409] : [201, 409]);
    if (approved.status === 200) expect(advance.body.error.code).toBe('PAYROLL_CLOSED');
    else expect(approved.body.error.code).toBe('PAYROLL_ADVANCES_CHANGED');
  });

  describe('while the month has no payroll yet', () => {
    /** Starts `second` while `first` is still uncommitted, so it has to wait for the outcome. */
    async function overlapping(f: Fixture, first: () => Promise<unknown>, second: () => Promise<unknown>): Promise<string> {
      let other: Promise<string> = Promise.resolve('');
      await f.run(async () => {
        await first();
        other = f.run(second).then(
          () => 'done',
          (error) => error.code,
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      return other;
    }

    /** One person makes and approves the run here, so the two-person rule is off for these. */
    async function month() {
      const f = await createFixture({ settings: { finance: { makerChecker: false } } });
      const owner = await f.as('owner');
      const e = await hire(owner);
      await fillMonth(owner, [e.id]);
      const accountId = await makeCashAccount(f);
      const advance = () => payroll.createAdvance({ employeeId: e.id, date: '2026-09-15', amount: 1_000_000, accountId });
      const approval = async () => payroll.approveRun((await payroll.createRun({ month: MONTH })).id);
      return { f, e, advance, approval };
    }

    it('an advance being paid holds off a run made and approved meanwhile', async () => {
      const { f, e, advance, approval } = await month();
      expect(await overlapping(f, advance, approval)).toBe('PAYROLL_ADVANCES_CHANGED');

      // The run was undone with its refusal, so the next one deducts the advance: 5 200 000 - 1 000 000.
      const run = await f.run(approval);
      expect(run.status).toBe('approved');
      expect(line(run, e.id)).toMatchObject({ advance: 1_000_000, net: 4_200_000 });
    });

    it('a run being approved holds off an advance, which then finds the month closed', async () => {
      const { f, advance, approval } = await month();
      expect(await overlapping(f, approval, advance)).toBe('PAYROLL_CLOSED');

      const [run] = (await f.run(() => payroll.listRuns({ page: 1, pageSize: 25 }))).data;
      expect(run.status).toBe('approved');
      expect(await f.run(() => payroll.listAdvances({ month: MONTH }))).toEqual([]);
    });
  });

  it('two first payments at the same moment share one payroll counterparty, or the debt would split', async () => {
    const f = await createFixture();
    const e = await hire(await f.as('owner'));
    const accountId = await makeCashAccount(f);
    const paid = (date: string) => payroll.createAdvance({ employeeId: e.id, date, amount: 100_000, accountId });

    let second: Promise<unknown> = Promise.resolve();
    await f.run(async () => {
      await paid('2026-08-15');
      second = f.run(() => paid('2026-09-15'));
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    await second;

    const rows = await f.run(() =>
      tx().select({ counterpartyId: transactions.counterpartyId }).from(transactions).where(eq(transactions.sourceType, 'payroll_advance')),
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.counterpartyId)).size).toBe(1);
  });

  it('cannot be added to a closed month', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const e = await hire(owner);
    await fillMonth(owner, [e.id]);
    const accountId = await makeCashAccount(f);
    const run = await createRun(owner);
    await director.post(`/hr/payroll/${run.id}/approve`);
    const res = await owner.post('/hr/advances', { employeeId: e.id, date: '2026-09-20', amount: 1, accountId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYROLL_CLOSED');
  });
});

describe('KPI rules', () => {
  it('create, edit, list, delete, with permissions', async () => {
    const f = await createFixture();
    const accountant = await f.as('accountant');
    const created = await accountant.post('/hr/kpi-rules', {
      name: 'Gektar',
      metric: 'hectares',
      threshold: 30,
      rewardType: 'fixed',
      amount: 500_000,
    });
    expect(created.status).toBe(201);
    const edited = await accountant.patch(`/hr/kpi-rules/${created.data.id}`, { active: false });
    expect(edited.data.active).toBe(false);
    expect((await accountant.get('/hr/kpi-rules')).data).toHaveLength(1);

    const bad = await accountant.post('/hr/kpi-rules', { name: 'x', metric: 'nonsense', threshold: 1, rewardType: 'fixed', amount: 1 });
    expect(bad.status).toBe(400);

    const director = await f.as('director');
    expect((await director.delete(`/hr/kpi-rules/${created.data.id}`)).status).toBe(200);
    expect((await director.delete(`/hr/kpi-rules/${created.data.id}`)).status).toBe(404);
  });

  it('an inactive rule pays nothing', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner, { baseRate: 0 });
    const { fieldId } = await makeField(f, '1');
    await fieldWork(f, { employeeId: e.id, fieldId, date: '2026-09-02', ha: 50 });
    await owner.post('/hr/kpi-rules', { name: 'G', metric: 'hectares', threshold: 1, rewardType: 'fixed', amount: 9, active: false });
    expect(line(await createRun(owner), e.id).bonus).toBe(0);
  });
});

describe('safety and reminders (spec 11.8, 11.9)', () => {
  it('tracks signed instructions', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner);
    const created = await owner.post('/hr/safety', {
      employeeId: e.id,
      title: 'Mehnat muhofazasi',
      signedOn: '2026-09-01',
      validUntil: '2027-09-01',
    });
    expect(created.status).toBe(201);
    const edited = await owner.patch(`/hr/safety/${created.data.id}`, { title: "Yong'in xavfsizligi" });
    expect(edited.data.title).toBe("Yong'in xavfsizligi");
    const list = await owner.get('/hr/safety', { employeeId: e.id });
    expect(list.data[0].fullName).toBe('Alisher Navro');

    const bad = await owner.post('/hr/safety', { employeeId: e.id, title: 'x', signedOn: '2026-09-01', validUntil: '2026-01-01' });
    expect(bad.body.error.code).toBe('INVALID_RANGE');

    expect((await owner.delete(`/hr/safety/${created.data.id}`)).status).toBe(200);
    expect((await owner.delete(`/hr/safety/${created.data.id}`)).status).toBe(404);
  });

  it('lists what falls due within the window, overdue first', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const today = todayIso();
    const e = await hire(owner, {
      hireDate: addDays(today, -60),
      contractEndDate: addDays(today, 10),
      medicalCheckDate: addDays(today, -3),
    });
    await hire(owner, { hireDate: addDays(today, -60), contractEndDate: addDays(today, 90) });
    await owner.post('/hr/safety', { employeeId: e.id, title: 'Yo\'riqnoma', validUntil: addDays(today, 5) });
    const veteran = await hire(owner, { fullName: 'Veteran', hireDate: addDays(today, -330) });

    const res = await owner.get('/hr/reminders', { days: 30 });
    expect(res.status).toBe(200);
    const types = res.data.map((r: any) => [r.type, r.daysLeft]);
    expect(types).toEqual([
      ['medical_check', -3],
      ['safety_expiry', 5],
      ['vacation_due', 5],
      ['contract_end', 10],
    ]);
    expect(res.data[2].employeeId).toBe(veteran.id);
  });

  it('a recent vacation clears the leave reminder, and leavers are ignored', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const today = todayIso();
    const rested = await hire(owner, { hireDate: addDays(today, -340) });
    await owner.put(`/hr/timesheets/${rested.id}/${addDays(today, -30)}`, { status: 'vacation' });
    const gone = await hire(owner, { hireDate: addDays(today, -340), contractEndDate: addDays(today, 2) });
    await owner.post(`/hr/employees/${gone.id}/terminate`, { date: addDays(today, -1) });
    expect(await f.run(() => reminders(30))).toEqual([]);
  });

  it('is closed to field roles', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    expect((await shepherd.get('/hr/reminders')).status).toBe(403);
    expect((await shepherd.get('/hr/safety')).status).toBe(403);
  });
});

describe('journal', () => {
  it('payroll steps are in the event journal', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const e = await hire(owner);
    await fillMonth(owner, [e.id]);
    const run = await createRun(owner);
    await owner.post(`/hr/payroll/${run.id}/submit`);
    await director.post(`/hr/payroll/${run.id}/approve`);
    const events = await f.run(() =>
      tx().select({ type: schema.events.type }).from(schema.events).where(eq(schema.events.entityId, run.id)),
    );
    expect(events.map((x) => x.type).sort()).toEqual(['payroll.approved', 'payroll.created', 'payroll.submitted']);
  });
});

describe('advances and personal data', () => {
  it('hides the name beside the amount without pii.view (rule 8)', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner, { baseRate: 6_000_000 });
    const accountId = await makeCashAccount(f);
    const made = await owner.post('/hr/advances', { employeeId: e.id, date: todayIso(), amount: 100_000, accountId });
    expect(made.status).toBe(201);
    expect((await owner.get('/hr/advances')).data[0].fullName).toBeTruthy();
    await f.run(async () => {
      const roles = await tx().select().from(schema.roles).where(eq(schema.roles.key, 'accountant'));
      const permissions = roles[0].permissions.filter((p: string) => p !== 'pii.view');
      await tx().update(schema.roles).set({ permissions }).where(eq(schema.roles.id, roles[0].id));
    });
    const accountant = await f.as('accountant');
    expect((await accountant.get('/hr/advances')).data[0].fullName).toBeNull();
  });
});

describe('pilot seed', () => {
  it('builds the staff, timesheets and an approved October payroll', async () => {
    const f = await createFixture();
    const users = {} as Record<RoleKey, string>;
    for (const role of ROLE_KEYS) users[role] = (await f.as(role)).userId;
    await f.run(() =>
      tx().insert(accounts).values({ tenantId: f.tenantId, farmId: f.farmId, name: SEED.account.cash, type: 'cash' }),
    );

    const seed = {
      tenantId: f.tenantId,
      farmId: f.farmId,
      users,
      run: <T,>(fn: () => Promise<T>, as: RoleKey = 'owner') => f.run(fn, { userId: users[as] }),
    };
    await seedHr(seed);
    const owner = await f.as('owner');
    const herd = await owner.post('/livestock/herds', { name: SEED.herd.pregnant });
    expect(herd.status).toBe(201);
    await seedPayroll(seed);

    const staff = await owner.get('/hr/employees', { pageSize: 50 });
    expect(staff.body.meta.total).toBe(13);
    const count = (position: string) => staff.body.data.filter((e: any) => e.position === position).length;
    expect(count(SEED.position.shepherd)).toBe(4);
    expect(count(SEED.position.mechanic)).toBe(2);
    expect(staff.body.data.filter((e: any) => e.userId).length).toBe(8);

    const runs = await owner.get('/hr/payroll');
    expect(runs.body.data).toHaveLength(1);
    const [summary] = runs.body.data;
    expect(summary.month).toBe('2026-10');
    expect(summary.status).toBe('approved');
    // Fits the salary line of the seeded budget, which is 32 to 36 million a month.
    expect(summary.totalGross).toBeGreaterThan(20_000_000);
    expect(summary.totalGross).toBeLessThan(36_000_000);

    const run = (await owner.get(`/hr/payroll/${summary.id}`)).data;
    // The piece-rate mechanic joined in November.
    expect(run.lines).toHaveLength(12);
    // A shepherd's wage is the herd's labour cost, not general overhead.
    const onHerd = run.allocation.find((a: any) => a.name === SEED.herd.pregnant);
    expect(onHerd.amount).toBeGreaterThan(0);
    // October 2026: 31 days, 4 Sundays, so 27 expected days and 27 present.
    const director = run.lines.find((l: any) => l.position === SEED.position.director);
    expect(director.base).toBe(5_000_000);
    expect(director.daysWorked).toBe(27);
    // The guard missed one day: 2 000 000 × 26/27.
    const guard = run.lines.find((l: any) => l.position === SEED.position.guard);
    expect(guard.base).toBe(1_925_925.93);

    // One entry per cost center, together the whole payroll.
    const posted = await payrollTransactions(f, summary.id);
    expect(posted).toHaveLength(2);
    expect(posted.reduce((sum: number, row: any) => sum + row.amountBase, 0)).toBeCloseTo(summary.totalGross, 2);

    const grid = await owner.get('/hr/timesheets', { month: '2026-11' });
    const shepherd = grid.data.employees.find((p: any) => p.fullName === 'Sherzod Boboyev');
    // Today is left for the demo shepherd to check in, except on a Sunday, the seed's day off for everyone.
    if (new Date(`${todayIso()}T00:00:00Z`).getUTCDay() === 0) {
      expect(shepherd.days[todayIso()].status).toBe('day_off');
    } else {
      expect(shepherd.days[todayIso()]).toBeUndefined();
    }
    const [firstNovember] = Object.values(shepherd.days) as any[];
    expect(firstNovember).toBeDefined();

    const advances = await owner.get('/hr/advances');
    expect(advances.data).toHaveLength(1);
    expect(advances.data[0].transactionStatus).toBe('approved');

    const due = await owner.get('/hr/reminders', { days: 30 });
    expect(due.data.map((r: any) => r.type)).toEqual(
      expect.arrayContaining(['contract_end', 'medical_check', 'safety_expiry']),
    );
    expect((await owner.get('/hr/kpi-rules')).data).toHaveLength(2);
  });
});
