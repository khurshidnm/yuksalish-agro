import { and, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { LAND_USES, round } from '@yap/shared';
import { unassignedAreaHa } from '@yap/shared/formulas/land';
import { ctx, hasPermission, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { isoDate, sumOf } from '../../core/query';
import { schema } from '../../db/client';

const { farms, fields, tenants } = schema;

const text = (max: number) => z.string().trim().max(max).nullish();

const passportDetails = z.object({
  landRightType: text(80),
  leaseContractNo: text(80),
  leaseContractDate: isoDate.nullish(),
  leaseValidUntil: isoDate.nullish(),
  bankName: text(120),
  bankAccount: text(40),
  mfo: text(10),
  responsiblePersons: z
    .array(z.object({ role: z.string().trim().min(1).max(80), fullName: z.string().trim().min(1).max(120), phone: text(30) }))
    .max(30)
    .optional(),
  notes: text(2000),
});

export const passportPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  region: text(120),
  district: text(120),
  address: text(300),
  totalAreaHa: z.number().positive().max(10_000_000).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  cadastreNumber: text(80),
  passport: passportDetails.optional(),
});

type ResponsiblePerson = { role: string; fullName: string; phone?: string | null };

/** How the farm's total land divides across contours (spec 6.2). */
export async function areaBalance(totalAreaHa: number | null) {
  const rows = await tx()
    .select({ landUse: fields.landUse, count: count(), areaHa: sumOf(fields.areaHa) })
    .from(fields)
    .where(and(eq(fields.farmId, ctx().farmId), eq(fields.status, 'active')))
    .groupBy(fields.landUse);
  const byLandUse = LAND_USES.map((landUse) => {
    const row = rows.find((r) => r.landUse === landUse);
    return { landUse, count: row?.count ?? 0, areaHa: round(row?.areaHa ?? 0, 4) };
  });
  const parts = byLandUse.map((r) => r.areaHa);
  const unassignedHa = unassignedAreaHa(totalAreaHa, parts);
  return {
    totalAreaHa,
    assignedHa: round(parts.reduce((sum, ha) => sum + ha, 0), 4),
    unassignedHa,
    overAssigned: unassignedHa !== null && unassignedHa < 0,
    byLandUse,
  };
}

export async function getPassport() {
  const c = ctx();
  const [farm] = await tx().select().from(farms).where(eq(farms.id, c.farmId));
  if (!farm) throw notFound('Farm');
  const [tenant] = await tx()
    .select({ name: tenants.name, legalName: tenants.legalName, tin: tenants.tin, legalForm: tenants.legalForm, taxRegime: tenants.taxRegime })
    .from(tenants)
    .where(eq(tenants.id, c.tenantId));

  const details = farm.passport as Record<string, unknown>;
  const people = (details.responsiblePersons ?? []) as ResponsiblePerson[];
  return {
    ...farm,
    passport: {
      ...details,
      // Phone numbers are personal data (CLAUDE.md rule 8).
      responsiblePersons: hasPermission('pii.view') ? people : people.map((p) => ({ ...p, phone: null })),
    },
    tenant,
    areaBalance: await areaBalance(farm.totalAreaHa),
  };
}

export async function updatePassport(input: z.infer<typeof passportPatch>) {
  if (Object.keys(input).length === 0) throw badRequest('NOTHING_TO_UPDATE', 'No changes were sent');
  const c = ctx();
  const [farm] = await tx().select().from(farms).where(eq(farms.id, c.farmId)).for('update');
  if (!farm) throw notFound('Farm');

  const { passport, ...columns } = input;
  const previous = farm.passport as Record<string, unknown>;
  let merged: Record<string, unknown> | undefined;
  if (passport) {
    merged = { ...previous, ...passport };
    // Without pii.view the page received phones as null, so saving must not wipe them.
    if (passport.responsiblePersons && !hasPermission('pii.view')) {
      const known = (previous.responsiblePersons ?? []) as ResponsiblePerson[];
      merged.responsiblePersons = passport.responsiblePersons.map((p) => ({
        ...p,
        phone: known.find((k) => k.fullName === p.fullName)?.phone ?? null,
      }));
    }
  }

  await tx()
    .update(farms)
    .set({ ...columns, ...(merged ? { passport: merged } : {}), updatedAt: sql`now()` })
    .where(eq(farms.id, c.farmId));
  await recordEvent({ type: 'farm.passport_updated', entityType: 'farm', entityId: c.farmId, data: { fields: Object.keys(input) } });
  return getPassport();
}
