import { sql } from 'drizzle-orm';
import { doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { day, dec, pk, ts } from './_helpers';
import { tenantColumns } from './_tenant';
import { devices } from './devices';
import { animals } from './livestock';

/**
 * Live tracking of animals (docs/tracking.md): collars and boluses report through a LoRaWAN network
 * server. The device itself is a row in `devices` with an `externalId` (DevEUI); this file holds
 * who wears it and what it said.
 */

/** Which animal wears which tracker, and when. A business record, so it keeps its history. */
export const trackerAssignments = pgTable(
  'tracker_assignments',
  {
    id: pk(),
    ...tenantColumns(),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    animalId: uuid()
      .notNull()
      .references(() => animals.id, { onDelete: 'cascade' }),
    fittedOn: day().notNull(),
    removedOn: day(),
    notes: text(),
  },
  (t) => [
    uniqueIndex('tracker_assignments_one_open_per_device').on(t.deviceId).where(sql`removed_on is null`),
    index().on(t.animalId),
    index().on(t.farmId, t.removedOn),
  ],
);

/**
 * Every reading as it arrived. About 100 000 rows a day for a flock of 700, so no audit trigger,
 * and the rows expire after `retention.trackerReadingsDays`; `animal_track_days` keeps the summary.
 * A value the device did not send is null, never 0.
 */
export const trackerReadings = pgTable(
  'tracker_readings',
  {
    id: pk(),
    ...tenantColumns(),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    /** The animal wearing the device at the time, if any. */
    animalId: uuid().references(() => animals.id, { onDelete: 'cascade' }),
    recordedAt: ts().notNull(),
    receivedAt: ts().notNull().defaultNow(),
    lat: doublePrecision(),
    lng: doublePrecision(),
    /** The device's own activity counter, in its own units. */
    activity: doublePrecision(),
    temperatureC: dec(4, 2),
    batteryPct: dec(5, 2),
    rssi: integer(),
    snr: dec(5, 2),
    gatewayId: text(),
  },
  (t) => [
    // A network server or a bridge may send the same uplink twice.
    uniqueIndex('tracker_readings_device_time').on(t.deviceId, t.recordedAt),
    index().on(t.farmId, t.recordedAt),
    index().on(t.animalId, t.recordedAt),
  ],
);

/** The latest word from each tracker: whether it still reports and how its battery is. */
export const trackerState = pgTable(
  'tracker_state',
  {
    id: pk(),
    ...tenantColumns(),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    lastReadingAt: ts().notNull(),
    batteryPct: dec(5, 2),
    batteryAt: ts(),
    rssi: integer(),
    snr: dec(5, 2),
    gatewayId: text(),
  },
  (t) => [uniqueIndex('tracker_state_device').on(t.deviceId)],
);

/**
 * Where each animal is and how it is, merged from all its trackers: position from the collar,
 * temperature from the bolus. The live map reads this table alone.
 */
export const animalTracking = pgTable(
  'animal_tracking',
  {
    id: pk(),
    ...tenantColumns(),
    animalId: uuid()
      .notNull()
      .references(() => animals.id, { onDelete: 'cascade' }),
    lat: doublePrecision(),
    lng: doublePrecision(),
    positionAt: ts(),
    temperatureC: dec(4, 2),
    temperatureAt: ts(),
    activity: doublePrecision(),
    activityAt: ts(),
    lastReadingAt: ts(),
    /** Health flags the rules raised, each with the time it was first raised: { isolated: ISO, ... }. */
    flags: jsonb().$type<Partial<Record<TrackingFlag, string>>>().notNull().default({}),
  },
  (t) => [uniqueIndex('animal_tracking_animal').on(t.animalId), index().on(t.farmId)],
);

export type TrackingFlag = 'isolated' | 'inactive' | 'fever';

/** One animal's day, kept after the raw readings expire. The baseline of the health rules. */
export const animalTrackDays = pgTable(
  'animal_track_days',
  {
    id: pk(),
    ...tenantColumns(),
    animalId: uuid()
      .notNull()
      .references(() => animals.id, { onDelete: 'cascade' }),
    date: day().notNull(),
    readings: integer().notNull(),
    fixes: integer().notNull(),
    distanceM: dec(9, 1),
    activityMean: doublePrecision(),
    temperatureMedianC: dec(4, 2),
    temperatureMaxC: dec(4, 2),
  },
  (t) => [uniqueIndex('animal_track_days_animal_date').on(t.animalId, t.date), index().on(t.farmId, t.date)],
);
