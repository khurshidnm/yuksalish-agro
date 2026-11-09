/**
 * Questions about another member of this farm, for checks that name someone other than the caller:
 * the person who authorised a payment that someone else enters, for example.
 */
import { and, eq } from 'drizzle-orm';
import type { Permission } from '@yap/shared';
import { schema } from '../db/client';
import { ctx, tx } from './context';
import { enabledPermissions } from './http';

const { memberships, roles, tenants, users } = schema;

/**
 * Whether a person holds a permission on this farm right now: an active member, an active account, a
 * role that grants it, and the module switched on. The same test a request of theirs would pass.
 */
export async function memberHolds(userId: string, permission: Permission): Promise<boolean> {
  const [row] = await tx()
    .select({ status: memberships.status, userStatus: users.status, permissions: roles.permissions, modules: tenants.modules })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(and(eq(memberships.userId, userId), eq(memberships.farmId, ctx().farmId)));
  if (!row || row.status !== 'active' || row.userStatus !== 'active') return false;
  return enabledPermissions(row.permissions, row.modules).includes(permission);
}
