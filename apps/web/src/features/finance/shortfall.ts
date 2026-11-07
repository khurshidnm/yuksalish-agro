/**
 * The stretch of a forecast to shade: the first run of months below zero, up to the month the balance
 * recovers. It ends there rather than at the end of the forecast, which would paint good months red.
 * A category axis needs two different months to draw any width, so a dip in the last month reaches back one.
 */
export function shortfallPeriod(rows: { month: string; negative: boolean }[]): { from: string; to: string } | undefined {
  const start = rows.findIndex((row) => row.negative);
  if (start < 0) return undefined;
  let end = start;
  while (end + 1 < rows.length && rows[end + 1].negative) end += 1;
  const from = rows[start === rows.length - 1 ? Math.max(0, start - 1) : start].month;
  const to = rows[Math.min(end + 1, rows.length - 1)].month;
  return from === to ? undefined : { from, to };
}
