import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIso } from '@yap/shared';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { receiveStock, stockOnHand } from '../src/core/inventory';
import { createFixture, type Client, type Fixture } from './helpers';
import { renderAlert } from '../src/modules/alerts/alerts.service';

const { alerts, dailyLogs, events, items, rationLines, rations, species, stockMovements, tasks, warehouses } = schema;

const today = todayIso();

/** Field names that reveal money. None may appear in anything stored on a phone (rule 7). */
const MONEY_KEYS = /"(unitCost|totalCost|purchasePrice|price|amount|value|costPerHead|transferPrice|lossAmount|baseRate)"/;

interface Farm {
  f: Fixture;
  owner: Client;
  speciesId: string;
  herdId: string;
  hayId: string;
  barleyId: string;
  warehouseId: string;
}

let tagCounter = 0;

/**
 * 3 ewes on 1.2 kg hay + 0.3 kg barley per head per day, so the plan is 3.6 kg hay and 0.9 kg barley.
 * Stock: 1 000 kg of hay at 1 000 so'm and 200 kg of barley at 3 000 so'm.
 */
async function makeFarm(): Promise<Farm> {
  const f = await createFixture();
  const owner = await f.as('owner');
  const ids = await f.run(async () => {
    const base = { tenantId: f.tenantId, farmId: f.farmId };
    const [sheep] = await tx().select().from(species).where(eq(species.key, 'sheep'));
    const [warehouse] = await tx().insert(warehouses).values({ ...base, name: 'Ozuqa ombori', type: 'feed' }).returning();
    const [hay] = await tx()
      .insert(items)
      .values({ ...base, name: 'Beda', category: 'feed', unit: 'kg', defaultWarehouseId: warehouse.id })
      .returning();
    const [barley] = await tx()
      .insert(items)
      .values({ ...base, name: 'Arpa', category: 'feed', unit: 'kg', defaultWarehouseId: warehouse.id })
      .returning();
    await receiveStock({ itemId: hay.id, warehouseId: warehouse.id, qty: 1_000, unitCost: 1_000, date: addDays(today, -30), source: 'opening' });
    await receiveStock({ itemId: barley.id, warehouseId: warehouse.id, qty: 200, unitCost: 3_000, date: addDays(today, -30), source: 'opening' });
    const [ration] = await tx().insert(rations).values({ ...base, name: 'Qishlov', state: 'pregnant' }).returning();
    await tx().insert(rationLines).values([
      { ...base, rationId: ration.id, itemId: hay.id, kgPerHeadDay: 1.2 },
      { ...base, rationId: ration.id, itemId: barley.id, kgPerHeadDay: 0.3 },
    ]);
    return { speciesId: sheep.id, warehouseId: warehouse.id, hayId: hay.id, barleyId: barley.id, rationId: ration.id };
  });
  const herd = await owner.post('/livestock/herds', { name: "Bo'g'oz sovliqlar", state: 'pregnant', rationId: ids.rationId });
  expect(herd.status).toBe(201);
  const farm = { f, owner, speciesId: ids.speciesId, herdId: herd.data.id, hayId: ids.hayId, barleyId: ids.barleyId, warehouseId: ids.warehouseId };
  for (let i = 0; i < 3; i++) await addEwe(farm);
  return farm;
}

async function addEwe(farm: Farm) {
  const res = await farm.owner.post('/livestock/animals', {
    tag: `TD-${String(++tagCounter).padStart(4, '0')}`,
    speciesId: farm.speciesId,
    sex: 'female',
    category: 'ewe',
    origin: 'purchased',
    purchaseDate: addDays(today, -40),
    purchasePrice: 4_200_000,
    herdId: farm.herdId,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data as { id: string; tag: string };
}

const uuid = () => crypto.randomUUID();

describe('GET /today', () => {
  let farm: Farm;
  beforeAll(async () => {
    farm = await makeFarm();
  });

  it('gives a shepherd the herd, ration plan and stock needed to log a day offline', async () => {
    const shepherd = await farm.f.as('shepherd');
    const res = await shepherd.get('/today');
    expect(res.status).toBe(200);
    expect(res.data.date).toBe(today);

    const [herd] = res.data.herds;
    expect(herd).toMatchObject({ id: farm.herdId, name: "Bo'g'oz sovliqlar", headCount: 3, log: null });
    const hay = herd.lines.find((l: any) => l.itemId === farm.hayId);
    const barley = herd.lines.find((l: any) => l.itemId === farm.barleyId);
    expect(hay).toMatchObject({ itemName: 'Beda', unit: 'kg', plannedQty: 3.6, qtyOnHand: 1000 });
    expect(barley).toMatchObject({ plannedQty: 0.9, qtyOnHand: 200 });

    expect(res.data.feedItems.map((i: any) => i.name).sort()).toEqual(['Arpa', 'Beda']);
    expect(res.data.warehouses.map((w: any) => w.name)).toEqual(['Ozuqa ombori']);
  });

  it('offers quick actions by permission (spec 18.1)', async () => {
    const shepherd = await (await farm.f.as('shepherd')).get('/today');
    expect(shepherd.data.actions).toEqual(expect.arrayContaining(['daily_log', 'report_sick', 'record_death']));
    expect(shepherd.data.actions).not.toContain('weight');
    expect(shepherd.data.actions).not.toContain('stock');

    const zootechnician = await (await farm.f.as('zootechnician')).get('/today');
    expect(zootechnician.data.actions).toEqual(expect.arrayContaining(['daily_log', 'weight', 'lambing']));

    const storekeeper = await (await farm.f.as('storekeeper')).get('/today');
    expect(storekeeper.data.actions).toContain('stock');
    expect(storekeeper.data.actions).not.toContain('daily_log');

    const mechanic = await (await farm.f.as('mechanic')).get('/today');
    expect(mechanic.data.actions).toEqual(expect.arrayContaining(['machinery', 'field_operation']));
  });

  it('shows my tasks due by today and overdue, not tasks of others or future ones', async () => {
    const shepherd = await farm.f.as('shepherd');
    const zootechnician = await farm.f.as('zootechnician');
    const base = { tenantId: farm.f.tenantId, farmId: farm.f.farmId };
    await farm.f.run(() =>
      tx().insert(tasks).values([
        { ...base, title: 'Bugungi', assigneeUserId: shepherd.userId, dueDate: today },
        { ...base, title: "Muddati o'tgan", assigneeUserId: shepherd.userId, dueDate: addDays(today, -2) },
        { ...base, title: 'Muddatsiz', assigneeUserId: shepherd.userId },
        { ...base, title: 'Ertangi', assigneeUserId: shepherd.userId, dueDate: addDays(today, 1) },
        { ...base, title: 'Bajarilgan', assigneeUserId: shepherd.userId, dueDate: today, status: 'done' },
        { ...base, title: 'Boshqaniki', assigneeUserId: zootechnician.userId, dueDate: today },
      ]),
    );
    const res = await shepherd.get('/today');
    expect(res.data.tasks.map((t: any) => t.title)).toEqual(["Muddati o'tgan", 'Bugungi', 'Muddatsiz']);
  });

  it('carries the logged day, so a correction starts from what was saved', async () => {
    const f = await makeFarm();
    const shepherd = await f.f.as('shepherd');
    const logId = uuid();
    const saved = await shepherd.post('/livestock/daily-logs', {
      id: logId,
      herdId: f.herdId,
      date: today,
      waterL: 900,
      lines: [
        { itemId: f.hayId, actualQty: 3.6 },
        { itemId: f.barleyId, actualQty: 0.9 },
      ],
    });
    expect(saved.status).toBe(201);
    const res = await shepherd.get('/today');
    const { log } = res.data.herds[0];
    expect(log).toMatchObject({ id: logId, createdBy: shepherd.userId, waterL: 900, condition: 'normal' });
    expect(log.lines).toEqual(
      expect.arrayContaining([
        { itemId: f.hayId, actualQty: 3.6 },
        { itemId: f.barleyId, actualQty: 0.9 },
      ]),
    );
    expect(log.updatedAt).toBeTruthy();
  });

  it('never carries money, not even for a role that may see it (rule 7)', async () => {
    const f = await makeFarm();
    const shepherd = await f.f.as('shepherd');
    await shepherd.post('/livestock/daily-logs', {
      id: uuid(),
      herdId: f.herdId,
      date: today,
      lines: [{ itemId: f.hayId, actualQty: 3.6 }],
    });
    for (const role of ['shepherd', 'zootechnician', 'owner', 'accountant'] as const) {
      const client = await f.f.as(role);
      const res = await client.get('/today');
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.data)).not.toMatch(MONEY_KEYS);
      const directory = await client.get('/today/animals');
      expect(JSON.stringify(directory.data)).not.toMatch(MONEY_KEYS);
    }
  });

  it('gives herds and feed only to those who can log them', async () => {
    const mechanic = await farm.f.as('mechanic');
    const res = await mechanic.get('/today');
    expect(res.status).toBe(200);
    expect(res.data.herds).toEqual([]);
    expect(res.data.feedItems).toEqual([]);
    expect(res.data.warehouses).toEqual([]);
  });

  it('reports attendance only for staff with an employee record', async () => {
    const shepherd = await farm.f.as('shepherd');
    expect((await shepherd.get('/today')).data.attendance).toBeNull();

    await farm.f.run(() =>
      tx().insert(schema.employees).values({
        tenantId: farm.f.tenantId,
        farmId: farm.f.farmId,
        userId: shepherd.userId,
        fullName: "Sherzod Cho'pon",
        position: "Cho'pon",
        hireDate: addDays(today, -100),
      }),
    );
    expect((await shepherd.post('/hr/me/check-in', {})).status).toBe(200);
    const res = await shepherd.get('/today');
    expect(res.data.attendance).toMatchObject({ status: 'present', openShift: true });
    expect(res.data.attendance.checkIn).toBeTruthy();
    expect(res.data.attendance.checkOut).toBeNull();
    expect(JSON.stringify(res.data.attendance)).not.toMatch(/passport|baseRate|phone/);
  });

  it("does not show another tenant's herd", async () => {
    const other = await createFixture();
    const owner = await other.as('owner');
    const res = await owner.get('/today');
    expect(res.data.herds).toEqual([]);
    expect(res.data.feedItems).toEqual([]);
  });

  it('needs a signed-in user', async () => {
    const res = await farm.f.app.inject({ method: 'GET', url: '/api/v1/today' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /today/animals', () => {
  it('lists animals on the farm with their other codes and open pregnancy', async () => {
    const farm = await makeFarm();
    const shepherd = await farm.f.as('shepherd');
    const owner = farm.owner;

    const rfid = await owner.post('/livestock/animals', {
      tag: 'RF-1',
      speciesId: farm.speciesId,
      sex: 'female',
      category: 'ewe',
      origin: 'purchased',
      purchaseDate: addDays(today, -40),
      herdId: farm.herdId,
      identifiers: [{ type: 'rfid', value: '982000123456789' }],
    });
    expect(rfid.status).toBe(201);
    const pregnant = await farm.f.as('zootechnician');
    const pregnancy = await pregnant.post('/livestock/breeding', { eweId: rfid.data.id, matingDate: addDays(today, -100) });
    expect(pregnancy.status, JSON.stringify(pregnancy.body)).toBe(201);

    const res = await shepherd.get('/today/animals');
    expect(res.status).toBe(200);
    expect(res.data.truncated).toBe(false);
    expect(res.data.animals).toHaveLength(4);
    const row = res.data.animals.find((a: any) => a.tag === 'RF-1');
    expect(row).toMatchObject({ sex: 'female', category: 'ewe', herdId: farm.herdId, status: 'pregnant' });
    expect(row.codes).toEqual(['982000123456789']);
    expect(row.expectedDate).toBe(addDays(addDays(today, -100), 150));
  });

  it('leaves out animals no longer on the farm', async () => {
    const farm = await makeFarm();
    const ewe = await addEwe(farm);
    const shepherd = await farm.f.as('shepherd');
    const exit = await shepherd.post('/livestock/exits', { animalId: ewe.id, type: 'death', date: today, reason: 'Kasallik' });
    expect(exit.status, JSON.stringify(exit.body)).toBe(201);
    const res = await shepherd.get('/today/animals');
    expect(res.data.animals.map((a: any) => a.id)).not.toContain(ewe.id);
  });

  it('is refused without livestock.view', async () => {
    const farm = await makeFarm();
    const mechanic = await farm.f.as('mechanic');
    expect((await mechanic.get('/today/animals')).status).toBe(403);
  });
});

describe('offline delivery of a daily log', () => {
  /** What the phone's outbox sends: a client id plus an Idempotency-Key. */
  const body = (f: Farm, id: string, hay = 3.6, barley = 0.9) => ({
    id,
    herdId: f.herdId,
    date: today,
    waterL: 900,
    condition: 'normal',
    lines: [
      { itemId: f.hayId, actualQty: hay },
      { itemId: f.barleyId, actualQty: barley },
    ],
  });

  async function counts(f: Farm) {
    return f.f.run(async () => ({
      logs: (await tx().select().from(dailyLogs).where(eq(dailyLogs.herdId, f.herdId))).length,
      issues: (
        await tx()
          .select()
          .from(stockMovements)
          .where(and(eq(stockMovements.farmId, f.f.farmId), eq(stockMovements.type, 'issue')))
      ).length,
      hay: await stockOnHand(f.hayId),
      barley: await stockOnHand(f.barleyId),
    }));
  }

  it('applies a repeated delivery exactly once: one log, one issue per feed, stock down once', async () => {
    const f = await makeFarm();
    const shepherd = await f.f.as('shepherd');
    const id = uuid();
    const headers = { 'idempotency-key': id };

    const first = await shepherd.post('/livestock/daily-logs', body(f, id), headers);
    const second = await shepherd.post('/livestock/daily-logs', body(f, id), headers);
    const third = await shepherd.post('/livestock/daily-logs', body(f, id), headers);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(third.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.data.id).toBe(id);

    const after = await counts(f);
    expect(after).toEqual({ logs: 1, issues: 2, hay: 996.4, barley: 199.1 });
  });

  it('also holds when the key was lost and only the client id repeats', async () => {
    const f = await makeFarm();
    const shepherd = await f.f.as('shepherd');
    const id = uuid();
    await shepherd.post('/livestock/daily-logs', body(f, id));
    const again = await shepherd.post('/livestock/daily-logs', body(f, id));
    expect(again.status).toBe(201);
    expect(await counts(f)).toEqual({ logs: 1, issues: 2, hay: 996.4, barley: 199.1 });
  });

  it('answers DAILY_LOG_EXISTS with the saved id when another device logged the same herd and day', async () => {
    const f = await makeFarm();
    const shepherd = await f.f.as('shepherd');
    const first = uuid();
    await shepherd.post('/livestock/daily-logs', body(f, first));

    const clash = await shepherd.post('/livestock/daily-logs', body(f, uuid(), 5, 1), { 'idempotency-key': uuid() });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('DAILY_LOG_EXISTS');
    expect(clash.body.error.details).toMatchObject({ id: first, date: today });
    // The losing record changed nothing.
    expect(await counts(f)).toEqual({ logs: 1, issues: 2, hay: 996.4, barley: 199.1 });
  });

  it('a failed delivery stores no idempotent result, so the corrected retry goes through', async () => {
    const f = await makeFarm();
    const shepherd = await f.f.as('shepherd');
    const id = uuid();
    const headers = { 'idempotency-key': id };

    const tooMuch = await shepherd.post('/livestock/daily-logs', body(f, id, 5_000), headers);
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await counts(f)).toEqual({ logs: 0, issues: 0, hay: 1000, barley: 200 });

    const fixed = await shepherd.post('/livestock/daily-logs', body(f, id), headers);
    expect(fixed.status).toBe(201);
    expect(await counts(f)).toEqual({ logs: 1, issues: 2, hay: 996.4, barley: 199.1 });
  });

  it("keep mine: the author replaces their record, and stale data is refused", async () => {
    const f = await makeFarm();
    const shepherd = await f.f.as('shepherd');
    const logId = uuid();
    await shepherd.post('/livestock/daily-logs', body(f, logId));
    const server = (await shepherd.get('/today')).data.herds[0].log;

    const stale = await shepherd.patch(`/livestock/daily-logs/${logId}`, {
      baseUpdatedAt: new Date(Date.parse(server.updatedAt) - 60_000).toISOString(),
      lines: [{ itemId: f.hayId, actualQty: 4 }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_UPDATE');

    const replaced = await shepherd.patch(`/livestock/daily-logs/${logId}`, {
      baseUpdatedAt: server.updatedAt,
      lines: [
        { itemId: f.hayId, actualQty: 4 },
        { itemId: f.barleyId, actualQty: 1 },
      ],
    });
    expect(replaced.status).toBe(200);
    const after = await counts(f);
    expect(after).toMatchObject({ logs: 1, hay: 996, barley: 199 });
  });

  it("a shepherd cannot overwrite a colleague's record", async () => {
    const f = await makeFarm();
    const zootechnician = await f.f.as('zootechnician');
    const shepherd = await f.f.as('shepherd');
    const logId = uuid();
    await zootechnician.post('/livestock/daily-logs', body(f, logId));
    const res = await shepherd.patch(`/livestock/daily-logs/${logId}`, { lines: [{ itemId: f.hayId, actualQty: 4 }] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EDIT_WINDOW_CLOSED');
  });
});

describe('POST /today/conflicts', () => {
  async function clash() {
    const f = await makeFarm();
    const zootechnician = await f.f.as('zootechnician');
    const logId = uuid();
    await zootechnician.post('/livestock/daily-logs', {
      id: logId,
      herdId: f.herdId,
      date: today,
      lines: [{ itemId: f.hayId, actualQty: 3.6 }],
    });
    const report = {
      id: uuid(),
      herdId: f.herdId,
      date: today,
      serverLogId: logId,
      mine: { headCount: 3, waterL: 800, condition: 'normal', notes: 'Oflayn', lines: [{ itemId: f.hayId, actualQty: 7 }] },
    };
    return { f, logId, report };
  }

  it('keeps the offline version in the journal and alerts someone who can decide', async () => {
    const { f, report, logId } = await clash();
    const shepherd = await f.f.as('shepherd');
    const res = await shepherd.post('/today/conflicts', report, { 'idempotency-key': `conflict-${report.id}` });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ reported: true });

    const [event] = await f.f.run(() =>
      tx().select().from(events).where(sql`type = 'herd.daily_log_conflict' and entity_id = ${f.herdId}`),
    );
    expect(event.createdBy).toBe(shepherd.userId);
    expect(event.data).toMatchObject({ outboxId: report.id, serverLogId: logId });
    const mine = (event.data as any).mine;
    expect(mine.lines[0]).toMatchObject({ itemName: 'Beda', unit: 'kg', actualQty: 7 });
    expect(mine.waterL).toBe(800);

    const [alert] = await f.f.run(() =>
      tx().select().from(alerts).where(eq(alerts.dedupKey, `offline_conflict:${report.id}`)),
    );
    expect(alert.status).toBe('open');
    expect(alert.severity).toBe('attention');
    expect(alert.body).toContain('Beda: 7 kg');
    expect(renderAlert(alert, 'en').title).toMatch(/: two different records for \d{2}\.\d{2}\.\d{4}$/);
    expect(renderAlert(alert, 'en').body).toContain('Offline record: Beda: 7 kg');

    // Saved stock is untouched: nothing moved until a person decides.
    expect(await f.f.run(() => stockOnHand(f.hayId))).toBe(996.4);
  });

  it('a repeated report makes one event and one alert', async () => {
    const { f, report } = await clash();
    const shepherd = await f.f.as('shepherd');
    const headers = { 'idempotency-key': `conflict-${report.id}` };
    await shepherd.post('/today/conflicts', report, headers);
    await shepherd.post('/today/conflicts', report, headers);
    const rows = await f.f.run(() =>
      tx().select().from(events).where(sql`type = 'herd.daily_log_conflict' and entity_id = ${f.herdId}`),
    );
    expect(rows).toHaveLength(1);
    const found = await f.f.run(() =>
      tx().select().from(alerts).where(eq(alerts.dedupKey, `offline_conflict:${report.id}`)),
    );
    expect(found).toHaveLength(1);
  });

  it('refuses a herd or log from another tenant', async () => {
    const { f, report } = await clash();
    const other = await makeFarm();
    const shepherd = await other.f.as('shepherd');
    expect((await shepherd.post('/today/conflicts', report)).status).toBe(404);
    expect((await (await f.f.as('mechanic')).post('/today/conflicts', report)).status).toBe(403);
  });
});
