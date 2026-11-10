import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayIso } from '@yap/shared';
import { db, schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { issueFormToken } from '../src/modules/leads/leads.service';
import * as catalogue from '../src/modules/sales/catalogue.service';
import { createFixture, getApp, type Client, type Fixture } from './helpers';

const { animalReservations, animals, catalogueListings, catalogueRequests, counterparties, events, files, healthRecords, notifications, species } = schema;

const TODAY = todayIso();
const uniquePhone = () => `+99890${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const uniqueSlug = () => `ferma-${randomBytes(4).toString('hex')}`;

async function send(method: 'GET' | 'POST', url: string, body?: unknown) {
  const app = await getApp();
  const response = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = response.body ? response.json() : null;
  return { status: response.statusCode, body: json, data: json?.data };
}

const form = (overrides: Record<string, unknown> = {}) => ({
  name: 'Sardor Qodirov',
  phone: uniquePhone(),
  animals: [],
  wanted: 'Ikkita qo\'chqor kerak',
  note: 'Hayitdan oldin',
  language: 'uz',
  consent: true,
  formToken: issueFormToken(Date.now() - 12_000),
  ...overrides,
});

let tagCounter = 0;
async function addAnimal(f: Fixture, over: Partial<typeof animals.$inferInsert> = {}) {
  return f.run(async () => {
    const [sheep] = await tx().select().from(species).where(eq(species.tenantId, f.tenantId)).limit(1);
    const [row] = await tx()
      .insert(animals)
      .values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        tag: `SECRET-TAG-${++tagCounter}`,
        speciesId: sheep.id,
        sex: 'male',
        category: 'ram',
        origin: 'purchased',
        purchasePrice: 1_234_567,
        birthDate: addDays(TODAY, -400),
        status: 'active',
        currentWeightKg: 62.5,
        notes: 'ichki eslatma',
        ...over,
      })
      .returning();
    return row;
  });
}

const open = (f: Fixture, slug: string) => f.run(async () => void (await tx().execute(sql`select 1`))).then(() => send('GET', `/sales/catalogue/pages/${slug}`));

const requestsOf = (f: Fixture, phone: string) =>
  f.run(() =>
    tx()
      .select()
      .from(catalogueRequests)
      .where(and(eq(catalogueRequests.tenantId, f.tenantId), eq(catalogueRequests.phone, phone))),
  );

describe('public catalogue', () => {
  let f: Fixture;
  let slug: string;
  let owner: Client;
  let accountant: Client;

  beforeAll(async () => {
    slug = uniqueSlug();
    f = await createFixture();
    owner = await f.as('owner');
    accountant = await f.as('accountant');
  });

  beforeEach(() => catalogue.resetNotificationBudget());

  it('is off by default: the page and the form answer 404', async () => {
    const animal = await addAnimal(f);
    expect((await accountant.put(`/sales/catalogue/listings/${animal.id}`, {})).status).toBe(200);
    expect((await send('GET', `/sales/catalogue/pages/${slug}`)).status).toBe(404);
    expect((await send('POST', `/sales/catalogue/pages/${slug}/requests`, form())).status).toBe(404);
    expect((await send('GET', '/sales/catalogue/pages/null')).status).toBe(404);
  });

  it('needs an address to be switched on, and a well-formed one', async () => {
    const noSlug = await owner.patch('/settings/policy', { catalogue: { enabled: true } });
    expect([noSlug.status, noSlug.body.error.code]).toEqual([400, 'CATALOGUE_SLUG_REQUIRED']);
    expect((await owner.patch('/settings/policy', { catalogue: { slug: 'A b/c' } })).status).toBe(400);
    expect((await owner.patch('/settings/policy', { catalogue: { slug: '../admin' } })).status).toBe(400);

    // An address alone does not open the page.
    expect((await owner.patch('/settings/policy', { catalogue: { slug, contact: 'Tel: 90 123 45 67' } })).status).toBe(200);
    expect((await send('GET', `/sales/catalogue/pages/${slug}`)).status).toBe(404);

    const on = await owner.patch('/settings/policy', { catalogue: { enabled: true } });
    expect(on.status).toBe(200);
    expect(on.data.catalogue).toEqual({ enabled: true, slug, contact: 'Tel: 90 123 45 67' });
    expect((await send('GET', `/sales/catalogue/pages/${slug}`)).status).toBe(200);
    // Only someone who may change settings.
    expect((await accountant.patch('/settings/policy', { catalogue: { enabled: false } })).status).toBe(403);
  });

  it('one address belongs to one workspace', async () => {
    const g = await createFixture();
    const other = await g.as('owner');
    const taken = await other.patch('/settings/policy', { catalogue: { enabled: true, slug } });
    expect([taken.status, taken.body.error.code]).toEqual([409, 'CATALOGUE_SLUG_TAKEN']);
    // The refusal left the other workspace's settings as they were.
    expect((await other.get('/settings/policy')).data.catalogue).toEqual({ enabled: false, slug: null, contact: null });
    expect((await other.patch('/settings/policy', { catalogue: { enabled: true, slug: uniqueSlug() } })).status).toBe(200);
  });

  it('shows only animals marked for it, and only what a visitor may know', async () => {
    const [photo] = await f.run(() =>
      tx().insert(files).values({ tenantId: f.tenantId, farmId: f.farmId, storageKey: 'k/ram.jpg', name: 'ram.jpg', mimeType: 'image/jpeg', sizeBytes: 10 }).returning(),
    );
    const priced = await addAnimal(f, { photoFileId: photo.id });
    const unpriced = await addAnimal(f, { sex: 'female', category: 'ewe', birthDate: null, currentWeightKg: null });
    const unlisted = await addAnimal(f);
    expect((await accountant.put(`/sales/catalogue/listings/${priced.id}`, { price: 3_500_000 })).status).toBe(200);
    expect((await accountant.put(`/sales/catalogue/listings/${unpriced.id}`, {})).status).toBe(200);

    const page = await send('GET', `/sales/catalogue/pages/${slug}`);
    expect(page.status).toBe(200);
    expect(Object.keys(page.data).sort()).toEqual(['animals', 'contact', 'currency', 'name']);
    expect(page.data.contact).toBe('Tel: 90 123 45 67');

    const listings = await f.run(() => tx().select().from(catalogueListings));
    const idOf = (animalId: string) => listings.find((row) => row.animalId === animalId)!.id;
    const shownPriced = page.data.animals.find((a: any) => a.id === idOf(priced.id));
    const shownUnpriced = page.data.animals.find((a: any) => a.id === idOf(unpriced.id));

    expect(Object.keys(shownPriced).sort()).toEqual(['ageMonths', 'breed', 'id', 'photoUrl', 'price', 'reserved', 'sex', 'species', 'weightKg']);
    // Born 400 days ago: 13 whole months.
    expect(shownPriced).toMatchObject({ sex: 'male', ageMonths: 13, weightKg: 62.5, price: 3_500_000, reserved: false });
    expect(shownPriced.species).toMatchObject({ uz: expect.any(String), ru: expect.any(String), en: expect.any(String) });
    expect(shownPriced.photoUrl).toMatch(new RegExp(`^/api/v1/files/${photo.id}/content\\?token=`));
    // No price was published for this one, and what is not known is null, not zero.
    expect(shownUnpriced).toMatchObject({ sex: 'female', ageMonths: null, weightKg: null, price: null, photoUrl: null });

    // Nothing internal anywhere in the answer: no tag, no animal id, no cost, no note.
    const text = JSON.stringify(page.body);
    for (const secret of ['SECRET-TAG', priced.id, unpriced.id, unlisted.id, '1234567', 'ichki eslatma', f.tenantId, f.farmId]) {
      expect(text).not.toContain(secret);
    }
    expect(page.data.animals.map((a: any) => a.id)).not.toContain(unlisted.id);
  });

  it('hides an animal under withdrawal, sick, or gone, and shows a reserved one as reserved', async () => {
    const [treated, sick, sold, held, fine] = [await addAnimal(f), await addAnimal(f), await addAnimal(f), await addAnimal(f), await addAnimal(f)];
    for (const a of [treated, sick, sold, held, fine]) expect((await accountant.put(`/sales/catalogue/listings/${a.id}`, {})).status).toBe(200);
    await f.run(async () => {
      await tx().insert(healthRecords).values({ tenantId: f.tenantId, farmId: f.farmId, type: 'treatment', date: TODAY, animalId: treated.id, withdrawalUntil: addDays(TODAY, 9) });
      await tx().update(animals).set({ status: 'sick' }).where(eq(animals.id, sick.id));
      await tx().update(animals).set({ status: 'sold' }).where(eq(animals.id, sold.id));
      const [buyer] = await tx().insert(counterparties).values({ tenantId: f.tenantId, farmId: f.farmId, name: 'Maxfiy Xaridor', type: 'buyer' }).returning();
      await tx().insert(animalReservations).values({ tenantId: f.tenantId, farmId: f.farmId, animalId: held.id, counterpartyId: buyer.id, agreedPrice: 9_999_999, reservedUntil: addDays(TODAY, 5) });
    });
    const listings = await f.run(() => tx().select().from(catalogueListings));
    const idOf = (animalId: string) => listings.find((row) => row.animalId === animalId)!.id;

    const page = await send('GET', `/sales/catalogue/pages/${slug}`);
    const shown = new Map<string, any>(page.data.animals.map((a: any) => [a.id, a]));
    expect(shown.has(idOf(treated.id))).toBe(false);
    expect(shown.has(idOf(sick.id))).toBe(false);
    expect(shown.has(idOf(sold.id))).toBe(false);
    expect(shown.get(idOf(held.id))).toMatchObject({ reserved: true });
    expect(shown.get(idOf(fine.id))).toMatchObject({ reserved: false });
    // Who it is held for, until when and for how much stay inside.
    const text = JSON.stringify(page.body);
    expect(text).not.toContain('Maxfiy');
    expect(text).not.toContain('9999999');

    // A reserved or hidden animal cannot be asked for.
    for (const animal of [held, treated, sick]) {
      const refused = await send('POST', `/sales/catalogue/pages/${slug}/requests`, form({ animals: [idOf(animal.id)] }));
      expect([refused.status, refused.body.error.code]).toEqual([409, 'CATALOGUE_ANIMAL_UNAVAILABLE']);
      expect(refused.body.error.details).toEqual({ animals: [idOf(animal.id)] });
    }
  });

  it('never shows another workspace\'s animals, and never takes a request for one', async () => {
    const g = await createFixture({ settings: { catalogue: { enabled: true, slug: uniqueSlug() } } });
    const theirSlug = (await (await g.as('owner')).get('/settings/policy')).data.catalogue.slug;
    const theirs = await addAnimal(g);
    expect((await (await g.as('accountant')).put(`/sales/catalogue/listings/${theirs.id}`, { price: 7_000_000 })).status).toBe(200);
    const [theirListing] = await g.run(() => tx().select().from(catalogueListings));

    const mine = await send('GET', `/sales/catalogue/pages/${slug}`);
    const their = await send('GET', `/sales/catalogue/pages/${theirSlug}`);
    expect(their.data.animals.map((a: any) => a.id)).toEqual([theirListing.id]);
    expect(mine.data.animals.map((a: any) => a.id)).not.toContain(theirListing.id);
    expect(mine.data.animals.length).toBeGreaterThan(0);
    expect(their.data.name).not.toBe(mine.data.name);

    // Their listing id sent to my page is an animal my page does not have.
    const crossed = await send('POST', `/sales/catalogue/pages/${slug}/requests`, form({ animals: [theirListing.id] }));
    expect([crossed.status, crossed.body.error.code]).toEqual([409, 'CATALOGUE_ANIMAL_UNAVAILABLE']);

    // A request sent to their page lands in their workspace only.
    const sent = form();
    expect((await send('POST', `/sales/catalogue/pages/${theirSlug}/requests`, sent)).status).toBe(201);
    expect(await requestsOf(g, sent.phone)).toHaveLength(1);
    expect(await requestsOf(f, sent.phone)).toHaveLength(0);
    expect((await accountant.get('/sales/catalogue/requests')).data.some((row: any) => row.phone === sent.phone)).toBe(false);
    // Staff of one workspace cannot list another's animal.
    expect((await accountant.put(`/sales/catalogue/listings/${theirs.id}`, {})).status).toBe(404);
  });

  it('a workspace with the sales module switched off has no page', async () => {
    const offSlug = uniqueSlug();
    await createFixture({ settings: { catalogue: { enabled: true, slug: offSlug } }, modules: ['livestock', 'finance'] });
    expect((await send('GET', `/sales/catalogue/pages/${offSlug}`)).status).toBe(404);
  });

  describe('pre-order', () => {
    it('stores the request for the workspace, writes the journal, and tells those who may see sales', async () => {
      const animal = await addAnimal(f);
      await accountant.put(`/sales/catalogue/listings/${animal.id}`, {});
      const [listing] = await f.run(() => tx().select().from(catalogueListings).where(eq(catalogueListings.animalId, animal.id)));
      const shepherd = await f.as('shepherd');
      const typed = '90 765 43 21';

      const sent = await send('POST', `/sales/catalogue/pages/${slug}/requests`, form({ phone: typed, animals: [listing.id] }));
      expect(sent.status).toBe(201);
      expect(sent.data).toEqual({ received: true });

      const [stored] = await requestsOf(f, '+998907654321');
      expect(stored).toMatchObject({
        farmId: f.farmId,
        name: 'Sardor Qodirov',
        animalIds: [animal.id],
        wanted: 'Ikkita qo\'chqor kerak',
        note: 'Hayitdan oldin',
        status: 'new',
        submissions: 1,
        createdBy: null,
      });

      const journal = await f.run(() => tx().select().from(events).where(eq(events.entityId, stored.id)));
      expect(journal.map((e) => e.type)).toEqual(['catalogue.request_received']);
      // The journal says a request came, not who sent it.
      expect(JSON.stringify(journal)).not.toContain('Sardor');

      const told = await f.run(() => tx().select().from(notifications).where(eq(notifications.link, '/sales/reservations?tab=requests')));
      const toldIds = told.map((n) => n.userId);
      expect(toldIds).toContain(owner.userId);
      expect(toldIds).toContain(accountant.userId);
      expect(toldIds).not.toContain(shepherd.userId);
      // The message carries nothing the visitor typed.
      expect(JSON.stringify(told)).not.toMatch(/Sardor|7654321|qo'chqor|Hayitdan/);
      expect(told.every((n) => n.permission === 'sales.view')).toBe(true);
    });

    it('answers a bot like a person but keeps nothing', async () => {
      const filledTrap = form({ website: 'https://spam.example' });
      const tooFast = form({ formToken: issueFormToken() });
      expect((await send('POST', `/sales/catalogue/pages/${slug}/requests`, filledTrap)).data).toEqual({ received: true });
      expect((await send('POST', `/sales/catalogue/pages/${slug}/requests`, tooFast)).data).toEqual({ received: true });
      expect(await requestsOf(f, filledTrap.phone)).toHaveLength(0);
      expect(await requestsOf(f, tooFast.phone)).toHaveLength(0);
    });

    it.each([
      ['no token', () => undefined],
      ['a number the client made up', () => `${Date.now() - 60_000}.not-our-signature`],
      ['a token two days old', () => issueFormToken(Date.now() - 2 * 86_400_000)],
      ['a token from the future', () => issueFormToken(Date.now() + 60_000)],
    ])('keeps nothing and asks the form to send again with %s', async (_name, token) => {
      const sent = form({ formToken: token() });
      const answer = await send('POST', `/sales/catalogue/pages/${slug}/requests`, sent);
      expect([answer.status, answer.body.error.code]).toEqual([400, 'FORM_EXPIRED']);
      expect(await requestsOf(f, sent.phone)).toHaveLength(0);
    });

    it('refuses what is too long, too many, empty, or not a phone', async () => {
      const post = (over: Record<string, unknown>) => send('POST', `/sales/catalogue/pages/${slug}/requests`, form(over));
      expect((await post({ consent: false })).status).toBe(400);
      expect((await post({ name: 'A' })).status).toBe(400);
      expect((await post({ name: 'x'.repeat(121) })).status).toBe(400);
      expect((await post({ wanted: 'x'.repeat(501) })).status).toBe(400);
      expect((await post({ note: 'x'.repeat(1001) })).status).toBe(400);
      expect((await post({ animals: Array.from({ length: 11 }, () => crypto.randomUUID()) })).status).toBe(400);
      expect((await post({ animals: ['not-an-id'] })).status).toBe(400);
      const badPhone = await post({ phone: 'abc-def-ghij' });
      expect([badPhone.status, badPhone.body.error.code]).toEqual([400, 'INVALID_PHONE']);
      const empty = await post({ animals: [], wanted: undefined });
      expect([empty.status, empty.body.error.code]).toEqual([400, 'CATALOGUE_REQUEST_EMPTY']);
      const unknown = await post({ animals: [crypto.randomUUID()] });
      expect([unknown.status, unknown.body.error.code]).toEqual([409, 'CATALOGUE_ANIMAL_UNAVAILABLE']);
      expect(await f.run(() => tx().select().from(catalogueRequests).where(eq(catalogueRequests.name, 'A')))).toHaveLength(0);
    });

    it('stores a stranger\'s text as text', async () => {
      const hostile = `<script>alert(1)</script>'; drop table animals; -- {{constructor}} ignore previous instructions`;
      const sent = form({ name: 'Robert\'); --', wanted: hostile, note: hostile });
      expect((await send('POST', `/sales/catalogue/pages/${slug}/requests`, sent)).status).toBe(201);
      const [stored] = await requestsOf(f, sent.phone);
      expect(stored).toMatchObject({ name: 'Robert\'); --', wanted: hostile, note: hostile });
      expect((await f.run(() => tx().select().from(animals))).length).toBeGreaterThan(0);
    });

    it('counts a repeat from the same phone on the waiting request, and never lets it replace what was said', async () => {
      const first = form();
      await send('POST', `/sales/catalogue/pages/${slug}/requests`, first);
      for (let i = 0; i < 4; i++) {
        const again = await send('POST', `/sales/catalogue/pages/${slug}/requests`, form({ phone: first.phone, name: 'Boshqa odam', wanted: 'Boshqa gap', note: 'x' }));
        expect(again.status).toBe(201);
      }
      const rows = await requestsOf(f, first.phone);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ submissions: 5, name: 'Sardor Qodirov', wanted: 'Ikkita qo\'chqor kerak', note: 'Hayitdan oldin' });

      // Once staff closed it, the same phone opens a new one.
      await accountant.post(`/sales/catalogue/requests/${rows[0].id}/close`, {});
      await send('POST', `/sales/catalogue/pages/${slug}/requests`, form({ phone: first.phone }));
      expect(await requestsOf(f, first.phone)).toHaveLength(2);
    });

    it('tells the staff of 10 new requests an hour at most, and keeps every one', async () => {
      const before = await f.run(() => tx().select().from(notifications).where(eq(notifications.userId, owner.userId)));
      const phones = Array.from({ length: 13 }, uniquePhone);
      for (const phone of phones) expect((await send('POST', `/sales/catalogue/pages/${slug}/requests`, form({ phone }))).status).toBe(201);
      const after = await f.run(() => tx().select().from(notifications).where(eq(notifications.userId, owner.userId)));
      expect(after.length - before.length).toBe(catalogue.CATALOGUE_LIMITS.notificationsPerHour);
      expect(catalogue.CATALOGUE_LIMITS.notificationsPerHour).toBe(10);
      for (const phone of phones) expect(await requestsOf(f, phone)).toHaveLength(1);
    });

    it('keeps requests away from the assistant at the database', async () => {
      const result = await db.execute(sql`select has_table_privilege('yap_ai', 'catalogue_requests', 'select') as allowed`);
      expect(result.rows[0].allowed).toBe(false);
    });
  });

  describe('staff', () => {
    it('reads requests with name and phone only under pii.view', async () => {
      const sent = form();
      await send('POST', `/sales/catalogue/pages/${slug}/requests`, sent);
      const seen = (permissions: string[]) =>
        f.run(async () => (await catalogue.listRequests({ page: 1, pageSize: 200 })).data.find((row) => row.wanted === sent.wanted && row.createdAt)!, { permissions });

      const full = (await accountant.get('/sales/catalogue/requests', { pageSize: 200 })).data.find((row: any) => row.phone === sent.phone);
      expect(full).toMatchObject({ name: 'Sardor Qodirov', phone: sent.phone, status: 'new', animals: [] });
      const hidden = await seen(['sales.view']);
      expect(hidden).toMatchObject({ name: null, phone: null });

      expect((await (await f.as('shepherd')).get('/sales/catalogue/requests')).status).toBe(403);
      expect((await (await f.as('zootechnician')).get('/sales/catalogue/requests')).status).toBe(403);
    });

    it('turns a request into a reservation that carries the visitor\'s name and phone', async () => {
      const animal = await addAnimal(f);
      await accountant.put(`/sales/catalogue/listings/${animal.id}`, {});
      const [listing] = await f.run(() => tx().select().from(catalogueListings).where(eq(catalogueListings.animalId, animal.id)));
      const sent = form({ animals: [listing.id] });
      await send('POST', `/sales/catalogue/pages/${slug}/requests`, sent);
      const [request] = await requestsOf(f, sent.phone);

      const listed = (await accountant.get('/sales/catalogue/requests', { pageSize: 200 })).data.find((row: any) => row.id === request.id);
      expect(listed.animals).toEqual([{ animalId: animal.id, tag: animal.tag, status: 'active', reserved: false }]);

      const done = await accountant.post(`/sales/catalogue/requests/${request.id}/reserve`, {
        animalId: animal.id,
        agreedPrice: 3_000_000,
        reservedUntil: addDays(TODAY, 7),
      });
      expect(done.status).toBe(200);
      expect(done.data.request).toMatchObject({ id: request.id, status: 'reserved' });
      expect(done.data.reservation).toMatchObject({
        animalId: animal.id,
        customerName: 'Sardor Qodirov',
        customerPhone: sent.phone,
        agreedPrice: 3_000_000,
        status: 'open',
        requestId: request.id,
      });

      // The animal is now held: the page shows it as reserved, and a second hold is refused.
      const page = await send('GET', `/sales/catalogue/pages/${slug}`);
      expect(page.data.animals.find((a: any) => a.id === listing.id)).toMatchObject({ reserved: true });
      const again = await accountant.post(`/sales/catalogue/requests/${request.id}/reserve`, { animalId: animal.id, reservedUntil: addDays(TODAY, 7) });
      expect([again.status, again.body.error.code]).toEqual([409, 'ANIMAL_RESERVED']);

      const closed = await accountant.post(`/sales/catalogue/requests/${request.id}/close`, {});
      expect(closed.data).toMatchObject({ status: 'closed' });
      const late = await accountant.post(`/sales/catalogue/requests/${request.id}/close`, {});
      expect([late.status, late.body.error.code]).toEqual([409, 'CATALOGUE_REQUEST_CLOSED']);
      const types = await f.run(async () => (await tx().select().from(events).where(eq(events.entityId, request.id))).map((e) => e.type).sort());
      expect(types).toEqual(['catalogue.request_closed', 'catalogue.request_received', 'catalogue.request_reserved']);
    });

    it('marks and unmarks an animal, and only those who see money publish or read a price', async () => {
      const animal = await addAnimal(f);
      const shepherd = await f.as('shepherd');
      expect((await shepherd.put(`/sales/catalogue/listings/${animal.id}`, {})).status).toBe(403);
      expect((await shepherd.get('/sales/catalogue/listings')).status).toBe(403);

      const listed = await accountant.put(`/sales/catalogue/listings/${animal.id}`, { price: 4_000_000 });
      expect(listed.data).toMatchObject({ animalId: animal.id, animalTag: animal.tag, price: 4_000_000 });
      // Marking again without a price keeps the price; null takes it off.
      expect((await accountant.put(`/sales/catalogue/listings/${animal.id}`, {})).data.price).toBe(4_000_000);
      expect((await accountant.put(`/sales/catalogue/listings/${animal.id}`, { price: null })).data.price).toBeNull();
      await accountant.put(`/sales/catalogue/listings/${animal.id}`, { price: 4_000_000 });
      expect(await f.run(() => tx().select().from(catalogueListings).where(eq(catalogueListings.animalId, animal.id)))).toHaveLength(1);

      const withoutMoney = { permissions: ['sales.view', 'sales.update'] };
      const [seen] = await f.run(async () => (await catalogue.listListings({ page: 1, pageSize: 25, animalId: animal.id })).data, withoutMoney);
      expect(seen).toMatchObject({ animalId: animal.id, price: null });
      await expect(f.run(() => catalogue.setListing(animal.id, { price: 1 }), withoutMoney)).rejects.toMatchObject({ status: 403 });
      // Without a price they may still mark it.
      await f.run(() => catalogue.setListing(animal.id, {}), withoutMoney);

      const sold = await addAnimal(f, { status: 'sold' });
      const refused = await accountant.put(`/sales/catalogue/listings/${sold.id}`, {});
      expect([refused.status, refused.body.error.code]).toEqual([409, 'CATALOGUE_ANIMAL_NOT_OFFERABLE']);

      expect((await accountant.delete(`/sales/catalogue/listings/${animal.id}`)).status).toBe(200);
      expect((await accountant.delete(`/sales/catalogue/listings/${animal.id}`)).status).toBe(404);
      const types = await f.run(async () => (await tx().select().from(events).where(eq(events.entityId, animal.id))).map((e) => e.type));
      expect(types.filter((t) => t === 'catalogue.listed').length).toBeGreaterThan(0);
      expect(types).toContain('catalogue.unlisted');
    });
  });

  it('switched off again, the page is gone and requests are refused', async () => {
    expect((await owner.patch('/settings/policy', { catalogue: { enabled: false } })).status).toBe(200);
    expect((await open(f, slug)).status).toBe(404);
    const sent = form();
    expect((await send('POST', `/sales/catalogue/pages/${slug}/requests`, sent)).status).toBe(404);
    expect(await requestsOf(f, sent.phone)).toHaveLength(0);
  });
});
