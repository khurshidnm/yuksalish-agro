/**
 * The invited person's side of an invitation. Inviting happens in settings/users.service. Their
 * details reach the farm only here, when they accept, signed in as the phone that was invited.
 */
import { and, asc, eq, gt } from 'drizzle-orm';
import { schema, type Tx } from '../../db/client';
import { withPlatform, withTenant } from '../../core/context';
import { notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { linkEmployeeByPhone } from '../hr/login-link.service';

const { farms, invitations, memberships, roles, tenants } = schema;

export function pendingInvitations(phone: string) {
  return withPlatform((trx) =>
    trx
      .select({
        id: invitations.id,
        tenantName: tenants.name,
        farmName: farms.name,
        roleKey: roles.key,
        roleName: roles.name,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .innerJoin(tenants, eq(tenants.id, invitations.tenantId))
      .innerJoin(farms, eq(farms.id, invitations.farmId))
      .innerJoin(roles, eq(roles.id, invitations.roleId))
      .where(
        and(
          eq(invitations.phone, phone),
          eq(invitations.status, 'pending'),
          gt(invitations.expiresAt, new Date()),
          eq(tenants.status, 'active'),
        ),
      )
      .orderBy(asc(invitations.createdAt)),
  );
}

/** Close an invitation for this phone. Anyone else's id, or one already closed, simply does not exist here. */
async function close(trx: Tx, phone: string, id: string, status: 'accepted' | 'declined') {
  const [row] = await trx
    .update(invitations)
    .set({ status })
    .where(and(eq(invitations.id, id), eq(invitations.phone, phone), eq(invitations.status, 'pending'), gt(invitations.expiresAt, new Date())))
    .returning();
  if (!row) throw notFound('Invitation');
  return row;
}

/** Returns the new membership. */
export async function acceptInvitation(user: { id: string; phone: string }, id: string): Promise<string> {
  const { invitation, membershipId } = await withPlatform(async (trx) => {
    const invitation = await close(trx, user.phone, id, 'accepted');
    const [membership] = await trx
      .insert(memberships)
      .values({ tenantId: invitation.tenantId, farmId: invitation.farmId, userId: user.id, roleId: invitation.roleId })
      .returning({ id: memberships.id });
    return { invitation, membershipId: membership.id };
  });
  await withTenant({ userId: user.id, tenantId: invitation.tenantId, farmId: invitation.farmId }, async () => {
    await recordEvent({ type: 'user.joined', entityType: 'membership', entityId: membershipId });
    await linkEmployeeByPhone(user.id, user.phone);
  });
  return membershipId;
}

export async function declineInvitation(user: { id: string; phone: string }, id: string): Promise<void> {
  const invitation = await withPlatform((trx) => close(trx, user.phone, id, 'declined'));
  await withTenant({ userId: user.id, tenantId: invitation.tenantId, farmId: invitation.farmId }, () =>
    recordEvent({ type: 'user.invitation_declined', entityType: 'invitation', entityId: id }),
  );
}
