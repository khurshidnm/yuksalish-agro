/** Live tracking of animals: collars and boluses (docs/tracking.md). */
import type { GEOFENCE_KINDS } from '@yap/shared';
import type { Geometry } from 'geojson';

export const TRACKING = '/tracking';
export const TRACKERS = '/tracking/trackers';
export const LIVE = '/tracking/live';

export type TrackerKind = 'collar' | 'bolus' | 'ear_tag';
export const TRACKER_KINDS: TrackerKind[] = ['collar', 'bolus', 'ear_tag'];

export const ZONES = '/tracking/zones';
export const NIGHT_WATCH = '/tracking/night-watch';
export const LOST = '/tracking/lost';
export const GRAZING = '/tracking/grazing';

export type TrackingFlag = 'isolated' | 'inactive' | 'fever' | 'out_of_zone';
/** Most urgent first: that is the order they are listed and drawn. */
export const FLAGS: TrackingFlag[] = ['fever', 'isolated', 'out_of_zone', 'inactive'];

/** Since when each flag has been raised, ISO time. */
export type Flags = Partial<Record<TrackingFlag, string>>;

export interface LiveAnimal {
  animalId: string;
  tag: string;
  herdId: string | null;
  herdName: string | null;
  lat: number | null;
  lng: number | null;
  positionAt: string | null;
  temperatureC: number | null;
  lastReadingAt: string | null;
  flags: Flags;
  /** The lowest of its trackers. */
  batteryPct: number | null;
  /** Every tracker it wears is past its silence limit. */
  silent: boolean;
}

export interface LiveHerd {
  id: string;
  name: string | null;
  tracked: number;
  located: number;
  silent: number;
  flagged: number;
  centre: { lat: number; lng: number } | null;
}

export interface LiveData {
  now: string;
  silentAfterMinutes: number;
  bolusSilentAfterMinutes: number;
  lowBatteryPct: number;
  summary: { tracked: number; located: number; silent: number; flagged: number; lowBattery: number };
  herds: LiveHerd[];
  animals: LiveAnimal[];
}

export interface TrackerRow {
  id: string;
  externalId: string | null;
  name: string;
  kind: TrackerKind;
  status: string;
  lastReadingAt: string | null;
  batteryPct: number | null;
  rssi: number | null;
  assignmentId: string | null;
  fittedOn: string | null;
  animalId: string | null;
  animalTag: string | null;
  herdId: string | null;
  herdName: string | null;
}

export interface WornTracker {
  assignmentId: string;
  deviceId: string;
  externalId: string | null;
  kind: TrackerKind;
  fittedOn: string;
  removedOn: string | null;
  lastReadingAt: string | null;
  batteryPct: number | null;
}

export interface AnimalTracking {
  animalId: string;
  tag: string;
  state: {
    lat: number | null;
    lng: number | null;
    positionAt: string | null;
    temperatureC: number | null;
    temperatureAt: string | null;
    activity: number | null;
    activityAt: string | null;
    lastReadingAt: string | null;
    flags: Flags;
  } | null;
  trackers: WornTracker[];
}

export interface TrackPoint {
  at: string;
  lat: number;
  lng: number;
}

export interface AnimalSeries {
  days: number;
  hourly: { hour: string; temperatureC: number | null; activity: number | null; fixes: number }[];
  history: {
    date: string;
    fixes: number;
    distanceM: number | null;
    activityMean: number | null;
    temperatureMedianC: number | null;
    temperatureMaxC: number | null;
  }[];
}

export type ImportAction = 'register' | 'register_and_fit' | 'fit' | 'move' | 'unchanged';

export interface ImportResult {
  applied: boolean;
  fittedOn: string;
  summary: { rows: number; register: number; fit: number; move: number; unchanged: number; errors: number };
  rows: { index: number; externalId: string; kind: TrackerKind; animalTag: string | null; action: ImportAction | null; error: string | null }[];
}

/** Two hours without a reading: the tracker needs someone to look. */
export const isStale = (iso: string | null, now: number, minutes: number) => !iso || now - Date.parse(iso) > minutes * 60_000;

export type ZoneKind = (typeof GEOFENCE_KINDS)[number];

/** A zone a herd must stay in or keep out of. */
export interface ZoneRow {
  id: string;
  name: string;
  kind: ZoneKind;
  /** The zone follows this field's boundary, or has its own outline when `null`. */
  fieldId: string | null;
  fieldNumber: string | null;
  fieldName: string | null;
  /** `null`: every herd. */
  herdId: string | null;
  herdName: string | null;
  active: boolean;
  /** The outline the rule reads; `null` when its field has none yet. */
  geometry: Geometry | null;
}

export type LostReason = 'silent' | 'isolated' | 'both';

export interface LostAnimal {
  animalId: string;
  tag: string;
  herdId: string | null;
  herdName: string | null;
  reason: LostReason;
  lat: number | null;
  lng: number | null;
  positionAt: string | null;
  lastReadingAt: string | null;
  minutesSinceContact: number | null;
  minutesSincePosition: number | null;
  distanceFromHerdM: number | null;
  batteryPct: number | null;
}

export interface LostData {
  now: string;
  silentAfterMinutes: number;
  tracked: number;
  /** Nothing reports at all: the gateway, not the sheep. */
  allSilent: boolean;
  total: number;
  animals: LostAnimal[];
}

export interface HeatCell {
  south: number;
  west: number;
  north: number;
  east: number;
  fixes: number;
  share: number;
  /** 1 (least used) to 5 (most used). */
  level: number;
}

export interface GrazingField {
  fieldId: string;
  number: string;
  name: string | null;
  landUse: string;
  areaHa: number | null;
  fixes: number;
  animalDays: number;
  animalHours: number;
  daysUsed: number;
  share: number;
  animalDaysPerHa: number | null;
}

/** Where the flock spent a period. Every list is `null` when no position is stored for it. */
export interface GrazingData {
  days: number;
  from: string;
  to: string;
  minAnimalDayHours: number;
  daysWithData: number;
  totalFixes: number | null;
  cells: HeatCell[] | null;
  truncated: boolean;
  fields: GrazingField[] | null;
}
