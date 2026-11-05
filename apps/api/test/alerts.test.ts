import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resources } from '@yap/shared/i18n';
import { addDays, todayIso, monthOf, type RoleKey } from '@yap/shared';
import { schema } from '../src/db/client';
import { tx, withPlatform } from '../src/core/context';
import { generalCostCenterId } from '../src/core/costCenters';
import * as health from '../src/core/health';
import { issueStock, receiveStock } from '../src/core/inventory';
import { postTransaction } from '../src/core/ledger';
import { INSIGHT_TYPES } from '../src/modules/ai/analyzers/types';
import { asAi } from '../src/modules/ai/role';
import { raiseAlert, renderAlert, repeatUrgentAlerts } from '../src/modules/alerts/alerts.service';
import { checkReach, UNREACHABLE_RULE } from '../src/modules/alerts/reach';
import { evaluateRules, RULES } from '../src/modules/alerts/rules';
import { openAlerts } from '../src/modules/alerts/summary';
import { startJobs } from '../src/jobs';
import { handleMessage, handleUpdate, laneOf, startTelegramBot } from '../src/modules/notifications/bot';
import { tr } from '../src/modules/notifications/i18n';
import { checkTelegram } from '../src/modules/notifications/telegram';
import { digestFacts, digestScope, renderDigest } from '../src/modules/notifications/digest';
import { sendDailySummary } from '../src/modules/notifications/jobs';
import { dispatchPending, notifyRole, notifyUser } from '../src/modules/notifications/notify.service';
import { addMember } from '../src/core/tenancy';
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
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
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
    [600, 780, 'attention'], // +30%: twice the threshold, and still a matter for the morning
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

  it('budget_overrun: over 100% is attention, and stays attention however far over', async () => {
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
    expect(alert.severity).toBe('attention');
    expect(alert.data).toMatchObject({ percent: 120 });
  });

  it('document_expiring: attention within 30 days, expired or not', async () => {
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
      ['Ruxsat', 'attention'],
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
    expect(found[0].severity).toBe('attention');
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

describe('an urgent alert with nobody reachable', () => {
  const dispatch = (f: Fixture) => f.run(async () => {
    await dispatchPending();
    await checkReach();
  });

  const telegramOk = () => vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
  const chatsMessaged = (fetchMock: ReturnType<typeof telegramOk>) =>
    fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string).chat_id as string);

  async function setup(linked: RoleKey[] = [], members: RoleKey[] = ['owner', 'director', 'veterinarian', 'shepherd']) {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    const f = await createFixture();
    const chats: Partial<Record<RoleKey, string>> = {};
    for (const role of members) {
      const client = await f.as(role);
      if (!linked.includes(role)) continue;
      chats[role] = `chat-${role}-${client.userId}`;
      await f.run(() => tx().update(users).set({ telegramChatId: chats[role] }).where(eq(users.id, client.userId)));
    }
    return { f, chats };
  }

  const fire = (extra: Partial<Parameters<typeof raiseAlert>[0]> = {}) =>
    raiseAlert({ ruleKey: 'device_event', dedupKey: 'fire', severity: 'urgent', title: 'Yong\'in', data: { deviceName: 'Molxona', eventType: 'fire' }, ...extra });

  const openAlert = async (f: Fixture, dedupKey = 'fire') => {
    const [row] = await f.run(() => tx().select().from(alerts).where(and(eq(alerts.farmId, f.farmId), eq(alerts.dedupKey, dedupKey))));
    return row;
  };
  const warning = (f: Fixture) => openAlert(f, UNREACHABLE_RULE);
  const rowsFor = (f: Fixture, userId: string) => f.run(() => tx().select().from(notifications).where(eq(notifications.userId, userId)));

  /** Moves everything that happened so far into the past. */
  const age = (f: Fixture, minutes: number) =>
    f.run(async () => {
      const ago = sql`interval '1 minute' * ${minutes}`;
      await tx().update(notifications).set({ createdAt: sql`created_at - ${ago}` }).where(eq(notifications.tenantId, f.tenantId));
      await tx().update(alerts).set({ undeliveredSince: sql`undelivered_since - ${ago}` }).where(eq(alerts.tenantId, f.tenantId));
    });

  beforeEach(() => vi.stubGlobal('fetch', telegramOk()));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('one message through is enough: nothing escalates, and nothing counts as undelivered', async () => {
    const { f, chats } = await setup(['director', 'veterinarian']);
    const fetchMock = telegramOk();
    vi.stubGlobal('fetch', fetchMock);

    await f.run(() => fire());
    await dispatch(f);
    await age(f, 30);
    await dispatch(f);

    expect(chatsMessaged(fetchMock)).toEqual([chats.director]);
    const alert = await openAlert(f);
    expect(alert.undeliveredSince).toBeNull();
    expect(alert.notifyRoles).toEqual(['director', 'owner']);
  });

  it('when no one on the role has linked a chat, the next role that can hear it does, at once', async () => {
    const { f, chats } = await setup(['veterinarian']);
    const fetchMock = telegramOk();
    vi.stubGlobal('fetch', fetchMock);

    await f.run(() => fire());
    await dispatch(f);

    const alert = await openAlert(f);
    expect(alert.notifyRoles).toEqual(['director', 'owner', 'veterinarian']);
    await dispatch(f);
    expect(chatsMessaged(fetchMock)).toEqual([chats.veterinarian]);
    expect((await openAlert(f)).undeliveredSince).toBeNull();
    const vet = await f.as('veterinarian');
    const [told] = await rowsFor(f, vet.userId);
    expect(told.body).toContain(tr('uz', 'alerts', 'bot.escalated'));
    const journal = await f.run(() => tx().select().from(schema.events).where(and(eq(schema.events.farmId, f.farmId), eq(schema.events.type, 'alert.escalated'))));
    expect(journal.map((event) => event.data.role)).toEqual(['veterinarian']);
  });

  it('nobody on the role at all counts the same', async () => {
    const { f, chats } = await setup(['shepherd'], ['shepherd']);
    const fetchMock = telegramOk();
    vi.stubGlobal('fetch', fetchMock);

    await f.run(() => fire());
    await dispatch(f);
    await dispatch(f);

    expect(chatsMessaged(fetchMock)).toEqual([chats.shepherd]);
  });

  it('a chat that blocked the bot passes it on, and each step goes to the next role', async () => {
    const { f, chats } = await setup(['director', 'veterinarian', 'shepherd']);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const chat = JSON.parse(init.body as string).chat_id;
      if (chat === chats.shepherd) return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      return new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), { status: 403 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await f.run(() => fire());
    await dispatch(f);
    await dispatch(f);
    await dispatch(f);

    expect(chatsMessaged(fetchMock)).toEqual([chats.director, chats.veterinarian, chats.shepherd]);
    expect((await openAlert(f)).undeliveredSince).toBeNull();
  });

  it('a send that keeps failing gets three minutes, then the next role hears too', async () => {
    const { f } = await setup(['director', 'veterinarian']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    await f.run(() => fire());
    await dispatch(f);
    expect((await openAlert(f)).notifyRoles).toEqual(['director', 'owner']);

    await age(f, 3);
    await dispatch(f);

    expect((await openAlert(f)).notifyRoles).toEqual(['director', 'owner', 'veterinarian']);
  });

  it('an alert that shows money does not escalate to someone who may not see it', async () => {
    const { f } = await setup(['shepherd', 'veterinarian']);

    await f.run(() => fire({ permission: 'finance.view' }));
    await dispatch(f);

    expect((await openAlert(f)).notifyRoles).toEqual(['director', 'owner']);
  });

  it('with the whole chain tried it stops, and stays undelivered', async () => {
    const { f } = await setup(['director'], ['owner', 'director']);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'Forbidden: user is deactivated' }), { status: 403 })));

    await f.run(() => fire());
    await dispatch(f);
    await dispatch(f);

    const alert = await openAlert(f);
    expect(alert.notifyRoles).toEqual(['director', 'owner']);
    expect(alert.undeliveredSince).not.toBeNull();
  });

  it('an alert someone has taken stops escalating, and what was already passed on is dropped', async () => {
    const { f } = await setup(['veterinarian']);
    const failing = vi.fn(async () => { throw new Error('network down'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', failing);

    await f.run(() => fire());
    await dispatch(f);
    const vet = await f.as('veterinarian');
    expect((await rowsFor(f, vet.userId)).map((row) => row.deliveries.telegram)).toEqual(['pending']);

    const owner = await f.as('owner');
    const { id } = await openAlert(f);
    expect((await owner.post(`/alerts/${id}/acknowledge`)).status).toBe(200);
    await age(f, 10);
    await f.run(() => tx().update(notifications).set({ deliveries: sql`deliveries - 'telegram_next'` }).where(eq(notifications.userId, vet.userId)));
    const working = telegramOk();
    vi.stubGlobal('fetch', working);
    await dispatch(f);

    expect(working).not.toHaveBeenCalled();
    expect((await rowsFor(f, vet.userId)).map((row) => row.deliveries.telegram)).toEqual(['skipped']);
    expect((await openAlert(f)).notifyRoles).toEqual(['director', 'owner', 'veterinarian']);
  });

  it('a new event on an alert that was delivered last time starts the count again', async () => {
    const { f } = await setup(['director']);

    await f.run(() => fire({ newAfterMs: 1_000 }));
    await dispatch(f);
    expect((await openAlert(f)).undeliveredSince).toBeNull();

    await f.run(() => tx().update(alerts).set({ lastSeenAt: new Date(Date.now() - 60_000) }).where(eq(alerts.farmId, f.farmId)));
    await f.run(() => fire({ newAfterMs: 1_000 }));

    expect((await openAlert(f)).undeliveredSince).not.toBeNull();
  });

  describe('someone who turned Telegram off for urgent alerts', () => {
    const turnOff = (f: Fixture, role: RoleKey, channels: string[] = []) =>
      f.as(role).then((client) => client.put('/notifications/preferences', { eventType: 'alert_urgent', channels }));

    it('counts as unreachable: the only leader doing so leaves the owner warned', async () => {
      const { f } = await setup(['director']);
      await turnOff(f, 'director');

      await f.run(() => checkReach());

      expect((await warning(f)).data.textKey).toBe('urgent_unreachable_not_linked');
    });

    it('a leader who kept it on is enough, and turning it back on clears the warning', async () => {
      const { f } = await setup(['director', 'owner']);
      await turnOff(f, 'director');
      await f.run(() => checkReach());
      expect(await warning(f)).toBeUndefined();

      await turnOff(f, 'owner');
      await f.run(() => checkReach());
      expect((await warning(f)).status).toBe('open');

      await turnOff(f, 'owner', ['telegram']);
      await f.run(() => checkReach());
      expect((await warning(f)).status).toBe('resolved');
    });

    it('is passed over when an alert looks for the next role, which goes to someone who can hear it', async () => {
      const { f, chats } = await setup(['veterinarian', 'shepherd']);
      await turnOff(f, 'veterinarian');
      const fetchMock = telegramOk();
      vi.stubGlobal('fetch', fetchMock);

      await f.run(() => fire());
      await dispatch(f);

      expect(chatsMessaged(fetchMock)).toEqual([]);
      await dispatch(f);
      expect((await openAlert(f)).notifyRoles).toEqual(['director', 'owner', 'shepherd']);
      await dispatch(f);
      expect(chatsMessaged(fetchMock)).toEqual([chats.shepherd]);
    });

    it('says nothing about the server: a farm that chose silence is not an outage', async () => {
      const { f } = await setup(['director']);
      await turnOff(f, 'director');
      const seen = vi.spyOn(health, 'noteUndelivered');

      await f.run(() => fire());
      await dispatch(f);

      expect(seen).toHaveBeenLastCalledWith(f.farmId, null);
    });

    it('the choice in one workspace says nothing about another', async () => {
      const { f } = await setup(['director']);
      const director = await f.as('director');
      const other = await createFixture();
      const [user] = await withPlatform((trx) => trx.select().from(users).where(eq(users.id, director.userId)));
      await addMember({ tenantId: other.tenantId, farmId: other.farmId, roleId: other.roleIds.director, phone: user.phone, fullName: user.fullName, password: 'Password123!' });
      await other.run(() => tx().insert(schema.notificationPrefs).values({ tenantId: other.tenantId, userId: director.userId, eventType: 'alert_urgent', channels: [] }));

      await f.run(() => checkReach());
      await other.run(() => checkReach());

      expect(await warning(f)).toBeUndefined();
      expect((await warning(other)).data.textKey).toBe('urgent_unreachable_not_linked');
    });
  });

  it('only urgent alerts are followed', async () => {
    const { f } = await setup([]);

    await f.run(() => fire({ severity: 'attention' }));

    expect((await openAlert(f)).undeliveredSince).toBeNull();
  });

  it('an urgent message waits five minutes at most between tries, so it goes soon after the channel returns', async () => {
    const { f } = await setup(['director']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await f.run(() => fire());
    const director = await f.as('director');

    for (const attempts of ['2', '4']) {
      await f.run(() => tx().update(notifications).set({ deliveries: { telegram: 'pending', telegram_attempts: attempts } }).where(eq(notifications.userId, director.userId)));
      await f.run(() => dispatchPending());
      const [row] = await rowsFor(f, director.userId);
      expect(Date.parse(row.deliveries.telegram_next)).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    }
  });

  it('the owner sees a standing warning while no owner or director is linked, and it goes when one is', async () => {
    const { f } = await setup(['shepherd']);
    const owner = await f.as('owner');

    await f.run(() => checkReach());
    await f.run(() => checkReach());

    const alert = await warning(f);
    expect(alert).toMatchObject({ severity: 'urgent', status: 'open', notifyRoles: ['owner'], link: '/notifications', nextNotifyAt: null, undeliveredSince: null });
    expect(renderAlert(alert, 'en').title).toBe('Fire alerts have nobody to go to');
    const told = await rowsFor(f, owner.userId);
    expect(told).toHaveLength(1);
    expect(told[0].deliveries).toEqual({});
    expect((await owner.get('/alerts/counts')).data.urgent).toBe(1);

    await f.run(() => tx().update(users).set({ telegramChatId: 'chat-owner' }).where(eq(users.id, owner.userId)));
    await f.run(() => checkReach());

    expect((await warning(f)).status).toBe('resolved');
  });

  it('the warning comes back if someone closes it while the problem holds', async () => {
    const { f } = await setup([]);
    await f.run(() => checkReach());
    const owner = await f.as('owner');
    expect((await owner.post(`/alerts/${(await warning(f)).id}/resolve`)).status).toBe(200);

    await f.run(() => checkReach());

    const open = await f.run(() => tx().select().from(alerts).where(and(eq(alerts.farmId, f.farmId), eq(alerts.dedupKey, UNREACHABLE_RULE), eq(alerts.status, 'open'))));
    expect(open).toHaveLength(1);
  });

  it('without a bot the warning says so, and nothing tries to escalate', async () => {
    const { f } = await setup(['director']);
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');

    await f.run(() => fire());
    await f.run(() => checkReach());

    expect(renderAlert(await warning(f), 'en').title).toBe('Urgent alerts do not leave the app');
    expect((await openAlert(f)).notifyRoles).toEqual(['director', 'owner']);
  });

  it('sends that keep failing raise the warning too, and it is gone once a message gets through', async () => {
    const { f } = await setup(['director'], ['owner', 'director']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    await f.run(() => fire());
    await dispatch(f);
    expect(await warning(f)).toBeUndefined();

    await age(f, 6);
    await dispatch(f);
    expect(renderAlert(await warning(f), 'ru').title).toBe('Срочное предупреждение никому не дошло');

    vi.stubGlobal('fetch', telegramOk());
    const director = await f.as('director');
    await f.run(() => tx().update(notifications).set({ deliveries: { telegram: 'pending' } }).where(eq(notifications.userId, director.userId)));
    await dispatch(f);

    expect((await warning(f)).status).toBe('resolved');
  });

  it('a bot that has lost Telegram warns the owner before any alert has failed', async () => {
    const { f } = await setup(['owner', 'director']);

    health.noteTelegramContact(new Date(Date.now() - 6 * 60_000));
    await f.run(() => checkReach());
    expect(renderAlert(await warning(f), 'en').title).toBe('Telegram cannot be reached');

    health.noteTelegramContact();
    await f.run(() => checkReach());
    expect((await warning(f)).status).toBe('resolved');
  });

  it('the warning itself is not followed, repeated or passed on', async () => {
    const { f } = await setup(['veterinarian']);

    await f.run(() => checkReach());
    await age(f, 30);
    await dispatch(f);
    const repeated = await f.run(() => repeatUrgentAlerts());

    const alert = await warning(f);
    expect(repeated).toBe(0);
    expect(alert.notifyRoles).toEqual(['owner']);
  });

  it('tells the health check about a stuck alert, but not a farm that has linked nobody', async () => {
    const seen = vi.spyOn(health, 'noteUndelivered');

    const nobody = await setup([]);
    await nobody.f.run(() => fire());
    await nobody.f.run(() => checkReach());
    expect(seen).toHaveBeenLastCalledWith(nobody.f.farmId, null);

    const linked = await setup(['director']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await linked.f.run(() => fire());
    await dispatch(linked.f);
    const { undeliveredSince } = await openAlert(linked.f);
    expect(seen).toHaveBeenLastCalledWith(linked.f.farmId, undeliveredSince);

    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    await linked.f.run(() => checkReach());
    expect(seen).toHaveBeenLastCalledWith(linked.f.farmId, null);
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
    UNREACHABLE_RULE: ['not_configured', 'channel_down', 'not_linked', 'undelivered'].map((reason) => `urgent_unreachable_${reason}`),
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

describe('the Acknowledge button on an urgent alert', () => {
  const log = () => ({ info: vi.fn(), error: vi.fn() });
  const fire = (extra: Partial<Parameters<typeof raiseAlert>[0]> = {}) =>
    raiseAlert({ ruleKey: 'device_event', dedupKey: 'fire', severity: 'urgent', title: "Yong'in", ...extra });

  /** Telegram, answering everything, and remembering what it was asked. */
  function fakeTelegram() {
    const calls: { method: string; body: any }[] = [];
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: url.split('/').pop()!, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
    }));
    return {
      of: (method: string) => calls.filter((call) => call.method === method).map((call) => call.body),
      notice: () => calls.filter((call) => call.method === 'answerCallbackQuery').at(-1)?.body.text as string | undefined,
    };
  }

  async function person(f: Fixture, role: RoleKey, chatId: string, locale = 'uz') {
    const client = await f.as(role);
    await f.run(() => tx().update(users).set({ telegramChatId: chatId, locale }).where(eq(users.id, client.userId)));
    return client;
  }

  const press = (chatId: string, alertId: string, extra: object = {}) =>
    handleUpdate(
      {
        update_id: 1,
        callback_query: {
          id: 'press',
          from: { id: Number(chatId) },
          data: `a:${alertId}`,
          message: { message_id: 7, chat: { id: Number(chatId), type: 'private' } },
          ...extra,
        },
      },
      log(),
    );

  const alertRow = async (f: Fixture, id: string) => {
    const [row] = await f.run(() => tx().select().from(alerts).where(eq(alerts.id, id)));
    return row;
  };
  const journal = (f: Fixture, id: string) =>
    f.run(() => tx().select().from(schema.events).where(and(eq(schema.events.type, 'alert.acknowledged'), eq(schema.events.entityId, id))));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('an urgent alert arrives with the button, in the language of the reader, on every repeat', async () => {
    const f = await createFixture();
    const telegram = fakeTelegram();
    await person(f, 'owner', '4101', 'ru');
    const { id } = await f.run(() => fire({ notify: ['owner'] }));
    await f.run(() => dispatchPending());

    const [first] = telegram.of('sendMessage');
    expect(first.reply_markup).toEqual({ inline_keyboard: [[{ text: tr('ru', 'alerts', 'bot.buttons.acknowledge'), callback_data: `a:${id}` }]] });

    await f.run(() => tx().update(alerts).set({ nextNotifyAt: new Date(0) }).where(eq(alerts.id, id)));
    await f.run(async () => {
      await repeatUrgentAlerts();
      await dispatchPending();
    });
    expect(telegram.of('sendMessage').map((message) => message.reply_markup.inline_keyboard[0][0].callback_data)).toEqual([`a:${id}`, `a:${id}`]);
  });

  it('nothing but an urgent alert has one: not a lesser alert, not a notice, not a long message cut in two', async () => {
    const f = await createFixture();
    const telegram = fakeTelegram();
    await person(f, 'owner', '4102');
    await f.run(() => raiseAlert({ ruleKey: 'stock_low', dedupKey: 's', severity: 'attention', title: 'Kam', notify: ['owner'] }));
    await f.run(() => notifyRole('owner', { severity: 'urgent', title: 'No alert behind this' }));
    await f.run(() => dispatchPending());
    expect(telegram.of('sendMessage')).toHaveLength(2);
    expect(telegram.of('sendMessage').every((message) => message.reply_markup === undefined)).toBe(true);

    const { id } = await f.run(() => fire({ notify: ['owner'], body: 'x '.repeat(3_000) }));
    await f.run(() => dispatchPending());
    const [, , head, tail] = telegram.of('sendMessage');
    expect(head.reply_markup).toBeUndefined();
    expect(tail.reply_markup.inline_keyboard[0][0].callback_data).toBe(`a:${id}`);
  });

  it('a press takes the alert as the linked person, stops the repeats, writes the journal and clears the button', async () => {
    const f = await createFixture();
    const telegram = fakeTelegram();
    const director = await person(f, 'director', '4103', 'ru');
    const { id } = await f.run(() => fire());

    await press('4103', id);

    expect(await alertRow(f, id)).toMatchObject({ status: 'acknowledged', acknowledgedBy: director.userId, nextNotifyAt: null });
    expect(await journal(f, id)).toMatchObject([{ createdBy: director.userId, source: 'mobile', data: { ruleKey: 'device_event' } }]);
    expect(telegram.notice()).toBe(tr('ru', 'alerts', 'toast.acknowledged'));
    expect(telegram.of('editMessageReplyMarkup')).toEqual([{ chat_id: '4103', message_id: 7 }]);

    await f.run(() => tx().update(alerts).set({ nextNotifyAt: new Date(0) }).where(eq(alerts.id, id)));
    expect(await f.run(() => repeatUrgentAlerts())).toBe(0);
  });

  it('a second press, from anyone, finds it taken, and the journal has one entry', async () => {
    const f = await createFixture();
    const telegram = fakeTelegram();
    const director = await person(f, 'director', '4104');
    await person(f, 'owner', '4105');
    const { id } = await f.run(() => fire());

    await press('4104', id);
    await press('4105', id);

    expect(telegram.notice()).toBe(tr('uz', 'alerts', 'errors.ALERT_NOT_OPEN'));
    expect((await alertRow(f, id)).acknowledgedBy).toBe(director.userId);
    expect(await journal(f, id)).toHaveLength(1);
    expect(telegram.of('editMessageReplyMarkup')).toHaveLength(2);
  });

  it('a closed alert is taken too, and a message too old to touch still works', async () => {
    const f = await createFixture();
    const telegram = fakeTelegram();
    await person(f, 'director', '4106');
    const first = await f.run(() => fire());
    await press('4106', first.id, { message: undefined });
    expect((await alertRow(f, first.id)).status).toBe('acknowledged');
    expect(telegram.of('editMessageReplyMarkup')).toEqual([]);

    const closed = await f.run(() => fire({ dedupKey: 'closed' }));
    await (await f.as('director')).post(`/alerts/${closed.id}/resolve`);
    await press('4106', closed.id);
    expect(telegram.notice()).toBe(tr('uz', 'alerts', 'errors.ALERT_NOT_OPEN'));
    expect((await alertRow(f, closed.id)).status).toBe('resolved');
  });

  it('without the right to acknowledge it refuses, as the web route does, and the alert keeps repeating', async () => {
    const f = await createFixture();
    const telegram = fakeTelegram();
    await person(f, 'director', '4107');
    await f.run(() => tx().update(schema.roles).set({ permissions: ['dashboard.view'] }).where(eq(schema.roles.id, f.roleIds.director)));
    const { id } = await f.run(() => fire());

    await press('4107', id);

    expect(telegram.notice()).toBe(tr('uz', 'alerts', 'bot.noRightToAcknowledge'));
    expect(await alertRow(f, id)).toMatchObject({ status: 'open', acknowledgedBy: null });
    expect(await journal(f, id)).toEqual([]);
    expect(telegram.of('editMessageReplyMarkup')).toEqual([]);
  });

  it('an alert this person may not see stays out of reach: money, another role, another workspace', async () => {
    const f = await createFixture();
    const other = await createFixture();
    const telegram = fakeTelegram();
    await person(f, 'shepherd', '4109');
    const money = await f.run(() => fire({ dedupKey: 'money', notify: ['shepherd'], permission: 'finance.view' }));
    const theirs = await f.run(() => fire({ dedupKey: 'theirs', notify: ['veterinarian'] }));
    const elsewhere = await other.run(() => fire({ notify: ['owner'] }));

    for (const { id } of [money, theirs, elsewhere]) {
      await press('4109', id);
      expect(telegram.notice()).toBe(tr('uz', 'alerts', 'bot.stale'));
    }

    expect((await alertRow(f, money.id)).status).toBe('open');
    expect((await alertRow(f, theirs.id)).status).toBe('open');
    expect((await alertRow(other, elsewhere.id)).status).toBe('open');
  });

  it('a chat nobody has linked, or a blocked person, gets no further than their refusal', async () => {
    const f = await createFixture();
    const telegram = fakeTelegram();
    const director = await person(f, 'director', '4110');
    const { id } = await f.run(() => fire());

    await press('4199', id);
    expect(telegram.notice()).toBe(tr(undefined, 'alerts', 'bot.notLinked'));

    await f.run(() => tx().update(users).set({ status: 'blocked' }).where(eq(users.id, director.userId)));
    await press('4110', id);
    expect(telegram.notice()).toBe(tr('uz', 'alerts', 'bot.blocked'));
    expect((await alertRow(f, id)).status).toBe('open');
  });

  it('a press that is not ours is out of date, not a failure', async () => {
    const f = await createFixture();
    const telegram = fakeTelegram();
    await person(f, 'director', '4111');

    await handleUpdate(
      { update_id: 1, callback_query: { id: 'press', from: { id: 4111 }, data: "a:' or 1=1 --", message: { message_id: 7, chat: { id: 4111 } } } },
      log(),
    );

    expect(telegram.notice()).toBe(tr('uz', 'alerts', 'bot.stale'));
  });

  it('it works from any farm the person is on, whichever one the chat is set to, and answers for that farm', async () => {
    const f = await createFixture();
    const second = await createFixture();
    fakeTelegram();
    const owner = await person(f, 'owner', '4112');
    const [user] = await withPlatform((trx) => trx.select().from(users).where(eq(users.id, owner.userId)));
    await addMember({ tenantId: second.tenantId, farmId: second.farmId, roleId: second.roleIds.owner, phone: user.phone, fullName: user.fullName, password: 'Password123!' });
    const { id } = await second.run(() => fire({ notify: ['owner'] }));

    await press('4112', id);

    expect(await alertRow(second, id)).toMatchObject({ status: 'acknowledged', acknowledgedBy: owner.userId });
    expect(await journal(second, id)).toHaveLength(1);
    expect(await journal(f, id)).toEqual([]);
  });

  it('someone who has not set up two-step sign-in cannot act through the bot either', async () => {
    const f = await createFixture({ settings: { security: { enforce2fa: true } } });
    const telegram = fakeTelegram();
    await person(f, 'director', '4113');
    const { id } = await f.run(() => fire());

    await press('4113', id);

    expect(telegram.notice()).toBe(tr('uz', 'alerts', 'bot.enroll2fa'));
    expect((await alertRow(f, id)).status).toBe('open');
  });

  it('a failure to take the button away does not read as a failed press', async () => {
    const f = await createFixture();
    await person(f, 'director', '4114');
    const { id } = await f.run(() => fire());
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('editMessageReplyMarkup')) return new Response(JSON.stringify({ ok: false, description: 'message to edit not found' }), { status: 400 });
      calls.push(JSON.parse(init.body as string).text);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }));
    const logger = log();

    await handleUpdate({ update_id: 1, callback_query: { id: 'press', from: { id: 4114 }, data: `a:${id}`, message: { message_id: 7, chat: { id: 4114 } } } }, logger);

    expect(calls).toEqual([tr('uz', 'alerts', 'toast.acknowledged')]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect((await alertRow(f, id)).status).toBe('acknowledged');
  });

  it('does not wait behind the assistant: a press has the quick lane', () => {
    const update = { update_id: 1, callback_query: { id: 'q', from: { id: 1 }, data: 'a:019a0000-0000-7000-8000-000000000000' } };
    expect(laneOf(update, '1')).toBe('1:quick');
  });

  it('the web and the bot at the same moment: one takes it, the other is told', async () => {
    const f = await createFixture();
    fakeTelegram();
    const director = await person(f, 'director', '4115');
    const { id } = await f.run(() => fire());

    const [web] = await Promise.all([director.post(`/alerts/${id}/acknowledge`), press('4115', id)]);

    expect([200, 409]).toContain(web.status);
    expect(await journal(f, id)).toHaveLength(1);
  });
});

describe('a test alert', () => {
  const staff: RoleKey[] = ['owner', 'director', 'veterinarian', 'shepherd'];

  async function setup(linked: RoleKey[], members: RoleKey[] = staff) {
    const f = await createFixture();
    const people = {} as Record<RoleKey, Awaited<ReturnType<Fixture['as']>>>;
    let chat = 5000;
    for (const role of members) {
      people[role] = await f.as(role);
      if (!linked.includes(role)) continue;
      const telegramChatId = String((chat += 1));
      await f.run(() => tx().update(users).set({ telegramChatId }).where(eq(users.id, people[role].userId)));
    }
    return { f, people };
  }

  function telegramAnswers(answer: (chatId: string) => Response = () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })) {
    const sent: any[] = [];
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sent.push(body);
      return answer(body.chat_id);
    }));
    return sent;
  }

  const roles = (rows: { role: string }[]) => rows.map((row) => row.role).sort();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('goes the way a real one goes, and says who heard it and who did not', async () => {
    const sent = telegramAnswers();
    const { f, people } = await setup(['owner', 'veterinarian']);

    const res = await people.owner.post('/alerts/test');

    expect(res.status).toBe(200);
    expect(roles(res.data.reached)).toEqual(['owner', 'veterinarian']);
    expect(res.data.reached.find((row: any) => row.role === 'owner')).toEqual({ userId: people.owner.userId, name: expect.stringContaining('owner'), role: 'owner' });
    expect(res.data.unreachable.map((row: any) => [row.role, row.reason]).sort()).toEqual([['director', 'not_linked'], ['shepherd', 'not_linked']]);
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain(tr('uz', 'alerts', 'testAlert.message.title'));
    expect(sent[0].text).toContain('🔴');

    const rows = await f.run(() => tx().select().from(notifications).where(eq(notifications.userId, people.owner.userId)));
    expect(rows).toMatchObject([{ eventType: 'alert_urgent', severity: 'urgent', alertId: null, deliveries: { telegram: 'sent' } }]);
  });

  it('each reader sees the word test in their own language', async () => {
    const sent = telegramAnswers();
    const { f, people } = await setup(['owner']);
    await f.run(() => tx().update(users).set({ locale: 'ru' }).where(eq(users.id, people.owner.userId)));

    await people.owner.post('/alerts/test');

    expect(sent[0].text).toContain('ПРОВЕРКА');
    expect(tr('en', 'alerts', 'testAlert.message.title')).toContain('TEST');
    expect(tr('uz', 'alerts', 'testAlert.message.title')).toContain('SINOV');
  });

  it('is no alert: nothing to acknowledge, nothing repeats, nothing is left open, and the journal has it', async () => {
    const sent = telegramAnswers();
    const { f, people } = await setup(['owner']);

    await people.owner.post('/alerts/test');

    expect(sent[0].reply_markup).toBeUndefined();
    expect(await f.run(() => tx().select().from(alerts))).toEqual([]);
    expect(await f.run(() => repeatUrgentAlerts())).toBe(0);
    const [event] = await f.run(() => tx().select().from(schema.events).where(eq(schema.events.type, 'alert.test_sent')));
    expect(event).toMatchObject({ createdBy: people.owner.userId, data: { reached: 1, unreachable: 3 } });
  });

  it('someone who turned Telegram off for urgent alerts hears nothing, and it says so', async () => {
    const sent = telegramAnswers();
    const { people } = await setup(['owner', 'director']);
    await people.director.put('/notifications/preferences', { eventType: 'alert_urgent', channels: [] });

    const res = await people.owner.post('/alerts/test');

    expect(sent).toHaveLength(1);
    expect(res.data.unreachable.find((row: any) => row.role === 'director').reason).toBe('turned_off');
  });

  it('a person who blocked the bot counts as not linked, and a Telegram that fails counts as failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { people } = await setup(['owner', 'director', 'veterinarian']);
    const [owner, director] = await Promise.all(
      [people.owner, people.director].map(async (client) => (await withPlatform((trx) => trx.select().from(users).where(eq(users.id, client.userId))))[0]),
    );
    telegramAnswers((chatId) => {
      if (chatId === owner.telegramChatId) return new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), { status: 403 });
      if (chatId === director.telegramChatId) return new Response('{}', { status: 502 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });

    const res = await people.owner.post('/alerts/test');

    expect(roles(res.data.reached)).toEqual(['veterinarian']);
    expect(res.data.unreachable.find((row: any) => row.role === 'owner').reason).toBe('not_linked');
    expect(res.data.unreachable.find((row: any) => row.role === 'director').reason).toBe('failed');
  });

  it('with no bot set up, it reaches nobody and says why', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { people } = await setup(['owner']);

    const res = await people.owner.post('/alerts/test');

    expect(res.data.reached).toEqual([]);
    expect(new Set(res.data.unreachable.map((row: any) => row.reason))).toEqual(new Set(['not_configured']));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('goes only to staff an urgent alert can reach, and each run answers for itself', async () => {
    const sent = telegramAnswers();
    const { people } = await setup(['owner', 'investor'], ['owner', 'investor']);

    const first = await people.owner.post('/alerts/test');
    const second = await people.owner.post('/alerts/test');

    expect(sent).toHaveLength(2);
    expect(roles(first.data.reached)).toEqual(['owner']);
    expect(first.data.unreachable).toEqual([]);
    expect(roles(second.data.reached)).toEqual(['owner']);
    expect(second.data.unreachable).toEqual([]);
  });

  it('is for those who manage alerts', async () => {
    telegramAnswers();
    const { people } = await setup([], ['owner', 'director', 'zootechnician', 'shepherd', 'accountant', 'investor']);

    expect((await people.director.post('/alerts/test')).status).toBe(200);
    for (const role of ['zootechnician', 'shepherd', 'accountant', 'investor'] as const) {
      expect((await people[role].post('/alerts/test')).status).toBe(403);
    }
  });

  it('names stay hidden without pii.view (rule 8)', async () => {
    telegramAnswers();
    const { f, people } = await setup(['owner']);
    await f.run(() =>
      tx().update(schema.roles).set({ permissions: ['dashboard.view', 'dashboard.update'] }).where(eq(schema.roles.id, f.roleIds.director)),
    );

    const res = await people.director.post('/alerts/test');

    expect(res.status).toBe(200);
    expect(res.data.reached).toEqual([{ userId: people.owner.userId, name: null, role: 'owner' }]);
    expect(res.data.unreachable.every((row: any) => row.name === null)).toBe(true);
  });
});

describe('what counts as urgent (spec 17.3)', () => {
  it.each(['budget_overrun', 'document_expiring', 'batch_expiring', 'loan_payment_due', 'ration_deviation', 'ai.feed_anomaly'])(
    '%s never repeats, even from a caller that asks for urgent',
    async (ruleKey) => {
      const f = await createFixture();
      await f.run(() => raiseAlert({ ruleKey, dedupKey: 'k', severity: 'urgent', title: 'T' }));
      const [alert] = await alertsOf(f, ruleKey);
      expect(alert).toMatchObject({ severity: 'attention', nextNotifyAt: null, undeliveredSince: null });
      await f.run(() => tx().update(alerts).set({ nextNotifyAt: new Date(0) }).where(eq(alerts.id, alert.id)));
      expect(await f.run(() => repeatUrgentAlerts())).toBe(0);
    },
  );

  it('an expired batch and an overdue loan payment wait for the working day', async () => {
    const f = await createFixture();
    const { item } = await makeFeed(f, 'Dori', 10);
    await f.run(async () => {
      await tx().update(stockBatches).set({ expiryDate: addDays(today, -1) }).where(eq(stockBatches.itemId, item.id));
      const [loan] = await tx()
        .insert(schema.loans)
        .values({ ...base(f), name: 'Kredit', principal: 1_000_000, annualRate: 20, termMonths: 12, startDate: addDays(today, -30) })
        .returning();
      await tx()
        .insert(schema.loanInstalments)
        .values({ ...base(f), loanId: loan.id, period: 1, dueDate: addDays(today, -1), principal: 100, interest: 1, payment: 101, balance: 900 });
      await evaluateRules();
    });
    expect((await alertsOf(f, 'batch_expiring')).map((a) => [a.data.textKey, a.severity])).toEqual([['batch_expired', 'attention']]);
    expect((await alertsOf(f, 'loan_payment_due')).map((a) => [a.data.textKey, a.severity])).toEqual([['loan_payment_overdue', 'attention']]);
  });

  it('an alert already repeating as urgent calms down at the next evaluation', async () => {
    const f = await createFixture();
    await f.run(() =>
      tx().insert(documents).values({ ...base(f), type: 'permit', title: 'Ruxsat', expiryDate: addDays(today, -1) }),
    );
    await f.run(() => evaluateRules());
    const [alert] = await alertsOf(f, 'document_expiring');
    await f.run(() =>
      tx().update(alerts).set({ severity: 'urgent', nextNotifyAt: new Date(0), undeliveredSince: new Date() }).where(eq(alerts.id, alert.id)),
    );
    await f.run(() => evaluateRules());
    expect((await alertsOf(f, 'document_expiring'))[0]).toMatchObject({ severity: 'attention', nextNotifyAt: null, undeliveredSince: null });
    expect(await f.run(() => repeatUrgentAlerts())).toBe(0);
  });

  it('what can hurt animals now stays urgent, and repeats', async () => {
    const f = await createFixture();
    for (const ruleKey of ['device_event', 'sick_animals', 'sick_report', 'mortality_spike', 'feed_low']) {
      await f.run(() => raiseAlert({ ruleKey, dedupKey: ruleKey, severity: 'urgent', title: 'T' }));
      expect((await alertsOf(f, ruleKey))[0]).toMatchObject({ severity: 'urgent', status: 'open' });
      expect((await alertsOf(f, ruleKey))[0].nextNotifyAt).not.toBeNull();
    }
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
    const stop = startJobs({ info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger);
    await vi.waitFor(() => expect(bull.workers).toHaveLength(2));
    await stop();

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
    const wired = vi.spyOn(health, 'setTelegramCheck');
    const log = { info: vi.fn(), error: vi.fn() };
    startTelegramBot(log)();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledOnce();
    expect(wired).not.toHaveBeenCalled();
  });

  it('a running bot hands the deep check its question to Telegram', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })));
    const wired = vi.spyOn(health, 'setTelegramCheck');

    const stop = startTelegramBot({ info: vi.fn(), error: vi.fn() });
    await stop();

    expect(wired).toHaveBeenCalledWith(checkTelegram);
    health.setTelegramCheck(null);
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
      raiseAlert({ ruleKey: 'budget_exceeded', dedupKey: 'b', severity: 'urgent', title: 'Byudjet', permission: 'finance.view' }),
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
