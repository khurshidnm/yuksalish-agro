/**
 * Platform administration (spec 5). Everything runs through withPlatform(), which reaches identity
 * tables only: RLS keeps business tables empty here, so a bug in this file still cannot expose
 * a tenant's animals or money.
 */
import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { MODULES } from '@yap/shared';
import { schema, type Tx } from '../../db/client';
import { withPlatform } from '../../core/context';
import { randomToken } from '../../core/crypto';
import { badRequest, conflict, notFound } from '../../core/errors';
import { listQuery } from '../../core/query';
import { addMember, provisionTenant } from '../../core/tenancy';
import { normalizePhone } from '../auth/auth.service';
import { inviteNotice, notifyAccount } from '../notifications/notifications.service';

const { farms, invitations, memberships, plans, tenants, users } = schema;

const OWNER_INVITATION_DAYS = 30;

const moduleList = z.array(z.enum(MODULES));

export const tenantListQuery = listQuery.extend({ status: z.enum(['active', 'suspended']).optional() });

export const tenantInput = z.object({
  tenant: z.object({
    name: z.string().trim().min(2).max(200),
    legalName: z.string().trim().max(300).optional(),
    tin: z.string().trim().max(20).optional(),
    legalForm: z.string().trim().max(50).optional(),
    taxRegime: z.string().trim().max(100).optional(),
    planId: z.uuid().nullish(),
    modules: moduleList.optional(),
  }),
  farm: z.object({
    name: z.string().trim().min(2).max(200),
    region: z.string().trim().max(120).optional(),
    district: z.string().trim().max(120).optional(),
    address: z.string().trim().max(300).optional(),
    totalAreaHa: z.number().positive().max(10_000_000).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  }),
  owner: z.object({
    phone: z.string().trim().min(9).max(20),
    fullName: z.string().trim().min(2).max(120),
    email: z.email().optional(),
  }),
});

export const tenantUpdate = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  planId: z.uuid().nullable().optional(),
  modules: moduleList.optional(),
});

export const planInput = z.object({
  key: z.string().trim().regex(/^[a-z0-9_-]+$/).max(40),
  name: z.string().trim().min(2).max(120),
  modules: moduleList,
  priceMonthly: z.number().min(0).nullish(),
});

const tenantColumns = {
  id: tenants.id,
  name: tenants.name,
  legalName: tenants.legalName,
  tin: tenants.tin,
  status: tenants.status,
  modules: tenants.modules,
  planId: tenants.planId,
  planName: plans.name,
  createdAt: tenants.createdAt,
  farmCount: sql<number>`(select count(*) from farms f where f.tenant_id = ${tenants.id})`.mapWith(Number),
  memberCount: sql<number>`(select count(*) from memberships m where m.tenant_id = ${tenants.id})`.mapWith(Number),
};

function matching(q: z.infer<typeof tenantListQuery>) {
  const search = q.search ? `%${q.search.replace(/[\\%_]/g, '\\$&')}%` : null;
  return and(
    q.status ? eq(tenants.status, q.status) : undefined,
    search ? or(ilike(tenants.name, search), ilike(tenants.legalName, search), ilike(tenants.tin, search)) : undefined,
  );
}

export async function listTenants(q: z.infer<typeof tenantListQuery>) {
  const where = matching(q);
  return withPlatform(async (trx) => {
    const data = await trx
      .select(tenantColumns)
      .from(tenants)
      .leftJoin(plans, eq(plans.id, tenants.planId))
      .where(where)
      .orderBy(desc(tenants.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ total }] = await trx.select({ total: count() }).from(tenants).where(where);
    return { data, meta: { page: q.page, pageSize: q.pageSize, total } };
  });
}

async function findTenant(trx: Tx, id: string) {
  const [row] = await trx.select(tenantColumns).from(tenants).leftJoin(plans, eq(plans.id, tenants.planId)).where(eq(tenants.id, id));
  if (!row) throw notFound('Tenant');
  return row;
}

export const getTenant = (id: string) => withPlatform((trx) => findTenant(trx, id));

async function assertPlanExists(trx: Tx, planId: string) {
  const [plan] = await trx.select().from(plans).where(eq(plans.id, planId));
  if (!plan) throw notFound('Plan');
  return plan;
}

/**
 * Create a tenant and its first owner. A new owner's one-time password is shown once. Someone who
 * already has an account decides for themselves, so the tenant has no owner until they accept.
 */
export async function createTenant(input: z.infer<typeof tenantInput>) {
  const phone = normalizePhone(input.owner.phone);
  if (!/^\+\d{9,15}$/.test(phone)) throw badRequest('INVALID_PHONE', 'This phone number is not valid');

  const { plan, existing } = await withPlatform(async (trx) => ({
    plan: input.tenant.planId ? await assertPlanExists(trx, input.tenant.planId) : null,
    existing: (await trx.select({ id: users.id }).from(users).where(eq(users.phone, phone)))[0] ?? null,
  }));

  const { planId: _planId, modules, ...tenant } = input.tenant;
  const provisioned = await provisionTenant({
    tenant: { ...tenant, modules: modules ?? plan?.modules },
    farm: input.farm,
  });
  if (plan) {
    await withPlatform((trx) => trx.update(tenants).set({ planId: plan.id }).where(eq(tenants.id, provisioned.tenantId)));
  }

  const tenantRow = await getTenant(provisioned.tenantId);
  if (existing) {
    await withPlatform((trx) =>
      trx.insert(invitations).values({
        tenantId: provisioned.tenantId,
        farmId: provisioned.farmId,
        roleId: provisioned.roleIds.owner,
        phone,
        fullName: input.owner.fullName,
        expiresAt: new Date(Date.now() + OWNER_INVITATION_DAYS * 86_400_000),
      }),
    );
    await notifyAccount(existing.id, inviteNotice(tenantRow.name));
    return { tenant: tenantRow, oneTimePassword: null, invited: true };
  }

  const password = randomToken(9);
  await addMember({
    tenantId: provisioned.tenantId,
    farmId: provisioned.farmId,
    roleId: provisioned.roleIds.owner,
    phone,
    fullName: input.owner.fullName,
    email: input.owner.email,
    password,
    mustChangePassword: true,
  });
  return { tenant: await getTenant(provisioned.tenantId), oneTimePassword: password, invited: false };
}

export async function updateTenant(id: string, input: z.infer<typeof tenantUpdate>) {
  return withPlatform(async (trx) => {
    await findTenant(trx, id);
    if (input.planId) await assertPlanExists(trx, input.planId);
    if (Object.keys(input).length > 0) await trx.update(tenants).set(input).where(eq(tenants.id, id));
    return findTenant(trx, id);
  });
}

/** Suspended members are refused on their next request; the guard reads the status every time. */
export async function setTenantStatus(id: string, status: 'active' | 'suspended') {
  return withPlatform(async (trx) => {
    const current = await findTenant(trx, id);
    if (current.status === status) throw conflict('STATUS_UNCHANGED', `The workspace is already ${status}`);
    await trx.update(tenants).set({ status }).where(eq(tenants.id, id));
    return findTenant(trx, id);
  });
}

export async function stats() {
  return withPlatform(async (trx) => {
    const [t] = await trx
      .select({
        total: count(),
        active: sql<number>`count(*) filter (where ${tenants.status} = 'active')`.mapWith(Number),
      })
      .from(tenants);
    const [f] = await trx.select({ n: count() }).from(farms);
    const [m] = await trx.select({ n: count() }).from(memberships);
    return { tenants: t.total, activeTenants: t.active, farms: f.n, members: m.n };
  });
}

export const listPlans = () =>
  withPlatform((trx) => trx.select().from(plans).orderBy(desc(plans.active), asc(plans.name)));

export const createPlan = (input: z.infer<typeof planInput>) =>
  withPlatform(async (trx) => (await trx.insert(plans).values(input).returning())[0]);

export const updatePlan = (id: string, input: Partial<z.infer<typeof planInput>> & { active?: boolean }) =>
  withPlatform(async (trx) => {
    if (Object.keys(input).length === 0) throw badRequest('NOTHING_TO_UPDATE', 'No changes were sent');
    const [row] = await trx.update(plans).set(input).where(eq(plans.id, id)).returning();
    if (!row) throw notFound('Plan');
    return row;
  });

/** Plans are retired rather than deleted: tenants may still point at them. */
export const retirePlan = (id: string) => updatePlan(id, { active: false });
