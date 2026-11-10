import { sql } from 'drizzle-orm';
import { boolean, doublePrecision, index, jsonb, pgTable, primaryKey, text, unique, uniqueIndex, uuid, integer, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { dec, money, pk, ts } from './_helpers';

/** Tariff plans: a plan is a set of modules (spec 4.1 p.2). */
export const plans = pgTable('plans', {
  id: pk(),
  key: text().notNull().unique(),
  name: text().notNull(),
  modules: jsonb().$type<string[]>().notNull(),
  priceMonthly: money(),
  active: boolean().notNull().default(true),
  createdAt: ts().notNull().defaultNow(),
});

export const tenants = pgTable('tenants', {
  id: pk(),
  name: text().notNull(),
  legalName: text(),
  tin: text(),
  legalForm: text(),
  taxRegime: text(),
  currency: text().notNull().default('UZS'),
  timezone: text().notNull().default('Asia/Tashkent'),
  locale: text().notNull().default('uz'),
  planId: uuid().references(() => plans.id),
  modules: jsonb().$type<string[]>().notNull().default([]),
  /** Tenant policy, merged over defaults in core/settings.ts. */
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  status: text().notNull().default('active'),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts().notNull().defaultNow().$onUpdate(() => new Date()),
}, () => [
  // The address of a public catalogue page belongs to one workspace. Row-level security hides other
  // workspaces from each other, so only an index can keep two of them from choosing the same one.
  uniqueIndex('tenants_catalogue_slug').on(sql`(settings #>> '{catalogue,slug}')`),
]);

/** Global identity: one person can work for several tenants (spec 5.1). No tenant_id, no RLS. */
export const users = pgTable('users', {
  id: pk(),
  phone: text().notNull().unique(),
  email: text(),
  fullName: text().notNull(),
  passwordHash: text().notNull(),
  /** Someone else issued this password, so it opens nothing until the person chooses their own. */
  mustChangePassword: boolean().notNull().default(false),
  locale: text().notNull().default('uz'),
  status: text().notNull().default('active'),
  totpSecret: text(),
  totpEnabled: boolean().notNull().default(false),
  /** The newest time step a code was accepted for. Anything at or before it is refused, so a code works once. */
  totpLastStep: integer(),
  isPlatformAdmin: boolean().notNull().default(false),
  telegramChatId: text(),
  /** The farm Telegram works on, chosen in the bot by someone on several farms. */
  telegramMembershipId: uuid().references((): AnyPgColumn => memberships.id, { onDelete: 'set null' }),
  lastLoginAt: ts(),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts().notNull().defaultNow().$onUpdate(() => new Date()),
});

export const roles = pgTable(
  'roles',
  {
    id: pk(),
    tenantId: uuid().notNull().references(() => tenants.id),
    key: text().notNull(),
    name: text().notNull(),
    permissions: jsonb().$type<string[]>().notNull(),
    isSystem: boolean().notNull().default(false),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [unique().on(t.tenantId, t.key)],
);

export const farms = pgTable(
  'farms',
  {
    id: pk(),
    tenantId: uuid().notNull().references(() => tenants.id),
    name: text().notNull(),
    region: text(),
    district: text(),
    address: text(),
    totalAreaHa: dec(12, 4),
    lat: doublePrecision(),
    lng: doublePrecision(),
    /** Metres above sea level, for crop water use. Taken from the weather service when unset. */
    elevationM: doublePrecision(),
    cadastreNumber: text(),
    /** Passport details (6.1.1): lease contract, responsible people, requisites. */
    passport: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index().on(t.tenantId)],
);

/** Who works where, in which role. One row per user and farm (spec 5.1). */
export const memberships = pgTable(
  'memberships',
  {
    id: pk(),
    tenantId: uuid().notNull().references(() => tenants.id),
    farmId: uuid().notNull().references(() => farms.id),
    userId: uuid().notNull().references(() => users.id),
    roleId: uuid().notNull().references(() => roles.id),
    status: text().notNull().default('active'),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [unique().on(t.userId, t.farmId), index().on(t.tenantId)],
);

/**
 * A farm asking someone who already has an account to join. It holds only what the inviter typed,
 * and nothing points at the account: the person's details reach the farm when they accept, signed in.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: pk(),
    tenantId: uuid().notNull().references(() => tenants.id),
    farmId: uuid().notNull().references(() => farms.id),
    roleId: uuid().notNull().references(() => roles.id, { onDelete: 'cascade' }),
    phone: text().notNull(),
    fullName: text().notNull(),
    status: text().notNull().default('pending'),
    expiresAt: ts().notNull(),
    createdBy: uuid().references(() => users.id),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    index().on(t.phone),
    index().on(t.tenantId),
    uniqueIndex('invitations_pending_idx').on(t.farmId, t.phone).where(sql`status = 'pending'`),
  ],
);

/** Single-use ways in for a lost authenticator. Shown once at enrolment, stored hashed. */
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: pk(),
    userId: uuid().notNull().references(() => users.id),
    codeHash: text().notNull().unique(),
    usedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);

/**
 * Failed tries against one phone from one address. No foreign key to users: an unknown phone
 * is counted the same way, so the lock cannot reveal which phones have accounts.
 */
export const signInFailures = pgTable(
  'sign_in_failures',
  {
    phone: text().notNull(),
    address: text().notNull(),
    failures: integer().notNull().default(0),
    windowStartedAt: ts().notNull().defaultNow(),
    lockedUntil: ts(),
  },
  (t) => [primaryKey({ columns: [t.phone, t.address] }), index().on(t.windowStartedAt)],
);

/** What platform administrators changed. The API can add to it but never rewrite it (post-schema.sql). */
export const platformAudit = pgTable(
  'platform_audit',
  {
    id: pk(),
    /** Null for the server-side reset command, which has no signed-in person. */
    adminId: uuid().references(() => users.id),
    action: text().notNull(),
    targetId: text(),
    ip: text(),
    device: text(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.createdAt)],
);

/** Refresh tokens are stored hashed and rotated; reuse of a rotated token revokes its family. */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: pk(),
    userId: uuid().notNull().references(() => users.id),
    membershipId: uuid().references(() => memberships.id),
    tokenHash: text().notNull().unique(),
    familyId: uuid().notNull(),
    expiresAt: ts().notNull(),
    /** Replaced by a newer token. Still accepted for a few seconds, for parallel tabs. */
    rotatedAt: ts(),
    /** Killed: logout, password change, or theft detection. Never accepted again. */
    revokedAt: ts(),
    userAgent: text(),
    ip: text(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.userId), index().on(t.familyId)],
);

/** Keys for machines: cameras, sensors, integrations (spec 19.1). Stored hashed. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: pk(),
    tenantId: uuid().notNull().references(() => tenants.id),
    farmId: uuid().notNull().references(() => farms.id),
    name: text().notNull(),
    keyHash: text().notNull().unique(),
    keyPrefix: text().notNull(),
    scopes: jsonb().$type<string[]>().notNull().default([]),
    lastUsedAt: ts(),
    /** Null: until someone revokes it. */
    expiresAt: ts(),
    revokedAt: ts(),
    createdBy: uuid().references(() => users.id),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.tenantId)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: uuid().notNull().references(() => tenants.id),
    key: text().notNull(),
    path: text().notNull(),
    userId: uuid(),
    statusCode: integer().notNull(),
    response: jsonb(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

export interface LeadRepeat {
  at: string;
  fullName: string;
  farmName?: string;
  region?: string;
  farmType?: string;
  farmSize?: string;
  message?: string;
}

/**
 * Enquiries from the public website. No tenant_id: a prospect has no tenant yet. The assistant has
 * no grant on this table, so it can never read a prospect's phone number.
 */
export const leads = pgTable(
  'leads',
  {
    id: pk(),
    fullName: text().notNull(),
    phone: text().notNull(),
    farmName: text(),
    region: text(),
    farmType: text(),
    farmSize: text(),
    message: text(),
    language: text().notNull().default('uz'),
    /** The page the form was sent from. */
    source: text(),
    utm: jsonb().$type<Record<string, string>>(),
    status: text().notNull().default('new'),
    notes: text(),
    /** A repeat enquiry from the same phone joins the open lead and adds to this. */
    submissions: integer().notNull().default(1),
    /** What repeat enquiries said. The columns above stay as first sent: anyone can type a phone number. */
    repeats: jsonb().$type<LeadRepeat[]>().notNull().default([]),
    consentAt: ts().notNull(),
    contactedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index().on(t.status, t.createdAt), index().on(t.phone)],
);
