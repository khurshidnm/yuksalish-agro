import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays, monthOf, monthRange, todayIso } from '@yap/shared';
import { resources } from '@yap/shared/i18n';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { addMember } from '../src/core/tenancy';
import { ALERT_TASK_DUE_DAYS, ALERT_TASK_PRIORITY, raiseAlert, resolveByDedupKey, type RaiseAlertInput } from '../src/modules/alerts/alerts.service';
import { createFixture, type Client, type Fixture } from './helpers';

const { alerts, events, herds, tasks } = schema;

const today = todayIso();
/** The dictionaries the server writes task text from. */
const ruleNames = (lang: 'uz' | 'ru' | 'en') => (resources[lang].alerts as { ruleNames: Record<string, string> }).ruleNames;
const RESOLVED_NOTE = (resources.uz.tasks as { alertResolvedNote: string }).alertResolvedNote;
const base = (f: Fixture) => ({ tenantId: f.tenantId, farmId: f.farmId });

const sick: RaiseAlertInput = {
  ruleKey: 'animal_sick',
  dedupKey: 'animal_sick:1',
  severity: 'attention',
  title: 'Kasal hayvon',
  body: 'Qoʻy oqsayapti',
  link: '/livestock/animals',
};

async function raise(f: Fixture, over: Partial<RaiseAlertInput> = {}) {
  const { id } = await f.run(() => raiseAlert({ ...sick, ...over }));
  return id;
}

const alertRow = async (f: Fixture, id: string) => (await f.run(() => tx().select().from(alerts).where(eq(alerts.id, id))))[0];
const taskRow = async (f: Fixture, id: string) => (await f.run(() => tx().select().from(tasks).where(eq(tasks.id, id))))[0];
const tasksOfAlert = (f: Fixture, alertId: string) => f.run(() => tx().select().from(tasks).where(eq(tasks.alertId, alertId)));
const eventsOf = (f: Fixture, type: string, entityId: string) =>
  f.run(() => tx().select().from(events).where(and(eq(events.type, type), eq(events.entityId, entityId))));

async function taskFromAlert(client: Client, alertId: string, body: object = {}) {
  const res = await client.post(`/alerts/${alertId}/task`, body);
  expect(res.status).toBe(201);
  return res.data as { id: string; title: string; status: string };
}

describe('a task from an alert', () => {
  it('takes its words, priority, link and date from the alert', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    const [herd] = await f.run(() => tx().insert(herds).values({ ...base(f), name: 'Poda 1' }).returning());
    const urgent = await raise(f, { severity: 'urgent', entityType: 'herd', entityId: herd.id });
    const info = await raise(f, { dedupKey: 'animal_sick:2', severity: 'info', entityType: 'stock_batch', entityId: herd.id });

    const res = await director.post(`/alerts/${urgent}/task`, { assigneeUserId: shepherd.userId });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      title: 'Kasal hayvon',
      description: 'Qoʻy oqsayapti',
      priority: ALERT_TASK_PRIORITY.urgent,
      dueDate: today,
      status: 'open',
      assigneeUserId: shepherd.userId,
      entityType: 'herd',
      entityId: herd.id,
      alertId: urgent,
      link: '/livestock/animals',
    });
    expect(res.data.priority).toBe('high');
    const [created] = await eventsOf(f, 'task.created', res.data.id);
    expect(created.data).toMatchObject({ alertId: urgent, auto: false });
    expect(created.createdBy).toBe(director.userId);

    // A date the person chose wins; without one the severity decides. A task cannot hold a stock batch, so that link is dropped.
    const quiet = await taskFromAlert(director, info);
    expect(quiet).toMatchObject({ priority: 'low', dueDate: addDays(today, ALERT_TASK_DUE_DAYS.info), entityType: null, entityId: null, assigneeUserId: null });
    const chosen = await raise(f, { dedupKey: 'animal_sick:3' });
    expect(await taskFromAlert(director, chosen, { dueDate: addDays(today, 30) })).toMatchObject({ priority: 'normal', dueDate: addDays(today, 30) });

    // The alert shows its task, in the list and by itself.
    const list = await director.get('/alerts', { id: urgent });
    expect(list.data).toHaveLength(1);
    expect(list.data[0].task).toMatchObject({ id: res.data.id, status: 'open', assigneeUserId: shepherd.userId });
    expect(list.data[0].task.assigneeName).toContain('shepherd');
    expect((await director.get(`/alerts/${urgent}`)).data.task.id).toBe(res.data.id);
    expect((await director.get('/tasks', { alertId: urgent })).data.map((t: { id: string }) => t.id)).toEqual([res.data.id]);

    // The name of the person is personal data.
    const zootechnician = await f.as('zootechnician');
    const hidden = (await zootechnician.get(`/alerts/${urgent}`)).data.task;
    expect(hidden).toMatchObject({ id: res.data.id, status: 'open', assigneeName: null });
  });

  it('an alert has one open task: a second request and a race both return it', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const zootechnician = await f.as('zootechnician');
    const alertId = await raise(f);

    const both = await Promise.all([director.post(`/alerts/${alertId}/task`, {}), zootechnician.post(`/alerts/${alertId}/task`, {})]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(both[0].data.id).toBe(both[1].data.id);

    const again = await director.post(`/alerts/${alertId}/task`, { dueDate: addDays(today, 9) });
    expect(again.status).toBe(200);
    expect(again.data.id).toBe(both[0].data.id);
    expect(again.data.dueDate).toBe(addDays(today, ALERT_TASK_DUE_DAYS.attention));
    expect(await tasksOfAlert(f, alertId)).toHaveLength(1);
    expect(await eventsOf(f, 'task.created', again.data.id)).toHaveLength(1);
  });

  it('refuses whoever cannot create tasks, cannot see the alert, or belongs to another farm', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    const mechanic = await f.as('mechanic');
    const alertId = await raise(f, { notify: ['shepherd'] });

    // The shepherd sees this alert, but does not hand out work.
    expect((await shepherd.get(`/alerts/${alertId}`)).status).toBe(200);
    expect((await shepherd.post(`/alerts/${alertId}/task`, {})).status).toBe(403);
    expect((await mechanic.post(`/alerts/${alertId}/task`, {})).status).toBe(403);
    expect((await mechanic.get(`/alerts/${alertId}`)).status).toBe(404);
    expect(await tasksOfAlert(f, alertId)).toHaveLength(0);

    const other = await createFixture();
    const stranger = await other.as('owner');
    expect((await stranger.post(`/alerts/${alertId}/task`, {})).status).toBe(404);
    expect((await stranger.get(`/alerts/${alertId}`)).status).toBe(404);
    expect((await director.post(`/alerts/${alertId}/task`, { assigneeUserId: stranger.userId })).status).toBe(400);
    expect(await tasksOfAlert(f, alertId)).toHaveLength(0);

    const task = await taskFromAlert(director, alertId);
    expect((await stranger.get(`/tasks/${task.id}`)).status).toBe(404);
    expect((await stranger.get('/tasks', { alertId })).data).toEqual([]);
    expect((await stranger.get('/alerts', { id: alertId })).data).toEqual([]);

    // A problem that is over needs no task.
    await director.post(`/alerts/${alertId}/resolve`);
    const late = await director.post(`/alerts/${alertId}/task`, {});
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ALERT_ALREADY_RESOLVED');
  });

  it('an alert about money gives a task that says no figure', async () => {
    const f = await createFixture();
    const accountant = await f.as('accountant');
    const zootechnician = await f.as('zootechnician');
    const alertId = await raise(f, {
      ruleKey: 'budget_overrun',
      dedupKey: 'budget_overrun:feed',
      title: 'Ozuqa byudjeti 12 345 678 soʻmga oshdi',
      body: 'Reja 50 000 000, fakt 62 345 678',
      data: { category: 'Ozuqa', amount: 12_345_678, plan: 50_000_000 },
      link: '/finance/budgets',
      permission: 'finance.view',
    });

    // Sees tasks and may create them, but not finance: the alert does not exist for this person.
    expect((await zootechnician.get(`/alerts/${alertId}`)).status).toBe(404);
    expect((await zootechnician.post(`/alerts/${alertId}/task`, {})).status).toBe(404);
    expect((await zootechnician.get('/alerts')).data).toEqual([]);

    const task = await taskFromAlert(accountant, alertId, { assigneeUserId: zootechnician.userId });
    expect(task.title).toBe(`Tekshirish: ${ruleNames('uz').budget_overrun}`);

    const seen = await zootechnician.get(`/tasks/${task.id}`);
    expect(seen.status).toBe(200);
    const everything = JSON.stringify([
      seen.data,
      (await zootechnician.get('/tasks')).data,
      (await zootechnician.get('/notifications')).data,
      await eventsOf(f, 'task.created', task.id),
    ]);
    expect(everything).toContain('Tekshirish');
    for (const secret of ['12 345 678', '12345678', '50 000 000', '50000000', '62 345 678', 'Ozuqa byudjeti']) expect(everything).not.toContain(secret);
  });
});

describe('closing the loop', () => {
  it('a resolved alert closes its task in the name of nobody, by all three roads', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');

    // By hand.
    const byHand = await raise(f);
    const first = await taskFromAlert(director, byHand, { assigneeUserId: shepherd.userId });
    expect((await director.post(`/alerts/${byHand}/resolve`)).status).toBe(200);
    expect(await taskRow(f, first.id)).toMatchObject({
      status: 'done',
      completedBy: null,
      completionSource: 'alert_resolved',
      completionNote: RESOLVED_NOTE,
    });
    const [closed] = await eventsOf(f, 'task.completed', first.id);
    expect(closed).toMatchObject({ source: 'system', data: { alertId: byHand, completionSource: 'alert_resolved' } });
    expect((await director.get('/alerts', { id: byHand })).data[0].task).toMatchObject({ status: 'done', completionSource: 'alert_resolved' });

    // By the module that raised it.
    const byModule = await raise(f, { dedupKey: 'animal_sick:2' });
    const second = await taskFromAlert(director, byModule);
    await director.post(`/tasks/${second.id}/start`);
    expect(await f.run(() => resolveByDedupKey('animal_sick:2'))).toBe(true);
    expect(await taskRow(f, second.id)).toMatchObject({ status: 'done', completedBy: null, completionSource: 'alert_resolved' });

    // By the rule engine, when the rule no longer finds the problem.
    const [overdue] = await f.run(() =>
      tx().insert(tasks).values({ ...base(f), title: 'Kechikkan ish', dueDate: addDays(today, -3) }).returning(),
    );
    await director.post('/alerts/evaluate');
    const [found] = await f.run(() => tx().select().from(alerts).where(and(eq(alerts.farmId, f.farmId), eq(alerts.dedupKey, 'tasks_overdue'))));
    expect(found.status).toBe('open');
    const third = await taskFromAlert(director, found.id, { assigneeUserId: shepherd.userId });
    expect((await director.post(`/tasks/${overdue.id}/complete`, {})).status).toBe(200);
    await director.post('/alerts/evaluate');
    expect((await alertRow(f, found.id)).status).toBe('resolved');
    expect(await taskRow(f, third.id)).toMatchObject({ status: 'done', completedBy: null, completionSource: 'alert_resolved' });

    // None of the three is the shepherd's own work.
    expect((await shepherd.get('/tasks/on-time')).data).toMatchObject({ onTime: 0, due: 0, percent: null });
  });

  it('a task that needs a record stays open when the alert resolves', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const alertId = await raise(f);
    const task = await taskFromAlert(director, alertId);
    expect((await director.patch(`/tasks/${task.id}`, { requiresRecord: 'daily_log' })).status).toBe(200);
    await director.post(`/alerts/${alertId}/resolve`);
    expect(await taskRow(f, task.id)).toMatchObject({ status: 'open', completedAt: null, completionSource: null });
    // And a person still cannot close it without that record.
    const res = await director.post(`/tasks/${task.id}/complete`, {});
    expect(res.status).toBe(400);
  });

  it('a person completing the task takes the alert, and does not resolve it', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    const alertId = await raise(f, { severity: 'urgent' });
    const task = await taskFromAlert(director, alertId, { assigneeUserId: shepherd.userId });

    expect((await shepherd.post(`/tasks/${task.id}/complete`, { note: 'Davolandi' })).status).toBe(200);
    expect(await taskRow(f, task.id)).toMatchObject({ status: 'done', completedBy: shepherd.userId, completionSource: 'person' });
    const alert = await alertRow(f, alertId);
    expect(alert).toMatchObject({ status: 'acknowledged', acknowledgedBy: shepherd.userId, resolvedAt: null, nextNotifyAt: null });
    expect(await eventsOf(f, 'alert.acknowledged', alertId)).toHaveLength(1);
    expect((await shepherd.get('/tasks/on-time')).data).toMatchObject({ onTime: 1, due: 1, percent: 100 });

    // Someone had already taken it: the name on the alert stays.
    const taken = await raise(f, { dedupKey: 'animal_sick:2' });
    const next = await taskFromAlert(director, taken, { assigneeUserId: shepherd.userId });
    expect((await director.post(`/alerts/${taken}/acknowledge`)).status).toBe(200);
    await shepherd.post(`/tasks/${next.id}/complete`, {});
    expect(await alertRow(f, taken)).toMatchObject({ status: 'acknowledged', acknowledgedBy: director.userId });

    // The work is done but the problem is still there, so the next task is a new one.
    const followUp = await director.post(`/alerts/${taken}/task`, {});
    expect(followUp.status).toBe(201);
    expect(followUp.data.id).not.toBe(next.id);
    const reopened = await director.post(`/tasks/${next.id}/reopen`);
    expect(reopened.status).toBe(409);
    expect(reopened.body.error.code).toBe('ALERT_TASK_EXISTS');
  });

  it('cancelling the task leaves the alert alone and allows another', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const alertId = await raise(f);
    const task = await taskFromAlert(director, alertId);

    expect((await director.post(`/tasks/${task.id}/cancel`)).status).toBe(200);
    expect(await alertRow(f, alertId)).toMatchObject({ status: 'open', acknowledgedBy: null });
    expect((await director.get(`/alerts/${alertId}`)).data.task).toBeNull();

    const next = await taskFromAlert(director, alertId);
    expect(next.id).not.toBe(task.id);
    expect((await director.get(`/alerts/${alertId}`)).data.task.id).toBe(next.id);

    const reopened = await director.post(`/tasks/${task.id}/reopen`);
    expect(reopened.status).toBe(409);
    expect(reopened.body.error.code).toBe('ALERT_TASK_EXISTS');
    await director.post(`/tasks/${next.id}/cancel`);
    expect((await director.post(`/tasks/${task.id}/reopen`)).status).toBe(200);
  });
});

describe('a task by itself, per rule', () => {
  it('is off unless the farm switched the rule on', async () => {
    const f = await createFixture();
    const alertId = await raise(f);
    expect(await tasksOfAlert(f, alertId)).toHaveLength(0);
  });

  it('a new alert of a rule that is on gets its task, given to the one holder of the role', async () => {
    const f = await createFixture({
      settings: { alerts: { autoTask: { animal_sick: { enabled: true, assigneeRole: 'veterinarian' }, feed_low: { enabled: false } } } },
    });
    const vet = await f.as('veterinarian');
    const alertId = await raise(f, { severity: 'urgent' });

    const [task] = await tasksOfAlert(f, alertId);
    expect(task).toMatchObject({
      title: 'Kasal hayvon',
      priority: 'high',
      dueDate: today,
      status: 'open',
      assigneeUserId: vet.userId,
      createdBy: null,
      link: '/livestock/animals',
    });
    const [created] = await eventsOf(f, 'task.created', task.id);
    expect(created).toMatchObject({ source: 'system', data: { alertId, auto: true } });

    // The same problem seen again, even more severe, is not a new alert.
    await raise(f, { severity: 'urgent', body: 'Yana' });
    expect(await tasksOfAlert(f, alertId)).toHaveLength(1);
    // A rule that is off, and one nobody chose, get none.
    expect(await tasksOfAlert(f, await raise(f, { ruleKey: 'feed_low', dedupKey: 'feed_low' }))).toHaveLength(0);
    expect(await tasksOfAlert(f, await raise(f, { ruleKey: 'other', dedupKey: 'other' }))).toHaveLength(0);

    // Pressing the button on it gives the same task.
    const director = await f.as('director');
    const pressed = await director.post(`/alerts/${alertId}/task`, {});
    expect(pressed.status).toBe(200);
    expect(pressed.data.id).toBe(task.id);
  });

  it('a role held by two people, or by nobody, leaves the task unassigned', async () => {
    const f = await createFixture({
      settings: {
        alerts: {
          autoTask: {
            animal_sick: { enabled: true, assigneeRole: 'shepherd' },
            feed_low: { enabled: true, assigneeRole: 'storekeeper' },
            ration_deviation: { enabled: true },
          },
        },
      },
    });
    await f.as('shepherd');
    await addMember({
      tenantId: f.tenantId,
      farmId: f.farmId,
      roleId: f.roleIds.shepherd,
      phone: `+998${Math.floor(100_000_000 + Math.random() * 899_999_999)}`,
      fullName: 'Ikkinchi cho`pon',
      password: 'Password123!',
    });

    const two = await tasksOfAlert(f, await raise(f));
    expect(two).toHaveLength(1);
    expect(two[0].assigneeUserId).toBeNull();
    const none = await tasksOfAlert(f, await raise(f, { ruleKey: 'feed_low', dedupKey: 'feed_low' }));
    expect(none).toHaveLength(1);
    expect(none[0].assigneeUserId).toBeNull();
    const noRole = await tasksOfAlert(f, await raise(f, { ruleKey: 'ration_deviation', dedupKey: 'ration_deviation' }));
    expect(noRole).toHaveLength(1);
    expect(noRole[0].assigneeUserId).toBeNull();
  });

  it('is switched on in settings, rule by rule, by whoever may change settings', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');

    const before = await owner.get('/alerts/rules');
    expect(before.status).toBe(200);
    expect(before.data.length).toBeGreaterThan(20);
    expect(before.data.every((rule: { enabled: boolean }) => rule.enabled === false)).toBe(true);
    // Every rule in the list has a name in each language.
    for (const lang of ['uz', 'ru', 'en'] as const) {
      for (const rule of before.data) expect(ruleNames(lang)[rule.ruleKey], `${lang} ${rule.ruleKey}`).toBeTruthy();
    }

    expect((await director.patch('/settings/policy', { alerts: { autoTask: { tasks_overdue: { enabled: true } } } })).status).toBe(403);
    expect((await shepherd.get('/alerts/rules')).status).toBe(403);
    expect((await owner.patch('/settings/policy', { alerts: { autoTask: { tasks_overdue: { enabled: true, assigneeRole: 'boss' } } } })).status).toBe(400);

    expect((await owner.patch('/settings/policy', { alerts: { autoTask: { tasks_overdue: { enabled: true, assigneeRole: 'director' } } } })).status).toBe(200);
    // A second rule does not forget the first, and other sections are untouched.
    expect((await owner.patch('/settings/policy', { alerts: { autoTask: { feed_low: { enabled: true } } } })).status).toBe(200);
    const after = (await owner.get('/alerts/rules')).data as { ruleKey: string; enabled: boolean; assigneeRole: string | null }[];
    expect(after.find((rule) => rule.ruleKey === 'tasks_overdue')).toEqual({ ruleKey: 'tasks_overdue', enabled: true, assigneeRole: 'director' });
    expect(after.filter((rule) => rule.enabled).map((rule) => rule.ruleKey).sort()).toEqual(['feed_low', 'tasks_overdue']);

    // The rule engine finds a late task: its alert comes with a task for the director.
    await f.run(() => tx().insert(tasks).values({ ...base(f), title: 'Kechikkan ish', dueDate: addDays(today, -1) }));
    expect((await owner.post('/alerts/evaluate')).status).toBe(200);
    const [alert] = await f.run(() => tx().select().from(alerts).where(and(eq(alerts.farmId, f.farmId), eq(alerts.dedupKey, 'tasks_overdue'))));
    const made = await tasksOfAlert(f, alert.id);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ assigneeUserId: director.userId, link: '/tasks', priority: 'normal', dueDate: addDays(today, ALERT_TASK_DUE_DAYS.attention) });
    await owner.post('/alerts/evaluate');
    expect(await tasksOfAlert(f, alert.id)).toHaveLength(1);

    // Switched off again: the next alert gets none.
    await owner.patch('/settings/policy', { alerts: { autoTask: { tasks_overdue: { enabled: false } } } });
    await owner.post(`/alerts/${alert.id}/resolve`);
    await owner.post('/alerts/evaluate');
    const alertsNow = await f.run(() => tx().select().from(alerts).where(and(eq(alerts.farmId, f.farmId), eq(alerts.dedupKey, 'tasks_overdue'), eq(alerts.status, 'open'))));
    expect(alertsNow).toHaveLength(1);
    expect(await tasksOfAlert(f, alertsNow[0].id)).toHaveLength(0);
  });
});

describe('tasks done on time', () => {
  /** September 2026, long past, so every open task in it is late. */
  const MONTH = '2026-09';
  const FROM = '2026-09-01';
  const TO = '2026-09-30';

  const hire = async (owner: Client, over: object) => {
    const res = await owner.post('/hr/employees', {
      fullName: 'Alisher Navro',
      position: "Cho'pon",
      hireDate: '2026-01-01',
      payType: 'monthly',
      baseRate: 0,
      ...over,
    });
    expect(res.status).toBe(201);
    return res.data as { id: string };
  };

  it('control numbers: 2 of 5, with 23:30 in Tashkent on time, and the bonus that follows', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const shepherd = await f.as('shepherd');
    const mechanic = await f.as('mechanic');
    const vet = await f.as('veterinarian');
    const worker = await hire(owner, { userId: shepherd.userId });
    const late = await hire(owner, { userId: mechanic.userId, fullName: 'Kech Qolgan' });
    const idle = await hire(owner, { userId: vet.userId, fullName: 'Vazifasiz' });
    const noLogin = await hire(owner, { fullName: 'Loginsiz' });

    const mine = { ...base(f), assigneeUserId: shepherd.userId };
    const done = (dueDate: string, completedAt: string, completedBy: string | null = shepherd.userId) => ({
      ...mine,
      title: `${dueDate} ${completedAt}`,
      dueDate,
      status: 'done',
      completedAt: new Date(completedAt),
      completedBy,
      completionSource: 'person',
    });
    await f.run(() =>
      tx().insert(tasks).values([
        // 23:30 in Tashkent on the due date: on time.
        done('2026-09-10', '2026-09-10T18:30:00Z'),
        // 00:30 the next day in Tashkent, though still the 10th in UTC: late.
        done('2026-09-10', '2026-09-10T19:30:00Z'),
        // Closed in time, but by the manager: due, and not the shepherd's own.
        done('2026-09-15', '2026-09-14T06:00:00Z', owner.userId),
        // Never done.
        { ...mine, title: 'Ochiq', dueDate: '2026-09-20' },
        // Done early.
        done('2026-09-28', '2026-09-20T06:00:00Z'),
        // Not counted at all: cancelled, closed by the system, due in another month, a recurring series, no date.
        { ...mine, title: 'Bekor', dueDate: '2026-09-22', status: 'cancelled' },
        { ...done('2026-09-25', '2026-09-24T06:00:00Z', null), completionSource: 'alert_resolved' },
        done('2026-10-01', '2026-10-01T06:00:00Z'),
        { ...mine, title: 'Har kuni', dueDate: '2026-09-05', recurrence: 'daily' },
        { ...mine, title: 'Sanasiz' },
        // The mechanic: one task, done a day late.
        { ...done('2026-09-12', '2026-09-13T06:00:00Z', mechanic.userId), assigneeUserId: mechanic.userId },
      ]),
    );

    const work = await owner.get('/hr/work-done', { from: FROM, to: TO });
    expect(work.status).toBe(200);
    const row = (id: string) => work.data.find((r: { employeeId: string }) => r.employeeId === id);
    // 2 on time of 5 due = 40 %
    expect(row(worker.id)).toMatchObject({ tasksOnTime: 2, tasksDue: 5, tasksOnTimePercent: 40 });
    expect(row(late.id)).toMatchObject({ tasksOnTime: 0, tasksDue: 1, tasksOnTimePercent: 0 });
    // Nothing fell due: no row for tasks alone, and no figure invented.
    expect(row(idle.id)).toBeUndefined();
    expect(row(noLogin.id)).toBeUndefined();

    const rule = await owner.post('/hr/kpi-rules', { name: 'Vazifalar', metric: 'tasks_on_time', threshold: 30, rewardType: 'fixed', amount: 500_000 });
    expect(rule.status).toBe(201);
    const run = await owner.post('/hr/payroll', { month: MONTH });
    expect(run.status).toBe(201);
    const line = (id: string) => run.data.lines.find((l: { employeeId: string }) => l.employeeId === id);
    expect(line(worker.id).basis.kpi[0]).toMatchObject({ value: 40, bonus: 500_000 });
    expect(line(worker.id).bonus).toBe(500_000);
    // 0 % is a result and earns nothing; no tasks is no data, and earns what the rule gives no data: nothing.
    expect(line(late.id).basis.kpi[0]).toMatchObject({ value: 0, bonus: 0 });
    expect(line(idle.id).basis.kpi[0].value).toBeNull();
    expect(line(idle.id).bonus).toBe(0);
    expect(line(noLogin.id).basis.kpi[0].value).toBeNull();
    expect(line(noLogin.id).bonus).toBe(0);

    // The figure is not for everyone: work done and payroll keep their own permissions.
    expect((await shepherd.get('/hr/work-done', { from: FROM, to: TO })).status).toBe(403);
    expect((await shepherd.post('/hr/payroll', { month: MONTH })).status).toBe(403);
  });

  it('each person sees their own figure for this month', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    const mechanic = await f.as('mechanic');
    const { from, to } = monthRange(monthOf(today));

    expect((await shepherd.get('/tasks/on-time')).data).toEqual({ from, to, onTime: 0, due: 0, percent: null });

    const task = await director.post('/tasks', { title: 'Bugungi ish', assigneeUserId: shepherd.userId, dueDate: today });
    // Open and not late yet: not counted.
    expect((await shepherd.get('/tasks/on-time')).data).toMatchObject({ onTime: 0, due: 0, percent: null });
    await shepherd.post(`/tasks/${task.data.id}/complete`, {});
    expect((await shepherd.get('/tasks/on-time')).data).toEqual({ from, to, onTime: 1, due: 1, percent: 100 });
    expect((await mechanic.get('/tasks/on-time')).data).toMatchObject({ onTime: 0, due: 0, percent: null });
    expect((await f.as('investor').then((c) => c.get('/tasks/on-time'))).status).toBe(403);
  });
});
