import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { pk, ts } from './_helpers';
import { tenantColumns } from './_tenant';
import { facilities } from './land';
import { apiKeys } from './platform';

/**
 * Cameras, sensors, RFID readers, scales (spec 16). The model and ingest API exist from phase 1;
 * detections arrive as rows in `events` through POST /api/v1/devices/events.
 */
export const devices = pgTable(
  'devices',
  {
    id: pk(),
    ...tenantColumns(),
    type: text().notNull(),
    name: text().notNull(),
    facilityId: uuid().references(() => facilities.id),
    lat: doublePrecision(),
    lng: doublePrecision(),
    /** RTSP or NVR address, with any user:password removed. */
    streamUrl: text(),
    onvifUrl: text(),
    /** Sealed "user:password" split out of streamUrl, so it never reaches the audit log in clear. */
    streamCredentials: text(),
    status: text().notNull().default('planned'),
    lastSeenAt: ts(),
    apiKeyId: uuid().references(() => apiKeys.id),
    /** { zone, liveUrl, offlineAfterMinutes } */
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    notes: text(),
  },
  (t) => [index().on(t.farmId, t.type)],
);

/** Outgoing webhook subscription (spec 19.1). `eventTypes` holds exact types, "prefix.*" or "*". */
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: pk(),
    ...tenantColumns(),
    url: text().notNull(),
    description: text(),
    eventTypes: jsonb().$type<string[]>().notNull(),
    /** Sealed HMAC secret. Shown once, on creation. */
    secret: text().notNull(),
    active: boolean().notNull().default(true),
    /** Newest journal event already considered. UUIDv7, so ids sort by time. */
    cursor: uuid().notNull(),
  },
  (t) => [index().on(t.farmId, t.active)],
);

/** One delivery of one event: the retry queue and the error log (spec 19.1). */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: pk(),
    ...tenantColumns(),
    subscriptionId: uuid().notNull().references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
    eventId: uuid(),
    eventType: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    /** pending, delivered or failed */
    status: text().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    nextAttemptAt: ts().notNull().defaultNow(),
    lastStatusCode: integer(),
    lastError: text(),
    deliveredAt: ts(),
  },
  (t) => [index().on(t.farmId, t.status, t.nextAttemptAt), index().on(t.subscriptionId, t.createdAt)],
);
