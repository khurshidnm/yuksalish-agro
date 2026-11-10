/**
 * Public catalogue: a page anyone can open, showing the animals a farm chose to offer, and a
 * pre-order form. Off unless the workspace turns it on (settings.catalogue).
 *
 * What a visitor can learn is decided here and nowhere else: species, breed, sex, age in months,
 * weight, a photo, and a price only when the farm published one. Never the tag, a cost, a health
 * record or a person. The id a visitor sees is the listing's, not the animal's.
 *
 * A visitor has no tenant. The page address is looked up among workspaces (the one thing the
 * platform context can read), and every read and write after that runs inside that workspace under
 * row-level security, exactly as a signed-in request does. What a visitor types is a stranger's
 * text: it is stored and shown to staff, never interpreted.
 */
import type { FastifyBaseLogger } from 'fastify';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CATALOGUE_REQUEST_STATUSES } from '@yap/shared';
import { ageInMonths } from '@yap/shared/formulas/livestock';
import { schema } from '../../db/client';
import { canSeeMoney, ctx, today, tx, withPlatform, withTenant } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { hideMoney, hidePii } from '../../core/privacy';
import { isoDate, listQuery, paged, searchAny } from '../../core/query';
import { mergeSettings, type TenantSettings } from '../../core/settings';
import { normalizePhone } from '../auth/auth.service';
import { signedFileUrl } from '../files';
import { formTokenVerdict } from '../leads/leads.service';
import { animalsUnderWithdrawal } from '../livestock/health.service';
import { tr } from '../notifications/i18n';
import { notifyRole } from '../notifications/notify.service';
import { MAX_MONEY } from './constants';
import * as reservations from './reservations.service';
import { openReservations } from './reserved.service';

const { tenants, farms, catalogueListings: l, catalogueRequests: q, animals, species, breeds, herds } = schema;

/** Starting values chosen for this product. */
export const CATALOGUE_LIMITS = {
  /** Animals one visitor can ask for in one request. */
  maxAnimalsPerRequest: 10,
  /** Animals one farm shows on the page. */
  maxShownPerFarm: 300,
  /** A second request from the same phone inside this many days joins the one still waiting. */
  repeatWindowDays: 14,
  /** New-request notifications one workspace gets in an hour. The requests are all saved either way. */
  notificationsPerHour: 10,
} as const;

/** A sick or quarantined animal is not offered, and the page does not say why it is missing. */
const SHOWN_STATUSES = ['active', 'pregnant'];

// ─── Finding the workspace behind an address ────────────────────────────────

interface Site {
  tenantId: string;
  name: string;
  settings: TenantSettings;
  currency: string;
  timezone: string;
  farmIds: string[];
}

/** The workspace whose catalogue lives at this address. Not found unless it is switched on. */
async function findSite(slug: string): Promise<Site> {
  const key = slug.trim().toLowerCase();
  const site = await withPlatform(async (trx) => {
    const [tenant] = await trx
      .select({
        id: tenants.id,
        name: tenants.name,
        settings: tenants.settings,
        modules: tenants.modules,
        currency: tenants.currency,
        timezone: tenants.timezone,
      })
      .from(tenants)
      .where(and(sql`(${tenants.settings} #>> '{catalogue,slug}') = ${key}`, eq(tenants.status, 'active')))
      .limit(1);
    if (!tenant) return null;
    const settings = mergeSettings(tenant.settings);
    // A switched-off module grants nothing, to a visitor as to a member.
    if (!settings.catalogue.enabled || !tenant.modules.includes('sales') || !tenant.modules.includes('livestock')) return null;
    const farmRows = await trx.select({ id: farms.id }).from(farms).where(eq(farms.tenantId, tenant.id)).orderBy(asc(farms.createdAt));
    return { tenantId: tenant.id, name: tenant.name, settings, currency: tenant.currency, timezone: tenant.timezone, farmIds: farmRows.map((f) => f.id) };
  });
  if (!site || site.farmIds.length === 0) throw notFound('Catalogue');
  return site;
}

/** Inside the workspace, as nobody: no user, no permission, row-level security bound to the tenant. */
const inFarm = <T>(site: Site, farmId: string, fn: () => Promise<T>): Promise<T> =>
  withTenant(
    { userId: null, tenantId: site.tenantId, farmId, permissions: [], source: 'system', settings: site.settings, currency: site.currency, timezone: site.timezone },
    fn,
  );

// ─── What a visitor sees ────────────────────────────────────────────────────

/** Listed animals of the current farm that may be offered today, with which of them are spoken for. */
async function offered(listingIds?: string[]) {
  if (listingIds && listingIds.length === 0) return [];
  const rows = await tx()
    .select({
      listingId: l.id,
      animalId: animals.id,
      species: species.name,
      breed: breeds.name,
      sex: animals.sex,
      birthDate: animals.birthDate,
      weightKg: animals.currentWeightKg,
      photoFileId: animals.photoFileId,
      price: l.price,
    })
    .from(l)
    .innerJoin(animals, eq(animals.id, l.animalId))
    .innerJoin(species, eq(species.id, animals.speciesId))
    .leftJoin(breeds, eq(breeds.id, animals.breedId))
    .where(and(eq(l.farmId, ctx().farmId), inArray(animals.status, SHOWN_STATUSES), listingIds ? inArray(l.id, listingIds) : undefined))
    .orderBy(desc(l.createdAt), asc(l.id))
    .limit(CATALOGUE_LIMITS.maxShownPerFarm);
  const ids = rows.map((row) => row.animalId);
  // An animal that may not leave yet is simply not on the page: showing it, even as "reserved",
  // would tell a visitor something about its treatment.
  const withheld = new Set((await animalsUnderWithdrawal(ids)).map((row) => row.animalId));
  const held = await openReservations(ids);
  return rows.filter((row) => !withheld.has(row.animalId)).map((row) => ({ ...row, reserved: held.has(row.animalId) }));
}

export async function publicCatalogue(slug: string) {
  const site = await findSite(slug);
  const shown = [];
  for (const farmId of site.farmIds) {
    shown.push(
      ...(await inFarm(site, farmId, async () => {
        const now = today();
        const rows = await offered();
        return Promise.all(
          rows.map(async (row) => ({
            id: row.listingId,
            species: row.species,
            breed: row.breed,
            sex: row.sex,
            ageMonths: ageInMonths(row.birthDate, now),
            weightKg: row.weightKg,
            photoUrl: row.photoFileId ? await signedFileUrl(row.photoFileId) : null,
            /** Only what the farm chose to publish. Null: ask the farm. */
            price: row.price,
            /** Held for a buyer: shown, and cannot be asked for. */
            reserved: row.reserved,
          })),
        );
      })),
    );
  }
  return { name: site.name, contact: site.settings.catalogue.contact, currency: site.currency, animals: shown };
}

// ─── Pre-order ──────────────────────────────────────────────────────────────

export const catalogueRequestInput = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(9).max(24),
  /** Ids from the catalogue page. */
  animals: z.array(z.uuid()).max(CATALOGUE_LIMITS.maxAnimalsPerRequest).default([]),
  wanted: z.string().trim().max(500).optional(),
  note: z.string().trim().max(1000).optional(),
  language: z.enum(['uz', 'uz-Cyrl', 'ru', 'en']).default('uz'),
  consent: z.literal(true),
  /** Hidden from people. Only a bot fills it. */
  website: z.string().max(300).optional(),
  /** From GET /leads/form-token: the same token the contact form uses. */
  formToken: z.string().max(100).optional(),
});

const notifyBudget = new Map<string, { hour: number; sent: number }>();

/** Lives in this process, so a restart forgets it. That can only mean a few extra messages. */
function spendNotification(tenantId: string): boolean {
  const hour = Math.floor(Date.now() / 3_600_000);
  const spent = notifyBudget.get(tenantId);
  const budget = spent && spent.hour === hour ? spent : { hour, sent: 0 };
  notifyBudget.set(tenantId, budget);
  if (budget.sent >= CATALOGUE_LIMITS.notificationsPerHour) return false;
  budget.sent += 1;
  return true;
}

/** Tests start each case with a full budget. */
export const resetNotificationBudget = () => notifyBudget.clear();

/**
 * The traps answer exactly like a real request, so a bot learns nothing. A token that is missing or
 * out of date does not: the real form must hear it, fetch a new one and send again.
 */
export async function submitRequest(slug: string, input: z.infer<typeof catalogueRequestInput>, log: FastifyBaseLogger) {
  // First, so that a catalogue that is switched off answers "not found" whatever is sent to it.
  const site = await findSite(slug);
  if (input.website) {
    log.info('catalogue request dropped by the bot trap');
    return { received: true };
  }
  const verdict = formTokenVerdict(input.formToken);
  if (verdict === 'expired') throw badRequest('FORM_EXPIRED', 'This form has expired, please send it again');
  if (verdict === 'too_fast') {
    log.info('catalogue request dropped by the bot trap');
    return { received: true };
  }
  const phone = normalizePhone(input.phone);
  if (!/^\+\d{9,15}$/.test(phone)) throw badRequest('INVALID_PHONE', 'This phone number is not valid');

  const asked = [...new Set(input.animals)];
  if (asked.length === 0 && !input.wanted) {
    throw badRequest('CATALOGUE_REQUEST_EMPTY', 'Choose an animal, or write what you are looking for');
  }

  // The ids came from a stranger: each must be on the page right now, and free.
  const found: { listingId: string; animalId: string; farmId: string }[] = [];
  if (asked.length) {
    for (const farmId of site.farmIds) {
      const rows = await inFarm(site, farmId, () => offered(asked));
      found.push(...rows.filter((row) => !row.reserved).map((row) => ({ listingId: row.listingId, animalId: row.animalId, farmId })));
    }
  }
  const missing = asked.filter((id) => !found.some((row) => row.listingId === id));
  if (missing.length) {
    throw conflict('CATALOGUE_ANIMAL_UNAVAILABLE', 'Some of the chosen animals are no longer available', { animals: missing });
  }

  const farmId = found[0]?.farmId ?? site.farmIds[0];
  const animalIds = found.map((row) => row.animalId);
  await inFarm(site, farmId, async () => {
    const since = new Date(Date.now() - CATALOGUE_LIMITS.repeatWindowDays * 86_400_000);
    const [open] = await tx()
      .select({ id: q.id, submissions: q.submissions, animalIds: q.animalIds })
      .from(q)
      .where(and(eq(q.farmId, farmId), eq(q.phone, phone), eq(q.status, 'new'), gt(q.createdAt, since)))
      .orderBy(desc(q.createdAt))
      .limit(1)
      .for('update');

    if (open) {
      // The same phone again: one request for staff to answer, not a pile. Anyone can type a phone
      // number, so a repeat never replaces what was said first; it is counted, and the animals it
      // names are added up to the same limit one request has.
      const merged = [...new Set([...open.animalIds, ...animalIds])].slice(0, CATALOGUE_LIMITS.maxAnimalsPerRequest);
      await tx().update(q).set({ submissions: open.submissions + 1, animalIds: merged }).where(eq(q.id, open.id));
      return;
    }

    const [row] = await tx()
      .insert(q)
      .values({
        tenantId: site.tenantId,
        farmId,
        name: input.name,
        phone,
        animalIds,
        wanted: input.wanted ?? null,
        note: input.note ?? null,
        language: input.language,
      })
      .returning({ id: q.id });
    // The journal keeps that a request came, not who sent it or what they wrote.
    await recordEvent({ type: 'catalogue.request_received', entityType: 'catalogue_request', entityId: row.id, data: { animals: animalIds.length } });

    if (!spendNotification(site.tenantId)) {
      log.warn('catalogue request notification skipped: the hourly limit is reached');
      return;
    }
    // The message carries a count and nothing the visitor typed.
    const params = { count: String(animalIds.length) };
    await notifyRole(
      ['owner', 'director', 'accountant'],
      {
        severity: 'attention',
        title: (locale) => tr(locale, 'sales', 'notify.catalogueRequest.title', params),
        body: (locale) => tr(locale, 'sales', 'notify.catalogueRequest.body', params),
        link: '/sales/reservations?tab=requests',
      },
      { permission: 'sales.view' },
    );
  });
  return { received: true };
}

// ─── Staff: which animals are on the page ───────────────────────────────────

export const listingListQuery = listQuery.extend({ animalId: z.uuid().optional() });

export const listingInput = z.object({
  /** The price to publish for this animal. Null takes it off the page; left out, it stays as it is. */
  price: z.number().positive().max(MAX_MONEY).nullable().optional(),
});

const listingSelection = {
  id: l.id,
  animalId: l.animalId,
  animalTag: animals.tag,
  animalCategory: animals.category,
  animalSex: animals.sex,
  animalStatus: animals.status,
  herdName: herds.name,
  currentWeightKg: animals.currentWeightKg,
  price: l.price,
  createdAt: l.createdAt,
};

const listingsFrom = () =>
  tx().select(listingSelection).from(l).innerJoin(animals, eq(animals.id, l.animalId)).leftJoin(herds, eq(herds.id, animals.herdId));

export async function listListings(query: z.infer<typeof listingListQuery>) {
  const where = and(eq(l.farmId, ctx().farmId), query.animalId ? eq(l.animalId, query.animalId) : undefined, searchAny(query.search, [animals.tag]));
  const rows = await listingsFrom()
    .where(where)
    .orderBy(desc(l.createdAt), asc(l.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [{ total }] = await tx()
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(l)
    .innerJoin(animals, eq(animals.id, l.animalId))
    .where(where);
  return { data: hideMoney(rows, ['price']), meta: { page: query.page, pageSize: query.pageSize, total } };
}

async function getListing(animalId: string) {
  const [row] = await listingsFrom().where(and(eq(l.farmId, ctx().farmId), eq(l.animalId, animalId)));
  if (!row) throw notFound('Listing');
  return hideMoney([row], ['price'])[0];
}

/** Put an animal on the public page, or change the price published for it. */
export async function setListing(animalId: string, input: z.infer<typeof listingInput>) {
  // A published price is money the farm makes public: only someone who may see money sets it.
  if (input.price !== undefined && !canSeeMoney()) throw forbidden();
  const c = ctx();
  const [animal] = await tx()
    .select({ id: animals.id, tag: animals.tag, status: animals.status })
    .from(animals)
    .where(and(eq(animals.id, animalId), eq(animals.farmId, c.farmId)))
    .for('update');
  if (!animal) throw notFound('Animal');
  if (!SHOWN_STATUSES.includes(animal.status)) {
    throw conflict('CATALOGUE_ANIMAL_NOT_OFFERABLE', `Animal ${animal.tag} cannot be offered in its current state`, {
      animalId: animal.id,
      tag: animal.tag,
      status: animal.status,
    });
  }
  await tx()
    .insert(l)
    .values({ tenantId: c.tenantId, farmId: c.farmId, animalId, price: input.price ?? null, createdBy: c.userId })
    .onConflictDoUpdate({ target: l.animalId, set: input.price !== undefined ? { price: input.price } : { updatedAt: new Date() } });
  await recordEvent({
    type: 'catalogue.listed',
    entityType: 'animal',
    entityId: animal.id,
    data: { tag: animal.tag, pricePublished: input.price != null },
  });
  return getListing(animalId);
}

export async function removeListing(animalId: string) {
  const [gone] = await tx()
    .delete(l)
    .where(and(eq(l.farmId, ctx().farmId), eq(l.animalId, animalId)))
    .returning({ id: l.id });
  if (!gone) throw notFound('Listing');
  await recordEvent({ type: 'catalogue.unlisted', entityType: 'animal', entityId: animalId, data: {} });
  return { animalId, listed: false };
}

// ─── Staff: requests from the page ──────────────────────────────────────────

export const requestListQuery = listQuery.extend({ status: z.enum(CATALOGUE_REQUEST_STATUSES).optional() });

export const requestReserveInput = z.object({
  animalId: z.uuid(),
  /** The buyer in the books. Without one the reservation carries the name and phone the visitor gave. */
  counterpartyId: z.uuid().nullish(),
  agreedPrice: z.number().positive().max(MAX_MONEY).nullish(),
  reservedUntil: isoDate,
  note: z.string().trim().max(500).nullish(),
});

const stripRequests = <T extends { name: string | null; phone: string | null }>(rows: T[]): T[] => hidePii(rows, ['name', 'phone']);

async function withAnimals<T extends { animalIds: string[] }>(rows: T[]) {
  const ids = [...new Set(rows.flatMap((row) => row.animalIds))];
  const found = ids.length
    ? await tx()
        .select({ id: animals.id, tag: animals.tag, status: animals.status })
        .from(animals)
        .where(and(eq(animals.farmId, ctx().farmId), inArray(animals.id, ids)))
    : [];
  const held = await openReservations(found.map((a) => a.id));
  const byId = new Map(found.map((a) => [a.id, { animalId: a.id, tag: a.tag, status: a.status, reserved: held.has(a.id) }]));
  return rows.map(({ animalIds, ...row }) => ({ ...row, animals: animalIds.flatMap((id) => byId.get(id) ?? []) }));
}

const requestSelection = {
  id: q.id,
  name: q.name,
  phone: q.phone,
  animalIds: q.animalIds,
  wanted: q.wanted,
  note: q.note,
  language: q.language,
  status: q.status,
  submissions: q.submissions,
  closedAt: q.closedAt,
  createdAt: q.createdAt,
};

export async function listRequests(query: z.infer<typeof requestListQuery>) {
  const where = and(eq(q.farmId, ctx().farmId), query.status ? eq(q.status, query.status) : undefined);
  const page = await paged(query, q, where, (limit, offset) =>
    tx()
      .select(requestSelection)
      .from(q)
      .where(where)
      // Waiting ones first.
      .orderBy(sql`case ${q.status} when 'new' then 0 when 'reserved' then 1 else 2 end`, desc(q.createdAt))
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: stripRequests(await withAnimals(page.data)) };
}

async function getRequest(id: string) {
  const [row] = await tx().select(requestSelection).from(q).where(and(eq(q.id, id), eq(q.farmId, ctx().farmId)));
  if (!row) throw notFound('Request');
  return stripRequests(await withAnimals([row]))[0];
}

async function lockRequest(id: string) {
  const [row] = await tx()
    .select()
    .from(q)
    .where(and(eq(q.id, id), eq(q.farmId, ctx().farmId)))
    .for('update');
  if (!row) throw notFound('Request');
  if (row.status === 'closed') throw conflict('CATALOGUE_REQUEST_CLOSED', 'This request is already closed');
  return row;
}

/**
 * Staff answer a request by holding an animal for the visitor. The reservation is made by the
 * reservations service, with its own rules; the name and phone are copied as they were typed.
 */
export async function reserveFromRequest(id: string, input: z.infer<typeof requestReserveInput>) {
  const request = await lockRequest(id);
  const reservation = await reservations.create(
    {
      animalId: input.animalId,
      counterpartyId: input.counterpartyId ?? null,
      customerName: input.counterpartyId ? null : request.name,
      customerPhone: input.counterpartyId ? null : request.phone,
      agreedPrice: input.agreedPrice ?? null,
      reservedUntil: input.reservedUntil,
      note: input.note ?? null,
    },
    { requestId: id },
  );
  await tx().update(q).set({ status: 'reserved' }).where(eq(q.id, id));
  await recordEvent({
    type: 'catalogue.request_reserved',
    entityType: 'catalogue_request',
    entityId: id,
    data: { reservationId: reservation.id, animalId: input.animalId },
  });
  return { request: await getRequest(id), reservation };
}

export async function closeRequest(id: string) {
  await lockRequest(id);
  await tx().update(q).set({ status: 'closed', closedBy: ctx().userId, closedAt: new Date() }).where(eq(q.id, id));
  await recordEvent({ type: 'catalogue.request_closed', entityType: 'catalogue_request', entityId: id, data: {} });
  return getRequest(id);
}
