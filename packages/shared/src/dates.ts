/** Business dates are local to the farm: Asia/Tashkent (UTC+5, no DST) by default. */
export const DEFAULT_TIMEZONE = 'Asia/Tashkent';

/** Today's date as YYYY-MM-DD in the given time zone. */
export function todayIso(timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The wall clock in a time zone: hour 0 to 23 and minute. */
export function localClock(timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: part('hour'), minute: part('minute') };
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function diffDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** "YYYY-MM" for a date. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** First and last date of a "YYYY-MM" month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
