import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resources } from '@yap/shared/i18n';
import { addDays, todayIso, monthOf } from '@yap/shared';
import { schema } from '../src/db/client';
import { tx, withPlatform } from '../src/core/context';
import { generalCostCenterId } from '../src/core/costCenters';
import { issueStock, receiveStock } from '../src/core/inventory';
import { postTransaction } from '../src/core/ledger';
import { INSIGHT_TYPES } from '../src/modules/ai/analyzers/types';
import { asAi } from '../src/modules/ai/role';
import { raiseAlert, renderAlert, repeatUrgentAlerts } from '../src/modules/alerts/alerts.service';
import { evaluateRules, RULES } from '../src/modules/alerts/rules';
import { openAlerts } from '../src/modules/alerts/summary';
import { startJobs } from '../src/jobs';
import { handleMessage, startTelegramBot } from '../src/modules/notifications/bot';
import { tr } from '../src/modules/notifications/i18n';
import { digestFacts, digestScope, renderDigest } from '../src/modules/notifications/digest';
import { sendDailySummary } from '../src/modules/notifications/jobs';
import { dispatchPending, notifyRole, notifyUser } from '../src/modules/notifications/notify.service';
import { createFixture, type Fixture } from './helpers';

/** The scheduler itself, with no Redis behind it. */
const bull = vi.hoisted(() => ({
  schedulers: [] as [string, string][],
  removed: [] as [string, string][],
  workers: [] as { queue: string }[],
  templates: [] as { opts?: { removeOnComplete?: unknown; removeOnFail?: unknown } }[],
  /** Stands in for Redis not answering, or refusing, until told otherwise. */
  before: async () => {},
  status: 'ready',
  closes: [] as (boolean | undefined)[],
  reset() {
    this.schedulers = [];
    this.removed = [];
    this.workers = [];
    this.templates = [];
    this.before = async () => {};
    this.status = 'ready';
    this.closes = [];
  },
}));

vi.mock('ioredis', () => ({
  Redis: class {
    on() {}
    disconnect() {}
    get status() {
      return bull.status;
    }
  },
}));
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(readonly name: string) {}
    on() {}
    async close() {}
    async upsertJobScheduler(job: string, _repeat: unknown, template: (typeof bull.templates)[number]) {
      await bull.before();
      bull.schedulers.push([this.name, job]);
      bull.templates.push(template);
    }
    async removeJobScheduler(job: string) {
      bull.removed.push([this.name, job]);
    }
  },
  Worker: class {
    constructor(queue: string) {
      bull.workers.push({ queue });
    }
    on() {}
    async close(force?: boolean) {
      bull.closes.push(force);
    }
  },
}));

const {
  alerts,
  animalExits,
  animals,
  breedingRecords,
  budgets,
  dailyLogLines,
  dailyLogs,
  documents,
  financeCategories,
  healthRecords,
  herds,
  items,
  notifications,
  rationLines,
  rations,
  species,
  stockBatches,
  telegramLinkCodes,
  transactions,
  users,
  vaccinationPlans,
  warehouses,
} = schema;

const today = todayIso();

const base = (f: Fixture) => ({ tenantId: f.tenantId, farmId: f.farmId });

async function sheepSpecies(f: Fixture) {
  const [row] = await tx().select().from(species).where(and(eq(species.tenantId, f.tenantId), eq(species.key, 'sheep')));
  return row.id;
}

/** A herd of `head` animals. */
async function makeHerd(f: Fixture, head: number, status = 'active') {
  return f.run(async () => {
    const [herd] = await tx().insert(herds).values({ ...base(f), name: `Poda ${Math.random()}`, state: 'pregnant' }).returning();
    const speciesId = await sheepSpecies(f);
    if (head > 0) {
      await tx()
        .insert(animals)
        .values(
          Array.from({ length: head }, (_, i) => ({
            ...base(f),
            tag: `T-${herd.id.slice(-6)}-${i}`,
            speciesId,
            sex: 'female',
            category: 'ewe',
            origin: 'purchased',
            herdId: herd.id,
            status,
          })),
        );
    }
    return herd;
  });
}

async function makeFeed(f: Fixture, name: string, stockKg: number) {
  return f.run(async () => {
    const [warehouse] = await tx().insert(warehouses).values({ ...base(f), name: `Ombor ${name}`, type: 'feed' }).returning();
    const [item] = await tx().insert(items).values({ ...base(f), name, category: 'feed', unit: 'kg' }).returning();
    if (stockKg > 0) {
      await receiveStock({ itemId: item.id, warehouseId: warehouse.id, qty: stockKg, unitCost: 1000, date: today, source: 'opening' });
    }
    return { item, warehouse };
  });
}

async function setRation(f: Fixture, herdId: string, itemId: string, kgPerHeadDay: number) {
  await f.run(async () => {
    const [ration] = await tx().insert(rations).values({ ...base(f), name: 'R', state: 'pregnant' }).returning();
    await tx().insert(rationLines).values({ ...base(f), rationId: ration.id, itemId, kgPerHeadDay });
    await tx().update(herds).set({ rationId: ration.id }).where(eq(herds.id, herdId));
  });
}

async function logFeeding(f: Fixture, herdId: string, itemId: string, warehouseId: string, date: string, planned: number, actual: number) {
  await f.run(async () => {
    const [log] = await tx().insert(dailyLogs).values({ ...base(f), herdId, date, headCount: 1 }).returning();
    await tx().insert(dailyLogLines).values({ ...base(f), logId: log.id, itemId, warehouseId, plannedQty: planned, actualQty: actual });
  });
}

/** Feed actually issued from the warehouse, which is what "days of stock" is based on. */
const issueFeed = (f: Fixture, itemId: string, warehouseId: string, qty: number) =>
  f.run(async () => {
    const costCenterId = await generalCostCenterId();
    await issueStock({ itemId, warehouseId, qty, date: today, costCenterId, reason: 'ration' });
  });

const alertsOf = (f: Fixture, ruleKey: string) =>
  f.run(() =>
    tx()
      .select()
      .from(alerts)
      .where(and(eq(alerts.farmId, f.farmId), eq(alerts.ruleKey, ruleKey), sql`status <> 'resolved'`)),
  );

const notificationsOf = (f: Fixture, userId: string) =>
  f.run(() => tx().select().from(notifications).where(eq(notifications.userId, userId)));

describe('raiseAlert', () => {
  const input = {
    ruleKey: 'animal_sick',
    dedupKey: 'animal_sick:1',
    severity: 'attention' as const,
    title: 'Kasal hayvon',
  };

  it('creates one alert per problem and tells people once', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    await f.run(() => raiseAlert(input));
    await f.run(() => raiseAlert(input));
    expect(await alertsOf(f, 'animal_sick')).toHaveLength(1);
    expect(await notificationsOf(f, vet.userId)).toHaveLength(1);
  });

  it('tells people again when it becomes more severe', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    await f.run(() => raiseAlert(input));
    const result = await f.run(() => raiseAlert({ ...input, severity: 'urgent' }));
    expect(result.escalated).toBe(true);
    const [alert] = await alertsOf(f, 'animal_sick');
    expect(alert.severity).toBe('urgent');
    expect(alert.nextNotifyAt).not.toBeNull();
    expect(await notificationsOf(f, vet.userId)).toHaveLength(2);
  });

  it('becoming less severe stays silent and stops repeats', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    await f.run(() => raiseAlert({ ...input, severity: 'urgent' }));
    await f.run(() => raiseAlert({ ...input, severity: 'attention' }));
    const [alert] = await alertsOf(f, 'animal_sick');
    expect(alert.severity).toBe('attention');
    expect(alert.nextNotifyAt).toBeNull();
    expect(await notificationsOf(f, vet.userId)).toHaveLength(1);
  });

  it('a problem that returns after being resolved is a new alert', async () => {
    const f = await createFixture();
    await f.as('veterinarian');
    await f.run(() => raiseAlert(input));
    const owner = await f.as('owner');
    const [first] = await alertsOf(f, 'animal_sick');
    expect((await owner.post(`/alerts/${first.id}/resolve`)).status).toBe(200);
    await f.run(() => raiseAlert(input));
    const [second] = await alertsOf(f, 'animal_sick');
    expect(second.id).not.toBe(first.id);
  });

  it('an acknowledged alert reopens if it gets worse', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await f.run(() => raiseAlert(input));
    const [alert] = await alertsOf(f, 'animal_sick');
    await owner.post(`/alerts/${alert.id}/acknowledge`);
    await f.run(() => raiseAlert({ ...input, severity: 'urgent' }));
    const [after] = await alertsOf(f, 'animal_sick');
    expect(after.status).toBe('open');
    expect(after.acknowledgedAt).toBeNull();
  });

  it('notifies only the responsible roles and honours a custom role list', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const agronomist = await f.as('agronomist');
    await f.run(() => raiseAlert(input));
    expect(await notificationsOf(f, vet.userId)).toHaveLength(1);
    expect(await notificationsOf(f, agronomist.userId)).toHaveLength(0);
    await f.run(() => raiseAlert({ ...input, ruleKey: 'x', dedupKey: 'x', notify: ['agronomist'] }));
    expect(await notificationsOf(f, agronomist.userId)).toHaveLength(1);
  });
});

describe('rule engine', () => {
  it('is idempotent: a second run creates nothing and resolves nothing', async () => {
    const f = await createFixture();
    const herd = await makeHerd(f, 10);
    const { item } = await makeFeed(f, 'Beda', 100);
    await setRation(f, herd.id, item.id, 1); // 10 kg/day → 10 days of stock
    const first = await f.run(() => evaluateRules());
    expect(first.raised).toBeGreaterThanOrEqual(1);
    const second = await f.run(() => evaluateRules());
    expect(second.raised).toBe(0);
    expect(second.resolved).toBe(0);
    expect(second.refreshed).toBe(first.raised);
    expect(await alertsOf(f, 'feed_low')).toHaveLength(1);
  });

  it('auto-resolves when the problem goes away', async () => {
    const f = await createFixture();
    const herd = await makeHerd(f, 10);
    const { item, warehouse } = await makeFeed(f, 'Beda', 100);
    await setRation(f, herd.id, item.id, 1);
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'feed_low')).toHaveLength(1);

    await f.run(() => receiveStock({ itemId: item.id, warehouseId: warehouse.id, qty: 1000, unitCost: 1, date: today, source: 'purchase' }));
    const result = await f.run(() => evaluateRules());
    expect(result.resolved).toBe(1);
    expect(await alertsOf(f, 'feed_low')).toHaveLength(0);
  });

  it('a failing rule is isolated: others still run and its alerts are not closed', async () => {
    const f = await createFixture();
    const herd = await makeHerd(f, 10, 'sick');
    const { item } = await makeFeed(f, 'Beda', 100);
    await setRation(f, herd.id, item.id, 1);
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'feed_low')).toHaveLength(1);

    const rule = RULES.find((r) => r.key === 'feed_low')!;
    const spy = vi.spyOn(rule, 'run').mockImplementation(async () => {
      await tx().execute(sql`select * from no_such_table`);
      return [];
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await f.run(() => evaluateRules());
    spy.mockRestore();
    consoleError.mockRestore();
    expect(result.failedRules).toEqual(['feed_low']);
    expect(await alertsOf(f, 'feed_low')).toHaveLength(1);
    expect(await alertsOf(f, 'sick_animals')).toHaveLength(1);
  });

  it('never closes alerts raised by other sources', async () => {
    const f = await createFixture();
    await f.run(() => raiseAlert({ ruleKey: 'animal_sick', dedupKey: 'manual-1', severity: 'attention', title: 'X' }));
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'animal_sick')).toHaveLength(1);
  });
});

describe('rules against control numbers', () => {
  it('feed_low: 10 head × 1 kg = 10 kg/day; default minimum is 14 days', async () => {
    const f = await createFixture();
    const herd = await makeHerd(f, 10);
    const { item } = await makeFeed(f, 'Beda', 200); // 20 days: fine
    await setRation(f, herd.id, item.id, 1);
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'feed_low')).toHaveLength(0);

    await f.run(() => tx().update(stockBatches).set({ qtyRemaining: 100 }).where(eq(stockBatches.itemId, item.id))); // 10 days
    await f.run(() => evaluateRules());
    let [alert] = await alertsOf(f, 'feed_low');
    expect(alert.severity).toBe('attention');
    expect(alert.data).toMatchObject({ days: 10, minimum: 14 });

    await f.run(() => tx().update(stockBatches).set({ qtyRemaining: 60 }).where(eq(stockBatches.itemId, item.id))); // 6 < 7
    await f.run(() => evaluateRules());
    [alert] = await alertsOf(f, 'feed_low');
    expect(alert.severity).toBe('urgent');
  });

  it('feed_low: actual consumption overrides the plan (spec 24.1)', async () => {
    const f = await createFixture();
    const herd = await makeHerd(f, 10);
    const { item, warehouse } = await makeFeed(f, 'Beda', 240);
    await setRation(f, herd.id, item.id, 1); // the plan would say 20 days
    await issueFeed(f, item.id, warehouse.id, 40); // 200 kg left at 40 kg a day is 5 days
    await f.run(() => evaluateRules());
    const [alert] = await alertsOf(f, 'feed_low');
    expect(alert.data).toMatchObject({ days: 5 });
    expect(alert.severity).toBe('urgent');
  });

  it('feed_low uses the item minimum when it has one', async () => {
    const f = await createFixture();
    const herd = await makeHerd(f, 10);
    const { item } = await makeFeed(f, 'Tuz', 200);
    await setRation(f, herd.id, item.id, 1); // 20 days
    await f.run(() => tx().update(items).set({ minDays: 30 }).where(eq(items.id, item.id)));
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'feed_low')).toHaveLength(1);
  });

  it.each([
    [600, 660, null], // +10%: within 15%
    [600, 690, 'attention'], // +15%: at the threshold
    [600, 510, 'attention'], // -15%
    [600, 780, 'urgent'], // +30%: twice the threshold
  ])('ration_deviation: planned %d, actual %d → %s', async (planned, actual, severity) => {
    const f = await createFixture();
    const herd = await makeHerd(f, 1);
    const { item, warehouse } = await makeFeed(f, 'Beda', 1_000_000);
    await logFeeding(f, herd.id, item.id, warehouse.id, today, planned, actual);
    await f.run(() => evaluateRules());
    const found = await alertsOf(f, 'ration_deviation');
    if (severity === null) expect(found).toHaveLength(0);
    else {
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe(severity);
    }
  });

  it('ration_deviation covers yesterday for the morning alert, but not older days', async () => {
    const f = await createFixture();
    const herd = await makeHerd(f, 1);
    const { item, warehouse } = await makeFeed(f, 'Beda', 1_000_000);
    await logFeeding(f, herd.id, item.id, warehouse.id, addDays(today, -1), 100, 200);
    await logFeeding(f, herd.id, item.id, warehouse.id, addDays(today, -2), 100, 200);
    await f.run(() => evaluateRules());
    const found = await alertsOf(f, 'ration_deviation');
    expect(found).toHaveLength(1);
    expect(found[0].data).toMatchObject({ date: addDays(today, -1), percent: 100 });
  });

  it('lambing_soon: info within a week, attention within two days', async () => {
    const f = await createFixture();
    const herd = await makeHerd(f, 3);
    const ewes = await f.run(() => tx().select().from(animals).where(eq(animals.herdId, herd.id)));
    const breeding = (eweId: string, date: string) => ({
      ...base(f),
      eweId,
      matingDate: addDays(date, -150),
      expectedDate: date,
      expectedEarliest: addDays(date, -5),
      expectedLatest: addDays(date, 2),
    });
    await f.run(() =>
      tx().insert(breedingRecords).values([breeding(ewes[0].id, addDays(today, 5)), breeding(ewes[1].id, addDays(today, 6))]),
    );
    await f.run(() => evaluateRules());
    let [alert] = await alertsOf(f, 'lambing_soon');
    expect(alert.severity).toBe('info');
    expect(alert.data).toMatchObject({ count: 2, date: addDays(today, 5) });

    await f.run(() => tx().insert(breedingRecords).values(breeding(ewes[2].id, addDays(today, 1))));
    await f.run(() => evaluateRules());
    [alert] = await alertsOf(f, 'lambing_soon');
    expect(alert.severity).toBe('attention');
    expect(alert.data).toMatchObject({ count: 3 });
  });

  it('vaccination_overdue counts animals not currently covered', async () => {
    const f = await createFixture();
    const herd = await makeHerd(f, 4);
    const other = await makeHerd(f, 2);
    const [plan] = await f.run(() =>
      tx().insert(vaccinationPlans).values({ ...base(f), name: 'Enterotoksemiya', intervalDays: 180 }).returning(),
    );
    await f.run(() => evaluateRules());
    let [alert] = await alertsOf(f, 'vaccination_overdue');
    expect(alert.data).toMatchObject({ plan: 'Enterotoksemiya', count: 6 });

    // A herd-level vaccination covers that herd; the record 200 days old does not count.
    await f.run(() =>
      tx().insert(healthRecords).values([
        { ...base(f), type: 'vaccination', herdId: herd.id, date: addDays(today, -10), vaccinationPlanId: plan.id },
        { ...base(f), type: 'vaccination', herdId: other.id, date: addDays(today, -200), vaccinationPlanId: plan.id },
      ]),
    );
    await f.run(() => evaluateRules());
    [alert] = await alertsOf(f, 'vaccination_overdue');
    expect(alert.data).toMatchObject({ count: 2 });
  });

  it('sick_animals: urgent from 2% of the herd', async () => {
    const f = await createFixture();
    await makeHerd(f, 98);
    await makeHerd(f, 1, 'sick');
    await f.run(() => evaluateRules());
    expect((await alertsOf(f, 'sick_animals'))[0].severity).toBe('attention'); // 1 of 99

    await makeHerd(f, 1, 'sick');
    await f.run(() => evaluateRules());
    expect((await alertsOf(f, 'sick_animals'))[0].severity).toBe('urgent'); // 2 of 100
  });

  it('quarantine_ended fires only after the period ends', async () => {
    const f = await createFixture();
    const herd = await makeHerd(f, 2, 'quarantine');
    await f.run(() => tx().update(animals).set({ quarantineUntil: addDays(today, 3) }).where(eq(animals.herdId, herd.id)));
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'quarantine_animals')).toHaveLength(1);
    expect(await alertsOf(f, 'quarantine_ended')).toHaveLength(0);

    await f.run(() => tx().update(animals).set({ quarantineUntil: addDays(today, -1) }).where(eq(animals.herdId, herd.id)));
    await f.run(() => evaluateRules());
    expect((await alertsOf(f, 'quarantine_ended'))[0].data).toMatchObject({ count: 2 });
  });

  it('mortality_spike needs three deaths, and scales to urgent', async () => {
    const f = await createFixture();
    const herd = await makeHerd(f, 40);
    const dead = await f.run(() => tx().select().from(animals).where(eq(animals.herdId, herd.id)).limit(5));
    const exit = (animalId: string) => ({ ...base(f), animalId, type: 'death', date: addDays(today, -3) });
    await f.run(() => tx().insert(animalExits).values([exit(dead[0].id), exit(dead[1].id)]));
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'mortality_spike')).toHaveLength(0);

    await f.run(() => tx().insert(animalExits).values(exit(dead[2].id)));
    await f.run(() => evaluateRules());
    const [attention] = await alertsOf(f, 'mortality_spike');
    expect(attention.severity).toBe('urgent'); // 3 / (40 + 1.5) = 7.2%
    expect(attention.data).toMatchObject({ count: 3, percent: 7.2, previous: 0 });
  });

  it('budget_overrun: over 100% is attention, 120% is urgent', async () => {
    const f = await createFixture();
    const month = monthOf(today);
    const account = await f.run(async () => {
      const [row] = await tx().insert(schema.accounts).values({ ...base(f), name: 'Kassa', type: 'cash' }).returning();
      return row;
    });
    const [category] = await f.run(() =>
      tx().select().from(financeCategories).where(and(eq(financeCategories.tenantId, f.tenantId), eq(financeCategories.key, 'feed'))),
    );
    await f.run(() => tx().insert(budgets).values({ ...base(f), month, categoryId: category.id, amount: 1_000_000 }));
    const spend = (amount: number) =>
      f.run(async () =>
        postTransaction({
          date: today,
          type: 'expense',
          amount,
          categoryId: category.id,
          costCenterId: await generalCostCenterId(),
          paymentMethod: 'cash',
          accountId: account.id,
        }),
      );
    await spend(1_000_000);
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'budget_overrun')).toHaveLength(0); // exactly on budget

    await spend(100_000);
    await f.run(() => evaluateRules());
    let [alert] = await alertsOf(f, 'budget_overrun');
    expect(alert.severity).toBe('attention');
    expect(alert.data).toMatchObject({ percent: 110 });

    await spend(100_000);
    await f.run(() => evaluateRules());
    [alert] = await alertsOf(f, 'budget_overrun');
    expect(alert.severity).toBe('urgent');
    expect(alert.data).toMatchObject({ percent: 120 });
  });

  it('document_expiring: attention within 30 days, urgent once expired', async () => {
    const f = await createFixture();
    await f.run(() =>
      tx().insert(documents).values([
        { ...base(f), type: 'land', title: 'Ijara', expiryDate: addDays(today, 10) },
        { ...base(f), type: 'permit', title: 'Ruxsat', expiryDate: addDays(today, -1) },
        { ...base(f), type: 'permit', title: 'Uzoq', expiryDate: addDays(today, 60) },
      ]),
    );
    await f.run(() => evaluateRules());
    const found = await alertsOf(f, 'document_expiring');
    expect(found.map((a) => [a.data.title, a.severity]).sort()).toEqual([
      ['Ijara', 'attention'],
      ['Ruxsat', 'urgent'],
    ]);
  });

  it('an expired document says expired, in the alert and in every language', async () => {
    const f = await createFixture();
    const vet = await f.as('director');
    await f.run(() => tx().update(users).set({ locale: 'ru' }).where(eq(users.id, vet.userId)));
    await f.run(() =>
      tx().insert(documents).values({ ...base(f), type: 'permit', title: 'Ruxsat', expiryDate: '2026-10-29' }),
    );
    await f.run(() => evaluateRules());
    const [alert] = await alertsOf(f, 'document_expiring');
    expect(alert.title).toBe('Hujjat muddati tugagan: Ruxsat');
    expect(alert.body).toBe('Amal qilish muddati: 29.10.2026.');
    expect(alert.data.textKey).toBe('document_expired');
    const [mine] = await notificationsOf(f, vet.userId);
    expect(mine.title).toBe('Срок документа истёк: Ruxsat');
  });

  it('a document that is about to expire moves to the expired wording without a duplicate', async () => {
    const f = await createFixture();
    const [doc] = await f.run(() =>
      tx().insert(documents).values({ ...base(f), type: 'permit', title: 'R', expiryDate: addDays(today, 3) }).returning(),
    );
    await f.run(() => evaluateRules());
    await f.run(() => tx().update(documents).set({ expiryDate: addDays(today, -1) }).where(eq(documents.id, doc.id)));
    await f.run(() => evaluateRules());
    const found = await alertsOf(f, 'document_expiring');
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe('Hujjat muddati tugagan: R');
    expect(found[0].severity).toBe('urgent');
  });

  it('tasks_overdue ignores recurring series and closed tasks', async () => {
    const f = await createFixture();
    const past = addDays(today, -1);
    await f.run(() =>
      tx().insert(schema.tasks).values([
        { ...base(f), title: 'A', dueDate: past },
        { ...base(f), title: 'B', dueDate: past, status: 'done' },
        { ...base(f), title: 'C', dueDate: past, recurrence: 'daily' },
      ]),
    );
    await f.run(() => evaluateRules());
    expect((await alertsOf(f, 'tasks_overdue'))[0].data).toMatchObject({ count: 1 });
  });

  it('camera_offline follows the status alone; each device\'s own threshold is the job\'s to apply', async () => {
    const f = await createFixture();
    await f.run(() =>
      tx().insert(schema.devices).values([
        { ...base(f), type: 'camera', name: 'Reja', status: 'planned' },
        { ...base(f), type: 'camera', name: 'Oflayn', status: 'offline' },
        // Quiet for an hour, but this camera's threshold may be longer: not for the rule to judge.
        { ...base(f), type: 'camera', name: 'Jim', status: 'online', lastSeenAt: new Date(Date.now() - 60 * 60_000) },
        { ...base(f), type: 'sensor', name: 'Datchik', status: 'offline' },
      ]),
    );
    await f.run(() => evaluateRules());
    expect((await alertsOf(f, 'camera_offline')).map((a) => a.data.camera)).toEqual(['Oflayn']);
  });

  it('the rule and the offline job make one alert for one outage, and it clears with the status', async () => {
    const f = await createFixture();
    const [camera] = await f.run(() =>
      tx().insert(schema.devices).values({ ...base(f), type: 'camera', name: 'Molxona', status: 'offline' }).returning(),
    );
    // What the devices job raises, with its dedup key.
    await f.run(() =>
      raiseAlert({
        ruleKey: 'camera_offline',
        dedupKey: `camera_offline:${camera.id}`,
        severity: 'attention',
        title: 'Kamera oflayn: Molxona',
        data: { camera: 'Molxona' },
      }),
    );
    const result = await f.run(() => evaluateRules());
    expect(result.raised).toBe(0);
    expect(await alertsOf(f, 'camera_offline')).toHaveLength(1);

    await f.run(() => tx().update(schema.devices).set({ status: 'online' }).where(eq(schema.devices.id, camera.id)));
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'camera_offline')).toEqual([]);
  });
});

describe('alert labels', () => {
  const LANGUAGES = ['uz', 'ru', 'en'] as const;
  const dictionary = (lang: (typeof LANGUAGES)[number]) => resources[lang].alerts as { rules: Record<string, Record<string, string>> };
  const placeholders = (text = '') => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    });
  }

  /** Every alert raised anywhere, read from the source, so a new caller cannot ship Uzbek-only text. */
  const callers = sourceFiles(join(import.meta.dirname, '../src/modules'))
    .filter((path) => !path.endsWith('alerts/alerts.service.ts'))
    .map((path) => readFileSync(path, 'utf8'))
    .filter((source) => source.includes('raiseAlert('));

  /** Rule keys that are computed. A new kind of expression must be added here on purpose. */
  const COMPUTED: Record<string, string[]> = {
    'rule.key': RULES.map((rule) => rule.key),
    'offlineRule(device)': ['camera_offline', 'device_offline'],
  };
  const AI_FAMILY = '`ai.${finding.type}`';

  const expressions = callers.flatMap((source) => [...source.matchAll(/ruleKey:\s*([^,\n]+),/g)].map((m) => m[1].trim()));
  const variants = callers.flatMap((source) => [...source.matchAll(/textKey:[^\n]*?'([a-z_]+)'/g)].map((m) => m[1]));

  const ruleKeys = () =>
    [
      ...expressions.flatMap((expression) => {
        if (expression === AI_FAMILY) return [];
        const literal = /^'([a-z_]+)'$/.exec(expression);
        if (literal) return [literal[1]];
        if (COMPUTED[expression]) return COMPUTED[expression];
        throw new Error(`Unknown ruleKey expression: ${expression}. Add it to COMPUTED, and give it labels.`);
      }),
      ...variants,
    ].filter((key, index, all) => all.indexOf(key) === index);

  it('finds the alerts raised by other modules', () => {
    expect(ruleKeys()).toEqual(expect.arrayContaining(['sick_report', 'herd_condition', 'offline_conflict', 'device_event', 'asset_fuel_deviation']));
    expect(expressions).toContain(AI_FAMILY);
  });

  it.each(LANGUAGES)('every rule key has a title in %s', (lang) => {
    const missing = ruleKeys().filter((key) => !dictionary(lang).rules[key]?.title);
    expect(missing).toEqual([]);
  });

  it('every finding an AI alert can carry is worded in each language', () => {
    for (const lang of LANGUAGES) {
      const insight = (resources[lang].ai as { insight: Record<string, { title?: string; body?: string }> }).insight;
      // A summary is written whole by the model and goes out as a notification, never as an alert.
      const findings = INSIGHT_TYPES.filter((type) => type !== 'executive_summary');
      const missing = findings.filter((type) => !insight[type]?.title || !insight[type]?.body);
      expect(missing).toEqual([]);
    }
  });

  it('all languages use the same placeholders, so no translation renders a blank', () => {
    const uz = dictionary('uz').rules;
    for (const [key, text] of Object.entries(uz)) {
      for (const lang of ['ru', 'en'] as const) {
        expect([key, placeholders(dictionary(lang).rules[key]?.title)]).toEqual([key, placeholders(text.title)]);
        expect([key, placeholders(dictionary(lang).rules[key]?.body)]).toEqual([key, placeholders(text.body)]);
      }
    }
  });

  const alert = (ruleKey: string, data: Record<string, unknown>, title = 'Saqlangan', body: string | null = 'Saqlangan matn') => ({ ruleKey, title, body, data });

  it('offline conflict with no feed listed says so, rather than leaving a blank', () => {
    const empty = alert('offline_conflict', { herd: 'P', date: '2026-11-04', summary: '', textKey: 'offline_conflict_empty' });
    expect(renderAlert(empty, 'en').body).toBe('A record entered offline did not match the saved one. It lists no feed.');
    expect(renderAlert(empty, 'en').title).toBe('P: two different records for 04.11.2026');
  });

  it('names device events from the cameras dictionary, and survives a dotted or unknown type', () => {
    const event = (eventType: string) => alert('device_event', { deviceName: 'K1', eventType });
    expect(renderAlert(event('camera.smoke'), 'ru').title).toBe('K1: Признак дыма');
    expect(renderAlert(event('fire'), 'en').title).toBe('K1: Signs of fire');
    expect(renderAlert(event('camera.alien_landing'), 'en').title).toBe('K1: camera.alien_landing');
  });

  it('an alert raised before its labels existed keeps its stored text', () => {
    expect(renderAlert(alert('herd_condition', { date: '2026-11-04' }, 'Podada og\'ish'), 'ru').title).toBe("Podada og'ish");
    expect(renderAlert(alert('ai.feed_anomaly', { insightId: 'x', confidence: 0.9 }, 'Saqlangan AI'), 'ru').title).toBe('Saqlangan AI');
  });

  it('text with no label at all stays as raised', () => {
    expect(renderAlert(alert('some_future_rule', {}), 'ru')).toEqual({ title: 'Saqlangan', body: 'Saqlangan matn' });
  });
});

describe('urgent repeat (spec 17.3)', () => {
  const urgent = { ruleKey: 'animal_sick', dedupKey: 'u', severity: 'urgent' as const, title: 'Shoshilinch' };

  const dueNow = (f: Fixture) => f.run(() => tx().update(alerts).set({ nextNotifyAt: new Date(Date.now() - 1000) }));

  it('repeats with growing gaps until acknowledged', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const owner = await f.as('owner');
    await f.run(() => raiseAlert(urgent));
    expect(await f.run(() => repeatUrgentAlerts())).toBe(0); // not due yet

    await dueNow(f);
    expect(await f.run(() => repeatUrgentAlerts())).toBe(1);
    expect(await notificationsOf(f, vet.userId)).toHaveLength(2);
    let [alert] = await alertsOf(f, 'animal_sick');
    const firstGap = alert.nextNotifyAt!.getTime() - Date.now();
    expect(firstGap).toBeGreaterThan(29 * 60_000); // second repeat waits 30 minutes
    expect(firstGap).toBeLessThanOrEqual(30 * 60_000);

    await dueNow(f);
    await f.run(() => repeatUrgentAlerts());
    [alert] = await alertsOf(f, 'animal_sick');
    expect(alert.nextNotifyAt!.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);

    await owner.post(`/alerts/${alert.id}/acknowledge`);
    await dueNow(f);
    expect(await f.run(() => repeatUrgentAlerts())).toBe(0);
  });
});

describe('alerts API', () => {
  async function withBudgetAlert() {
    const f = await createFixture();
    await f.run(() =>
      raiseAlert({
        ruleKey: 'budget_overrun',
        dedupKey: 'b1',
        severity: 'attention',
        title: 'Byudjet',
        permission: 'finance.view',
      }),
    );
    await f.run(() => raiseAlert({ ruleKey: 'lambing_soon', dedupKey: 'l1', severity: 'info', title: 'Qo\'zilash' }));
    await f.run(() => raiseAlert({ ruleKey: 'document_expiring', dedupKey: 'd1', severity: 'attention', title: 'Hujjat' }));
    return f;
  }

  it('money alerts are hidden from people without finance.view (rule 7)', async () => {
    const f = await withBudgetAlert();
    const shepherd = await f.as('shepherd');
    const seen = await shepherd.get('/alerts');
    expect(seen.status).toBe(200);
    expect(seen.body.data.map((a: any) => a.ruleKey)).toEqual(['lambing_soon']); // addressed to shepherd
    expect((await shepherd.get('/alerts/counts')).data.total).toBe(1);

    const vet = await f.as('veterinarian');
    const vetSees = (await vet.get('/alerts')).body.data.map((a: any) => a.ruleKey);
    expect(vetSees).not.toContain('budget_overrun');
  });

  it('staff cannot act on an alert they cannot see', async () => {
    const f = await withBudgetAlert();
    const [hidden] = await alertsOf(f, 'budget_overrun');
    const shepherd = await f.as('shepherd');
    expect((await shepherd.post(`/alerts/${hidden.id}/acknowledge`)).status).toBe(404);
  });

  it('sorts urgent first and counts by severity', async () => {
    const f = await withBudgetAlert();
    await f.run(() => raiseAlert({ ruleKey: 'x', dedupKey: 'x', severity: 'urgent', title: 'Shoshilinch' }));
    const owner = await f.as('owner');
    const list = await owner.get('/alerts', { active: true });
    expect(list.body.data[0].severity).toBe('urgent');
    expect(list.body.data.at(-1).severity).toBe('info');
    expect((await owner.get('/alerts/counts')).data).toEqual({ urgent: 1, attention: 2, info: 1, total: 4 });
  });

  it('acknowledge records who took it; cannot be repeated', async () => {
    const f = await withBudgetAlert();
    const director = await f.as('director');
    const [alert] = await alertsOf(f, 'document_expiring');
    const done = await director.post(`/alerts/${alert.id}/acknowledge`);
    expect(done.data.status).toBe('acknowledged');
    expect(done.data.acknowledgedBy).toBe(director.userId);
    const again = await director.post(`/alerts/${alert.id}/acknowledge`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALERT_NOT_OPEN');
  });

  it('investors can read but not act', async () => {
    const f = await withBudgetAlert();
    const investor = await f.as('investor');
    const [alert] = await alertsOf(f, 'document_expiring');
    expect((await investor.post(`/alerts/${alert.id}/acknowledge`)).status).toBe(403);
  });

  it('evaluate is limited to managers', async () => {
    const f = await createFixture();
    expect((await (await f.as('shepherd')).post('/alerts/evaluate')).status).toBe(403);
    expect((await (await f.as('director')).post('/alerts/evaluate')).status).toBe(200);
  });

  it('another tenant cannot see or touch an alert', async () => {
    const a = await withBudgetAlert();
    const b = await createFixture();
    const [alert] = await alertsOf(a, 'document_expiring');
    const owner = await b.as('owner');
    expect((await owner.get('/alerts')).body.data).toEqual([]);
    expect((await owner.post(`/alerts/${alert.id}/acknowledge`)).status).toBe(404);
  });

  it('openAlerts respects the caller and the limit', async () => {
    const f = await withBudgetAlert();
    const rows = await f.run(() => openAlerts(2));
    expect(rows).toHaveLength(2);
    expect(rows[0].severity).toBe('attention');
  });
});

describe('notifications API', () => {
  it('shows each user only their own, and tracks reading', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await f.as('director');
    await f.run(() => notifyRole('owner', { title: 'Egaga' }));
    await f.run(() => notifyRole('owner', { title: 'Yana egaga' }));
    await f.run(() => notifyUser(director.userId, { title: 'Direktorga' }));

    expect((await owner.get('/notifications/unread-count')).data.count).toBe(2);
    const list = await owner.get('/notifications');
    expect(list.body.data.map((n: any) => n.title).sort()).toEqual(['Egaga', 'Yana egaga']);

    const read = await owner.post(`/notifications/${list.body.data[0].id}/read`);
    expect(read.status).toBe(200);
    expect((await owner.get('/notifications/unread-count')).data.count).toBe(1);
    expect((await owner.get('/notifications', { unread: true })).body.data).toHaveLength(1);

    // Someone else's notification is not reachable.
    expect((await director.post(`/notifications/${list.body.data[0].id}/read`)).status).toBe(404);

    expect((await owner.post('/notifications/read-all')).data.updated).toBe(1);
    expect((await owner.get('/notifications/unread-count')).data.count).toBe(0);
    expect((await director.get('/notifications/unread-count')).data.count).toBe(1);
  });

  it('renders the text in each recipient\'s language', async () => {
    const f = await createFixture();
    const ru = await f.as('veterinarian');
    const en = await f.as('zootechnician');
    await f.run(async () => {
      await tx().update(users).set({ locale: 'ru' }).where(eq(users.id, ru.userId));
      await tx().update(users).set({ locale: 'en' }).where(eq(users.id, en.userId));
    });
    await f.run(() =>
      raiseAlert({
        ruleKey: 'sick_animals',
        dedupKey: 's',
        severity: 'attention',
        title: 'Kasal hayvonlar: 3 bosh',
        data: { count: 3 },
      }),
    );
    expect((await notificationsOf(f, ru.userId))[0].title).toBe('Больных животных: 3');
    expect((await notificationsOf(f, en.userId))[0].title).toBe('Sick animals: 3');
  });

  it('preferences default sensibly and can be changed', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const prefs = (await owner.get('/notifications/preferences')).data;
    expect(prefs.channels).toContainEqual({ key: 'sms', configured: false });
    expect(prefs.events.find((e: any) => e.eventType === 'alert_urgent').channels).toEqual(['telegram']);

    const saved = await owner.put('/notifications/preferences', { eventType: 'alert_urgent', channels: [] });
    expect(saved.status).toBe(200);
    expect(saved.data.events.find((e: any) => e.eventType === 'alert_urgent')).toMatchObject({ channels: [], isDefault: false });

    await f.run(() => notifyRole('owner', { severity: 'urgent', title: 'Jim' }));
    const [row] = await notificationsOf(f, owner.userId);
    expect(row.deliveries).toEqual({});
  });
});

describe('telegram delivery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function telegramOk() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    return fetchMock;
  }

  async function linked(f: Fixture, role: 'owner' | 'shepherd' | 'director', chatId: string) {
    const client = await f.as(role);
    await f.run(() => tx().update(users).set({ telegramChatId: chatId }).where(eq(users.id, client.userId)));
    return client;
  }

  const deliveries = async (f: Fixture, userId: string) => (await notificationsOf(f, userId))[0].deliveries;

  it('sends pending messages once and records the result', async () => {
    const f = await createFixture();
    const fetchMock = telegramOk();
    const owner = await linked(f, 'owner', '777');
    await f.run(() => notifyRole('owner', { severity: 'urgent', title: 'Yong\'in <xavfi>', body: 'Omborda', link: '/alerts' }));

    const first = await f.run(() => dispatchPending());
    expect(first.sent).toBe(1);
    expect(await deliveries(f, owner.userId)).toEqual({ telegram: 'sent' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
    const payload = JSON.parse(init.body as string);
    expect(payload.chat_id).toBe('777');
    expect(payload.text).toContain('<b>Yong\'in &lt;xavfi&gt;</b>'); // user text is escaped
    expect(payload.text).toContain('/alerts');

    await f.run(() => dispatchPending());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries server errors in-process, then succeeds', async () => {
    const f = await createFixture();
    await linked(f, 'owner', '1');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: 'oops' }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await f.run(() => notifyRole('owner', { severity: 'urgent', title: 'X' }));
    expect((await f.run(() => dispatchPending())).sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('jobs that wait on the model cannot take a slot from the ones that reach people', async () => {
    bull.reset();
    startJobs({ info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger);
    await vi.waitFor(() => expect(bull.workers).toHaveLength(2));

    const on = (queue: string) => bull.schedulers.filter(([name]) => name === queue).map(([, job]) => job);
    expect(on('yap-urgent').sort()).toEqual(['alerts.evaluate', 'alerts.repeat-urgent', 'notifications.dispatch']);
    expect(on('yap')).toContain('ai-summary-weekly');
    expect(on('yap')).not.toContain('notifications.dispatch');
    expect(bull.workers.map((worker) => worker.queue).sort()).toEqual(['yap', 'yap-urgent']);
    // A scheduler left in Redis from before the split would keep firing on the shared queue.
    expect(bull.removed.filter(([name]) => name === 'yap').map(([, job]) => job).sort()).toEqual(on('yap-urgent').sort());
    // Two of these run every minute for ever, and Redis has no memory limit.
    expect(bull.templates.every((template) => template.opts?.removeOnComplete && template.opts.removeOnFail)).toBe(true);
  });

  it('a Redis that refuses the start is told about loudly and tried again', async () => {
    bull.reset();
    const log = { info: vi.fn(), error: vi.fn() };
    let refusals = 2;
    bull.before = async () => {
      if (refusals-- > 0) throw new Error('LOADING Redis is loading the dataset in memory');
    };

    const stop = startJobs(log as unknown as FastifyBaseLogger);

    await vi.waitFor(() => expect(bull.workers).toHaveLength(2), { timeout: 5_000 });
    expect(log.error).toHaveBeenCalledTimes(1);
    await stop();
  });

  it('stopping lets running jobs finish, unless Redis has gone and no answer can come', async () => {
    bull.reset();
    const stopping = () => startJobs({ info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger);
    const stop = stopping();
    await vi.waitFor(() => expect(bull.workers).toHaveLength(2));
    await stop();
    expect(bull.closes).toEqual([false, false]);

    bull.reset();
    const stopWithRedisGone = stopping();
    await vi.waitFor(() => expect(bull.workers).toHaveLength(2));
    bull.status = 'reconnecting';
    await stopWithRedisGone();
    expect(bull.closes).toEqual([true, true]);
  });

  it('stopping before Redis ever answered ends at once, with no worker left behind', async () => {
    bull.reset();
    bull.before = () => new Promise(() => {});

    const stop = startJobs({ info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger);
    await stop();

    expect(bull.workers).toEqual([]);
  });

  it('a connection lost in the middle of a transaction fails that work, and the process carries on', async () => {
    const f = await createFixture();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const terminate = () => tx().execute(sql`select pg_terminate_backend(pg_backend_pid())`);

    await expect(f.run(terminate)).rejects.toThrow();
    await expect(f.run(() => asAi(terminate))).rejects.toThrow();

    expect((await f.run(() => tx().execute(sql`select 1 as one`))).rows).toEqual([{ one: 1 }]);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
  });

  it('a person Telegram limits keeps their message for after the pause, and it costs no attempt', async () => {
    const f = await createFixture();
    const owner = await linked(f, 'owner', '1');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, parameters: { retry_after: 30 } }), { status: 429 })));
    await f.run(() => notifyRole('owner', { severity: 'urgent', title: 'X' }));

    const started = Date.now();
    expect(await f.run(() => dispatchPending())).toMatchObject({ sent: 0, retried: 1 });

    expect(Date.now() - started).toBeLessThan(5_000);
    const state = await deliveries(f, owner.userId);
    expect(state.telegram).toBe('pending');
    expect(state.telegram_attempts).toBeUndefined();
    expect(Date.parse(state.telegram_next)).toBeGreaterThan(started + 25_000);
  });

  it('one person\'s retry_after does not delay a fire alert to the next person', async () => {
    const f = await createFixture();
    await linked(f, 'owner', '1');
    await linked(f, 'director', '2');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const { chat_id: chatId } = JSON.parse(init.body as string);
        asked.push(chatId);
        return chatId === '1'
          ? new Response(JSON.stringify({ ok: false, parameters: { retry_after: 600 } }), { status: 429 })
          : new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      }),
    );
    await f.run(() => notifyRole(['owner', 'director'], { severity: 'urgent', title: "Yong'in" }));
    await f.run(() => notifyRole('owner', { severity: 'attention', title: 'Yana biri' }));

    const started = Date.now();
    const result = await f.run(() => dispatchPending());

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ sent: 1, retried: 2 });
    expect(asked.filter((chat) => chat === '1')).toHaveLength(1); // once limited, that chat is left alone
    expect(asked).toContain('2');
  });

  it('a chat that blocked the bot is settled at once, and a bad token is not', async () => {
    const f = await createFixture();
    const owner = await linked(f, 'owner', '1');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const answer = (status: number, description: string) =>
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, description }), { status })));

    answer(401, 'Unauthorized');
    await f.run(() => notifyRole('owner', { severity: 'urgent', title: 'X' }));
    await f.run(() => dispatchPending());
    expect((await deliveries(f, owner.userId)).telegram).toBe('pending');

    await f.run(() => tx().update(notifications).set({ deliveries: { telegram: 'pending' } }));
    answer(403, 'Forbidden: bot was blocked by the user');
    await f.run(() => dispatchPending());
    expect((await deliveries(f, owner.userId)).telegram).toBe('not_linked');
  });

  it('an outage stops the run early, rather than sitting out every timeout, and costs the rest no attempt', async () => {
    const f = await createFixture();
    const owner = await linked(f, 'owner', '1');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);
    for (let i = 0; i < 5; i++) await f.run(() => notifyRole('owner', { severity: 'urgent', title: `X${i}` }));

    expect((await f.run(() => dispatchPending())).retried).toBe(3);

    const rows = await notificationsOf(f, owner.userId);
    expect(rows.filter((row) => row.deliveries.telegram_attempts === '1')).toHaveLength(3);
    expect(rows.filter((row) => row.deliveries.telegram_attempts === undefined)).toHaveLength(2);
  });

  it('a fire alert goes first, past rows waiting out their retry and past older urgent ones', async () => {
    const f = await createFixture();
    await linked(f, 'owner', '1');
    const fetchMock = telegramOk();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await f.run(async () => {
      for (let i = 0; i < 3; i++) await notifyRole('owner', { severity: 'info', eventType: 'daily_summary', title: `Kunlik ${i}` });
      for (let i = 0; i < 3; i++) await notifyRole('owner', { severity: 'urgent', title: `Kasal ${i}` });
      await tx().update(notifications).set({ createdAt: new Date(Date.now() - 86_400_000) });
      for (let i = 0; i < 3; i++) await notifyRole('owner', { severity: 'attention', title: `Kutmoqda ${i}` });
      await tx()
        .update(notifications)
        .set({ deliveries: { telegram: 'pending', telegram_next: later, telegram_attempts: '2' } })
        .where(eq(notifications.severity, 'attention'));
      await notifyRole('owner', { severity: 'urgent', title: "Yong'in" });
    });

    await f.run(() => dispatchPending(2));

    const sent = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(([, init]) => JSON.parse(init.body as string).text as string);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("Yong'in");
    expect(sent[1]).toContain('Kasal');
  });

  it('rows waiting out their retry do not use up the batch', async () => {
    const f = await createFixture();
    await linked(f, 'owner', '1');
    const fetchMock = telegramOk();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await f.run(async () => {
      await notifyRole('owner', { severity: 'urgent', title: "Yong'in" });
      await tx().update(notifications).set({ createdAt: new Date(Date.now() - 60_000) });
      for (let i = 0; i < 3; i++) await notifyRole('owner', { severity: 'urgent', title: `Kutmoqda ${i}` });
      await tx()
        .update(notifications)
        .set({ deliveries: { telegram: 'pending', telegram_next: later, telegram_attempts: '2' } })
        .where(sql`${notifications.title} like 'Kutmoqda%'`);
    });

    expect(await f.run(() => dispatchPending(2))).toMatchObject({ sent: 1 });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).text).toContain("Yong'in");
  });

  it.each([
    ['the account is blocked', (f: Fixture, id: string) => tx().update(users).set({ status: 'blocked' }).where(eq(users.id, id))],
    ['the membership has ended', (f: Fixture, id: string) => tx().update(schema.memberships).set({ status: 'blocked' }).where(eq(schema.memberships.userId, id))],
  ])('a message waiting in the outbox does not go out once %s', async (_name, block) => {
    const f = await createFixture();
    const owner = await linked(f, 'owner', '1');
    const fetchMock = telegramOk();
    await f.run(() => notifyRole('owner', { severity: 'urgent', title: 'X', body: '3 000 000 so\'m' }));
    await f.run(() => block(f, owner.userId));

    const result = await f.run(() => dispatchPending());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect((await deliveries(f, owner.userId)).telegram).toBe('skipped');
  });

  it('an outage keeps the message for later, with backoff, and finally gives up in the journal', async () => {
    const f = await createFixture();
    const owner = await linked(f, 'owner', '1');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await f.run(() => notifyRole('owner', { severity: 'urgent', title: 'X' }));

    const first = await f.run(() => dispatchPending());
    expect(first.retried).toBe(1);
    const state = await deliveries(f, owner.userId);
    expect(state.telegram).toBe('pending');
    expect(state.telegram_attempts).toBe('1');
    expect(Date.parse(state.telegram_next)).toBeGreaterThan(Date.now());

    // Too early: nothing is tried.
    expect((await f.run(() => dispatchPending())).retried).toBe(0);

    const force = (attempts: string) =>
      f.run(() =>
        tx()
          .update(notifications)
          .set({ deliveries: { telegram: 'pending', telegram_attempts: attempts } })
          .where(eq(notifications.userId, owner.userId)),
      );
    await force('5');
    const last = await f.run(() => dispatchPending());
    expect(last.failed).toBe(1);
    expect((await deliveries(f, owner.userId)).telegram).toBe('failed');
    const events = await f.run(() => tx().select().from(schema.events).where(eq(schema.events.type, 'notification.delivery_failed')));
    expect(events).toHaveLength(1);
  });

  it('a user who has not linked Telegram does not block the queue', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    telegramOk();
    await f.run(() => notifyRole('owner', { severity: 'urgent', title: 'X' }));
    await f.run(() => dispatchPending());
    expect((await deliveries(f, owner.userId)).telegram).toBe('not_linked');
  });

  it('without a token, messages go to the log and the channel reports not configured', async () => {
    const f = await createFixture();
    const owner = await linked(f, 'owner', '1');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await f.run(() => notifyRole('owner', { severity: 'urgent', title: 'Sinov', body: "Kassada 3 000 000 so'm" }));
    const result = await f.run(() => dispatchPending());
    expect(result.skipped).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toContain('Sinov');
    expect(log.mock.calls.flat().join(' ')).not.toContain('3 000 000'); // money stays out of the log
    expect((await deliveries(f, owner.userId)).telegram).toBe('not_configured');

    const status = await owner.get('/notifications/telegram');
    expect(status.data).toEqual({ configured: false, linked: true, botUsername: null });
    expect((await owner.post('/notifications/telegram/link')).body.error.code).toBe('TELEGRAM_NOT_CONFIGURED');
  });

  it('links a chat with /start <code>; a code works once and expires', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    telegramOk();
    const link = await owner.post('/notifications/telegram/link');
    expect(link.status).toBe(200);
    const { code } = link.data;

    expect(await handleMessage('42', `/start ${code}`)).toContain('/holat');
    expect((await owner.get('/notifications/telegram')).data.linked).toBe(true);

    expect(await handleMessage('43', `/start ${code}`)).toContain("noto'g'ri");

    await f.run(async () => {
      await tx().insert(telegramLinkCodes).values({ code: 'old', userId: owner.userId, expiresAt: new Date(Date.now() - 1000) });
    });
    expect(await handleMessage('44', '/start old')).toContain("noto'g'ri");

    expect((await owner.delete('/notifications/telegram')).data.linked).toBe(false);
  });

  it('the bot polls, answers, moves past what it read, and stops cleanly', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    const replies: any[] = [];
    const polls: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (url.endsWith('/setMyCommands')) return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        if (url.endsWith('/sendMessage')) {
          replies.push(body);
          return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
        }
        polls.push(body);
        // Telegram keeps handing an update back until a poll's offset passes it.
        if (body.offset <= 10) {
          const update = { update_id: 10, message: { message_id: 1, text: '/holat', chat: { id: 555001, type: 'private' } } };
          return new Response(JSON.stringify({ ok: true, result: [update] }), { status: 200 });
        }
        if (body.timeout === 0) return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
        // A real long poll hangs until something arrives or the caller gives up.
        return new Promise((_, reject) =>
          init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        );
      }),
    );
    const log = { info: vi.fn(), error: vi.fn() };

    const stop = startTelegramBot(log);
    await vi.waitFor(() => expect(polls.at(-1).offset).toBe(11), { timeout: 3_000 });

    expect(replies).toHaveLength(1); // however many times Telegram hands it back
    expect(replies[0].chat_id).toBe('555001');
    expect(replies[0].text).toContain('ulanmagan'); // an unknown chat learns nothing about the farm
    expect(polls[0].offset).toBe(0);

    await stop();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('without a token the bot does not start and makes no network call', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const log = { info: vi.fn(), error: vi.fn() };
    startTelegramBot(log)();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('an unknown chat gets instructions and no data', async () => {
    expect(await handleMessage('999999', '/holat')).toContain('ulanmagan');
  });

  async function farmWithMoney() {
    const f = await createFixture();
    const herd = await makeHerd(f, 5);
    const { item, warehouse } = await makeFeed(f, 'Beda', 800);
    await issueFeed(f, item.id, warehouse.id, 100);
    await f.run(() =>
      tx().insert(schema.accounts).values({ ...base(f), name: 'Kassa', type: 'cash', openingBalance: 12_500_000 }),
    );
    await f.run(() =>
      raiseAlert({ ruleKey: 'budget_overrun', dedupKey: 'b', severity: 'urgent', title: 'Byudjet', permission: 'finance.view' }),
    );
    return { f, item };
  }

  it('/holat shows money to the owner and hides it from a shepherd (rule 7)', async () => {
    const { f } = await farmWithMoney();
    await linked(f, 'owner', '100');
    await linked(f, 'shepherd', '200');

    const ownerText = await handleMessage('100', '/holat');
    expect(ownerText).toContain('Kassa va bank');
    expect(ownerText).toContain("so'm");
    expect(ownerText).toContain('5 bosh');
    expect(ownerText).toContain('7 kunga yetadi'); // 700 kg / 100 kg per day
    expect(ownerText).toContain('shoshilinch: 1');

    const shepherdText = await handleMessage('200', '/holat');
    expect(shepherdText).toContain('5 bosh');
    expect(shepherdText).not.toContain('Kassa');
    expect(shepherdText).not.toContain("so'm");
    expect(shepherdText).toContain('shoshilinch: 0'); // the budget alert does not count for them
  });

  it('/ogohlantirishlar lists what the sender may see', async () => {
    const { f } = await farmWithMoney();
    await linked(f, 'owner', '101');
    await linked(f, 'shepherd', '201');
    await f.run(() => raiseAlert({ ruleKey: 'lambing_soon', dedupKey: 'l', severity: 'info', title: 'L', data: { count: 2, date: today } }));
    const owner = await handleMessage('101', '/ogohlantirishlar');
    expect(owner).toContain('Byudjet');
    const shepherd = await handleMessage('201', '/ogohlantirishlar');
    expect(shepherd).not.toContain('Byudjet');
    expect(shepherd).toContain('2 ta sovliq');
  });

  it('daily summary reaches owner and director, each in their language', async () => {
    const { f } = await farmWithMoney();
    const owner = await f.as('owner');
    const director = await f.as('director');
    const shepherd = await f.as('shepherd');
    await f.run(() => tx().update(users).set({ locale: 'ru' }).where(eq(users.id, director.userId)));

    expect(await f.run(() => sendDailySummary())).toBe(2);
    const [mine] = (await notificationsOf(f, owner.userId)).filter((n) => n.eventType === 'daily_summary');
    expect(mine.body).toContain('Kassa va bank');
    expect(mine.deliveries).toEqual({ telegram: 'pending' });
    const [theirs] = (await notificationsOf(f, director.userId)).filter((n) => n.eventType === 'daily_summary');
    expect(theirs.title).toContain('Сводка');
    expect(theirs.body).toContain('Касса и банк');
    expect(await notificationsOf(f, shepherd.userId)).toHaveLength(0);
  });

  it('/holat shows a role only what the web shows it', async () => {
    const { f } = await farmWithMoney();
    const mechanic = await f.as('mechanic');
    await f.run(() => tx().update(users).set({ telegramChatId: '301' }).where(eq(users.id, mechanic.userId)));
    expect((await mechanic.get('/livestock/summary')).status).toBe(403);

    const text = await handleMessage('301', '/holat');

    expect(text).not.toContain(tr('uz', 'alerts', 'digest.herd', { head: '', pregnant: '' }).split(' ')[0]);
    expect(text).toContain(tr('uz', 'alerts', 'digest.alerts', { count: 0, urgent: 0 }).split(' ')[0]);
  });

  it('the daily summary shows no cash when the finance module is off', async () => {
    const { f } = await farmWithMoney();
    const owner = await f.as('owner');
    await withPlatform((trx) => trx.update(schema.tenants).set({ modules: ['livestock', 'feed'] }).where(eq(schema.tenants.id, f.tenantId)));

    await f.run(() => sendDailySummary());

    const [mine] = (await notificationsOf(f, owner.userId)).filter((n) => n.eventType === 'daily_summary');
    expect(mine.body).not.toContain('Kassa va bank');
  });

  it('digest leaves out what it cannot say, and cash adds up', async () => {
    const f = await createFixture();
    const account = await f.run(async () => {
      const [row] = await tx().insert(schema.accounts).values({ ...base(f), name: 'K', type: 'cash', openingBalance: 1000 }).returning();
      return row;
    });
    const [category] = await f.run(() =>
      tx().select().from(financeCategories).where(and(eq(financeCategories.tenantId, f.tenantId), eq(financeCategories.key, 'other'))),
    );
    await f.run(async () =>
      postTransaction({
        date: today,
        type: 'income',
        amount: 500,
        categoryId: category.id,
        costCenterId: await generalCostCenterId(),
        paymentMethod: 'cash',
        accountId: account.id,
      }),
    );
    // An unapproved or unpaid transaction moves no cash.
    await f.run(() =>
      tx().insert(transactions).values({
        ...base(f),
        date: today,
        type: 'expense',
        amount: 300,
        amountBase: 300,
        paymentMethod: 'cash',
        accountId: account.id,
        status: 'pending',
      }),
    );
    const facts = await f.run(() => digestFacts(digestScope(['finance.view'])));
    expect(facts.cash).toBe(1500);
    const { body } = renderDigest({ ...facts, scarceFeed: null }, 'en');
    expect(body).not.toContain('Lowest feed');
    expect(body).not.toContain('Sick');
    expect((await f.run(() => digestFacts(digestScope([])))).cash).toBeNull();
  });
});
