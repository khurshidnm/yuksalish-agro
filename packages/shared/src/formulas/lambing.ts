/**
 * Lambing season: how many lambs to expect once ewes have been scanned, and which newborn lambs
 * need a person now. Pure functions, so the calendar, the outlook, the assistant, the desk and the
 * alerts cannot disagree.
 */
import { DEFAULT_TIMEZONE, addDays, diffDays, todayIso } from '../dates';
import { round } from './index';
import { WEANING_DAYS } from './reproduction';

/**
 * Starting values chosen for the pilot, not figures from a book. Each farm's zootechnician and
 * vet should set their own once a season has shown what fits.
 */
export const LAMBING_DESK = {
  /** The night-watch list shows ewes due within this many days, and every overdue one. */
  watchDays: 14,
  /** A live lamb with no colostrum on record this many hours after birth needs attention. */
  colostrumHours: 6,
  /** After this many days a missing colostrum record is history, not something to act on. */
  colostrumWatchDays: 3,
  /** Planned stay of a ewe and her lambs in a lambing pen, in days. */
  penDays: 3,
} as const;

/** Most foetuses a scan can record. A lambing form takes up to three lambs too. */
export const MAX_SCAN_FETUSES = 3;

export interface PregnancyTally {
  /** Open pregnancies: ewes still to lamb. */
  ewes: number;
  /** How many of them have a scan on record. */
  scannedEwes?: number;
  /** Foetuses those scans counted in total. */
  scannedFetuses?: number;
}

/**
 * Lambs to expect from open pregnancies, not rounded. A scanned ewe counts what the scan found;
 * an unscanned one takes `lambsPerEwe`. Null when that rate is needed and not known, or when
 * there is neither a rate nor a scan to go by.
 */
export function lambsFromPregnancies(tally: PregnancyTally, lambsPerEwe: number | null): number | null {
  const ewes = Math.max(0, tally.ewes);
  const scannedEwes = Math.min(Math.max(0, tally.scannedEwes ?? 0), ewes);
  const unscanned = ewes - scannedEwes;
  if (lambsPerEwe === null && (unscanned > 0 || scannedEwes === 0)) return null;
  return (scannedEwes > 0 ? Math.max(0, tally.scannedFetuses ?? 0) : 0) + unscanned * (lambsPerEwe ?? 0);
}

/** The same, as whole lambs: the count every screen shows. */
export function expectedLambCrop(tally: PregnancyTally, lambsPerEwe: number | null): number | null {
  const lambs = lambsFromPregnancies(tally, lambsPerEwe);
  return lambs === null ? null : round(lambs, 0);
}

export interface BirthFacts {
  /** The lambing date, YYYY-MM-DD. */
  birthDate: string;
  /** When the person saved the lambing form on their device, if the device said. */
  bornAt: Date | null;
  /** When the record reached the server. */
  recordedAt: Date;
  now: Date;
  timeZone?: string;
}

const HOUR_MS = 3_600_000;

/**
 * The least this lamb can be old, in hours. With the time the form was saved, that is the answer.
 * Without it, a record that arrived on the birth date counts from its arrival, and one that
 * arrived later adds the whole days in between: she was born by the end of her birth date at the
 * latest. An alert built on this can be late, never early.
 */
export function minHoursSinceBirth({ birthDate, bornAt, recordedAt, now, timeZone = DEFAULT_TIMEZONE }: BirthFacts): number {
  if (bornAt) return Math.max(0, (now.getTime() - bornAt.getTime()) / HOUR_MS);
  const recordedDay = todayIso(timeZone, recordedAt);
  const wholeDaysBetween = Math.max(0, diffDays(birthDate, recordedDay) - 1);
  return Math.max(0, (now.getTime() - recordedAt.getTime()) / HOUR_MS) + wholeDaysBetween * 24;
}

export interface LambCareFacts {
  /** From `minHoursSinceBirth`. */
  hoursOld: number;
  /** Days since the birth date. */
  ageDays: number;
  colostrumGiven: boolean;
  /** `with_dam`, `fostered`, `bottle`, or null with no care record. */
  mothering: string | null;
}

export interface LambAttention {
  noColostrum: boolean;
  bottle: boolean;
}

/** Why a live lamb is on the attention list. Both false means she is not on it. */
export function lambAttention(
  facts: LambCareFacts,
  limits: { colostrumHours: number; colostrumWatchDays: number } = LAMBING_DESK,
): LambAttention {
  return {
    noColostrum: !facts.colostrumGiven && facts.hoursOld >= limits.colostrumHours && facts.ageDays <= limits.colostrumWatchDays,
    // An orphan on the bottle needs feeding by hand until she is weaned.
    bottle: facts.mothering === 'bottle' && facts.ageDays < WEANING_DAYS,
  };
}

/** Day a pen is planned to be free again. */
export function penReleaseDate(sinceDate: string, days: number = LAMBING_DESK.penDays): string {
  return addDays(sinceDate, days);
}
