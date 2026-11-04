import { addDays, monthOf, monthRange } from '@yap/shared';

/** Weeks start on Monday in Uzbekistan. */
export function weekdayIndex(iso: string): number {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export const startOfWeek = (iso: string): string => addDays(iso, -weekdayIndex(iso));

export const weekDays = (iso: string): string[] => {
  const start = startOfWeek(iso);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
};

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** Same day in another month, clamped: from 31 January one month on is 28 February. */
export function shiftDateByMonth(iso: string, delta: number): string {
  const target = shiftMonth(monthOf(iso), delta);
  const day = Math.min(Number(iso.slice(8, 10)), Number(monthRange(target).to.slice(8, 10)));
  return `${target}-${String(day).padStart(2, '0')}`;
}

/** Whole weeks covering the month, Monday first. */
export function monthGrid(month: string): string[] {
  const { from, to } = monthRange(month);
  const start = startOfWeek(from);
  const end = addDays(startOfWeek(to), 6);
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
  return days;
}
