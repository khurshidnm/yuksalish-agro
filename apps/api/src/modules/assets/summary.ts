import { and, eq, sql } from 'drizzle-orm';
import { addDays } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { sumOf } from '../../core/query';
import { dueMaintenance } from './maintenance.service';

export { machineryCostByField } from './costs.service';

const { assets, assetUsageLogs } = schema;

export async function assetStatus() {
  const rows = await tx()
    .select({ status: assets.status, count: sql<number>`count(*)`.mapWith(Number) })
    .from(assets)
    .where(eq(assets.farmId, ctx().farmId))
    .groupBy(assets.status);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  const total = rows.filter((r) => r.status !== 'written_off').reduce((sum, r) => sum + r.count, 0);
  return { total, byStatus, maintenanceDue: (await dueMaintenance()).length };
}

export async function fuelUsage(days: number) {
  const since = addDays(today(), -days);
  const [row] = await tx()
    .select({ liters: sumOf(assetUsageLogs.fuelL) })
    .from(assetUsageLogs)
    .where(and(eq(assetUsageLogs.farmId, ctx().farmId), sql`${assetUsageLogs.date} > ${since}`));
  return { liters: row.liters };
}
