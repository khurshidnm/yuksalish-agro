import { bigint, boolean, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { day, pk, ts, type I18nName } from './_helpers';
import { tenantColumns, tenantOnlyColumns } from './_tenant';
import { farms, tenants, users } from './platform';

/** Bo'linma: a group of cost centers (dehqonchilik, qo'ychilik, mexanizatsiya). */
export const divisions = pgTable('divisions', {
  id: pk(),
  ...tenantColumns(),
  key: text().notNull(),
  name: text().notNull(),
});

export const files = pgTable(
  'files',
  {
    id: pk(),
    ...tenantColumns(),
    storageKey: text().notNull(),
    name: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: bigint({ mode: 'number' }).notNull(),
  },
  (t) => [index().on(t.tenantId)],
);

export const documents = pgTable(
  'documents',
  {
    id: pk(),
    ...tenantColumns(),
    type: text().notNull(),
    title: text().notNull(),
    number: text(),
    fileId: uuid().references(() => files.id),
    issueDate: day(),
    expiryDate: day(),
    /** Link to any object, e.g. entityType 'field', 'asset', 'counterparty'. */
    entityType: text(),
    entityId: uuid(),
    notes: text(),
  },
  (t) => [index().on(t.farmId, t.expiryDate), index().on(t.entityType, t.entityId)],
);

/** Unified event journal (spec 4.1 p.4, Event in section 22). Reports and AI read from here. Append-only. */
export const events = pgTable(
  'events',
  {
    id: pk(),
    tenantId: uuid().notNull().references(() => tenants.id),
    farmId: uuid().notNull().references(() => farms.id),
    occurredAt: ts().notNull().defaultNow(),
    source: text().notNull().default('user'),
    /** Dotted type, e.g. 'animal.vaccinated', 'stock.issued', 'camera.motion'. */
    type: text().notNull(),
    severity: text().notNull().default('info'),
    entityType: text(),
    entityId: uuid(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    photoFileId: uuid(),
    deviceId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    index().on(t.farmId, t.occurredAt.desc()),
    index().on(t.farmId, t.type, t.occurredAt.desc()),
    index().on(t.entityType, t.entityId),
  ],
);

/** Written only by the audit trigger; the API role has read access only. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull(),
    userId: uuid(),
    entity: text().notNull(),
    entityId: text(),
    action: text().notNull(),
    before: jsonb(),
    after: jsonb(),
    ip: text(),
    device: text(),
    at: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.tenantId, t.at.desc()), index().on(t.tenantId, t.entity, t.entityId)],
);

// ─── Reference data (ma'lumotnomalar), copied per tenant on provisioning ────

export const species = pgTable('species', {
  id: pk(),
  ...tenantOnlyColumns(),
  key: text().notNull(),
  name: jsonb().$type<I18nName>().notNull(),
  gestationDays: integer().notNull(),
  gestationMinDays: integer().notNull(),
  gestationMaxDays: integer().notNull(),
  active: boolean().notNull().default(true),
});

export const breeds = pgTable('breeds', {
  id: pk(),
  ...tenantOnlyColumns(),
  speciesId: uuid().notNull().references(() => species.id),
  key: text().notNull(),
  name: jsonb().$type<I18nName>().notNull(),
  active: boolean().notNull().default(true),
});

export const crops = pgTable('crops', {
  id: pk(),
  ...tenantOnlyColumns(),
  key: text().notNull(),
  name: jsonb().$type<I18nName>().notNull(),
  /** Usable as feed for own livestock (spec 7.1). */
  isFeed: boolean().notNull().default(false),
  defaultYieldTHa: text(),
  active: boolean().notNull().default(true),
});
