import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { DEFAULT_ROLE_PERMISSIONS, MODULES, ROLE_KEYS, type RoleKey } from '@yap/shared';
import { config } from '../config';
import { schema } from '../db/client';
import { tx, withPlatform, withTenant } from './context';
import { DEFAULT_BREEDS, DEFAULT_CATEGORIES, DEFAULT_CROPS, DEFAULT_DIVISIONS, DEFAULT_SPECIES } from './defaults';
import { generalCostCenterId } from './costCenters';

const { breeds, crops, divisions, farms, financeCategories, memberships, roles, species, tenants, users } = schema;

export interface ProvisionInput {
  tenant: {
    name: string;
    legalName?: string;
    tin?: string;
    legalForm?: string;
    taxRegime?: string;
    settings?: Record<string, unknown>;
    modules?: string[];
  };
  farm: {
    name: string;
    region?: string;
    district?: string;
    address?: string;
    totalAreaHa?: number;
    lat?: number;
    lng?: number;
    passport?: Record<string, unknown>;
  };
}

export interface Provisioned {
  tenantId: string;
  farmId: string;
  roleIds: Record<RoleKey, string>;
}

/** Create a tenant with default roles, reference data, first farm and general cost center. */
export async function provisionTenant(input: ProvisionInput): Promise<Provisioned> {
  const { tenantId, farmId, roleIds } = await withPlatform(async (trx) => {
    const [tenant] = await trx
      .insert(tenants)
      .values({ ...input.tenant, modules: input.tenant.modules ?? [...MODULES] })
      .returning();
    const [farm] = await trx.insert(farms).values({ ...input.farm, tenantId: tenant.id }).returning();
    const roleRows = await trx
      .insert(roles)
      .values(
        ROLE_KEYS.map((key) => ({
          tenantId: tenant.id,
          key,
          name: key,
          permissions: DEFAULT_ROLE_PERMISSIONS[key],
          isSystem: true,
        })),
      )
      .returning();
    return {
      tenantId: tenant.id,
      farmId: farm.id,
      roleIds: Object.fromEntries(roleRows.map((r) => [r.key, r.id])) as Record<RoleKey, string>,
    };
  });

  await withTenant({ userId: null, tenantId, farmId, source: 'system' }, async () => {
    await tx().insert(divisions).values(DEFAULT_DIVISIONS.map((d) => ({ ...d, tenantId, farmId })));
    const speciesRows = await tx()
      .insert(species)
      .values(DEFAULT_SPECIES.map((s) => ({ ...s, tenantId })))
      .returning();
    const speciesId = new Map(speciesRows.map((s) => [s.key, s.id]));
    await tx()
      .insert(breeds)
      .values(DEFAULT_BREEDS.map((b) => ({ tenantId, speciesId: speciesId.get(b.species)!, key: b.key, name: b.name })));
    await tx().insert(crops).values(DEFAULT_CROPS.map((c) => ({ ...c, tenantId })));
    await tx().insert(financeCategories).values(DEFAULT_CATEGORIES.map((c) => ({ ...c, tenantId })));
    await generalCostCenterId();
  });

  return { tenantId, farmId, roleIds };
}

/** Create a login and attach it to a farm with a role. Reuses an existing user by phone. */
export async function addMember(i: {
  tenantId: string;
  farmId: string;
  roleId: string;
  phone: string;
  fullName: string;
  password: string;
  email?: string;
  locale?: string;
}): Promise<{ userId: string; membershipId: string }> {
  const passwordHash = await bcrypt.hash(i.password, config.BCRYPT_ROUNDS);
  return withPlatform(async (trx) => {
    const [existing] = await trx.select({ id: users.id }).from(users).where(eq(users.phone, i.phone));
    const userId =
      existing?.id ??
      (
        await trx
          .insert(users)
          .values({ phone: i.phone, fullName: i.fullName, email: i.email, locale: i.locale ?? 'uz', passwordHash })
          .returning({ id: users.id })
      )[0].id;
    const [membership] = await trx
      .insert(memberships)
      .values({ tenantId: i.tenantId, farmId: i.farmId, userId, roleId: i.roleId })
      .returning({ id: memberships.id });
    return { userId, membershipId: membership.id };
  });
}
