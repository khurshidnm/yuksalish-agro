/** Live tracking of animals: collars and boluses (docs/tracking.md). */

export const TRACKING = '/tracking';
export const TRACKERS = '/tracking/trackers';
export const LIVE = '/tracking/live';

export type TrackerKind = 'collar' | 'bolus' | 'ear_tag';
export const TRACKER_KINDS: TrackerKind[] = ['collar', 'bolus', 'ear_tag'];

export type TrackingFlag = 'isolated' | 'inactive' | 'fever';
/** Most urgent first: that is the order they are listed and drawn. */
export const FLAGS: TrackingFlag[] = ['fever', 'isolated', 'inactive'];

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
