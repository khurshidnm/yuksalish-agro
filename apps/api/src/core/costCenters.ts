import { and, eq, isNull } from 'drizzle-orm';
import type { CostCenterType } from '@yap/shared';
import { schema } from '../db/client';
import { ctx, tx } from './context';

const { costCenters } = schema;

/** The cost center of a field, herd, animal, asset or employee, created on first use. */
export async function ensureCostCenter(type: CostCenterType, refId: string, name: string): Promise<string> {
  const c = ctx();
  const inserted = await tx()
    .insert(costCenters)
    .values({ tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId, type, refId, name })
    .onConflictDoNothing()
    .returning({ id: costCenters.id });
  if (inserted[0]) return inserted[0].id;

  const [existing] = await tx()
    .select({ id: costCenters.id })
    .from(costCenters)
    .where(and(eq(costCenters.farmId, c.farmId), eq(costCenters.type, type), eq(costCenters.refId, refId)));
  return existing.id;
}

/** The farm-wide "general" cost center for shared costs. */
export async function generalCostCenterId(): Promise<string> {
  const c = ctx();
  const [existing] = await tx()
    .select({ id: costCenters.id })
    .from(costCenters)
    .where(and(eq(costCenters.farmId, c.farmId), eq(costCenters.type, 'general'), isNull(costCenters.refId)));
  if (existing) return existing.id;

  const [created] = await tx()
    .insert(costCenters)
    .values({ tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId, type: 'general', name: 'General' })
    .returning({ id: costCenters.id });
  return created.id;
}

/** Keep a cost center's label in step when its field, herd or asset is renamed. */
export async function renameCostCenter(id: string, name: string): Promise<void> {
  await tx().update(costCenters).set({ name }).where(eq(costCenters.id, id));
}

/** Stop offering an archived object's cost center. Its history stays. */
export async function deactivateCostCenter(id: string): Promise<void> {
  await tx().update(costCenters).set({ active: false }).where(eq(costCenters.id, id));
}
