import { boolean, doublePrecision, index, jsonb, pgTable, primaryKey, text, unique, uuid, integer } from 'drizzle-orm/pg-core';
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
});

/** Global identity: one person can work for several tenants (spec 5.1). No tenant_id, no RLS. */
export const users = pgTable('users', {
  id: pk(),
  phone: text().notNull().unique(),
  email: text(),
  fullName: text().notNull(),
  passwordHash: text().notNull(),
  locale: text().notNull().default('uz'),
  status: text().notNull().default('active'),
  totpSecret: text(),
  totpEnabled: boolean().notNull().default(false),
  isPlatformAdmin: boolean().notNull().default(false),
  telegramChatId: text(),
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
    statusCode: integer().notNull(),
    response: jsonb(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);
