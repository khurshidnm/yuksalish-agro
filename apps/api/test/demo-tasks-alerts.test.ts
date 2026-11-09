/**
 * Demo audit fixes for tasks, calendar, alerts and notifications: a task closes only with work done
 * for it, deadlines open the tab they are about, and a decided message says so.
 */
import { addDays, todayIso } from '@yap/shared';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tx } from '../src/core/context';
import { schema } from '../src/db/client';
import { evaluateRules } from '../src/modules/alerts/rules';
import { registerAction } from '../src/modules/notifications/actions.service';
import { notifyUser } from '../src/modules/notifications/notify.service';
import { recordsFrom } from '../src/modules/tasks/tasks.service';
import { createFixture, type Fixture } from './helpers';

const { alerts, fieldOperations, fields, healthRecords, herds } = schema;

const today = () => todayIso();
const base = (f: Fixture) => ({ tenantId: f.tenantId, farmId: f.farmId });

const makeHerd = (f: Fixture) =>
  f.run(async () => (await tx().insert(herds).values({ ...base(f), name: `Poda ${Math.random()}` }).returning())[0]);

const healthRecord = (f: Fixture, herdId: string, type: string, date: string) =>
  f.run(async () => (await tx().insert(healthRecords).values({ ...base(f), type, herdId, date }).returning())[0]);

describe('a task closes only with work done for it', () => {
  it("is not closed by last week's vaccination, nor by an examination when it asks for a vaccination", async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const herd = await makeHerd(f);
    // The demo: the herd was vaccinated three days before the task was set.
    const earlier = await healthRecord(f, herd.id, 'vaccination', addDays(today(), -3));
    const task = await director.post('/tasks', {
      title: 'Enterotoksemiyaga qarshi emlash',
      requiresRecord: 'vaccination_record',
      entityType: 'herd',
      entityId: herd.id,
    });
    expect(task.data.requiresRecord).toBe('vaccination_record');
    const examination = await healthRecord(f, herd.id, 'examination', today());

    expect((await director.get(`/tasks/${task.data.id}/record-candidates`)).data).toEqual([]);
    for (const record of [earlier, examination]) {
      const refused = await director.post(`/tasks/${task.data.id}/complete`, { recordId: record.id });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatchObject({ code: 'RECORD_REQUIRED', details: { requires: 'vaccination_record' } });
    }

    const shot = await healthRecord(f, herd.id, 'vaccination', today());
    const candidates = await director.get(`/tasks/${task.data.id}/record-candidates`);
    expect(candidates.data).toEqual([{ id: shot.id, date: today(), label: 'vaccination' }]);
    const done = await director.post(`/tasks/${task.data.id}/complete`, { recordId: shot.id });
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({ status: 'done', completionRecordId: shot.id });
  });

  it('any veterinary record still closes a veterinary task, but only one made since it was set', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const herd = await makeHerd(f);
    const yesterday = await healthRecord(f, herd.id, 'examination', addDays(today(), -1));
    const task = await director.post('/tasks', { title: "Ko'rik", requiresRecord: 'health_record', entityType: 'herd', entityId: herd.id });
    const now = await healthRecord(f, herd.id, 'examination', today());

    const candidates = await director.get(`/tasks/${task.data.id}/record-candidates`);
    expect(candidates.data.map((r: { id: string }) => r.id)).toEqual([now.id]);
    expect((await director.post(`/tasks/${task.data.id}/complete`, { recordId: yesterday.id })).body.error.code).toBe('RECORD_REQUIRED');
    expect((await director.post(`/tasks/${task.data.id}/complete`, { recordId: now.id })).status).toBe(200);
  });

  it('a planned field operation is not work done', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const field = await f.run(async () => (await tx().insert(fields).values({ ...base(f), number: '3' }).returning())[0]);
    const task = await director.post('/tasks', { title: "Sug'orish", requiresRecord: 'field_operation', entityType: 'field', entityId: field.id });
    const [planned, done] = await f.run(() =>
      tx()
        .insert(fieldOperations)
        .values([
          { ...base(f), type: 'irrigation', status: 'planned', date: today(), fieldId: field.id },
          { ...base(f), type: 'irrigation', status: 'done', date: today(), fieldId: field.id },
        ])
        .returning(),
    );
    const candidates = await director.get(`/tasks/${task.data.id}/record-candidates`);
    expect(candidates.data.map((r: { id: string }) => r.id)).toEqual([done.id]);
    expect((await director.post(`/tasks/${task.data.id}/complete`, { recordId: planned.id })).body.error.code).toBe('RECORD_REQUIRED');
  });

  it("counts from the business day in Tashkent on which the task was set", () => {
    // 01:30 on 9 November in Tashkent is still 8 November in UTC.
    expect(recordsFrom({ createdAt: new Date('2026-11-08T20:30:00Z') }, 'Asia/Tashkent')).toBe('2026-11-09');
    expect(recordsFrom({ createdAt: new Date('2026-11-09T18:59:00Z') }, 'Asia/Tashkent')).toBe('2026-11-09');
  });

  it('the board can list closed tasks by when they were closed', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const old = await director.post('/tasks', { title: 'Eski', dueDate: addDays(today(), -30) });
    const recent = await director.post('/tasks', { title: 'Yangi', dueDate: addDays(today(), 5) });
    // Closed in the opposite order to their due dates: the old one last.
    await director.post(`/tasks/${recent.data.id}/complete`, {});
    await director.post(`/tasks/${old.data.id}/complete`, {});
    const list = await director.get('/tasks', { status: 'done', sort: '-completedAt' });
    expect(list.data.map((r: { title: string }) => r.title)).toEqual(['Eski', 'Yangi']);
    expect(list.body.meta.total).toBe(2);
  });
});

describe('deadlines open the sales tab they are about', () => {
  it('contracts open the contracts tab and state reports the reports tab, in the calendar and the alert', async () => {
    const f = await createFixture();
    const day = addDays(today(), 5);
    await f.run(async () => {
      const [counterparty] = await tx().insert(schema.counterparties).values({ ...base(f), name: 'Agro LLC', type: 'buyer' }).returning();
      await tx().insert(schema.contracts).values({ ...base(f), number: 'YS-2026/14', counterpartyId: counterparty.id, endDate: day });
      await tx().insert(schema.stateReports).values({ ...base(f), title: 'Veterinariya oylik hisoboti', authority: 'Vetqo\'mita', dueDate: day });
    });
    const director = await f.as('director');
    const items = (await director.get('/tasks/calendar', { from: today(), to: addDays(today(), 10) })).data;
    const linkOf = (kind: string) => items.find((i: { kind: string }) => i.kind === kind)?.link;
    expect(linkOf('contract')).toBe('/sales?tab=contracts');
    expect(linkOf('state_report')).toBe('/sales?tab=grants');

    await f.run(() => evaluateRules());
    const [alert] = await f.run(() => tx().select().from(alerts).where(and(eq(alerts.farmId, f.farmId), eq(alerts.ruleKey, 'contract_expiring'))));
    expect(alert.link).toBe('/sales?tab=contracts');
  });
});

describe('a message whose decision is taken', () => {
  // A stand-in for cash handed over: open until pressed, then decided.
  const decided = new Set<string>();
  registerAction('demo_decision', {
    async buttons(id) {
      return decided.has(id) ? [] : [{ key: 'ok', label: 'finance:cashHolders.actions.accept', tone: 'primary' }];
    },
    async run(id) {
      decided.add(id);
      return { message: 'finance:cashHolders.actions.accepted' };
    },
  });

  it('says it was answered instead of still asking for a press', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const id = crypto.randomUUID();
    await f.run(() => notifyUser(director.userId, { title: 'Sizga naqd pul berildi', body: 'Oldim tugmasini bosing.', action: { kind: 'demo_decision', id } }));

    const before = (await director.get('/notifications')).data[0];
    expect(before.action).toMatchObject({ kind: 'demo_decision', id, state: null });
    expect(before.action.buttons.map((b: { key: string }) => b.key)).toEqual(['ok']);

    expect((await director.post('/notifications/actions', { kind: 'demo_decision', id, button: 'ok' })).status).toBe(200);
    const after = (await director.get('/notifications')).data[0];
    expect(after.action).toMatchObject({ buttons: [], state: { label: 'alerts:inbox.answered' } });
  });

  it('offers only channels that exist', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const prefs = (await owner.get('/notifications/preferences')).data;
    expect(prefs.channels.map((c: { key: string }) => c.key)).toEqual(['telegram']);
  });
});
