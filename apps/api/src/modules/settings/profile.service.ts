import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { COSTING_METHODS, CURRENCIES, OVERHEAD_BASES } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { mergeSettings } from '../../core/settings';

const { farms, tenants, transactions } = schema;

export const profileInput = z.object({
  tenant: z
    .object({
      name: z.string().trim().min(2).max(200),
      legalName: z.string().trim().max(300).nullable(),
      tin: z.string().trim().max(20).nullable(),
      legalForm: z.string().trim().max(50).nullable(),
      taxRegime: z.string().trim().max(100).nullable(),
      locale: z.enum(['uz', 'uz-Cyrl', 'ru', 'en']),
    })
    .partial()
    .optional(),
  farm: z
    .object({
      name: z.string().trim().min(2).max(200),
      region: z.string().trim().max(120).nullable(),
      district: z.string().trim().max(120).nullable(),
      address: z.string().trim().max(300).nullable(),
      lat: z.number().min(-90).max(90).nullable(),
      lng: z.number().min(-180).max(180).nullable(),
    })
    .partial()
    .optional(),
});

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Partial update of TenantSettings. `.strict()` makes a mistyped key an error, not a silent no-op. */
export const policyInput = z
  .object({
    finance: z
      .object({
        approvalThreshold: z.number().min(0),
        makerChecker: z.boolean(),
        overheadBase: z.enum(OVERHEAD_BASES),
      })
      .partial()
      .strict(),
    inventory: z.object({ costingMethod: z.enum(COSTING_METHODS) }).partial().strict(),
    feed: z
      .object({
        winterDays: z.number().int().min(1).max(366),
        minStockDays: z.number().min(0).max(365),
        deviationPercent: z.number().min(0).max(100),
      })
      .partial()
      .strict(),
    livestock: z
      .object({
        quarantineDays: z.number().int().min(0).max(365),
        defaultGestationDays: z.number().int().min(1).max(400),
      })
      .partial()
      .strict(),
    security: z.object({ enforce2fa: z.boolean() }).partial().strict(),
    storage: z
      .object({
        quotaMb: z.number().int().min(100).max(10_000_000),
        dailyUploadMb: z.number().int().min(15).max(1_000_000),
      })
      .partial()
      .strict(),
    retention: z
      .object({
        notificationDays: z.number().int().min(30).max(3650),
        // Below this, a phone that was offline for weeks could post the same record twice.
        idempotencyDays: z.number().int().min(30).max(365),
        webhookDeliveryDays: z.number().int().min(7).max(3650),
        aiToolDataDays: z.number().int().min(7).max(3650),
        importDays: z.number().int().min(7).max(3650),
      })
      .partial()
      .strict(),
    currency: z.enum(CURRENCIES),
    timezone: z.string().refine(isTimeZone, 'Unknown time zone'),
  })
  .partial()
  .strict();

async function loadTenant() {
  const [tenant] = await tx().select().from(tenants).where(eq(tenants.id, ctx().tenantId));
  if (!tenant) throw notFound('Tenant');
  return tenant;
}

export async function getProfile() {
  const c = ctx();
  const tenant = await loadTenant();
  const [farm] = await tx().select().from(farms).where(and(eq(farms.id, c.farmId), eq(farms.tenantId, c.tenantId)));
  if (!farm) throw notFound('Farm');
  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      legalName: tenant.legalName,
      tin: tenant.tin,
      legalForm: tenant.legalForm,
      taxRegime: tenant.taxRegime,
      locale: tenant.locale,
    },
    farm: {
      id: farm.id,
      name: farm.name,
      region: farm.region,
      district: farm.district,
      address: farm.address,
      lat: farm.lat,
      lng: farm.lng,
    },
  };
}

export async function updateProfile(input: z.infer<typeof profileInput>) {
  const c = ctx();
  if (input.tenant && Object.keys(input.tenant).length > 0) {
    await tx().update(tenants).set(input.tenant).where(eq(tenants.id, c.tenantId));
  }
  if (input.farm && Object.keys(input.farm).length > 0) {
    await tx().update(farms).set(input.farm).where(eq(farms.id, c.farmId));
  }
  await recordEvent({ type: 'settings.profile_changed', entityType: 'tenant', entityId: c.tenantId });
  return getProfile();
}

export async function getPolicy() {
  const tenant = await loadTenant();
  return { ...mergeSettings(tenant.settings), currency: tenant.currency, timezone: tenant.timezone };
}

/** Sections are merged key by key, so a partial form never wipes the other values in its section. */
function mergePolicy(stored: Record<string, unknown>, patch: Record<string, Record<string, unknown>>) {
  const merged: Record<string, unknown> = { ...stored };
  for (const [section, values] of Object.entries(patch)) {
    merged[section] = { ...(stored[section] as Record<string, unknown> | undefined), ...values };
  }
  return merged;
}

export async function updatePolicy(input: z.infer<typeof policyInput>) {
  const c = ctx();
  const { currency, timezone, ...sections } = input;
  const [tenant] = await tx().select().from(tenants).where(eq(tenants.id, c.tenantId)).for('update');
  if (!tenant) throw notFound('Tenant');

  if (currency && currency !== tenant.currency) {
    // amount_base of every existing transaction is in the old currency.
    const [{ exists }] = (
      await tx().execute(sql`select exists (select 1 from ${transactions} limit 1) as exists`)
    ).rows as { exists: boolean }[];
    if (exists) {
      throw conflict('CURRENCY_LOCKED', 'The base currency cannot change once transactions exist');
    }
  }

  await tx()
    .update(tenants)
    .set({
      settings: mergePolicy(tenant.settings, sections),
      ...(currency ? { currency } : {}),
      ...(timezone ? { timezone } : {}),
    })
    .where(eq(tenants.id, c.tenantId));

  await recordEvent({
    type: 'settings.policy_changed',
    severity: 'attention',
    entityType: 'tenant',
    entityId: c.tenantId,
    data: { changes: input },
  });
  return getPolicy();
}
