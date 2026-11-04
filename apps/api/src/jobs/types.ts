/** A job that runs once per farm, inside withTenant() with a system identity. */
export interface FarmJob {
  name: string;
  /** Cron in the farm's business time zone (Asia/Tashkent). */
  cron: string;
  run: () => Promise<void>;
}
