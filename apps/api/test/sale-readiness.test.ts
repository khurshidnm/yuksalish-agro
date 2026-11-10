import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIso } from '@yap/shared';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { ensureCostCenter } from '../src/core/costCenters';
import { jobs as salesJobs } from '../src/modules/sales/jobs';
import * as reservations from '../src/modules/sales/reservations.service';
import { createFixture, type Client, type Fixture } from './helpers';

const { accounts, animalExits, animalReservations, animals, counterparties, cullMarks, events, healthRecords, herds, sales, species, weightRecords } =
  schema;

const TODAY = todayIso();
const day = (offset: number) => addDays(TODAY, offset);

interface World {
  herdId: string;
  otherHerdId: string;
  speciesId: string;
  buyerId: string;
  otherBuyerId: string;
  accountId: string;
}

async function arrange(f: Fixture): Promise<World> {
  return f.run(async () => {
    const base = { tenantId: f.tenantId, farmId: f.farmId };
    const [sheep] = await tx().select().from(species).where(eq(species.tenantId, f.tenantId)).limit(1);
    const made = await tx().insert(herds).values([{ ...base, name: 'Bo\'rdoqi' }, { ...base, name: 'Sovliqlar' }]).returning();
    for (const herd of made) {
      const costCenterId = await ensureCostCenter('herd', herd.id, herd.name);
      await tx().update(herds).set({ costCenterId }).where(eq(herds.id, herd.id));
    }
    const [buyer] = await tx().insert(counterparties).values({ ...base, name: 'Xaridor MChJ', type: 'buyer' }).returning();
    const [other] = await tx().insert(counterparties).values({ ...base, name: 'Boshqa Xaridor', type: 'buyer' }).returning();
    const [account] = await tx().insert(accounts).values({ ...base, name: 'Kassa', type: 'cash' }).returning();
    return { herdId: made[0].id, otherHerdId: made[1].id, speciesId: sheep.id, buyerId: buyer.id, otherBuyerId: other.id, accountId: account.id };
  });
}

let tagCounter = 0;
/** An animal with its weighings: `[days from today, kg]`. The animal row carries the newest, as the weights service keeps it. */
async function addAnimal(f: Fixture, w: World, weighings: [number, number][] = [], over: Partial<typeof animals.$inferInsert> = {}) {
  return f.run(async () => {
    const newest = [...weighings].sort((a, b) => a[0] - b[0]).at(-1);
    const [row] = await tx()
      .insert(animals)
      .values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        tag: `SR-${++tagCounter}`,
        speciesId: w.speciesId,
        sex: 'male',
        category: 'fattening',
        origin: 'born',
        herdId: w.herdId,
        status: 'active',
        currentWeightKg: newest ? newest[1] : null,
        lastWeighedOn: newest ? day(newest[0]) : null,
        ...over,
      })
      .returning();
    if (weighings.length) {
      await tx()
        .insert(weightRecords)
        .values(weighings.map(([offset, kg]) => ({ tenantId: f.tenantId, farmId: f.farmId, animalId: row.id, date: day(offset), weightKg: kg })));
    }
    return row;
  });
}

/**
 * The control animal of the formula test, moved to today: weighed 71, 40 and 10 days ago at
 * 30.0, 36.2 and 42.2 kg. 12.2 kg over 61 days is 0.2 kg a day. Target 45 kg: 2.8 / 0.2 = 14 days
 * after the last weighing, which is 4 days from today. Today it should weigh 42.2 + 0.2 x 10 = 44.2 kg.
 */
const CONTROL: [number, number][] = [
  [-71, 30],
  [-40, 36.2],
  [-10, 42.2],
];

const rowOf = (res: { data: { id: string }[] }, id: string) => res.data.find((row) => row.id === id) as any;

describe('ready-for-sale list', () => {
  let f: Fixture;
  let w: World;
  let shepherd: Client;
  let accountant: Client;
  let control: typeof animals.$inferSelect;

  beforeAll(async () => {
    f = await createFixture({ settings: { livestock: { saleTargetWeightKg: 45 } } });
    w = await arrange(f);
    shepherd = await f.as('shepherd');
    accountant = await f.as('accountant');
    control = await addAnimal(f, w, CONTROL);
  });

  it('gives the hand-computed forecast for the control animal', async () => {
    const res = await shepherd.get('/livestock/sale-readiness', { pageSize: 200 });
    expect(res.status).toBe(200);
    expect(rowOf(res, control.id)).toMatchObject({
      tag: control.tag,
      targetKg: 45,
      status: 'soon',
      currentWeightKg: 42.2,
      lastWeighedOn: day(-10),
      dailyGainKg: 0.2,
      gainFrom: day(-71),
      projectedWeightKg: 44.2,
      targetDate: day(4),
      daysToTarget: 4,
      notGaining: false,
      withdrawalUntil: null,
      reservation: null,
      cullMark: null,
      freeToSell: true,
    });
  });

  it('a target given with the request stands in for the setting', async () => {
    // 60 kg: 17.8 / 0.2 = 89 days after the weighing, 79 days from today: later.
    const far = await shepherd.get('/livestock/sale-readiness', { targetKg: 60, pageSize: 200 });
    expect(rowOf(far, control.id)).toMatchObject({ targetKg: 60, status: 'later', targetDate: day(79), daysToTarget: 79 });
    // 42 kg: the last measured weight is already there.
    const there = await shepherd.get('/livestock/sale-readiness', { targetKg: 42, pageSize: 200 });
    expect(rowOf(there, control.id)).toMatchObject({ status: 'ready', targetDate: day(-10) });
  });

  it('without a target nothing is forecast: unknown, with the measured gain still shown', async () => {
    const g = await createFixture();
    const world = await arrange(g);
    const animal = await addAnimal(g, world, CONTROL);
    const res = await (await g.as('zootechnician')).get('/livestock/sale-readiness');
    expect(rowOf(res, animal.id)).toMatchObject({ targetKg: null, status: 'unknown', targetDate: null, daysToTarget: null, dailyGainKg: 0.2 });
  });

  it('ready, not gaining, never weighed, and a weight with no weighing behind it', async () => {
    const heavy = await addAnimal(f, w, [[-5, 51.5]]);
    const losing = await addAnimal(f, w, [
      [-40, 40],
      [-10, 38.5],
    ]);
    const unweighed = await addAnimal(f, w);
    // An import puts the weight on the animal and leaves no weighing: still one measured point.
    const imported = await addAnimal(f, w, [], { currentWeightKg: 47, lastWeighedOn: day(-3) });

    const res = await shepherd.get('/livestock/sale-readiness', { pageSize: 200 });
    expect(rowOf(res, heavy.id)).toMatchObject({ status: 'ready', currentWeightKg: 51.5, dailyGainKg: null, targetDate: day(-5) });
    // 40 to 38.5 kg over 30 days: -0.05 kg a day, so it never arrives.
    expect(rowOf(res, losing.id)).toMatchObject({ status: 'later', dailyGainKg: -0.05, notGaining: true, targetDate: null });
    expect(rowOf(res, unweighed.id)).toMatchObject({ status: 'unknown', currentWeightKg: null, dailyGainKg: null, projectedWeightKg: null });
    expect(rowOf(res, imported.id)).toMatchObject({ status: 'ready', currentWeightKg: 47, lastWeighedOn: day(-3) });

    // Ready first, then soon, later, unknown.
    const order = res.data.map((row: any) => row.status);
    expect(order).toEqual([...order].sort((a, b) => ['ready', 'soon', 'later', 'unknown'].indexOf(a) - ['ready', 'soon', 'later', 'unknown'].indexOf(b)));
  });

  it('filters by status, herd and sex, and pages', async () => {
    const ewe = await addAnimal(f, w, [[-5, 60]], { sex: 'female', category: 'ewe', herdId: w.otherHerdId });

    const ready = await shepherd.get('/livestock/sale-readiness', { status: 'ready', pageSize: 200 });
    expect(ready.data.length).toBeGreaterThan(0);
    expect(ready.data.every((row: any) => row.status === 'ready')).toBe(true);
    expect(ready.body.meta.total).toBe(ready.data.length);

    const herd = await shepherd.get('/livestock/sale-readiness', { herdId: w.otherHerdId });
    expect(herd.data.map((row: any) => row.id)).toEqual([ewe.id]);
    const females = await shepherd.get('/livestock/sale-readiness', { sex: 'female' });
    expect(females.data.map((row: any) => row.id)).toEqual([ewe.id]);
    const ewes = await shepherd.get('/livestock/sale-readiness', { category: 'ewe' });
    expect(ewes.data.map((row: any) => row.id)).toEqual([ewe.id]);
    expect((await shepherd.get('/livestock/sale-readiness', { category: 'goat' })).status).toBe(400);

    const all = await shepherd.get('/livestock/sale-readiness', { pageSize: 200 });
    const first = await shepherd.get('/livestock/sale-readiness', { pageSize: 2, page: 1 });
    const second = await shepherd.get('/livestock/sale-readiness', { pageSize: 2, page: 2 });
    expect(first.body.meta).toEqual({ page: 1, pageSize: 2, total: all.data.length });
    expect([...first.data, ...second.data].map((row: any) => row.id)).toEqual(all.data.slice(0, 4).map((row: any) => row.id));
  });

  it('an animal that left the farm is not on the list', async () => {
    const sold = await addAnimal(f, w, [[-5, 60]], { status: 'sold' });
    const res = await shepherd.get('/livestock/sale-readiness', { pageSize: 200 });
    expect(rowOf(res, sold.id)).toBeUndefined();
  });

  it('flags a withdrawal period and never lists the animal as free to sell', async () => {
    const treated = await addAnimal(f, w, [[-5, 52]]);
    const cleared = await addAnimal(f, w, [[-5, 52]]);
    await f.run(() =>
      tx()
        .insert(healthRecords)
        .values([
          { tenantId: f.tenantId, farmId: f.farmId, type: 'treatment', date: day(-3), animalId: treated.id, withdrawalUntil: day(6) },
          // The withdrawal date is the first day the animal may leave, as the sale itself reads it.
          { tenantId: f.tenantId, farmId: f.farmId, type: 'treatment', date: day(-20), animalId: cleared.id, withdrawalUntil: TODAY },
        ]),
    );
    const res = await shepherd.get('/livestock/sale-readiness', { pageSize: 200 });
    expect(rowOf(res, treated.id)).toMatchObject({ status: 'ready', withdrawalUntil: day(6), freeToSell: false });
    expect(rowOf(res, cleared.id)).toMatchObject({ status: 'ready', withdrawalUntil: null, freeToSell: true });
  });

  it('shows an open cull mark as a reason to sell, and it does not block the sale', async () => {
    const marked = await addAnimal(f, w, [[-5, 40]]);
    await f.run(() => tx().insert(cullMarks).values({ tenantId: f.tenantId, farmId: f.farmId, animalId: marked.id, reason: 'age', markedOn: day(-2) }));
    const res = await shepherd.get('/livestock/sale-readiness', { pageSize: 200 });
    expect(rowOf(res, marked.id)).toMatchObject({ cullMark: { reason: 'age', markedOn: day(-2) }, freeToSell: true });
  });

  it('a reserved animal is flagged; who it is for and the price are for those with the right', async () => {
    const held = await addAnimal(f, w, [[-5, 55]]);
    const made = await accountant.post('/sales/reservations', { animalId: held.id, counterpartyId: w.buyerId, agreedPrice: 3_000_000, reservedUntil: day(7) });
    expect(made.status).toBe(201);

    const forShepherd = rowOf(await shepherd.get('/livestock/sale-readiness', { pageSize: 200 }), held.id);
    expect(forShepherd.freeToSell).toBe(false);
    expect(forShepherd.reservation).toEqual({ id: made.data.id, reservedUntil: day(7), counterpartyId: null, customer: null, agreedPrice: null });

    const forAccountant = rowOf(await accountant.get('/livestock/sale-readiness', { pageSize: 200 }), held.id);
    expect(forAccountant.reservation).toEqual({
      id: made.data.id,
      reservedUntil: day(7),
      counterpartyId: w.buyerId,
      customer: 'Xaridor MChJ',
      agreedPrice: 3_000_000,
    });
  });

  it('the value estimate comes from the farm\'s own sales and only reaches finance.view', async () => {
    // Two live-weight sales: 40 kg for 2 000 000 and 60 kg for 3 300 000. 5 300 000 / 100 kg = 53 000 a kg.
    // The control animal last weighed 42.2 kg: 42.2 x 53 000 = 2 236 600.
    const gone = [await addAnimal(f, w, [], { status: 'sold' }), await addAnimal(f, w, [], { status: 'sold' })];
    await f.run(() =>
      tx()
        .insert(animalExits)
        .values([
          { tenantId: f.tenantId, farmId: f.farmId, animalId: gone[0].id, type: 'sale', date: day(-20), liveWeightKg: 40, amount: 2_000_000 },
          { tenantId: f.tenantId, farmId: f.farmId, animalId: gone[1].id, type: 'sale', date: day(-10), liveWeightKg: 60, amount: 3_300_000 },
        ]),
    );
    const withMoney = rowOf(await accountant.get('/livestock/sale-readiness', { pageSize: 200 }), control.id);
    expect(withMoney).toMatchObject({ pricePerKg: 53_000, estimatedValue: 2_236_600 });
    const without = rowOf(await shepherd.get('/livestock/sale-readiness', { pageSize: 200 }), control.id);
    expect(without).toMatchObject({ pricePerKg: null, estimatedValue: null });
  });

  it('needs livestock.view, and never shows another tenant\'s animals', async () => {
    expect((await (await f.as('mechanic')).get('/livestock/sale-readiness')).status).toBe(403);
    const g = await createFixture({ settings: { livestock: { saleTargetWeightKg: 45 } } });
    const res = await (await g.as('owner')).get('/livestock/sale-readiness', { pageSize: 200 });
    expect(res.data).toEqual([]);
  });
});

describe('reservations', () => {
  let f: Fixture;
  let w: World;
  let accountant: Client;
  let director: Client;

  beforeAll(async () => {
    f = await createFixture();
    w = await arrange(f);
    accountant = await f.as('accountant');
    director = await f.as('director');
  });

  const eventsOf = (id: string) =>
    f.run(async () => (await tx().select().from(events).where(eq(events.entityId, id))).map((e) => e.type).sort());

  it('holds an animal for a buyer and writes it in the journal', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const res = await accountant.post('/sales/reservations', {
      animalId: animal.id,
      counterpartyId: w.buyerId,
      agreedPrice: 2_800_000,
      reservedUntil: day(10),
      note: 'Hayitga',
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      animalId: animal.id,
      animalTag: animal.tag,
      counterpartyName: 'Xaridor MChJ',
      agreedPrice: 2_800_000,
      reservedUntil: day(10),
      status: 'open',
      saleId: null,
      withdrawalUntil: null,
    });
    expect(await eventsOf(res.data.id)).toEqual(['reservation.created']);
  });

  it('a second reservation of the same animal is refused with ANIMAL_RESERVED', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const first = await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, reservedUntil: day(3) });
    const second = await director.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.otherBuyerId, reservedUntil: day(5) });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ANIMAL_RESERVED');
    expect(second.body.error.details).toMatchObject({ animalId: animal.id, reservationId: first.data.id, reservedUntil: day(3) });
    // The refusal names the animal and the date, not who holds it.
    expect(JSON.stringify(second.body)).not.toContain('Xaridor');
  });

  it('two requests racing for one animal: exactly one wins, the other gets ANIMAL_RESERVED', async () => {
    for (let round = 0; round < 3; round++) {
      const animal = await addAnimal(f, w, [[-5, 50]]);
      const results = await Promise.all([
        accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, reservedUntil: day(3) }),
        director.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.otherBuyerId, reservedUntil: day(3) }),
        director.post('/sales/reservations', { animalId: animal.id, customerName: 'Sardor aka', customerPhone: '+998901112233', reservedUntil: day(3) }),
      ]);
      expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409]);
      expect(results.filter((res) => res.status === 409).every((res) => res.body.error.code === 'ANIMAL_RESERVED')).toBe(true);
      const open = await f.run(() =>
        tx()
          .select()
          .from(animalReservations)
          .where(and(eq(animalReservations.animalId, animal.id), eq(animalReservations.status, 'open'))),
      );
      expect(open).toHaveLength(1);
    }
  });

  it('the database itself keeps one open reservation per animal', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const row = { tenantId: f.tenantId, farmId: f.farmId, animalId: animal.id, counterpartyId: w.buyerId, reservedUntil: day(3) };
    await f.run(() => tx().insert(animalReservations).values(row));
    await expect(f.run(() => tx().insert(animalReservations).values(row))).rejects.toThrow();
    // A closed one does not stand in the way of a new one.
    await f.run(() => tx().update(animalReservations).set({ status: 'cancelled' }).where(eq(animalReservations.animalId, animal.id)));
    await f.run(() => tx().insert(animalReservations).values(row));
  });

  it('needs a customer, a sane date and a real phone', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const none = await accountant.post('/sales/reservations', { animalId: animal.id, reservedUntil: day(3) });
    expect([none.status, none.body.error.code]).toEqual([400, 'RESERVATION_CUSTOMER_REQUIRED']);
    const past = await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, reservedUntil: day(-1) });
    expect([past.status, past.body.error.code]).toEqual([400, 'RESERVATION_DATE_INVALID']);
    const far = await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, reservedUntil: day(400) });
    expect([far.status, far.body.error.code]).toEqual([400, 'RESERVATION_DATE_INVALID']);
    const phone = await accountant.post('/sales/reservations', { animalId: animal.id, customerName: 'Sardor aka', customerPhone: 'abc-def-ghi', reservedUntil: day(3) });
    expect([phone.status, phone.body.error.code]).toEqual([400, 'INVALID_PHONE']);
    const sold = await addAnimal(f, w, [], { status: 'sold' });
    const gone = await accountant.post('/sales/reservations', { animalId: sold.id, counterpartyId: w.buyerId, reservedUntil: day(3) });
    expect(gone.status).toBe(409);
  });

  it('an animal under withdrawal can be held, and the answer carries the date it may leave', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    await f.run(() =>
      tx().insert(healthRecords).values({ tenantId: f.tenantId, farmId: f.farmId, type: 'treatment', date: day(-2), animalId: animal.id, withdrawalUntil: day(9) }),
    );
    const res = await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, reservedUntil: day(14) });
    expect(res.status).toBe(201);
    expect(res.data.withdrawalUntil).toBe(day(9));
  });

  it('shepherd and zootechnician cannot reserve or read reservations', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const shepherd = await f.as('shepherd');
    expect((await shepherd.get('/sales/reservations')).status).toBe(403);
    expect((await shepherd.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, reservedUntil: day(3) })).status).toBe(403);
    expect((await (await f.as('zootechnician')).get('/sales/reservations')).status).toBe(403);
    // The auditor reads, and may not write.
    const auditor = await f.as('auditor');
    expect((await auditor.get('/sales/reservations')).status).toBe(200);
    expect((await auditor.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, reservedUntil: day(3) })).status).toBe(403);
  });

  it('strips the agreed price without finance.view and the typed-in person without pii.view', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const made = await director.post('/sales/reservations', {
      animalId: animal.id,
      customerName: 'Sardor Qodirov',
      customerPhone: '90 111 22 33',
      agreedPrice: 2_500_000,
      reservedUntil: day(3),
    });
    expect(made.status).toBe(201);
    expect(made.data).toMatchObject({ customerName: 'Sardor Qodirov', customerPhone: '+998901112233', agreedPrice: 2_500_000 });

    const seen = (permissions: string[], search?: string) =>
      f.run(async () => (await reservations.list({ page: 1, pageSize: 200, animalId: animal.id, search })).data, { permissions });

    const [full] = await seen(['sales.view', 'finance.view', 'pii.view']);
    expect(full).toMatchObject({ customerName: 'Sardor Qodirov', customerPhone: '+998901112233', agreedPrice: 2_500_000 });

    const [noMoney] = await seen(['sales.view', 'pii.view']);
    expect(noMoney).toMatchObject({ customerName: 'Sardor Qodirov', agreedPrice: null });

    const [noPerson] = await seen(['sales.view', 'finance.view']);
    expect(noPerson).toMatchObject({ customerName: null, customerPhone: null, agreedPrice: 2_500_000 });
    // A search by the hidden name finds nothing: it would otherwise confirm the name is there.
    expect(await seen(['sales.view', 'finance.view'], 'Sardor')).toEqual([]);
    expect(await seen(['sales.view', 'finance.view', 'pii.view'], 'Sardor')).toHaveLength(1);
  });

  it('cancel frees the animal, and a closed reservation cannot be cancelled again', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const made = await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, reservedUntil: day(3) });
    const cancelled = await accountant.post(`/sales/reservations/${made.data.id}/cancel`, { reason: 'Xaridor voz kechdi' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.data).toMatchObject({ status: 'cancelled', closeReason: 'Xaridor voz kechdi' });
    expect(await eventsOf(made.data.id)).toEqual(['reservation.cancelled', 'reservation.created']);

    const again = await accountant.post(`/sales/reservations/${made.data.id}/cancel`, {});
    expect([again.status, again.body.error.code]).toEqual([409, 'RESERVATION_NOT_OPEN']);
    const next = await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.otherBuyerId, reservedUntil: day(3) });
    expect(next.status).toBe(201);
  });

  it('convert creates exactly one draft sale through the sales order, and no money', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const made = await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, agreedPrice: 2_800_000, reservedUntil: day(3) });
    const before = await f.run(() => tx().select().from(sales));
    const moneyBefore = await f.run(() => tx().select().from(schema.transactions));

    const converted = await accountant.post(`/sales/reservations/${made.data.id}/convert`, {});
    expect(converted.status).toBe(200);
    // Still open: the draft has to be confirmed, and until then the animal stays held.
    expect(converted.data).toMatchObject({ status: 'open' });
    expect(converted.data.saleId).toBeTruthy();
    expect(converted.data.saleNumber).toMatch(/^S-\d{4}-\d{4}$/);

    const after = await f.run(() => tx().select().from(sales));
    expect(after).toHaveLength(before.length + 1);
    const sale = await accountant.get(`/sales/orders/${converted.data.saleId}`);
    expect(sale.data).toMatchObject({ status: 'draft', counterpartyId: w.buyerId, totalAmount: 2_800_000 });
    expect(sale.data.lines).toHaveLength(1);
    expect(sale.data.lines[0]).toMatchObject({ animalId: animal.id, qty: 1, price: 2_800_000 });
    // A draft moves no money and the animal has not left.
    expect(await f.run(() => tx().select().from(schema.transactions))).toHaveLength(moneyBefore.length);
    const [still] = await f.run(() => tx().select().from(animals).where(eq(animals.id, animal.id)));
    expect(still.status).toBe('active');
    expect(await eventsOf(made.data.id)).toEqual(['reservation.created', 'reservation.sale_drafted']);

    // Converting twice makes no second sale.
    const twice = await accountant.post(`/sales/reservations/${made.data.id}/convert`, {});
    expect([twice.status, twice.body.error.code]).toEqual([409, 'RESERVATION_SALE_EXISTS']);
    expect(twice.body.error.details).toEqual({ saleId: converted.data.saleId, number: converted.data.saleNumber });
    expect(await f.run(() => tx().select().from(sales))).toHaveLength(before.length + 1);
  });

  it('the animal stays held while its draft sale waits, and the reservation closes when the sale is confirmed', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const made = await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, agreedPrice: 2_800_000, reservedUntil: day(3) });
    const converted = await accountant.post(`/sales/reservations/${made.data.id}/convert`, {});
    expect(converted.status).toBe(200);

    // Another buyer cannot take the animal while the draft waits to be confirmed.
    const line = { animalId: animal.id, qty: 1, unit: 'head', price: 3_000_000 };
    const other = await accountant.post('/sales/orders', { date: TODAY, counterpartyId: w.otherBuyerId, paymentMethod: 'debt', lines: [line] });
    expect([other.status, other.body.error.code]).toEqual([409, 'ANIMAL_RESERVED_FOR_OTHER']);
    const second = await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.otherBuyerId, reservedUntil: day(3) });
    expect([second.status, second.body.error.code]).toEqual([409, 'ANIMAL_RESERVED']);

    const confirm = await director.post(`/sales/orders/${converted.data.saleId}/confirm`, {});
    expect(confirm.status).toBe(200);
    const [row] = await f.run(() => tx().select().from(animalReservations).where(eq(animalReservations.id, made.data.id)));
    expect(row).toMatchObject({ status: 'converted', saleId: converted.data.saleId });
    expect(row.closedAt).not.toBeNull();
    expect(await eventsOf(made.data.id)).toEqual(['reservation.converted', 'reservation.created', 'reservation.sale_drafted']);
  });

  it('deleting the draft sale leaves the reservation holding the animal, and a new sale can be made', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const made = await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, agreedPrice: 2_800_000, reservedUntil: day(3) });
    const first = await accountant.post(`/sales/reservations/${made.data.id}/convert`, {});
    const removed = await accountant.delete(`/sales/orders/${first.data.saleId}`);
    expect(removed.status).toBe(200);

    const after = await accountant.get(`/sales/reservations?animalId=${animal.id}`);
    expect(after.data).toHaveLength(1);
    expect(after.data[0]).toMatchObject({ id: made.data.id, status: 'open', saleId: null, saleNumber: null });
    const line = { animalId: animal.id, qty: 1, unit: 'head', price: 3_000_000 };
    const other = await accountant.post('/sales/orders', { date: TODAY, counterpartyId: w.otherBuyerId, paymentMethod: 'debt', lines: [line] });
    expect([other.status, other.body.error.code]).toEqual([409, 'ANIMAL_RESERVED_FOR_OTHER']);

    const again = await accountant.post(`/sales/reservations/${made.data.id}/convert`, {});
    expect(again.status).toBe(200);
    expect(again.data.saleId).toBeTruthy();
    expect(again.data.saleId).not.toBe(first.data.saleId);
  });

  it('convert asks for what the sale needs: a buyer in the books and a price', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const made = await director.post('/sales/reservations', { animalId: animal.id, customerName: 'Sardor aka', customerPhone: '+998901112233', reservedUntil: day(3) });
    const noBuyer = await director.post(`/sales/reservations/${made.data.id}/convert`, { price: 2_000_000 });
    expect([noBuyer.status, noBuyer.body.error.code]).toEqual([400, 'RESERVATION_NEEDS_COUNTERPARTY']);
    const noPrice = await director.post(`/sales/reservations/${made.data.id}/convert`, { counterpartyId: w.buyerId });
    expect([noPrice.status, noPrice.body.error.code]).toEqual([400, 'RESERVATION_PRICE_REQUIRED']);
    // Neither refusal closed it.
    const [row] = await f.run(() => tx().select().from(animalReservations).where(eq(animalReservations.id, made.data.id)));
    expect(row.status).toBe('open');
    const ok = await director.post(`/sales/reservations/${made.data.id}/convert`, { counterpartyId: w.buyerId, price: 2_000_000 });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ status: 'open', counterpartyId: w.buyerId });
    expect(ok.data.saleId).toBeTruthy();
  });

  it('the sale flow refuses an animal held for a different buyer, in the order and at the exit', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const made = await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, reservedUntil: day(3) });
    const line = { animalId: animal.id, qty: 1, unit: 'head', price: 2_000_000 };

    const order = await accountant.post('/sales/orders', { date: TODAY, counterpartyId: w.otherBuyerId, paymentMethod: 'debt', lines: [line] });
    expect([order.status, order.body.error.code]).toEqual([409, 'ANIMAL_RESERVED_FOR_OTHER']);
    expect(order.body.error.details.animals).toEqual([{ animalId: animal.id, tag: animal.tag, reservationId: made.data.id, reservedUntil: day(3) }]);
    expect(JSON.stringify(order.body)).not.toContain('Xaridor');

    const exit = await director.post('/livestock/exits', {
      animalId: animal.id,
      type: 'sale',
      date: TODAY,
      counterpartyId: w.otherBuyerId,
      amount: 2_000_000,
      paymentMethod: 'debt',
    });
    expect([exit.status, exit.body.error.code]).toEqual([409, 'ANIMAL_RESERVED_FOR_OTHER']);
    const [still] = await f.run(() => tx().select().from(animals).where(eq(animals.id, animal.id)));
    expect(still.status).toBe('active');
  });

  it('a draft made before the reservation is refused at confirm', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const draft = await accountant.post('/sales/orders', {
      date: TODAY,
      counterpartyId: w.otherBuyerId,
      paymentMethod: 'debt',
      lines: [{ animalId: animal.id, qty: 1, unit: 'head', price: 2_000_000 }],
    });
    expect(draft.status).toBe(201);
    await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, reservedUntil: day(3) });
    const confirm = await director.post(`/sales/orders/${draft.data.id}/confirm`, {});
    expect([confirm.status, confirm.body.error.code]).toEqual([409, 'ANIMAL_RESERVED_FOR_OTHER']);
  });

  it('a sale to the buyer the animal is held for goes through and closes the reservation', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const made = await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, reservedUntil: day(3) });
    const order = await accountant.post('/sales/orders', {
      date: TODAY,
      counterpartyId: w.buyerId,
      paymentMethod: 'debt',
      lines: [{ animalId: animal.id, qty: 1, unit: 'head', price: 2_000_000 }],
    });
    expect(order.status).toBe(201);
    const confirm = await director.post(`/sales/orders/${order.data.id}/confirm`, {});
    expect(confirm.status).toBe(200);
    const [row] = await f.run(() => tx().select().from(animalReservations).where(eq(animalReservations.id, made.data.id)));
    expect(row).toMatchObject({ status: 'converted', saleId: order.data.id });
    expect(await eventsOf(made.data.id)).toEqual(['reservation.converted', 'reservation.created']);
  });

  it('the daily job expires reservations past their date and frees the animal', async () => {
    const [late, due, gone] = [await addAnimal(f, w, [[-5, 50]]), await addAnimal(f, w, [[-5, 50]]), await addAnimal(f, w, [[-5, 50]])];
    const base = { tenantId: f.tenantId, farmId: f.farmId, counterpartyId: w.buyerId };
    const rows = await f.run(() =>
      tx()
        .insert(animalReservations)
        .values([
          { ...base, animalId: late.id, reservedUntil: day(-1) },
          // The last day of a reservation still holds the animal.
          { ...base, animalId: due.id, reservedUntil: TODAY },
          { ...base, animalId: gone.id, reservedUntil: day(5) },
        ])
        .returning(),
    );
    await f.run(() => tx().update(animals).set({ status: 'dead' }).where(eq(animals.id, gone.id)));

    const job = salesJobs.find((candidate) => candidate.name === 'sales.expire-reservations')!;
    await f.run(() => job.run());

    const after = await f.run(() =>
      tx()
        .select()
        .from(animalReservations)
        .where(inArray(animalReservations.id, rows.map((row) => row.id))),
    );
    const statusOf = (animalId: string) => after.find((row) => row.animalId === animalId)!;
    expect(statusOf(late.id).status).toBe('expired');
    expect(statusOf(due.id).status).toBe('open');
    expect(statusOf(gone.id)).toMatchObject({ status: 'cancelled', closeReason: 'animal_left' });
    expect(await eventsOf(statusOf(late.id).id)).toEqual(['reservation.expired']);
    expect(await eventsOf(statusOf(gone.id).id)).toEqual(['reservation.cancelled']);

    // Running it again changes nothing, and the freed animal can be held again.
    await f.run(() => job.run());
    expect(await eventsOf(statusOf(late.id).id)).toEqual(['reservation.expired']);
    const next = await accountant.post('/sales/reservations', { animalId: late.id, counterpartyId: w.otherBuyerId, reservedUntil: day(3) });
    expect(next.status).toBe(201);
  });

  it('another tenant sees none of it and cannot touch it', async () => {
    const animal = await addAnimal(f, w, [[-5, 50]]);
    const made = await accountant.post('/sales/reservations', { animalId: animal.id, counterpartyId: w.buyerId, reservedUntil: day(3) });
    const g = await createFixture();
    const stranger = await g.as('owner');
    expect((await stranger.get('/sales/reservations')).data).toEqual([]);
    expect((await stranger.post(`/sales/reservations/${made.data.id}/cancel`, {})).status).toBe(404);
    expect((await stranger.post('/sales/reservations', { animalId: animal.id, customerName: 'Begona', reservedUntil: day(3) })).status).toBe(404);
  });
});
