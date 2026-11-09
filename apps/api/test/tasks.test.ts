import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { addDays, todayIso, type RoleKey } from '@yap/shared';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { taskSummary } from '../src/modules/tasks/summary';
import { generateRecurringTasks, latestOccurrence } from '../src/modules/tasks/tasks.service';
import { SEED } from '../src/seed/names';
import { seedTasks } from '../src/seed/tasks';
import { createFixture, type Fixture } from './helpers';

const { assets, breedingRecords, documents, fieldOperations, fields, files, healthRecords, herds, animals, loanInstalments, loans, maintenanceRecords, notifications, species, tasks } = schema;

const today = todayIso();
const base = (f: Fixture) => ({ tenantId: f.tenantId, farmId: f.farmId });

const makeHerd = (f: Fixture, name = 'Poda') =>
  f.run(async () => {
    const [row] = await tx().insert(herds).values({ ...base(f), name: `${name} ${Math.random()}` }).returning();
    return row;
  });

const makeFile = (f: Fixture) =>
  f.run(async () => {
    const [row] = await tx()
      .insert(files)
      .values({ ...base(f), storageKey: 'k', name: 'a.png', mimeType: 'image/png', sizeBytes: 1 })
      .returning();
    return row;
  });

describe('task permissions and visibility', () => {
  it('managers create and see all; field staff work only their own', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    const mechanic = await f.as('mechanic');

    const mine = await director.post('/tasks', { title: 'Ozuqa berish', assigneeUserId: shepherd.userId });
    expect(mine.status).toBe(201);
    expect(mine.data.assigneeName).toContain('shepherd');
    await director.post('/tasks', { title: 'Plug ta\'mirlash', assigneeUserId: mechanic.userId });

    expect((await director.get('/tasks')).body.meta.total).toBe(2);
    const seen = await shepherd.get('/tasks');
    expect(seen.body.data.map((t: any) => t.title)).toEqual(['Ozuqa berish']);

    // Someone else's task does not exist for them.
    const theirs = (await mechanic.get('/tasks')).body.data[0];
    expect((await shepherd.get(`/tasks/${theirs.id}`)).status).toBe(404);
    expect((await shepherd.post(`/tasks/${theirs.id}/start`)).status).toBe(404);
  });

  it('a shepherd cannot create or edit tasks, only carry them out', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    expect((await shepherd.post('/tasks', { title: 'X' })).status).toBe(403);

    const task = await director.post('/tasks', { title: 'Tozalash', assigneeUserId: shepherd.userId });
    expect((await shepherd.patch(`/tasks/${task.data.id}`, { title: 'Boshqa' })).status).toBe(403);
    expect((await shepherd.post(`/tasks/${task.data.id}/cancel`)).status).toBe(403);
    expect((await shepherd.post(`/tasks/${task.data.id}/start`)).data.status).toBe('in_progress');
    expect((await shepherd.post(`/tasks/${task.data.id}/complete`, {})).data.status).toBe('done');
  });

  it('investors have no access to tasks', async () => {
    const f = await createFixture();
    expect((await (await f.as('investor')).get('/tasks')).status).toBe(403);
  });

  it('cannot assign to someone outside the farm', async () => {
    const f = await createFixture();
    const other = await createFixture();
    const stranger = await other.as('shepherd');
    const response = await (await f.as('director')).post('/tasks', { title: 'X', assigneeUserId: stranger.userId });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ASSIGNEE_NOT_MEMBER');
  });

  it('another tenant cannot reach a task', async () => {
    const a = await createFixture();
    const b = await createFixture();
    const task = await (await a.as('director')).post('/tasks', { title: 'Sir' });
    const owner = await b.as('owner');
    expect((await owner.get(`/tasks/${task.data.id}`)).status).toBe(404);
    expect((await owner.patch(`/tasks/${task.data.id}`, { title: 'X' })).status).toBe(404);
  });

  it('assignment tells the assignee, but not when you assign yourself', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    await director.post('/tasks', { title: 'Sizga', assigneeUserId: shepherd.userId });
    await director.post('/tasks', { title: "O'zimga", assigneeUserId: director.userId });
    const inbox = await shepherd.get('/notifications');
    expect(inbox.body.data).toHaveLength(1);
    expect(inbox.body.data[0]).toMatchObject({ eventType: 'task_assigned', body: 'Sizga', link: '/tasks' });
    expect((await director.get('/notifications')).body.data).toEqual([]);
  });

  it('reassigning tells the new person', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    const task = await director.post('/tasks', { title: 'Vazifa' });
    await director.patch(`/tasks/${task.data.id}`, { assigneeUserId: shepherd.userId });
    expect((await shepherd.get('/notifications')).body.data).toHaveLength(1);
  });
});

describe('editing', () => {
  it('a PATCH changes only what it names', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const herd = await makeHerd(f);
    const task = await director.post('/tasks', {
      title: 'Asl',
      priority: 'high',
      requiresPhoto: true,
      requiresRecord: 'health_record',
      entityType: 'herd',
      entityId: herd.id,
      dueDate: today,
    });
    const patched = await director.patch(`/tasks/${task.data.id}`, { title: 'Yangi' });
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({
      title: 'Yangi',
      priority: 'high',
      requiresPhoto: true,
      requiresRecord: 'health_record',
      entityId: herd.id,
      dueDate: today,
    });
  });

  it('clears a field set to null', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const task = await director.post('/tasks', { title: 'X', dueDate: today });
    expect((await director.patch(`/tasks/${task.data.id}`, { dueDate: null })).data.dueDate).toBeNull();
  });

  it('an empty PATCH is refused rather than silently accepted', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const task = await director.post('/tasks', { title: 'X' });
    const event = await director.post('/tasks/calendar/events', { title: 'T', date: today });
    expect((await director.patch(`/tasks/${task.data.id}`, {})).body.error.code).toBe('NOTHING_TO_UPDATE');
    expect((await director.patch(`/tasks/calendar/events/${event.data.id}`, {})).body.error.code).toBe('NOTHING_TO_UPDATE');
  });

  it('a PATCH of an event keeps its kind', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const event = await director.post('/tasks/calendar/events', { title: 'T', kind: 'inspection', date: today });
    const patched = await director.patch(`/tasks/calendar/events/${event.data.id}`, { title: 'Y' });
    expect(patched.data).toMatchObject({ title: 'Y', kind: 'inspection' });
  });
});

describe('task list', () => {
  it('filters and shows what a task is linked to', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    const herd = await makeHerd(f, 'Bogoz');
    await director.post('/tasks', {
      title: 'Kechikkan',
      dueDate: addDays(today, -2),
      assigneeUserId: shepherd.userId,
      division: 'livestock',
      priority: 'high',
      entityType: 'herd',
      entityId: herd.id,
    });
    await director.post('/tasks', { title: 'Keyingi', dueDate: addDays(today, 3), division: 'crops' });
    const done = await director.post('/tasks', { title: 'Tugagan', dueDate: addDays(today, -5) });
    await director.post(`/tasks/${done.data.id}/complete`, {});

    const titles = async (query: Record<string, unknown>) =>
      (await director.get('/tasks', query)).body.data.map((t: any) => t.title);

    expect(await titles({ overdue: true })).toEqual(['Kechikkan']);
    expect(await titles({ division: 'crops' })).toEqual(['Keyingi']);
    expect(await titles({ priority: 'high' })).toEqual(['Kechikkan']);
    expect(await titles({ assigneeUserId: shepherd.userId })).toEqual(['Kechikkan']);
    expect(await titles({ status: 'done' })).toEqual(['Tugagan']);
    expect(await titles({ active: true })).toEqual(['Kechikkan', 'Keyingi']);
    expect(await titles({ search: 'keyin' })).toEqual(['Keyingi']);
    expect(await titles({ dueFrom: today, dueTo: addDays(today, 7) })).toEqual(['Keyingi']);
    expect(await titles({ entityType: 'herd', entityId: herd.id })).toEqual(['Kechikkan']);

    const [linked] = (await director.get('/tasks', { entityId: herd.id })).body.data;
    expect(linked.entityLabel).toBe(herd.name);
    expect(linked.entityLink).toBe(`/livestock/herds/${herd.id}`);

    const myView = await shepherd.get('/tasks', { mine: true });
    expect(myView.body.data).toHaveLength(1);
  });

  it('orders by due date with undated tasks last, and paginates', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    await director.post('/tasks', { title: 'Sanasiz' });
    await director.post('/tasks', { title: 'Ertaga', dueDate: addDays(today, 1) });
    await director.post('/tasks', { title: 'Bugun', dueDate: today });
    const page = await director.get('/tasks', { pageSize: 2 });
    expect(page.body.data.map((t: any) => t.title)).toEqual(['Bugun', 'Ertaga']);
    expect(page.body.meta.total).toBe(3);
  });

  it('rejects an unknown linked object type and a bad date', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    expect((await director.post('/tasks', { title: 'X', entityType: 'spaceship' })).status).toBe(400);
    expect((await director.post('/tasks', { title: 'X', dueDate: '2026-13-40' })).status).toBe(400);
    expect((await director.post('/tasks', { title: '' })).status).toBe(400);
  });
});

describe('completing tasks (spec 17.2)', () => {
  it('requires a photo when the task says so', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const task = await director.post('/tasks', { title: 'Foto bilan', requiresPhoto: true });

    const without = await director.post(`/tasks/${task.data.id}/complete`, {});
    expect(without.status).toBe(400);
    expect(without.body.error.code).toBe('PHOTO_REQUIRED');

    const made = await makeFile(f);
    const done = await director.post(`/tasks/${task.data.id}/complete`, { photoFileId: made.id, note: 'Bajarildi' });
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({ status: 'done', completionPhotoFileId: made.id, completionNote: 'Bajarildi', completedBy: director.userId });
  });

  it("refuses another tenant's file as proof", async () => {
    const a = await createFixture();
    const b = await createFixture();
    const foreign = await makeFile(b);
    const director = await a.as('director');
    const task = await director.post('/tasks', { title: 'Foto', requiresPhoto: true });
    const result = await director.post(`/tasks/${task.data.id}/complete`, { photoFileId: foreign.id });
    expect(result.body.error.code).toBe('PHOTO_REQUIRED');
  });

  it('a vaccination task closes only with a health record for its herd', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const herd = await makeHerd(f);
    const otherHerd = await makeHerd(f);
    const task = await director.post('/tasks', {
      title: 'Emlash',
      requiresRecord: 'health_record',
      entityType: 'herd',
      entityId: herd.id,
    });

    const missing = await director.post(`/tasks/${task.data.id}/complete`, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: 'RECORD_REQUIRED', details: { requires: 'health_record' } });

    const [wrong, right] = await f.run(() =>
      tx()
        .insert(healthRecords)
        .values([
          { ...base(f), type: 'vaccination', herdId: otherHerd.id, date: today },
          { ...base(f), type: 'vaccination', herdId: herd.id, date: today },
        ])
        .returning(),
    );
    const mismatched = await director.post(`/tasks/${task.data.id}/complete`, { recordId: wrong.id });
    expect(mismatched.body.error.code).toBe('RECORD_REQUIRED');

    const candidates = await director.get(`/tasks/${task.data.id}/record-candidates`);
    expect(candidates.data.map((r: any) => r.id)).toEqual([right.id]);

    const done = await director.post(`/tasks/${task.data.id}/complete`, { recordId: right.id });
    expect(done.status).toBe(200);
    expect(done.data.completionRecordId).toBe(right.id);
  });

  it('writes a journal event, and can be reopened', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const task = await director.post('/tasks', { title: 'Jurnal' });
    await director.post(`/tasks/${task.data.id}/complete`, {});
    const events = await f.run(() => tx().select().from(schema.events).where(eq(schema.events.entityId, task.data.id)));
    expect(events.map((e) => e.type).sort()).toEqual(['task.completed', 'task.created']);

    const again = await director.post(`/tasks/${task.data.id}/complete`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TASK_NOT_ACTIVE');

    const reopened = await director.post(`/tasks/${task.data.id}/reopen`);
    expect(reopened.data).toMatchObject({ status: 'open', completedAt: null, completionNote: null });
  });

  it('cancelled and deleted tasks behave', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const task = await owner.post('/tasks', { title: 'Bekor' });
    expect((await owner.post(`/tasks/${task.data.id}/cancel`)).data.status).toBe('cancelled');
    expect((await owner.post(`/tasks/${task.data.id}/complete`, {})).status).toBe(409);
    expect((await owner.delete(`/tasks/${task.data.id}`)).status).toBe(200);
    expect((await owner.get(`/tasks/${task.data.id}`)).status).toBe(404);
  });

  it('deleting needs the delete permission', async () => {
    const f = await createFixture();
    const agronomist = await f.as('agronomist');
    const task = await agronomist.post('/tasks', { title: 'X' });
    expect((await agronomist.delete(`/tasks/${task.data.id}`)).status).toBe(403);
  });
});

describe('recurrence', () => {
  it('computes the latest occurrence', () => {
    expect(latestOccurrence('2026-11-10', 'daily', '2026-11-04')).toBeNull();
    expect(latestOccurrence('2026-11-01', 'daily', '2026-11-04')).toBe('2026-11-04');
    expect(latestOccurrence('2026-11-02', 'weekly', '2026-11-04')).toBe('2026-11-02');
    expect(latestOccurrence('2026-11-02', 'weekly', '2026-11-09')).toBe('2026-11-09');
    expect(latestOccurrence('2026-11-02', 'weekly', '2026-11-15')).toBe('2026-11-09');
    expect(latestOccurrence('2026-10-15', 'monthly', '2026-11-14')).toBe('2026-10-15');
    expect(latestOccurrence('2026-10-15', 'monthly', '2026-11-15')).toBe('2026-11-15');
  });

  it('keeps a month-end series on month ends', () => {
    expect(latestOccurrence('2026-01-31', 'monthly', '2026-02-28')).toBe('2026-02-28');
    expect(latestOccurrence('2026-01-31', 'monthly', '2026-03-30')).toBe('2026-02-28');
    expect(latestOccurrence('2026-01-31', 'monthly', '2026-03-31')).toBe('2026-03-31');
    expect(latestOccurrence('2028-01-31', 'monthly', '2028-02-29')).toBe('2028-02-29');
  });

  it('crosses a year boundary', () => {
    expect(latestOccurrence('2026-11-20', 'monthly', '2027-01-25')).toBe('2027-01-20');
    expect(latestOccurrence('2026-12-30', 'weekly', '2027-01-06')).toBe('2027-01-06');
  });

  it('creates today\'s instance at once, and the job is safe to repeat', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    const series = await director.post('/tasks', {
      title: 'Ertalabki ozuqa',
      recurrence: 'daily',
      assigneeUserId: shepherd.userId,
      priority: 'high',
    });
    expect(series.status).toBe(201);

    expect(await f.run(() => generateRecurringTasks())).toBe(0); // already there
    expect(await f.run(() => generateRecurringTasks())).toBe(0);

    const instances = await shepherd.get('/tasks');
    expect(instances.body.data).toHaveLength(1);
    expect(instances.body.data[0]).toMatchObject({
      title: 'Ertalabki ozuqa',
      dueDate: today,
      templateId: series.data.id,
      recurrence: 'none',
      priority: 'high',
    });
  });

  it('a new day creates a new instance, and yesterday\'s stays', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const series = await director.post('/tasks', { title: 'Har kuni', recurrence: 'daily', dueDate: addDays(today, -3) });
    await f.run(() =>
      tx()
        .update(tasks)
        .set({ dueDate: addDays(today, -1), templateId: series.data.id })
        .where(and(eq(tasks.templateId, series.data.id), eq(tasks.dueDate, today))),
    );
    expect(await f.run(() => generateRecurringTasks())).toBe(1);
    const rows = (await director.get('/tasks')).body.data.map((t: any) => t.dueDate);
    expect(rows.sort()).toEqual([addDays(today, -1), today]);
  });

  it('after a gap, only the current occurrence is created, not a backlog', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    await director.post('/tasks', { title: 'Haftalik', recurrence: 'weekly', dueDate: addDays(today, -30) });
    const rows = (await director.get('/tasks')).body.data;
    expect(rows).toHaveLength(1);
    expect(rows[0].dueDate).toBe(addDays(today, -2)); // 28 days after the start
  });

  it('a series starting later creates nothing yet', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    await director.post('/tasks', { title: 'Keyin', recurrence: 'daily', dueDate: addDays(today, 5) });
    expect((await director.get('/tasks')).body.data).toEqual([]);
    expect((await director.get('/tasks', { recurring: true })).body.data).toHaveLength(1);
  });

  it('series are listed apart from tasks, and cannot be completed', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const series = await director.post('/tasks', { title: 'Seriya', recurrence: 'weekly' });
    const listed = await director.get('/tasks', { recurring: true });
    expect(listed.body.data.map((t: any) => t.id)).toEqual([series.data.id]);
    const closed = await director.post(`/tasks/${series.data.id}/complete`, {});
    expect(closed.body.error.code).toBe('TASK_IS_SERIES');
  });

  it('a cancelled series stops', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const series = await director.post('/tasks', { title: 'Tugadi', recurrence: 'daily', dueDate: addDays(today, -1) });
    await director.post(`/tasks/${series.data.id}/cancel`);
    await f.run(() => tx().delete(tasks).where(eq(tasks.templateId, series.data.id)));
    expect(await f.run(() => generateRecurringTasks())).toBe(0);
  });

  it('instances inherit photo and record requirements', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    await director.post('/tasks', { title: 'Tozalash', recurrence: 'daily', requiresPhoto: true });
    const [instance] = (await director.get('/tasks')).body.data;
    expect(instance.requiresPhoto).toBe(true);
    expect((await director.post(`/tasks/${instance.id}/complete`, {})).body.error.code).toBe('PHOTO_REQUIRED');
  });

  it('generating instances does not spam the assignee', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    await director.post('/tasks', { title: 'Har kuni', recurrence: 'daily', assigneeUserId: shepherd.userId });
    const rows = await f.run(() => tx().select().from(notifications).where(eq(notifications.userId, shepherd.userId)));
    expect(rows).toEqual([]);
  });
});

describe('calendar (spec 17.1)', () => {
  const range = { from: addDays(today, -1), to: addDays(today, 30) };

  async function populated() {
    const f = await createFixture();
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    const herd = await makeHerd(f);
    await f.run(async () => {
      const [sheep] = await tx().select().from(species).where(and(eq(species.tenantId, f.tenantId), eq(species.key, 'sheep')));
      const ewes = await tx()
        .insert(animals)
        .values(
          [1, 2, 3].map((i) => ({
            ...base(f),
            tag: `E${i}`,
            speciesId: sheep.id,
            sex: 'female',
            category: 'ewe',
            origin: 'purchased',
            herdId: herd.id,
          })),
        )
        .returning();
      const due = addDays(today, 5);
      await tx()
        .insert(breedingRecords)
        .values(
          ewes.slice(0, 2).map((e) => ({
            ...base(f),
            eweId: e.id,
            matingDate: addDays(due, -150),
            expectedDate: due,
            expectedEarliest: addDays(due, -5),
            expectedLatest: addDays(due, 2),
          })),
        );
      await tx().insert(breedingRecords).values({
        ...base(f),
        eweId: ewes[2].id,
        matingDate: addDays(due, -150),
        expectedDate: due,
        expectedEarliest: addDays(due, -5),
        expectedLatest: addDays(due, 2),
        status: 'lambed',
      });

      await tx().insert(healthRecords).values({
        ...base(f),
        type: 'vaccination',
        herdId: herd.id,
        date: addDays(today, -10),
        nextDueDate: addDays(today, 7),
        notes: 'x',
      });

      const [field] = await tx().insert(fields).values({ ...base(f), number: '7' }).returning();
      await tx().insert(fieldOperations).values([
        { ...base(f), type: 'irrigation', status: 'planned', date: addDays(today, 2), fieldId: field.id },
        { ...base(f), type: 'tillage', status: 'done', date: addDays(today, 2), fieldId: field.id },
      ]);

      const [loan] = await tx()
        .insert(loans)
        .values({ ...base(f), name: 'Agrobank', principal: 1000, annualRate: 14, termMonths: 12, startDate: today })
        .returning();
      await tx().insert(loanInstalments).values([
        { ...base(f), loanId: loan.id, period: 1, dueDate: addDays(today, 10), principal: 1, interest: 1, payment: 2, balance: 1 },
        { ...base(f), loanId: loan.id, period: 2, dueDate: addDays(today, 11), principal: 1, interest: 1, payment: 2, balance: 0, paidDate: today },
      ]);

      await tx().insert(documents).values({ ...base(f), type: 'land', title: 'Ijara', expiryDate: addDays(today, 12) });

      const [asset] = await tx().insert(assets).values({ ...base(f), name: 'MTZ', type: 'tractor' }).returning();
      await tx().insert(maintenanceRecords).values([
        { ...base(f), assetId: asset.id, date: addDays(today, -20), type: 'planned', nextDueDate: addDays(today, 3) },
        { ...base(f), assetId: asset.id, date: addDays(today, -5), type: 'planned', nextDueDate: addDays(today, 20) },
      ]);
    });
    await director.post('/tasks', { title: 'Vazifa', dueDate: addDays(today, 1), assigneeUserId: shepherd.userId, division: 'livestock' });
    await director.post('/tasks', { title: 'Boshqa', dueDate: addDays(today, 2) });
    await director.post('/tasks/calendar/events', { title: 'Uchrashuv', date: addDays(today, 4), division: 'admin', responsibleUserId: director.userId });
    return { f, director, shepherd };
  }

  it('shows state report deadlines and staff dates, with names only for HR readers', async () => {
    const f = await createFixture();
    const base = { tenantId: f.tenantId, farmId: f.farmId };
    const day = addDays(todayIso(), 5);
    await f.run(async () => {
      await tx().insert(schema.stateReports).values({ ...base, title: 'Statistika', authority: 'Statagentlik', dueDate: day });
      await tx().insert(schema.stateReports).values({ ...base, title: 'Topshirilgan', authority: 'Soliq', dueDate: day, status: 'submitted' });
      await tx().insert(schema.employees).values({
        ...base, fullName: 'Ali Valiyev', position: "Cho'pon", hireDate: '2026-01-01', contractEndDate: day, medicalCheckDate: day,
      });
    });
    const window = { from: todayIso(), to: addDays(todayIso(), 10) };
    const director = await f.as('director');
    const items = (await director.get('/tasks/calendar', window)).data;
    const of = (kind: string) => items.filter((i: any) => i.kind === kind);
    expect(of('state_report').map((i: any) => i.params.name)).toEqual(['Statistika']);
    expect(of('staff_contract')[0].params.name).toBe('Ali Valiyev');
    expect(of('staff_medical')).toHaveLength(1);

    const shepherd = await f.as('shepherd');
    expect(JSON.stringify((await shepherd.get('/tasks/calendar', window)).data)).not.toContain('Ali Valiyev');
  });

  it('gathers everything scheduled, with counts from the source tables', async () => {
    const { director } = await populated();
    const response = await director.get('/tasks/calendar', range);
    expect(response.status).toBe(200);
    const byKind = (kind: string) => response.data.filter((i: any) => i.kind === kind);

    // Three pregnant-looking records, but one has already lambed.
    expect(byKind('lambing')).toHaveLength(1);
    expect(byKind('lambing')[0]).toMatchObject({ date: addDays(today, 5), params: { count: 2 }, division: 'livestock' });
    expect(byKind('vaccination')).toHaveLength(1);
    expect(byKind('field_operation')).toHaveLength(1); // the done one is not scheduled work
    expect(byKind('field_operation')[0].params).toMatchObject({ operation: 'irrigation', field: '7' });
    expect(byKind('loan')).toHaveLength(1); // the paid instalment is gone
    expect(byKind('document')[0].params).toMatchObject({ name: 'Ijara' });
    expect(byKind('maintenance')[0].date).toBe(addDays(today, 20)); // only the newest record counts
    expect(byKind('task')).toHaveLength(2);
    expect(byKind('manual')[0]).toMatchObject({ title: 'Uchrashuv', responsibleName: expect.stringContaining('director') });

    const dates = response.data.map((i: any) => i.date);
    expect(dates).toEqual([...dates].sort());
  });

  it('a record with no plan or drug still has a usable calendar entry', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const herd = await makeHerd(f);
    await f.run(() =>
      tx()
        .insert(healthRecords)
        .values({ ...base(f), type: 'deworming', herdId: herd.id, date: addDays(today, -10), nextDueDate: addDays(today, 7) }),
    );
    const items = (await director.get('/tasks/calendar', { ...range, kinds: 'vaccination' })).data;
    expect(items).toHaveLength(1);
    expect(items[0].params).toEqual({ name: null, fromPlan: false, type: 'deworming', count: 1 });
  });

  it('filters by division, person and kind', async () => {
    const { director, shepherd } = await populated();
    const kinds = async (query: object) =>
      [...new Set((await director.get('/tasks/calendar', { ...range, ...query })).data.map((i: any) => i.kind))].sort();
    expect(await kinds({ division: 'crops' })).toEqual(['field_operation']);
    expect(await kinds({ division: 'admin' })).toEqual(['document', 'loan', 'manual']);
    expect(await kinds({ kinds: 'task,manual' })).toEqual(['manual', 'task']);
    expect(await kinds({ responsibleUserId: shepherd.userId })).toEqual(['task']);
  });

  it('a shepherd sees no money, and only their own tasks (rule 7)', async () => {
    const { shepherd } = await populated();
    const items = (await shepherd.get('/tasks/calendar', range)).data;
    const kinds = new Set(items.map((i: any) => i.kind));
    expect(kinds.has('loan')).toBe(false);
    expect(kinds.has('contract')).toBe(false);
    expect(kinds.has('document')).toBe(false);
    expect(items.filter((i: any) => i.kind === 'task').map((i: any) => i.title)).toEqual(['Vazifa']);
    expect(JSON.stringify(items)).not.toContain('Agrobank');
  });

  it('the range limits results and must be valid', async () => {
    const { director } = await populated();
    const none = await director.get('/tasks/calendar', { from: addDays(today, 100), to: addDays(today, 110) });
    expect(none.data).toEqual([]);
    expect((await director.get('/tasks/calendar', { from: addDays(today, 5), to: today })).status).toBe(400);
    expect((await director.get('/tasks/calendar')).status).toBe(400);
  });

  it('manual events: multi-day overlap, edit, delete', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    const trip = await director.post('/tasks/calendar/events', {
      title: 'Tekshiruv',
      kind: 'inspection',
      date: addDays(today, 1),
      endDate: addDays(today, 3),
    });
    expect(trip.status).toBe(201);

    const inside = await director.get('/tasks/calendar', { from: addDays(today, 2), to: addDays(today, 2) });
    expect(inside.data).toHaveLength(1);
    expect(inside.data[0]).toMatchObject({ endDate: addDays(today, 3), editableId: trip.data.id });

    expect((await director.patch(`/tasks/calendar/events/${trip.data.id}`, { title: 'Yangi' })).data.title).toBe('Yangi');
    const bad = await director.patch(`/tasks/calendar/events/${trip.data.id}`, { endDate: addDays(today, -5) });
    expect(bad.body.error.code).toBe('INVALID_DATE_RANGE');
    const backwards = await director.post('/tasks/calendar/events', { title: 'X', date: today, endDate: addDays(today, -1) });
    expect(backwards.body.error.code).toBe('INVALID_DATE_RANGE');

    expect((await director.delete(`/tasks/calendar/events/${trip.data.id}`)).status).toBe(200);
    expect((await director.delete(`/tasks/calendar/events/${trip.data.id}`)).status).toBe(404);
  });

  it('the responsible person must work on this farm', async () => {
    const f = await createFixture();
    const other = await createFixture();
    const stranger = await other.as('shepherd');
    const director = await f.as('director');
    const created = await director.post('/tasks/calendar/events', { title: 'X', date: today, responsibleUserId: stranger.userId });
    expect(created.body.error.code).toBe('ASSIGNEE_NOT_MEMBER');
    const event = await director.post('/tasks/calendar/events', { title: 'Y', date: today, responsibleUserId: director.userId });
    const patched = await director.patch(`/tasks/calendar/events/${event.data.id}`, { responsibleUserId: stranger.userId });
    expect(patched.body.error.code).toBe('ASSIGNEE_NOT_MEMBER');
  });

  it('manual events need the right permission', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    expect((await shepherd.post('/tasks/calendar/events', { title: 'X', date: today })).status).toBe(403);
  });
});

describe('demo seed', () => {
  it('runs against a farm and leaves work, events and real alerts behind', async () => {
    const f = await createFixture();
    const roles = ['owner', 'director', 'shepherd', 'veterinarian', 'mechanic', 'agronomist', 'storekeeper', 'zootechnician'] as const;
    const users = Object.fromEntries(
      await Promise.all(roles.map(async (role) => [role, (await f.as(role)).userId])),
    ) as Record<RoleKey, string>;
    await f.run(async () => {
      await tx().insert(herds).values({ ...base(f), name: SEED.herd.pregnant });
      await tx().insert(fields).values({ ...base(f), number: SEED.field.wheat1 });
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedTasks({
      tenantId: f.tenantId,
      farmId: f.farmId,
      users,
      run: (fn, as = 'owner') => f.run(fn, { userId: users[as] }),
    });
    log.mockRestore();

    const director = await f.as('director');
    const series = (await director.get('/tasks', { recurring: true })).body.data;
    expect(series.map((t: any) => t.title).sort()).toEqual(['Ertalabki ozuqa berish', 'Molxonani tozalash']);
    expect(series.find((t: any) => t.title === 'Molxonani tozalash').requiresPhoto).toBe(true);

    const shepherd = await f.as('shepherd');
    const mine = (await shepherd.get('/tasks')).body.data;
    expect(mine.map((t: any) => t.title)).toContain('Ertalabki ozuqa berish');

    expect((await director.get('/tasks', { overdue: true })).body.meta.total).toBe(0);
    const vaccination = (await director.get('/tasks', { search: 'Enterotoksemiya' })).body.data[0];
    expect(vaccination.requiresRecord).toBe('health_record');
    expect((await director.post(`/tasks/${vaccination.id}/complete`, {})).body.error.code).toBe('RECORD_REQUIRED');

    const events = (await director.get('/tasks/calendar', { from: today, to: addDays(today, 30), kinds: 'manual' })).data;
    expect(events).toHaveLength(4);

    const summary = (await director.get('/notifications')).body.data.find((n: any) => n.eventType === 'daily_summary');
    expect(summary.title).toContain('Kunlik xulosa');
  });
});

describe('taskSummary', () => {
  it('counts open, overdue and done today', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    await director.post('/tasks', { title: 'Kechikkan', dueDate: addDays(today, -1) });
    await director.post('/tasks', { title: 'Ochiq', dueDate: addDays(today, 1) });
    await director.post('/tasks', { title: 'Seriya', recurrence: 'weekly', dueDate: addDays(today, 3) });
    const done = await director.post('/tasks', { title: 'Tugadi', dueDate: addDays(today, -1) });
    await director.post(`/tasks/${done.data.id}/complete`, {});
    const cancelled = await director.post('/tasks', { title: 'Bekor', dueDate: addDays(today, -1) });
    await director.post(`/tasks/${cancelled.data.id}/cancel`);
    expect(await f.run(() => taskSummary())).toEqual({ open: 2, overdue: 1, doneToday: 1 });
  });
});
